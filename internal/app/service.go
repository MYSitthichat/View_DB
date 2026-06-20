package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"view-db/internal/config"
	"view-db/internal/connection"
	"view-db/internal/db"
	"view-db/internal/db/influx"
	"view-db/internal/db/postgres"
	"view-db/internal/export"
	q "view-db/internal/query"
)

type Service struct {
	connections *connection.Manager
	secrets     *config.Secrets
	queries     *q.Manager
	qStorage    *q.Storage
}

func NewService() *Service {
	storagePath := defaultStoragePath()
	storage := connection.NewStorage(storagePath)
	manager := connection.NewManagerWithStorage(storage)
	_ = manager.Load()
	return &Service{
		connections: manager,
		secrets:     config.NewSecrets("view-db"),
		queries:     q.NewManager(q.ManagerOptions{MaxConcurrent: 4, MaxJobs: 100}),
		qStorage:    q.NewStorage(),
	}
}

func defaultStoragePath() string {
	appDir := config.GetAppDir()
	preferred := filepath.Join(appDir, "connections.json")
	if _, err := os.Stat(preferred); err == nil {
		return preferred
	}
	if _, err := os.Stat(legacyStoragePath()); err == nil {
		return legacyStoragePath()
	}
	return preferred
}

func legacyStoragePath() string { return filepath.Join(".", "data", "connections.json") }

func (s *Service) AddConnection(upsert connection.ConnectionUpsert) error {
	profile := upsert.Profile()
	if err := profile.Validate(); err != nil {
		return err
	}

	// Store secrets in OS keychain; keep a copy in-memory for this session.
	switch profile.Version {
	case connection.InfluxV1:
		if upsert.Password == "" {
			_ = s.secrets.DeleteConnectionPassword(profile.ID)
			profile.HasPassword = false
		} else if upsert.Password != "••••••••" {
			if err := s.secrets.SetConnectionPassword(profile.ID, upsert.Password); err != nil {
				return err
			}
			profile.Password = upsert.Password
			profile.HasPassword = true
		} else {
			if secret, err := s.secrets.GetConnectionPassword(profile.ID); err == nil {
				profile.Password = secret
				profile.HasPassword = true
			} else {
				profile.HasPassword = false
			}
		}
	case connection.InfluxV2, connection.InfluxV3:
		if upsert.Token == "" {
			_ = s.secrets.DeleteConnectionToken(profile.ID)
			profile.HasToken = false
		} else if upsert.Token != "••••••••" {
			if err := s.secrets.SetConnectionToken(profile.ID, upsert.Token); err != nil {
				return err
			}
			profile.Token = upsert.Token
			profile.HasToken = true
		} else {
			if secret, err := s.secrets.GetConnectionToken(profile.ID); err == nil {
				profile.Token = secret
				profile.HasToken = true
			} else {
				profile.HasToken = false
			}
		}
	case connection.InfluxPg:
		if upsert.Password == "" {
			_ = s.secrets.DeleteConnectionPassword(profile.ID)
			profile.HasPassword = false
		} else if upsert.Password != "••••••••" {
			if err := s.secrets.SetConnectionPassword(profile.ID, upsert.Password); err != nil {
				return err
			}
			profile.Password = upsert.Password
			profile.HasPassword = true
		} else {
			if secret, err := s.secrets.GetConnectionPassword(profile.ID); err == nil {
				profile.Password = secret
				profile.HasPassword = true
			} else {
				profile.HasPassword = false
			}
		}
	}

	return s.connections.Save(profile)
}

func (s *Service) ListConnections() []connection.ConnectionProfile {
	list := s.connections.List()
	for i := range list {
		p := &list[i]
		if _, err := s.secrets.GetConnectionPassword(p.ID); err == nil {
			p.HasPassword = true
		}
		if _, err := s.secrets.GetConnectionToken(p.ID); err == nil {
			p.HasToken = true
		}
	}
	return list
}

func (s *Service) DeleteConnection(id string) error {
	if id == "" {
		return fmt.Errorf("connection id is required")
	}
	// Best-effort secret cleanup.
	_ = s.secrets.DeleteConnectionPassword(id)
	_ = s.secrets.DeleteConnectionToken(id)
	if ok := s.connections.Delete(id); !ok {
		return fmt.Errorf("connection not found: %s", id)
	}
	return nil
}

func (s *Service) getAdapter(id string) (db.Adapter, error) {
	profile, ok := s.connections.Get(id)
	if !ok {
		return nil, fmt.Errorf("connection not found: %s", id)
	}

	slog.Info("getAdapter hydrating profile", "id", id, "name", profile.Name, "version", profile.Version, "has_token_in_profile", profile.Token != "", "profile_hasToken_flag", profile.HasToken)

	// Hydrate secrets for persisted connections.
	switch profile.Version {
	case connection.InfluxV1:
		if profile.Password == "" {
			secret, err := s.secrets.GetConnectionPassword(profile.ID)
			if err != nil {
				slog.Error("getAdapter failed to retrieve password from keyring", "id", profile.ID, "error", err)
			} else {
				// Use Debug level for secret-related metadata. The RedactingHandler
				// in internal/logger also strips any leaked secret, but it's better
				// not to log lengths in the first place at Info level.
				profile.Password = secret
				slog.Debug("getAdapter retrieved password from keyring", "id", profile.ID)
			}
		}
	case connection.InfluxV2, connection.InfluxV3:
		if profile.Token == "" {
			secret, err := s.secrets.GetConnectionToken(profile.ID)
			if err != nil {
				slog.Error("getAdapter failed to retrieve token from keyring", "id", profile.ID, "error", err)
			} else {
				profile.Token = secret
				slog.Debug("getAdapter retrieved token from keyring", "id", profile.ID)
			}
		} else {
			slog.Debug("getAdapter using existing in-memory profile token", "id", profile.ID)
		}
	case connection.InfluxPg:
		if profile.Password == "" {
			if secret, err := s.secrets.GetConnectionPassword(profile.ID); err == nil {
				profile.Password = secret
			}
		}
	}

	adapter, err := db.NewAdapter(profile)
	if err != nil {
		return nil, fmt.Errorf("unsupported connection version: %w", err)
	}
	return adapter, nil
}

func (s *Service) contextWithTimeout(ctx context.Context, timeoutSecs int) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	timeout := time.Duration(timeoutSecs) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return context.WithTimeout(ctx, timeout)
}

func (s *Service) TestConnection(ctx context.Context, id string) error {
	profile, ok := s.connections.Get(id)
	if !ok {
		return fmt.Errorf("connection not found: %s", id)
	}
	ctx, cancel := s.contextWithTimeout(ctx, profile.TimeoutSeconds)
	defer cancel()

	adapter, err := s.getAdapter(id)
	if err != nil {
		slog.Error("TestConnection failed to get adapter", "error", err, "id", id)
		return err
	}
	defer adapter.Close()
	return adapter.TestConnection(ctx)
}

func (s *Service) TestConnectionProfile(ctx context.Context, upsert connection.ConnectionUpsert) error {
	profile := upsert.Profile()
	if err := profile.Validate(); err != nil {
		return err
	}

	ctx, cancel := s.contextWithTimeout(ctx, profile.TimeoutSeconds)
	defer cancel()

	// Hydrate the credential secret from the upsert DTO directly or fallback to keyring.
	switch profile.Version {
	case connection.InfluxV1, connection.InfluxPg:
		// pg shares the password field with v1 (both use basic auth).
		if upsert.Password == "••••••••" && upsert.ID != "" {
			if secret, err := s.secrets.GetConnectionPassword(upsert.ID); err == nil {
				profile.Password = secret
			}
		} else {
			profile.Password = upsert.Password
		}
	case connection.InfluxV2, connection.InfluxV3:
		if upsert.Token == "••••••••" && upsert.ID != "" {
			if secret, err := s.secrets.GetConnectionToken(upsert.ID); err == nil {
				profile.Token = secret
			}
		} else {
			profile.Token = upsert.Token
		}
	}

	adapter, err := db.NewAdapter(profile)
	if err != nil {
		return fmt.Errorf("unsupported connection version: %w", err)
	}
	defer adapter.Close()
	return adapter.TestConnection(ctx)
}

func (s *Service) ListDatabases(ctx context.Context, id string) ([]db.DatabaseInfo, error) {
	profile, ok := s.connections.Get(id)
	if !ok {
		return nil, fmt.Errorf("connection not found: %s", id)
	}
	ctx, cancel := s.contextWithTimeout(ctx, profile.TimeoutSeconds)
	defer cancel()

	adapter, err := s.getAdapter(id)
	if err != nil {
		return nil, err
	}
	defer adapter.Close()
	return adapter.ListDatabases(ctx)
}

func (s *Service) ListDatabasesForProfile(ctx context.Context, upsert connection.ConnectionUpsert) ([]db.DatabaseInfo, error) {
	profile := upsert.Profile()
	if err := profile.Validate(); err != nil {
		return nil, err
	}

	ctx, cancel := s.contextWithTimeout(ctx, profile.TimeoutSeconds)
	defer cancel()

	switch profile.Version {
	case connection.InfluxV1, connection.InfluxPg:
		if upsert.Password == "••••••••" && upsert.ID != "" {
			if secret, err := s.secrets.GetConnectionPassword(upsert.ID); err == nil {
				profile.Password = secret
			}
		} else {
			profile.Password = upsert.Password
		}
	case connection.InfluxV2, connection.InfluxV3:
		if upsert.Token == "••••••••" && upsert.ID != "" {
			if secret, err := s.secrets.GetConnectionToken(upsert.ID); err == nil {
				profile.Token = secret
			}
		} else {
			profile.Token = upsert.Token
		}
	}

	adapter, err := db.NewAdapter(profile)
	if err != nil {
		return nil, fmt.Errorf("unsupported connection version: %w", err)
	}
	defer adapter.Close()
	return adapter.ListDatabases(ctx)
}

// ListMeasurements returns the list of "tables" available in a database.
// For InfluxDB connections these are measurements; for PostgreSQL these
// are user tables/views. The frontend uses the same shape regardless.
func (s *Service) ListMeasurements(ctx context.Context, id string, scope db.QueryScope) ([]influx.MeasurementInfo, error) {
	profile, ok := s.connections.Get(id)
	if !ok {
		return nil, fmt.Errorf("connection not found: %s", id)
	}
	ctx, cancel := s.contextWithTimeout(ctx, profile.TimeoutSeconds)
	defer cancel()

	adapter, err := s.getAdapter(id)
	if err != nil {
		return nil, err
	}
	defer adapter.Close()

	if profile.Version == connection.InfluxPg {
		pg, ok := db.PostgresSchemaAdapter(adapter)
		if !ok {
			return nil, fmt.Errorf("connection is not PostgreSQL")
		}
		tables, err := pg.ListTables(ctx, postgres.QueryScope{Database: scope.Database, Schema: scope.Schema})
		if err != nil {
			return nil, err
		}
		// Map pg TableInfo → influx MeasurementInfo so the frontend tree works
		// unchanged. Type is appended to Name for visibility ("users (view)").
		out := make([]influx.MeasurementInfo, 0, len(tables))
		for _, t := range tables {
			name := t.Name
			if t.Type != "" && t.Type != "table" {
				name = t.Name + " (" + t.Type + ")"
			}
			out = append(out, influx.MeasurementInfo{Name: name})
		}
		return out, nil
	}

	infl, ok := db.InfluxSchemaAdapter(adapter)
	if !ok {
		return nil, fmt.Errorf("connection is not InfluxDB")
	}
	return infl.ListMeasurements(ctx, influx.QueryScope{
		Database: scope.Database,
		Bucket:   scope.Bucket,
		Org:      scope.Org,
		Schema:   scope.Schema,
	})
}

// ListFields returns the list of "columns" available in a table.
// For InfluxDB these are field keys; for PostgreSQL these are columns.
func (s *Service) ListFields(ctx context.Context, id string, scope db.QueryScope, measurement string) ([]influx.FieldInfo, error) {
	profile, ok := s.connections.Get(id)
	if !ok {
		return nil, fmt.Errorf("connection not found: %s", id)
	}
	ctx, cancel := s.contextWithTimeout(ctx, profile.TimeoutSeconds)
	defer cancel()

	adapter, err := s.getAdapter(id)
	if err != nil {
		return nil, err
	}
	defer adapter.Close()

	if profile.Version == connection.InfluxPg {
		pg, ok := db.PostgresSchemaAdapter(adapter)
		if !ok {
			return nil, fmt.Errorf("connection is not PostgreSQL")
		}
		cols, err := pg.ListColumns(ctx, postgres.QueryScope{Database: scope.Database, Schema: scope.Schema}, measurement)
		if err != nil {
			return nil, err
		}
		out := make([]influx.FieldInfo, 0, len(cols))
		for _, c := range cols {
			out = append(out, influx.FieldInfo{Name: c.Name, Type: c.Type})
		}
		return out, nil
	}

	infl, ok := db.InfluxSchemaAdapter(adapter)
	if !ok {
		return nil, fmt.Errorf("connection is not InfluxDB")
	}
	return infl.ListFields(ctx, influx.QueryScope{
		Database: scope.Database,
		Bucket:   scope.Bucket,
		Org:      scope.Org,
		Schema:   scope.Schema,
	}, measurement)
}

// ListTags returns the list of "tag keys" available in a measurement.
// PostgreSQL has no equivalent concept, so this returns an empty list.
func (s *Service) ListTags(ctx context.Context, id string, scope db.QueryScope, measurement string) ([]influx.TagInfo, error) {
	profile, ok := s.connections.Get(id)
	if !ok {
		return nil, fmt.Errorf("connection not found: %s", id)
	}
	ctx, cancel := s.contextWithTimeout(ctx, profile.TimeoutSeconds)
	defer cancel()

	adapter, err := s.getAdapter(id)
	if err != nil {
		return nil, err
	}
	defer adapter.Close()

	if profile.Version == connection.InfluxPg {
		pg, ok := db.PostgresSchemaAdapter(adapter)
		if !ok {
			return nil, fmt.Errorf("connection is not PostgreSQL")
		}
		pgTags, err := pg.ListTags(ctx, postgres.QueryScope{Database: scope.Database, Schema: scope.Schema}, measurement)
		if err != nil {
			return nil, err
		}
		out := make([]influx.TagInfo, 0, len(pgTags))
		for _, t := range pgTags {
			out = append(out, influx.TagInfo{Name: t.Name})
		}
		return out, nil
	}

	infl, ok := db.InfluxSchemaAdapter(adapter)
	if !ok {
		return nil, fmt.Errorf("connection is not InfluxDB")
	}
	return infl.ListTags(ctx, influx.QueryScope{
		Database: scope.Database,
		Bucket:   scope.Bucket,
		Org:      scope.Org,
		Schema:   scope.Schema,
	}, measurement)
}

func (s *Service) ExecuteQuery(ctx context.Context, req q.QueryRequest) (q.QueryResult, error) {
	adapter, err := s.getAdapter(req.ConnectionID)
	if err != nil {
		slog.Error("ExecuteQuery failed to get adapter", "error", err, "connection_id", req.ConnectionID)
		return q.QueryResult{}, err
	}
	defer adapter.Close()

	req = q.ApplyDefaultLimit(req)

	// Apply timeout if provided.
	if req.Timeout > 0 {
		ctx2, cancel := context.WithTimeout(ctx, req.Timeout)
		defer cancel()
		ctx = ctx2
	} else if _, ok := ctx.Deadline(); !ok {
		ctx2, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		ctx = ctx2
	}

	result, err := adapter.Query(ctx, db.QueryRequest{
		ConnectionID:    req.ConnectionID,
		Query:           req.Statement,
		Limit:           req.Limit,
		Database:        req.Database,
		SelectedColumns: req.SelectedColumns,
	})
	
	// Record History
	status := "success"
	if err != nil {
		status = "failed"
	}
	s.appendQueryHistory(q.QueryHistoryItem{
		ID:           fmt.Sprintf("hist-%d", time.Now().UnixNano()),
		Timestamp:    time.Now(),
		ConnectionID: req.ConnectionID,
		Database:     req.Database,
		Statement:    req.Statement,
		Status:       status,
	})

	if err != nil {
		slog.Error("ExecuteQuery adapter query failed", "error", err, "connection_id", req.ConnectionID)
		return q.QueryResult{}, err
	}
	slog.Info("Executed query successfully", "connection_id", req.ConnectionID, "rows", len(result.Rows))
	return q.QueryResult{Columns: result.Columns, Rows: result.Rows, Count: result.Count}, nil
}

func (s *Service) StartQuery(req q.QueryRequest) (string, error) {
	if req.ConnectionID == "" {
		return "", fmt.Errorf("connection id is required")
	}
	if _, ok := s.connections.Get(req.ConnectionID); !ok {
		return "", fmt.Errorf("connection not found: %s", req.ConnectionID)
	}
	return s.queries.Start(req, func(ctx context.Context, r q.QueryRequest) (q.QueryResult, error) {
		return s.ExecuteQuery(ctx, r)
	})
}

func (s *Service) GetQuery(id string) (q.QueryJob, error) {
	job, ok := s.queries.Get(id)
	if !ok {
		return q.QueryJob{}, fmt.Errorf("query not found: %s", id)
	}
	return job, nil
}

func (s *Service) CancelQuery(id string) error {
	if id == "" {
		return fmt.Errorf("query id is required")
	}
	if ok := s.queries.Cancel(id); !ok {
		return fmt.Errorf("query not found: %s", id)
	}
	return nil
}

// ExportQueryCSV streams the query result to filePath as RFC 4180 CSV.
// Rows exceeding export.MaxExportRows are truncated and a warning is
// logged so the user knows data was clipped.
func (s *Service) ExportQueryCSV(queryID, filePath string) error {
	if filePath == "" {
		return fmt.Errorf("file path is required")
	}
	job, err := s.GetQuery(queryID)
	if err != nil {
		return err
	}
	if job.Status != q.JobSuccess || job.Result == nil {
		return fmt.Errorf("query is not completed")
	}
	truncated, err := export.WriteCSVCapped(filePath, job.Result.Columns, job.Result.Rows)
	if truncated {
		slog.Warn("ExportQueryCSV truncated to MaxExportRows", "query_id", queryID, "max", export.MaxExportRows)
	}
	return err
}

// ExportQueryJSON writes the full result as a pretty-printed JSON envelope.
func (s *Service) ExportQueryJSON(queryID, filePath string) error {
	if filePath == "" {
		return fmt.Errorf("file path is required")
	}
	job, err := s.GetQuery(queryID)
	if err != nil {
		return err
	}
	if job.Status != q.JobSuccess || job.Result == nil {
		return fmt.Errorf("query is not completed")
	}
	return export.WriteJSON(filePath, job.Result.Columns, job.Result.Rows, job.Result.Count)
}

// ExportQueryNDJSON streams rows as newline-delimited JSON (one object
// per line, with a leading header line carrying column names). Use this
// for very large exports that don't fit comfortably in a single JSON
// document.
func (s *Service) ExportQueryNDJSON(queryID, filePath string) error {
	if filePath == "" {
		return fmt.Errorf("file path is required")
	}
	job, err := s.GetQuery(queryID)
	if err != nil {
		return err
	}
	if job.Status != q.JobSuccess || job.Result == nil {
		return fmt.Errorf("query is not completed")
	}
	return export.WriteNDJSON(filePath, job.Result.Columns, job.Result.Rows)
}

func (s *Service) appendQueryHistory(item q.QueryHistoryItem) {
	history, _ := s.qStorage.ReadHistory()
	history = append([]q.QueryHistoryItem{item}, history...)
	if len(history) > 100 {
		history = history[:100]
	}
	_ = s.qStorage.WriteHistory(history)
}

func (s *Service) GetQueryHistory() ([]q.QueryHistoryItem, error) {
	return s.qStorage.ReadHistory()
}

func (s *Service) ClearQueryHistory() error {
	return s.qStorage.WriteHistory([]q.QueryHistoryItem{})
}

func (s *Service) ListSavedQueries() ([]q.SavedQuery, error) {
	return s.qStorage.ReadSavedQueries()
}

func (s *Service) SaveQuery(query q.SavedQuery) error {
	queries, _ := s.qStorage.ReadSavedQueries()
	// Replace if exists
	found := false
	for i, q := range queries {
		if q.ID == query.ID {
			queries[i] = query
			found = true
			break
		}
	}
	if !found {
		queries = append(queries, query)
	}
	return s.qStorage.WriteSavedQueries(queries)
}

func (s *Service) DeleteSavedQuery(id string) error {
	queries, _ := s.qStorage.ReadSavedQueries()
	filtered := []q.SavedQuery{}
	for _, q := range queries {
		if q.ID != id {
			filtered = append(filtered, q)
		}
	}
	return s.qStorage.WriteSavedQueries(filtered)
}
