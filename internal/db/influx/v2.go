package influx

import (
	"context"
	"fmt"
	"strings"
	"time"

	influxdb2 "github.com/influxdata/influxdb-client-go/v2"
	"github.com/influxdata/influxdb-client-go/v2/api"

	"view-db/internal/connection"
)

type v2Adapter struct {
	profile connection.ConnectionProfile
	client  influxdb2.Client
	query   api.QueryAPI
}

func newV2Adapter(profile connection.ConnectionProfile) Adapter {
	client := influxdb2.NewClient(profile.URL, profile.Token)
	return &v2Adapter{
		profile: profile,
		client:  client,
		query:   client.QueryAPI(profile.Organization),
	}
}

func (a *v2Adapter) TestConnection(ctx context.Context) error {
	_, err := a.query.Query(ctx, "buckets() |> limit(n: 1)")
	return err
}

func (a *v2Adapter) ListDatabases(ctx context.Context) ([]DatabaseInfo, error) {
	buckets, err := a.client.BucketsAPI().GetBuckets(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]DatabaseInfo, 0, len(*buckets))
	for _, b := range *buckets {
		out = append(out, DatabaseInfo{Name: b.Name})
	}
	return out, nil
}

func (a *v2Adapter) ListMeasurements(ctx context.Context, scope QueryScope) ([]MeasurementInfo, error) {
	bucket := scope.Bucket
	if bucket == "" {
		bucket = a.profile.Bucket
	}
	// Schema discovery must NOT be limited to recent data, otherwise tables
	// that had no writes in the last hour appear empty. Use a wide range.
	flux := fmt.Sprintf(`from(bucket: %q) |> range(start: -100y) |> keep(columns: ["_measurement"]) |> distinct(column: "_measurement")`, bucket)
	iter, err := a.query.Query(ctx, flux)
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	rows := scanNames(*iter, "_measurement")
	out := make([]MeasurementInfo, 0, len(rows))
	for _, n := range rows {
		out = append(out, MeasurementInfo{Name: n})
	}
	return out, nil
}

func (a *v2Adapter) ListFields(ctx context.Context, scope QueryScope, measurement string) ([]FieldInfo, error) {
	bucket := scope.Bucket
	if bucket == "" {
		bucket = a.profile.Bucket
	}
	// Wide range so schema discovery returns full field list, not just the
	// fields written in the last hour. This fixes the symptom where wide
	// tables (e.g. VIBRATION_SENSOR with 46 fields) appear to have only the
	// few fields written recently.
	flux := fmt.Sprintf(`from(bucket: %q) |> range(start: -100y) |> filter(fn: (r) => r._measurement == %q) |> keep(columns: ["_field"]) |> distinct(column: "_field")`, bucket, measurement)
	iter, err := a.query.Query(ctx, flux)
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	rows := scanNames(*iter, "_field")
	out := make([]FieldInfo, 0, len(rows))
	for _, n := range rows {
		out = append(out, FieldInfo{Name: n, Type: "unknown"})
	}
	return out, nil
}

func (a *v2Adapter) ListTags(ctx context.Context, scope QueryScope, measurement string) ([]TagInfo, error) {
	bucket := scope.Bucket
	if bucket == "" {
		bucket = a.profile.Bucket
	}
	flux := fmt.Sprintf(`from(bucket: %q) |> range(start: -100y) |> filter(fn: (r) => r._measurement == %q) |> group() |> keys() |> distinct(column: "_value")`, bucket, measurement)
	iter, err := a.query.Query(ctx, flux)
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	rows := scanNames(*iter, "_value")
	out := make([]TagInfo, 0, len(rows))
	for _, n := range rows {
		if strings.HasPrefix(n, "_") {
			continue
		}
		out = append(out, TagInfo{Name: n})
	}
	return out, nil
}

func (a *v2Adapter) Query(ctx context.Context, req QueryRequest) (*QueryResult, error) {
	stmt := req.Query
	if req.Limit > 0 && !strings.Contains(strings.ToLower(stmt), "limit(") {
		stmt = fmt.Sprintf(`%s |> limit(n: %d)`, strings.TrimSpace(stmt), req.Limit)
	}
	iter, err := a.query.Query(ctx, stmt)
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	// Build the canonical column set.
	//
	// Critical for stability: Flux records omit keys whose value is NULL
	// (e.g. `Record().Values()` for a row missing field `val_z` won't have a
	// "val_z" key at all). If we derived columns from records, page 1 might
	// only see 6 fields (all NULL elsewhere) and page 4 might see 46 — a
	// wild UX where columns appear/disappear on pagination.
	//
	// When the caller passes SelectedColumns (the schema-discovered list),
	// we use it as the canonical set and only fill values that exist in the
	// record. Missing keys → nil. This guarantees stable columns.
	var columns []string
	if len(req.SelectedColumns) > 0 {
		columns = make([]string, len(req.SelectedColumns))
		copy(columns, req.SelectedColumns)
	}
	colIdx := map[string]int{}
	for i, c := range columns {
		colIdx[c] = i
	}

	rows := make([][]any, 0)
	for iter.Next() {
		values := iter.Record().Values()
		if len(columns) == 0 {
			// Fallback: no canonical set provided — discover columns from
			// this record (legacy behaviour).
			columns = make([]string, 0, len(values))
			for k := range values {
				colIdx[k] = len(columns)
				columns = append(columns, k)
			}
		}
		row := make([]any, len(columns))
		for k, v := range values {
			if i, ok := colIdx[k]; ok {
				row[i] = v
			}
		}
		rows = append(rows, row)
	}
	if iter.Err() != nil {
		return nil, iter.Err()
	}
	return &QueryResult{Columns: columns, Rows: rows, Count: len(rows)}, nil
}

func (a *v2Adapter) Close() error {
	a.client.Close()
	return nil
}

func scanNames(iter api.QueryTableResult, key string) []string {
	values := make([]string, 0)
	for iter.Next() {
		if v, ok := iter.Record().ValueByKey(key).(string); ok && v != "" {
			values = append(values, v)
		}
	}
	return values
}

func init() {
	_ = time.Second
}
