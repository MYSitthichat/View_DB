package influx

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"view-db/internal/connection"
)

type DatabaseInfo struct {
	Name string `json:"name"`
}

type QueryScope struct {
	Database string `json:"database"`
	Bucket   string `json:"bucket"`
	Org      string `json:"org"`
}

type MeasurementInfo struct {
	Name string `json:"name"`
}

type FieldInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type TagInfo struct {
	Name string `json:"name"`
}

type QueryRequest struct {
	ConnectionID string   `json:"connectionId"`
	Query        string   `json:"query"`
	Limit        int      `json:"limit"`
	Database     string   `json:"database"`
	// SelectedColumns is the canonical column set the caller expects. When
	// non-empty, adapters use it as the result's Columns (instead of
	// deriving from response data, which can vary across paginations).
	SelectedColumns []string `json:"selectedColumns,omitempty"`
}

type QueryResult struct {
	Columns []string
	Rows    [][]any
	Count   int
}

type InfluxAdapter interface {
	TestConnection(ctx context.Context) error
	ListDatabases(ctx context.Context) ([]DatabaseInfo, error)
	ListMeasurements(ctx context.Context, scope QueryScope) ([]MeasurementInfo, error)
	ListFields(ctx context.Context, scope QueryScope, measurement string) ([]FieldInfo, error)
	ListTags(ctx context.Context, scope QueryScope, measurement string) ([]TagInfo, error)
	Query(ctx context.Context, req QueryRequest) (*QueryResult, error)
	Close() error
}

func NewAdapter(profile connection.ConnectionProfile) InfluxAdapter {
	switch profile.Version {
	case connection.InfluxV1:
		return newV1Adapter(profile)
	case connection.InfluxV2:
		return newV2Adapter(profile)
	case connection.InfluxV3:
		return newV3Adapter(profile)
	default:
		return nil
	}
}

type unsupportedAdapter struct{ reason string }

func (a *unsupportedAdapter) TestConnection(context.Context) error                           { return errors.New(a.reason) }
func (a *unsupportedAdapter) ListDatabases(context.Context) ([]DatabaseInfo, error)           { return nil, errors.New(a.reason) }
func (a *unsupportedAdapter) ListMeasurements(context.Context, QueryScope) ([]MeasurementInfo, error) {
	return nil, errors.New(a.reason)
}
func (a *unsupportedAdapter) ListFields(context.Context, QueryScope, string) ([]FieldInfo, error) {
	return nil, errors.New(a.reason)
}
func (a *unsupportedAdapter) ListTags(context.Context, QueryScope, string) ([]TagInfo, error) {
	return nil, errors.New(a.reason)
}
func (a *unsupportedAdapter) Query(context.Context, QueryRequest) (*QueryResult, error) { return nil, errors.New(a.reason) }
func (a *unsupportedAdapter) Close() error                                               { return nil }

func limitQuery(query string, limit int) string {
	if limit <= 0 {
		return query
	}
	if strings.Contains(strings.ToLower(query), " limit ") {
		return query
	}
	return fmt.Sprintf("%s LIMIT %d", strings.TrimSpace(query), limit)
}
