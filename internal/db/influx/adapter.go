// Package influx implements the db.Adapter contract for InfluxDB v1/v2/v3.
// Each version has its own struct (v1Adapter, v2Adapter, v3Adapter) that
// implements Adapter (common surface) and Adapter (influx-specific metadata).
//
// Note: This package deliberately does NOT import "view-db/internal/db" — that
// would create an import cycle (db.NewAdapter imports us, we'd import db).
// Conformance with db.Adapter is checked at runtime in db.NewAdapter via the
// returned interface type.
package influx

import (
	"context"
	"fmt"

	"view-db/internal/connection"
)

// MeasurementInfo describes a measurement (InfluxDB equivalent of a table).
type MeasurementInfo struct {
	Name string `json:"name"`
}

// FieldInfo describes a field within a measurement.
type FieldInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// TagInfo describes a tag key for a measurement.
type TagInfo struct {
	Name string `json:"name"`
}

// QueryScope is the influx-specific scope (database/bucket/org) used by
// metadata helpers. Mirrors db.QueryScope's JSON shape so the wire format
// stays identical.
type QueryScope struct {
	Database string `json:"database"`
	Bucket   string `json:"bucket"`
	Org      string `json:"org"`
	Schema   string `json:"schema,omitempty"`
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

// Adapter is the contract every InfluxDB backend (v1/v2/v3) must satisfy.
// The same shape is enforced on the db.Adapter interface but duplicated here
// to avoid the import cycle. db.NewAdapter relies on the returned value
// satisfying both interfaces (verified by assignment).
type Adapter interface {
	TestConnection(ctx context.Context) error
	ListDatabases(ctx context.Context) ([]DatabaseInfo, error)
	Query(ctx context.Context, req QueryRequest) (*QueryResult, error)
	Close() error
	// InfluxDB-specific metadata helpers (schema browser).
	ListMeasurements(ctx context.Context, scope QueryScope) ([]MeasurementInfo, error)
	ListFields(ctx context.Context, scope QueryScope, measurement string) ([]FieldInfo, error)
	ListTags(ctx context.Context, scope QueryScope, measurement string) ([]TagInfo, error)
}

// DatabaseInfo mirrors db.DatabaseInfo's wire shape (name only).
type DatabaseInfo struct {
	Name string `json:"name"`
}

// NewAdapter returns the correct InfluxAdapter implementation for a given
// profile.Version (InfluxV1/V2/V3). Returns nil for unknown versions.
func NewAdapter(profile connection.ConnectionProfile) Adapter {
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

// AsDBAdapter wraps an influx.Adapter into a value that implements db.Adapter
// by adapting each call's argument/return types. Defined in db package's
// factory (see db/adapter.go) to keep this package cycle-free.
//
// This helper exists only to keep the package documentation focused — the
// actual adapter is in db/adapter.go.
var _ = fmt.Sprintf
