package main

import (
	"context"
	"fmt"
	"time"

	"view-db/internal/app"
	"view-db/internal/connection"
	q "view-db/internal/query"
)

func main() {
	svc := app.NewService()

	profile := connection.ConnectionUpsert{
		ID:             "local-demo",
		Name:           "Local Demo",
		Version:        connection.InfluxV1,
		URL:            "http://127.0.0.1:8086",
		Username:       "admin",
		Password:       "secret",
		Database:       "telegraf",
		TLSInsecure:    true,
		TimeoutSeconds: 30,
	}

	if err := svc.AddConnection(profile); err != nil {
		panic(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := svc.TestConnection(ctx, profile.ID); err != nil {
		fmt.Println("test connection failed:", err)
	} else {
		fmt.Println("connection ok")
	}

	result, err := svc.ExecuteQuery(ctx, q.QueryRequest{
		ConnectionID: profile.ID,
		Statement:    "SELECT * FROM cpu LIMIT 1",
		Limit:        1,
	})
	if err != nil {
		panic(err)
	}

	fmt.Printf("query result: columns=%v rows=%d\n", result.Columns, len(result.Rows))
}
