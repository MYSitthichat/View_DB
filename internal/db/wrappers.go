package db

import (
	"context"

	"view-db/internal/db/influx"
	"view-db/internal/db/postgres"
)

// This file provides wrapper adapters that bridge each backend's local
// types (which can't import "internal/db" because of import cycle) to the
// unified Adapter interface used by the rest of the app.

// influxWrapper adapts influx.Adapter → Adapter by translating DTO types.
type influxWrapper struct {
	a influx.Adapter
}

func (w *influxWrapper) TestConnection(ctx context.Context) error {
	return w.a.TestConnection(ctx)
}
func (w *influxWrapper) ListDatabases(ctx context.Context) ([]DatabaseInfo, error) {
	in, err := w.a.ListDatabases(ctx)
	if err != nil {
		return nil, err
	}
	return convertDB(in), nil
}
func (w *influxWrapper) Query(ctx context.Context, req QueryRequest) (*QueryResult, error) {
	r, err := w.a.Query(ctx, influx.QueryRequest{
		ConnectionID:    req.ConnectionID,
		Query:           req.Query,
		Database:        req.Database,
		Schema:          req.Schema,
		Limit:           req.Limit,
		SelectedColumns: req.SelectedColumns,
	})
	if err != nil {
		return nil, err
	}
	return convertQR(r), nil
}
func (w *influxWrapper) Close() error { return w.a.Close() }

// InfluxSchemaAdapter returns the underlying influx.Adapter so callers can
// access influx-specific metadata methods (ListMeasurements, ListFields, ...).
func InfluxSchemaAdapter(a Adapter) (influx.Adapter, bool) {
	w, ok := a.(*influxWrapper)
	if !ok {
		return nil, false
	}
	return w.a, true
}

// postgresWrapper adapts postgres.Adapter → Adapter.
type postgresWrapper struct {
	a postgres.Adapter
}

func (w *postgresWrapper) TestConnection(ctx context.Context) error {
	return w.a.TestConnection(ctx)
}
func (w *postgresWrapper) ListDatabases(ctx context.Context) ([]DatabaseInfo, error) {
	in, err := w.a.ListDatabases(ctx)
	if err != nil {
		return nil, err
	}
	return convertDBpg(in), nil
}
func (w *postgresWrapper) Query(ctx context.Context, req QueryRequest) (*QueryResult, error) {
	r, err := w.a.Query(ctx, postgres.QueryRequest{
		ConnectionID:    req.ConnectionID,
		Query:           req.Query,
		Database:        req.Database,
		Schema:          req.Schema,
		Limit:           req.Limit,
		SelectedColumns: req.SelectedColumns,
	})
	if err != nil {
		return nil, err
	}
	return convertQRpg(r), nil
}
func (w *postgresWrapper) Close() error { return w.a.Close() }

// PostgresSchemaAdapter returns the underlying postgres.Adapter so callers
// can access pg-specific methods (ListTables, ListColumns, ...).
func PostgresSchemaAdapter(a Adapter) (postgres.Adapter, bool) {
	w, ok := a.(*postgresWrapper)
	if !ok {
		return nil, false
	}
	return w.a, true
}

func convertDB(in []influx.DatabaseInfo) []DatabaseInfo {
	out := make([]DatabaseInfo, len(in))
	for i, d := range in {
		out[i] = DatabaseInfo{Name: d.Name}
	}
	return out
}

func convertDBpg(in []postgres.DatabaseInfo) []DatabaseInfo {
	out := make([]DatabaseInfo, len(in))
	for i, d := range in {
		out[i] = DatabaseInfo{Name: d.Name}
	}
	return out
}

func convertQR(r *influx.QueryResult) *QueryResult {
	if r == nil {
		return &QueryResult{Columns: []string{}, Rows: [][]any{}, Count: 0}
	}
	cols := r.Columns
	if cols == nil {
		cols = []string{}
	}
	rows := r.Rows
	if rows == nil {
		rows = [][]any{}
	}
	return &QueryResult{Columns: cols, Rows: rows, Count: r.Count}
}

func convertQRpg(r *postgres.QueryResult) *QueryResult {
	if r == nil {
		return &QueryResult{Columns: []string{}, Rows: [][]any{}, Count: 0}
	}
	cols := r.Columns
	if cols == nil {
		cols = []string{}
	}
	rows := r.Rows
	if rows == nil {
		rows = [][]any{}
	}
	return &QueryResult{Columns: cols, Rows: rows, Count: r.Count}
}
