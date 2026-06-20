package influx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"view-db/internal/connection"
)

type v1Adapter struct {
	profile    connection.ConnectionProfile
	httpClient *http.Client
	pingClient *http.Client
	baseURL    string
	queryURL   string
	authUser   string
	authPass   string
}

func newV1Adapter(profile connection.ConnectionProfile) InfluxAdapter {
	timeout := time.Duration(profile.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}

	return &v1Adapter{
		profile:    profile,
		baseURL:    profile.URL,
		queryURL:   fmt.Sprintf("%s/query", profile.URL),
		authUser:   profile.Username,
		authPass:   profile.Password,
		httpClient: &http.Client{Timeout: timeout},
		pingClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// v1QueryResult maps the InfluxDB v1 JSON response.
type v1QueryResult struct {
	Results []v1Result `json:"results"`
}

type v1Result struct {
	StatementID int        `json:"statement_id"`
	Series      []v1Series `json:"series,omitempty"`
	Error       string     `json:"error,omitempty"`
}

type v1Series struct {
	Name    string            `json:"name"`
	Columns []string          `json:"columns"`
	Values  [][]interface{}   `json:"values"`
	Tags    map[string]string `json:"tags,omitempty"`
}

func (a *v1Adapter) doQuery(ctx context.Context, ql string, db string) (*v1QueryResult, error) {
	vals := url.Values{}
	vals.Set("q", ql)
	if db != "" {
		vals.Set("db", db)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", a.queryURL, bytes.NewBufferString(vals.Encode()))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if a.authUser != "" {
		req.SetBasicAuth(a.authUser, a.authPass)
	}

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	var result v1QueryResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(result.Results) == 0 {
		return &v1QueryResult{Results: []v1Result{{}}}, nil
	}
	if result.Results[0].Error != "" {
		return nil, fmt.Errorf("influxql error: %s", result.Results[0].Error)
	}
	return &result, nil
}

func (a *v1Adapter) TestConnection(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", a.baseURL+"/ping", nil)
	if err != nil {
		return fmt.Errorf("create ping: %w", err)
	}
	if a.authUser != "" {
		req.SetBasicAuth(a.authUser, a.authPass)
	}
	resp, err := a.pingClient.Do(req)
	if err != nil {
		return fmt.Errorf("ping failed: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("ping returned status %d", resp.StatusCode)
	}
	return nil
}

func (a *v1Adapter) ListDatabases(ctx context.Context) ([]DatabaseInfo, error) {
	res, err := a.doQuery(ctx, "SHOW DATABASES", "")
	if err != nil {
		return nil, err
	}
	if len(res.Results) == 0 || len(res.Results[0].Series) == 0 {
		return []DatabaseInfo{}, nil
	}
	series := res.Results[0].Series[0]
	out := make([]DatabaseInfo, 0, len(series.Values))
	for _, row := range series.Values {
		if len(row) > 0 {
			out = append(out, DatabaseInfo{Name: fmt.Sprint(row[0])})
		}
	}
	return out, nil
}

func (a *v1Adapter) ListMeasurements(ctx context.Context, scope QueryScope) ([]MeasurementInfo, error) {
	db := scope.Database
	if db == "" {
		db = a.profile.Database
	}
	if db == "" {
		return []MeasurementInfo{}, nil
	}
	dbEscaped := strings.ReplaceAll(db, "\"", "\\\"")
	res, err := a.doQuery(ctx, fmt.Sprintf("SHOW MEASUREMENTS ON \"%s\"", dbEscaped), db)
	if err != nil {
		return nil, err
	}
	if len(res.Results) == 0 || len(res.Results[0].Series) == 0 {
		return []MeasurementInfo{}, nil
	}
	series := res.Results[0].Series[0]
	out := make([]MeasurementInfo, 0, len(series.Values))
	for _, row := range series.Values {
		if len(row) > 0 {
			out = append(out, MeasurementInfo{Name: fmt.Sprint(row[0])})
		}
	}
	return out, nil
}

func (a *v1Adapter) ListFields(ctx context.Context, scope QueryScope, measurement string) ([]FieldInfo, error) {
	db := scope.Database
	if db == "" {
		db = a.profile.Database
	}
	if db == "" || measurement == "" {
		return []FieldInfo{}, nil
	}
	dbEscaped := strings.ReplaceAll(db, "\"", "\\\"")
	measEscaped := strings.ReplaceAll(measurement, "\"", "\\\"")
	res, err := a.doQuery(ctx, fmt.Sprintf("SHOW FIELD KEYS ON \"%s\" FROM \"%s\"", dbEscaped, measEscaped), db)
	if err != nil {
		return nil, err
	}
	if len(res.Results) == 0 || len(res.Results[0].Series) == 0 {
		return []FieldInfo{}, nil
	}
	series := res.Results[0].Series[0]
	out := make([]FieldInfo, 0, len(series.Values))
	for _, row := range series.Values {
		if len(row) >= 2 {
			out = append(out, FieldInfo{Name: fmt.Sprint(row[0]), Type: fmt.Sprint(row[1])})
		}
	}
	return out, nil
}

func (a *v1Adapter) ListTags(ctx context.Context, scope QueryScope, measurement string) ([]TagInfo, error) {
	db := scope.Database
	if db == "" {
		db = a.profile.Database
	}
	if db == "" || measurement == "" {
		return []TagInfo{}, nil
	}
	dbEscaped := strings.ReplaceAll(db, "\"", "\\\"")
	measEscaped := strings.ReplaceAll(measurement, "\"", "\\\"")
	res, err := a.doQuery(ctx, fmt.Sprintf("SHOW TAG KEYS ON \"%s\" FROM \"%s\"", dbEscaped, measEscaped), db)
	if err != nil {
		return nil, err
	}
	if len(res.Results) == 0 || len(res.Results[0].Series) == 0 {
		return []TagInfo{}, nil
	}
	series := res.Results[0].Series[0]
	out := make([]TagInfo, 0, len(series.Values))
	for _, row := range series.Values {
		if len(row) > 0 {
			out = append(out, TagInfo{Name: fmt.Sprint(row[0])})
		}
	}
	return out, nil
}

func (a *v1Adapter) Query(ctx context.Context, req QueryRequest) (*QueryResult, error) {
	queryText := limitQuery(req.Query, req.Limit)
	db := req.Database
	if db == "" {
		db = a.profile.Database
	}
	res, err := a.doQuery(ctx, queryText, db)
	if err != nil {
		return nil, err
	}
	if len(res.Results) == 0 || len(res.Results[0].Series) == 0 {
		return &QueryResult{Columns: []string{}, Rows: [][]any{}, Count: 0}, nil
	}

	merged := mergeV1Series(res.Results[0].Series)

	// If the caller passed SelectedColumns (e.g. the schema-discovered set),
	// prefer it as the canonical column order so columns stay stable across
	// paginations even when InfluxDB's series ordering shifts.
	if len(req.SelectedColumns) > 0 {
		merged = reorderWithCanonical(merged, req.SelectedColumns)
	}
	return merged, nil
}

// reorderWithCanonical returns a copy of qr with Columns set to canonical
// (preserving its order, only including columns that actually exist in qr),
// and pads each row so values align to that order. Missing values → nil.
func reorderWithCanonical(qr *QueryResult, canonical []string) *QueryResult {
	existing := make(map[string]int, len(qr.Columns))
	for i, c := range qr.Columns {
		existing[c] = i
	}

	keep := make([]string, 0, len(canonical))
	for _, c := range canonical {
		if _, ok := existing[c]; ok {
			keep = append(keep, c)
		}
	}
	// Append any columns the response had but canonical didn't (rare).
	for _, c := range qr.Columns {
		if !contains(keep, c) {
			keep = append(keep, c)
		}
	}

	keepIdx := make([]int, len(keep))
	for i, c := range keep {
		keepIdx[i] = existing[c]
	}

	rows := make([][]any, len(qr.Rows))
	for r, row := range qr.Rows {
		newRow := make([]any, len(keep))
		for i, src := range keepIdx {
			if src < len(row) {
				newRow[i] = row[src]
			}
		}
		rows[r] = newRow
	}
	return &QueryResult{Columns: keep, Rows: rows, Count: len(rows)}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// mergeV1Series unions columns across ALL series (InfluxDB v1 returns one
// series per tag combination, each with its own column subset) and pads rows
// from narrower series with nil so every row aligns to the same column set.
//
// Previously only series[0] was used, which caused queries on wide tables
// (e.g. VIBRATION_SENSOR with 46+ fields split across many series) to show
// only the columns of whichever series InfluxDB happened to put first for
// that LIMIT/OFFSET range — page 1 might show 6 columns, page 4 might show
// 46. Now every page shows the same complete column set.
func mergeV1Series(series []v1Series) *QueryResult {
	seen := map[string]struct{}{}
	allColumns := make([]string, 0)
	for _, s := range series {
		for _, c := range s.Columns {
			if _, ok := seen[c]; !ok {
				seen[c] = struct{}{}
				allColumns = append(allColumns, c)
			}
		}
	}

	colIdx := make(map[string]int, len(allColumns))
	for i, c := range allColumns {
		colIdx[c] = i
	}

	rows := make([][]any, 0)
	for _, s := range series {
		sColIdx := make(map[string]int, len(s.Columns))
		for i, c := range s.Columns {
			sColIdx[c] = i
		}
		for _, row := range s.Values {
			merged := make([]any, len(allColumns))
			for col, srcIdx := range sColIdx {
				if dstIdx, ok := colIdx[col]; ok && srcIdx < len(row) {
					merged[dstIdx] = row[srcIdx]
				}
			}
			rows = append(rows, merged)
		}
	}

	return &QueryResult{Columns: allColumns, Rows: rows, Count: len(rows)}
}

func (a *v1Adapter) Close() error {
	a.httpClient.CloseIdleConnections()
	a.pingClient.CloseIdleConnections()
	return nil
}

type errorAdapter struct{ reason string }

func (e *errorAdapter) TestConnection(context.Context) error { return fmt.Errorf(e.reason) }
func (e *errorAdapter) ListDatabases(context.Context) ([]DatabaseInfo, error) {
	return nil, fmt.Errorf(e.reason)
}
func (e *errorAdapter) ListMeasurements(context.Context, QueryScope) ([]MeasurementInfo, error) {
	return nil, fmt.Errorf(e.reason)
}
func (e *errorAdapter) ListFields(context.Context, QueryScope, string) ([]FieldInfo, error) {
	return nil, fmt.Errorf(e.reason)
}
func (e *errorAdapter) ListTags(context.Context, QueryScope, string) ([]TagInfo, error) {
	return nil, fmt.Errorf(e.reason)
}
func (e *errorAdapter) Query(context.Context, QueryRequest) (*QueryResult, error) {
	return nil, fmt.Errorf(e.reason)
}
func (e *errorAdapter) Close() error { return nil }
