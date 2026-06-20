package influx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"view-db/internal/connection"
)

type v3Adapter struct {
	profile    connection.ConnectionProfile
	httpClient *http.Client
	baseURL    string
	queryURL   string
	token      string
	database   string
}

func newV3Adapter(profile connection.ConnectionProfile) Adapter {
	// Long client-side safety net only. Real timeout is enforced by the
	// request context (service.ExecuteQuery derives it from
	// profile.TimeoutSeconds). Setting http.Client.Timeout to the profile
	// value previously overrode the context deadline and broke long queries.
	safetyNet := 2 * time.Hour
	if t := profile.TimeoutSeconds; t > 0 {
		safetyNet = time.Duration(t) * time.Second * 4
		if safetyNet < time.Hour {
			safetyNet = time.Hour
		}
	}

	return &v3Adapter{
		profile:    profile,
		baseURL:    profile.URL,
		queryURL:   fmt.Sprintf("%s/api/v3/query_sql", profile.URL),
		token:      profile.Token,
		database:   profile.Database,
		httpClient: &http.Client{Timeout: safetyNet},
	}
}

func (a *v3Adapter) doQuery(ctx context.Context, sql string, db string) ([]map[string]any, error) {
	if db == "" {
		db = a.database
	}
	payload := map[string]string{
		"db":     db,
		"q":      sql,
		"format": "json",
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", a.queryURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	
	slog.Info("v3 doQuery starting", "url", a.queryURL, "db", db, "sql", sql, "has_token", a.token != "")
	if a.token != "" {
		tokenPreview := a.token
		if len(tokenPreview) > 8 {
			tokenPreview = fmt.Sprintf("%s...%s", tokenPreview[:4], tokenPreview[len(tokenPreview)-4:])
		}
		slog.Info("v3 authorization token info", "len", len(a.token), "preview", tokenPreview)
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", a.token))
	} else {
		slog.Warn("v3 doQuery: no token provided")
	}

	resp, err := a.httpClient.Do(req)
	if err != nil {
		slog.Error("v3 doQuery http request failed", "error", err)
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		slog.Error("v3 doQuery read response failed", "error", err)
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		slog.Error("v3 doQuery HTTP error response received", "status", resp.StatusCode, "body", string(respBody))
		var errObj struct {
			Message string `json:"message"`
			Error   string `json:"error"`
		}
		if err := json.Unmarshal(respBody, &errObj); err == nil {
			if errObj.Message != "" {
				return nil, fmt.Errorf("api error (status %d): %s", resp.StatusCode, errObj.Message)
			}
			if errObj.Error != "" {
				return nil, fmt.Errorf("api error (status %d): %s", resp.StatusCode, errObj.Error)
			}
		}
		return nil, fmt.Errorf("http error status %d: %s", resp.StatusCode, string(respBody))
	}

	var results []map[string]any
	if err := json.Unmarshal(respBody, &results); err != nil {
		slog.Error("v3 doQuery failed to parse JSON response", "error", err)
		return nil, fmt.Errorf("parse json response: %w", err)
	}

	slog.Info("v3 doQuery completed successfully", "rows", len(results))
	return results, nil
}

func (a *v3Adapter) TestConnection(ctx context.Context) error {
	if a.database == "" {
		req, err := http.NewRequestWithContext(ctx, "GET", a.baseURL+"/api/v3/configure/database", nil)
		if err != nil {
			return err
		}
		if a.token != "" {
			req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", a.token))
		}
		resp, err := a.httpClient.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("unauthorized or invalid server response: status %d", resp.StatusCode)
		}
		return nil
	}

	_, err := a.doQuery(ctx, "SELECT 1", a.database)
	return err
}

func (a *v3Adapter) ListDatabases(ctx context.Context) ([]DatabaseInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", a.baseURL+"/api/v3/configure/database", nil)
	if err != nil {
		return nil, err
	}
	if a.token != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", a.token))
	}

	resp, err := a.httpClient.Do(req)
	if err != nil {
		if a.database != "" {
			return []DatabaseInfo{{Name: a.database}}, nil
		}
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		if a.database != "" {
			return []DatabaseInfo{{Name: a.database}}, nil
		}
		return nil, fmt.Errorf("list databases api returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var databases []DatabaseInfo
	lines := strings.Split(string(body), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var item map[string]any
		if err := json.Unmarshal([]byte(line), &item); err == nil {
			if dbName, ok := item["iox::database"].(string); ok && dbName != "" {
				databases = append(databases, DatabaseInfo{Name: dbName})
			} else if name, ok := item["name"].(string); ok && name != "" {
				databases = append(databases, DatabaseInfo{Name: name})
			}
		}
	}

	if len(databases) == 0 {
		var array []map[string]any
		if err := json.Unmarshal(body, &array); err == nil {
			for _, item := range array {
				if dbName, ok := item["iox::database"].(string); ok && dbName != "" {
					databases = append(databases, DatabaseInfo{Name: dbName})
				} else if name, ok := item["name"].(string); ok && name != "" {
					databases = append(databases, DatabaseInfo{Name: name})
				}
			}
		}
	}

	if len(databases) == 0 && a.database != "" {
		return []DatabaseInfo{{Name: a.database}}, nil
	}

	return databases, nil
}

func (a *v3Adapter) ListMeasurements(ctx context.Context, scope QueryScope) ([]MeasurementInfo, error) {
	db := scope.Database
	if db == "" {
		db = a.database
	}
	if db == "" {
		return nil, fmt.Errorf("database is required to list measurements")
	}

	results, err := a.doQuery(ctx, "SHOW TABLES", db)
	if err != nil {
		return nil, err
	}

	var out []MeasurementInfo
	for _, row := range results {
		if schema, ok := row["table_schema"].(string); ok {
			if schema == "system" || schema == "information_schema" {
				continue
			}
		}
		if tblName, ok := row["table_name"].(string); ok && tblName != "" {
			if tblName == "influxdb_schema" {
				continue
			}
			out = append(out, MeasurementInfo{Name: tblName})
		}
	}
	return out, nil
}

func (a *v3Adapter) ListFields(ctx context.Context, scope QueryScope, measurement string) ([]FieldInfo, error) {
	if measurement == "" {
		return nil, fmt.Errorf("measurement name is required")
	}

	db := scope.Database
	if db == "" {
		db = a.database
	}

	query := fmt.Sprintf("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'iox' AND table_name = '%s'", measurement)
	results, err := a.doQuery(ctx, query, db)
	if err != nil {
		return nil, err
	}

	var out []FieldInfo
	for _, row := range results {
		colName, _ := row["column_name"].(string)
		dataType, _ := row["data_type"].(string)
		if colName == "" || colName == "time" {
			continue
		}
		isTag := strings.Contains(strings.ToLower(dataType), "dictionary")
		if !isTag {
			out = append(out, FieldInfo{Name: colName, Type: dataType})
		}
	}
	return out, nil
}

func (a *v3Adapter) ListTags(ctx context.Context, scope QueryScope, measurement string) ([]TagInfo, error) {
	if measurement == "" {
		return nil, fmt.Errorf("measurement name is required")
	}

	db := scope.Database
	if db == "" {
		db = a.database
	}

	query := fmt.Sprintf("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'iox' AND table_name = '%s'", measurement)
	results, err := a.doQuery(ctx, query, db)
	if err != nil {
		return nil, err
	}

	var out []TagInfo
	for _, row := range results {
		colName, _ := row["column_name"].(string)
		dataType, _ := row["data_type"].(string)
		if colName == "" || colName == "time" {
			continue
		}
		isTag := strings.Contains(strings.ToLower(dataType), "dictionary")
		if isTag {
			out = append(out, TagInfo{Name: colName})
		}
	}
	return out, nil
}

func (a *v3Adapter) Query(ctx context.Context, req QueryRequest) (*QueryResult, error) {
	queryText := localLimitQuery(req.Query, req.Limit)
	results, err := a.doQuery(ctx, queryText, req.Database)
	if err != nil {
		return nil, err
	}

	if len(results) == 0 {
		return &QueryResult{Columns: []string{}, Rows: [][]any{}, Count: 0}, nil
	}

	// Discover columns from ALL rows (some InfluxDB v3 responses return
	// rows with different key sets depending on data shape).
	hasTime := false
	colIdx := map[string]int{}
	cols := []string{}
	for _, row := range results {
		for k := range row {
			if _, ok := colIdx[k]; !ok {
				if k == "time" {
					hasTime = true
				} else {
					colIdx[k] = len(cols)
					cols = append(cols, k)
				}
			}
		}
	}

	// Inline bubble sort (standard library only).
	for i := 0; i < len(cols); i++ {
		for j := i + 1; j < len(cols); j++ {
			if cols[i] > cols[j] {
				cols[i], cols[j] = cols[j], cols[i]
			}
		}
	}

	if hasTime {
		cols = append([]string{"time"}, cols...)
	}

	// If the caller passed SelectedColumns (schema-discovered set), prefer it
	// as the canonical column order so pagination doesn't shift columns.
	if len(req.SelectedColumns) > 0 {
		cols = reorderWithCanonicalV3(cols, req.SelectedColumns)
	}

	// Build column index from final ordering.
	colIdx = map[string]int{}
	for i, c := range cols {
		colIdx[c] = i
	}

	rows := make([][]any, 0, len(results))
	for _, rowMap := range results {
		rowVals := make([]any, len(cols))
		for i, col := range cols {
			rowVals[i] = rowMap[col]
		}
		rows = append(rows, rowVals)
	}

	return &QueryResult{Columns: cols, Rows: rows, Count: len(rows)}, nil
}

// reorderWithCanonicalV3 reorders cols to match the order of canonical where
// possible, appending any extra cols the response had at the end.
func reorderWithCanonicalV3(cols []string, canonical []string) []string {
	existing := map[string]bool{}
	for _, c := range cols {
		existing[c] = true
	}
	out := make([]string, 0, len(canonical))
	seen := map[string]bool{}
	for _, c := range canonical {
		if existing[c] && !seen[c] {
			out = append(out, c)
			seen[c] = true
		}
	}
	for _, c := range cols {
		if !seen[c] {
			out = append(out, c)
		}
	}
	return out
}

func (a *v3Adapter) Close() error {
	a.httpClient.CloseIdleConnections()
	return nil
}
