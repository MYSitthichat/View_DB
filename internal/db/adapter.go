// Package db defines the unified DatabaseAdapter interface used by every
// supported backend (InfluxDB v1/v2/v3, PostgreSQL, ...).
//
// Adapter implementations live in subpackages (e.g. db/influx, db/postgres).
// The factory function NewAdapter dispatches by connection profile version.
package db

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"view-db/internal/connection"
	"view-db/internal/db/influx"
	"view-db/internal/db/postgres"
)

// Adapter is the minimum surface every database backend must implement.
// Backends may expose additional methods via type assertion if needed
// (e.g. influx-specific metadata helpers).
type Adapter interface {
	// TestConnection verifies credentials and connectivity.
	TestConnection(ctx context.Context) error

	// ListDatabases returns all databases/buckets the user can access.
	ListDatabases(ctx context.Context) ([]DatabaseInfo, error)

	// Query runs a SQL/Flux/InfluxQL statement and returns columns + rows.
	// Implementations should honour req.Limit, req.SelectedColumns, and ctx deadline.
	Query(ctx context.Context, req QueryRequest) (*QueryResult, error)

	// Close releases any held resources (connection pools, clients, ...).
	Close() error
}

// DatabaseInfo is the lightweight metadata used by the UI's database list.
type DatabaseInfo struct {
	Name string `json:"name"`
}

// QueryRequest carries everything an adapter needs to execute a single
// statement. SelectedColumns is the canonical column set; backends that
// normally derive columns from response data (Flux, V3 JSON) should use
// this so columns stay stable across paginations.
type QueryRequest struct {
	ConnectionID    string   `json:"connectionId"`
	Query           string   `json:"query"`
	Database        string   `json:"database"`
	Schema          string   `json:"schema,omitempty"`
	Limit           int      `json:"limit"`
	SelectedColumns []string `json:"selectedColumns,omitempty"`
}

// QueryResult is the wire-format result that flows back to the frontend.
// Rows is a 2D slice of opaque values (strings, numbers, bools, time.Time).
type QueryResult struct {
	Columns []string
	Rows    [][]any
	Count   int
}

// QueryScope is used by adapters that distinguish "container" from "namespace"
// (e.g. InfluxDB: bucket vs database; PostgreSQL: database vs schema).
// Adapters that don't need this can ignore it.
type QueryScope struct {
	Database string `json:"database"`
	Bucket   string `json:"bucket"`
	Org      string `json:"org"`
	Schema   string `json:"schema,omitempty"`
}

// NewAdapter dispatches a profile to the right adapter implementation.
// Returns a descriptive error for unknown versions.
func NewAdapter(profile connection.ConnectionProfile) (Adapter, error) {
	switch profile.Version {
	case connection.InfluxV1, connection.InfluxV2, connection.InfluxV3:
		a := influx.NewAdapter(profile)
		if a == nil {
			return nil, fmt.Errorf("unsupported influx version: %s", profile.Version)
		}
		return &influxWrapper{a: a}, nil
	case connection.InfluxPg:
		a, err := postgres.NewAdapter(profile)
		if err != nil {
			return nil, err
		}
		return &postgresWrapper{a: a}, nil
	default:
		return nil, fmt.Errorf("unsupported connection version: %s", profile.Version)
	}
}

// LimitQuery appends " LIMIT n" to a query that doesn't already have one.
// Subpackages call this helper to keep limit semantics consistent.
func LimitQuery(query string, limit int) string {
	if limit <= 0 {
		return query
	}
	if strings.Contains(strings.ToLower(query), " limit ") {
		return query
	}
	return fmt.Sprintf("%s LIMIT %d", strings.TrimSpace(query), limit)
}

// ErrUnsupported is returned by adapter stubs when a backend doesn't
// implement a particular metadata helper.
var ErrUnsupported = errors.New("operation not supported by this backend")
