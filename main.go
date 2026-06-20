package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"view-db/internal/app"
	"view-db/internal/connection"
	"view-db/internal/db"
	"view-db/internal/db/influx"
	"view-db/internal/logger"
	q "view-db/internal/query"
)

//go:embed frontend/dist
var assets embed.FS

type DesktopApp struct {
	ctx context.Context
	svc *app.Service
}

func NewDesktopApp() *DesktopApp { return &DesktopApp{svc: app.NewService()} }

func (d *DesktopApp) startup(ctx context.Context) {
	d.ctx = ctx
}
func (d *DesktopApp) AddConnection(profile connection.ConnectionUpsert) error {
	return d.svc.AddConnection(profile)
}
func (d *DesktopApp) ListConnections() []connection.ConnectionProfile { return d.svc.ListConnections() }
func (d *DesktopApp) TestConnection(id string) error {
	return d.svc.TestConnection(context.Background(), id)
}
func (d *DesktopApp) TestConnectionProfile(profile connection.ConnectionUpsert) error {
	return d.svc.TestConnectionProfile(context.Background(), profile)
}
func (d *DesktopApp) ExecuteQuery(req q.QueryRequest) (q.QueryResult, error) {
	return d.svc.ExecuteQuery(context.Background(), req)
}
func (d *DesktopApp) StartQuery(req q.QueryRequest) (string, error) { return d.svc.StartQuery(req) }
func (d *DesktopApp) GetQuery(id string) (q.QueryJob, error)        { return d.svc.GetQuery(id) }
func (d *DesktopApp) CancelQuery(id string) error                   { return d.svc.CancelQuery(id) }
func (d *DesktopApp) DeleteConnection(id string) error              { return d.svc.DeleteConnection(id) }
func (d *DesktopApp) ExportQueryCSV(queryID string) (string, error) {
	if d.ctx == nil {
		return "", fmt.Errorf("app context not ready")
	}
	path, err := runtime.SaveFileDialog(d.ctx, runtime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("view-db-%s.csv", queryID),
		Filters:         []runtime.FileFilter{{DisplayName: "CSV", Pattern: "*.csv"}},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := d.svc.ExportQueryCSV(queryID, path); err != nil {
		return "", err
	}
	return path, nil
}

func (d *DesktopApp) ExportQueryJSON(queryID string) (string, error) {
	if d.ctx == nil {
		return "", fmt.Errorf("app context not ready")
	}
	path, err := runtime.SaveFileDialog(d.ctx, runtime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("view-db-%s.json", queryID),
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON (single object)", Pattern: "*.json"},
			{DisplayName: "NDJSON (one row per line, large datasets)", Pattern: "*.ndjson"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	// Choose writer based on file extension. NDJSON is preferred for
	// large exports because each row is written independently and the
	// result rows stay out of the output buffer.
	if strings.HasSuffix(strings.ToLower(path), ".ndjson") {
		if err := d.svc.ExportQueryNDJSON(queryID, path); err != nil {
			return "", err
		}
	} else {
		if err := d.svc.ExportQueryJSON(queryID, path); err != nil {
			return "", err
		}
	}
	return path, nil
}
func (d *DesktopApp) ListDatabases(id string) ([]db.DatabaseInfo, error) {
	return d.svc.ListDatabases(context.Background(), id)
}
func (d *DesktopApp) ListDatabasesForProfile(profile connection.ConnectionUpsert) ([]db.DatabaseInfo, error) {
	return d.svc.ListDatabasesForProfile(context.Background(), profile)
}
func (d *DesktopApp) ListMeasurements(id string, scope db.QueryScope) ([]influx.MeasurementInfo, error) {
	return d.svc.ListMeasurements(context.Background(), id, scope)
}
func (d *DesktopApp) ListFields(id string, scope db.QueryScope, measurement string) ([]influx.FieldInfo, error) {
	return d.svc.ListFields(context.Background(), id, scope, measurement)
}
func (d *DesktopApp) ListTags(id string, scope db.QueryScope, measurement string) ([]influx.TagInfo, error) {
	return d.svc.ListTags(context.Background(), id, scope, measurement)
}

func (d *DesktopApp) GetQueryHistory() ([]q.QueryHistoryItem, error) { return d.svc.GetQueryHistory() }
func (d *DesktopApp) ClearQueryHistory() error                       { return d.svc.ClearQueryHistory() }
func (d *DesktopApp) ListSavedQueries() ([]q.SavedQuery, error)      { return d.svc.ListSavedQueries() }
func (d *DesktopApp) SaveQuery(query q.SavedQuery) error             { return d.svc.SaveQuery(query) }
func (d *DesktopApp) DeleteSavedQuery(id string) error               { return d.svc.DeleteSavedQuery(id) }

func main() {
	if err := logger.Setup(); err != nil {
		log.Printf("failed to setup logger: %v", err)
	}
	defer logger.Close()

	app := NewDesktopApp()
	if err := wails.Run(&options.App{
		Title:       "view-db",
		Width:       1440,
		Height:      960,
		AssetServer: &assetserver.Options{Assets: assets},
		Bind:        []interface{}{app},
		OnStartup:   app.startup,
	}); err != nil {
		log.Fatal(err)
	}
}
