package postgres

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"view-db/internal/connection"
)

// tlsConfigBag is the type used for profile.TLSConfig below. Keeping it
// in this package avoids needing to add the field to ConnectionProfile
// (which would change the JSON wire format).
type tlsConfigBag map[string]string

// insecureTLSConfig returns a *tls.Config that accepts any server cert.
// Use ONLY when profile.TLSInsecure is explicitly set — never as a default.
func insecureTLSConfig() *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec // user opted in via profile
	}
}

// verifyTLSConfig returns a *tls.Config that validates the server cert
// against system roots and (optionally) a custom CA file. When
// insecureOnly is true, cert verification is skipped but the connection
// is still encrypted.
func verifyTLSConfig(insecureOnly bool, caFilePath string) *tls.Config {
	pool := x509.NewCertPool()
	// System roots are always trusted.
	if sysRoots, err := x509.SystemCertPool(); err == nil && sysRoots != nil {
		pool = sysRoots
	}
	if caFilePath != "" {
		if pem, err := os.ReadFile(caFilePath); err == nil {
			pool.AppendCertsFromPEM(pem)
		}
	}
	return &tls.Config{
		RootCAs:            pool,
		InsecureSkipVerify: insecureOnly, //nolint:gosec // explicit user choice
	}
}

// QueryRequest mirrors db.QueryRequest's wire shape.
type QueryRequest struct {
	ConnectionID    string   `json:"connectionId"`
	Query           string   `json:"query"`
	Database        string   `json:"database"`
	Schema          string   `json:"schema,omitempty"`
	Limit           int      `json:"limit"`
	SelectedColumns []string `json:"selectedColumns,omitempty"`
}

// QueryResult mirrors db.QueryResult (column names + 2D row values).
type QueryResult struct {
	Columns []string
	Rows    [][]any
	Count   int
}

// DatabaseInfo mirrors db.DatabaseInfo's wire shape.
type DatabaseInfo struct {
	Name string `json:"name"`
}

// TableInfo is a postgres "table-like" object — same shape as
// influx.MeasurementInfo so the frontend tree can treat them uniformly.
type TableInfo struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
}

// ColumnInfo mirrors influx.FieldInfo.
type ColumnInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// TagInfo mirrors influx.TagInfo.
type TagInfo struct {
	Name string `json:"name"`
}

// Adapter is the postgres-specific interface.
type Adapter interface {
	TestConnection(ctx context.Context) error
	ListDatabases(ctx context.Context) ([]DatabaseInfo, error)
	ListTables(ctx context.Context, scope QueryScope) ([]TableInfo, error)
	ListColumns(ctx context.Context, scope QueryScope, table string) ([]ColumnInfo, error)
	ListTags(ctx context.Context, scope QueryScope, table string) ([]TagInfo, error)
	Query(ctx context.Context, req QueryRequest) (*QueryResult, error)
	Close() error
}

// QueryScope mirrors db.QueryScope (database/schema/...).
type QueryScope struct {
	Database string `json:"database"`
	Schema   string `json:"schema,omitempty"`
}

// buildDSN converts a ConnectionProfile into a libpq-style DSN suitable for
// pgx/v5.
//
// For PostgreSQL we ALWAYS build the DSN from profile fields (Host/Port/User/
// Database/SSLMode) and ignore profile.URL. The URL field exists for
// InfluxDB HTTP endpoints and users sometimes paste http://host there by
// mistake — pgx would reject that with "failed to parse as keyword/value".
//
// Escape hatch: if Host looks like a libpq keyword string already, pass it
// through unchanged so power users can set advanced options (SSL cert paths,
// application_name, etc.) without code changes.
func buildDSN(profile connection.ConnectionProfile) (string, error) {
	host := profile.Host
	if host == "" {
		return "", fmt.Errorf("postgres: host is required")
	}
	if strings.HasPrefix(host, "host=") {
		return host, nil
	}
	port := profile.Port
	if port == 0 {
		port = 5432
	}
	user := profile.Username
	dbname := profile.Database
	sslmode := profile.SSLMode
	if sslmode == "" {
		sslmode = "disable"
	}
	return fmt.Sprintf("host=%s port=%d user=%s dbname=%s sslmode=%s",
		host, port, user, dbname, sslmode), nil
}

// Global limits across all pgAdapter instances in this process. Without
// these, a user who opens connections to many databases can blow past
// the PostgreSQL server's max_connections (default 100).
const (
	// MaxTotalConnections caps the sum of pgxpool.MaxConns across every
	// cached pool in this process. When the cap is hit, ensurePool waits
	// for a slot rather than spawning a new connection.
	MaxTotalConnections = 16

	// MaxConnsPerDB caps each per-database pool. Even one busy user
	// should not be able to saturate the server.
	MaxConnsPerDB = 4
)

// poolRegistry tracks in-use connections across all pgAdapter instances
// in this process so we can enforce a global ceiling.
type poolRegistry struct {
	inUse atomic.Int64
	sem   chan struct{}
}

var globalPoolRegistry = func() *poolRegistry {
	return &poolRegistry{
		sem: make(chan struct{}, MaxTotalConnections),
	}
}()

// acquire blocks until a global pool slot is available or the context
// is cancelled. Returns a release function the caller MUST defer.
func (r *poolRegistry) acquire(ctx context.Context) (release func(), err error) {
	select {
	case globalPoolRegistry.sem <- struct{}{}:
		// Acquired. Increment counter and return a release closure.
		r.inUse.Add(1)
		return func() {
			r.inUse.Add(-1)
			<-globalPoolRegistry.sem
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(10 * time.Second):
		// Give up after 10s to avoid hanging the UI forever.
		return nil, fmt.Errorf("pg: pool registry full, timeout after 10s (in-use=%d)",
			r.inUse.Load())
	}
}

// inUseCount returns the current number of checked-out pool slots.
// Useful for tests and admin logging.
func inUseCount() int64 {
	return globalPoolRegistry.inUse.Load()
}

// pgAdapter is the pgx-backed implementation of Adapter.
//
// We keep ONE connection pool PER database, not per profile. This lets the
// user connect with database="postgres" (the default for listing servers)
// and then browse other databases like "VibrationSS_db" — each one gets
// its own pool that's lazy-opened on first query and cached afterwards.
//
// Without this, querying information_schema.tables would always look in the
// pool's connected database (postgres), not the database the user clicked
// in the UI, and the table list would always be empty.
//
// Each per-database pool is also bounded by a global quota (see
// poolRegistry) so opening many databases cannot exceed PostgreSQL's
// server-side max_connections.
type pgAdapter struct {
	profile connection.ConnectionProfile
	dsn     string
	// pools maps database name → pool. nil entries are lazily created.
	pools map[string]*pgxpool.Pool
	// poolReleases holds the release func for each pool's global slot.
	// Released when the pool is closed.
	poolReleases map[string]func()
	mu           sync.Mutex
}

// NewAdapter builds a PostgreSQL adapter for db.NewAdapter.
//
// The pool is NOT opened here — we defer that until TestConnection or
// Query is actually called. This lets users save a connection profile
// with invalid credentials and surface a clear error at first use.
func NewAdapter(profile connection.ConnectionProfile) (Adapter, error) {
	dsn, err := buildDSN(profile)
	if err != nil {
		return nil, err
	}
	return &pgAdapter{
		profile:      profile,
		dsn:          dsn,
		pools:        map[string]*pgxpool.Pool{},
		poolReleases: map[string]func(){},
	}, nil
}

// Close releases every cached connection pool and the global slots
// they hold.
func (a *pgAdapter) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for db, p := range a.pools {
		if p != nil {
			p.Close()
		}
		delete(a.pools, db)
	}
	for db, rel := range a.poolReleases {
		rel()
		delete(a.poolReleases, db)
	}
	return nil
}

// ensurePool returns a connection pool for the given database name.
// If a pool for that database already exists and is healthy, it's reused;
// otherwise a new pool is built from the profile's DSN (with dbname swapped).
//
// On creation the pool blocks until the global poolRegistry has a free
// slot — this keeps the total open connections bounded by
// MaxTotalConnections across all databases in this process.
func (a *pgAdapter) ensurePool(ctx context.Context, database string) (*pgxpool.Pool, error) {
	if database == "" {
		database = a.profile.Database
	}
	if database == "" {
		return nil, fmt.Errorf("pg: database name is required")
	}

	a.mu.Lock()
	p, ok := a.pools[database]
	a.mu.Unlock()
	if ok && p != nil {
		pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if err := p.Ping(pingCtx); err == nil {
			return p, nil
		}
		// Stale pool — drop and rebuild.
		a.closePool(database)
	}

	// Wait for a global pool slot before opening new connections.
	release, err := globalPoolRegistry.acquire(ctx)
	if err != nil {
		return nil, err
	}

	// Build a DSN with dbname swapped to the requested database.
	dsn := swapDBName(a.dsn, database)

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		release()
		return nil, fmt.Errorf("pg: parse config: %w", err)
	}
	// Cap each pool's internal concurrency.
	if cfg.MaxConns > MaxConnsPerDB {
		cfg.MaxConns = MaxConnsPerDB
	}
	cfg.MinConns = 0
	cfg.MaxConnLifetime = 30 * time.Minute
	if a.profile.Password != "" {
		// Override password from keyring so it never appears in URLs/logs.
		cfg.ConnConfig.Password = a.profile.Password
	}
	if a.profile.TimeoutSeconds > 0 {
		cfg.ConnConfig.ConnectTimeout = time.Duration(a.profile.TimeoutSeconds) * time.Second
	}
	// TLS settings — honour profile.TLSInsecure and a custom root CA file
	// (sslrootcert) when the user provides one. This finally makes the
	// "Skip TLS Verification" checkbox in the connection form actually do
	// something useful for production deployments.
	switch a.profile.SSLMode {
	case "disable", "allow", "prefer":
		// No TLS layer at all — leave defaults alone.
	case "require":
		// Encrypted but don't validate the server cert. Useful for self-signed
		// dev boxes where TLSInsecure == true.
		if a.profile.TLSInsecure {
			cfg.ConnConfig.TLSConfig = insecureTLSConfig()
		}
	case "verify-ca", "verify-full":
		// Full validation. Honour TLSInsecure only when the user explicitly
		// unchecked "verify-full" by picking verify-ca.
		caPath := ""
		if v, ok := a.profile.TLSConfig["sslrootcert"]; ok {
			caPath = v
		}
		cfg.ConnConfig.TLSConfig = verifyTLSConfig(a.profile.TLSInsecure && a.profile.SSLMode == "verify-ca", caPath)
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		release()
		return nil, fmt.Errorf("pg: connect (%s): %w", database, err)
	}

	a.mu.Lock()
	a.pools[database] = pool
	a.poolReleases[database] = release
	a.mu.Unlock()
	return pool, nil
}

// closePool is a helper that drops a single database's pool and its
// global slot. Must be called with a.mu NOT held (it locks).
func (a *pgAdapter) closePool(database string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, ok := a.pools[database]; ok {
		if p != nil {
			p.Close()
		}
		delete(a.pools, database)
	}
	if rel, ok := a.poolReleases[database]; ok {
		rel()
		delete(a.poolReleases, database)
	}
}

// swapDBName returns a copy of dsn with dbname replaced by the given
// value. Handles both URI (postgres://user@host/dbname?...) and keyword
// (host=... dbname=...) forms.
func swapDBName(dsn, newDB string) string {
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, err := url.Parse(dsn)
		if err == nil {
			u.Path = "/" + newDB
			return u.String()
		}
	}
	parts := strings.Fields(dsn)
	found := false
	for i, p := range parts {
		if strings.HasPrefix(p, "dbname=") {
			parts[i] = "dbname=" + newDB
			found = true
			break
		}
	}
	if !found {
		parts = append(parts, "dbname="+newDB)
	}
	return strings.Join(parts, " ")
}

// TestConnection opens the pool and runs SELECT 1.
func (a *pgAdapter) TestConnection(ctx context.Context) error {
	pool, err := a.ensurePool(ctx, "")
	if err != nil {
		return err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var v int
	if err := pool.QueryRow(pingCtx, "SELECT 1").Scan(&v); err != nil {
		return fmt.Errorf("pg: test query: %w", err)
	}
	if v != 1 {
		return fmt.Errorf("pg: unexpected SELECT 1 result: %d", v)
	}
	return nil
}

// ListDatabases returns user-visible databases (excluding templates).
func (a *pgAdapter) ListDatabases(ctx context.Context) ([]DatabaseInfo, error) {
	pool, err := a.ensurePool(ctx, "")
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT datname
		FROM pg_database
		WHERE datistemplate = false
		ORDER BY datname
	`)
	if err != nil {
		return nil, fmt.Errorf("pg: list databases: %w", err)
	}
	defer rows.Close()

	out := make([]DatabaseInfo, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, DatabaseInfo{Name: name})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ListTables returns user-visible tables/views in the given database.
func (a *pgAdapter) ListTables(ctx context.Context, scope QueryScope) ([]TableInfo, error) {
	db := scope.Database
	if db == "" {
		db = a.profile.Database
	}
	if db == "" {
		return nil, fmt.Errorf("pg: ListTables requires database name")
	}
	pool, err := a.ensurePool(ctx, db)
	if err != nil {
		return nil, err
	}
	schema := scope.Schema
	if schema == "" {
		schema = a.profile.Schema
	}

	out := make([]TableInfo, 0)

	if schema != "" {
		rows, err := pool.Query(ctx, `
			SELECT table_name, table_type
			FROM information_schema.tables
			WHERE table_schema = $1
			ORDER BY table_name
		`, schema)
		if err == nil {
			for rows.Next() {
				var name, ttype string
				if err := rows.Scan(&name, &ttype); err != nil {
					rows.Close()
					return nil, err
				}
				switch ttype {
				case "BASE TABLE":
					ttype = "table"
				case "VIEW":
					ttype = "view"
				}
				out = append(out, TableInfo{Name: name, Type: ttype})
			}
			rows.Close()
		}
	}

	if len(out) == 0 {
		rows, err := pool.Query(ctx, `
			SELECT table_schema, table_name, table_type
			FROM information_schema.tables
			WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
			  AND table_schema NOT LIKE 'pg_toast%'
			  AND table_schema NOT LIKE 'pg_temp_%'
			ORDER BY table_schema, table_name
		`)
		if err != nil {
			return nil, fmt.Errorf("pg: list tables (fallback): %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var sname, tname, ttype string
			if err := rows.Scan(&sname, &tname, &ttype); err != nil {
				return nil, err
			}
			switch ttype {
			case "BASE TABLE":
				ttype = "table"
			case "VIEW":
				ttype = "view"
			}
			display := tname
			if sname != "public" {
				display = sname + "." + tname
			}
			out = append(out, TableInfo{Name: display, Type: ttype})
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	return out, nil
}

// ListColumns returns columns for a table in the given database/schema.
func (a *pgAdapter) ListColumns(ctx context.Context, scope QueryScope, table string) ([]ColumnInfo, error) {
	if table == "" {
		return []ColumnInfo{}, nil
	}
	db := scope.Database
	if db == "" {
		db = a.profile.Database
	}
	if db == "" {
		return nil, fmt.Errorf("pg: ListColumns requires database name")
	}
	pool, err := a.ensurePool(ctx, db)
	if err != nil {
		return nil, err
	}
	schema := scope.Schema
	if schema == "" {
		schema = a.profile.Schema
	}
	if schema == "" {
		schema = "public"
	}

	realSchema := schema
	if i := strings.LastIndex(table, "."); i >= 0 {
		realSchema = table[:i]
		table = table[i+1:]
	}

	rows, err := pool.Query(ctx, `
		SELECT column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = $1 AND table_name = $2
		ORDER BY ordinal_position
	`, realSchema, table)
	if err != nil {
		return nil, fmt.Errorf("pg: list columns: %w", err)
	}
	defer rows.Close()

	out := make([]ColumnInfo, 0)
	for rows.Next() {
		var name, dtype string
		if err := rows.Scan(&name, &dtype); err != nil {
			return nil, err
		}
		out = append(out, ColumnInfo{Name: name, Type: dtype})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ListTags returns an empty list for postgres.
func (a *pgAdapter) ListTags(ctx context.Context, scope QueryScope, table string) ([]TagInfo, error) {
	return []TagInfo{}, nil
}

func (a *pgAdapter) Query(ctx context.Context, req QueryRequest) (*QueryResult, error) {
	db := req.Database
	if db == "" {
		db = a.profile.Database
	}
	if db == "" {
		return nil, fmt.Errorf("pg: Query requires database name")
	}
	pool, err := a.ensurePool(ctx, db)
	if err != nil {
		return nil, err
	}

	queryText := req.Query
	if req.Limit > 0 && !hasLimitClause(queryText) {
		queryText = fmt.Sprintf("%s LIMIT %d", queryText, req.Limit)
	}

	qctx := ctx
	if a.profile.TimeoutSeconds > 0 {
		var cancel context.CancelFunc
		qctx, cancel = context.WithTimeout(ctx, time.Duration(a.profile.TimeoutSeconds)*time.Second)
		defer cancel()
	}

	rows, err := pool.Query(qctx, queryText)
	if err != nil {
		return nil, fmt.Errorf("pg: query: %w", err)
	}
	defer rows.Close()

	fdesc := rows.FieldDescriptions()
	cols := make([]string, len(fdesc))
	for i, f := range fdesc {
		cols[i] = string(f.Name)
	}

	colTypes := make([]uint32, len(fdesc))
	for i, f := range fdesc {
		colTypes[i] = f.DataTypeOID
	}

	displayCols := cols
	if len(req.SelectedColumns) > 0 {
		displayCols = req.SelectedColumns
	}
	displayIdx := make(map[string]int, len(displayCols))
	for i, c := range displayCols {
		displayIdx[c] = i
	}

	out := &QueryResult{
		Columns: displayCols,
		Rows:    make([][]any, 0),
	}

	values := make([]any, len(cols))
	scanTargets := make([]any, len(cols))
	for i := range values {
		values[i] = new(any)
		scanTargets[i] = values[i]
	}

	for rows.Next() {
		if err := rows.Scan(scanTargets...); err != nil {
			return nil, fmt.Errorf("pg: scan: %w", err)
		}

		row := make([]any, len(displayCols))
		for i, col := range cols {
			raw := *values[i].(*any)
			conv, err := pgToGo(raw, colTypes[i])
			if err != nil {
				conv = fmt.Sprintf("%v", raw)
			}
			if destIdx, ok := displayIdx[col]; ok {
				row[destIdx] = conv
			}
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pg: rows: %w", err)
	}

	out.Count = len(out.Rows)
	return out, nil
}

func hasLimitClause(q string) bool {
	lower := q
	for i := 0; i < len(lower); i++ {
		c := lower[i]
		if c >= 'A' && c <= 'Z' {
			lower = lower[:i] + string(c+32) + lower[i+1:]
		}
	}
	for i := 0; i+6 < len(lower); i++ {
		if lower[i] == ' ' && lower[i+1] == 'l' && lower[i+2] == 'i' && lower[i+3] == 'm' && lower[i+4] == 'i' && lower[i+5] == 't' {
			return true
		}
	}
	return false
}

func pgToGo(raw any, oid uint32) (any, error) {
	if raw == nil {
		return nil, nil
	}
	if t, ok := raw.(time.Time); ok {
		return t, nil
	}
	switch v := raw.(type) {
	case string, bool, int32, int64, float32, float64:
		return v, nil
	case []byte:
		return string(v), nil
	}
	return raw, nil
}
