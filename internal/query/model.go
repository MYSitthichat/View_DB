package query

import "time"

type QueryRequest struct {
	ConnectionID    string        `json:"connectionId"`
	Statement       string        `json:"statement"`
	Database        string        `json:"database"`
	Bucket          string        `json:"bucket"`
	Organization    string        `json:"organization"`
	Limit           int           `json:"limit"`
	Timeout         time.Duration `json:"timeout"`
	// SelectedColumns is the canonical column set the caller expects back.
	// Adapters that derive columns from response data (Flux / V3) use this
	// instead so columns stay stable across paginations and row subsets.
	SelectedColumns []string `json:"selectedColumns,omitempty"`
}

type QueryResult struct {
	Columns []string  `json:"columns"`
	Rows    [][]any   `json:"rows"`
	Count   int       `json:"count"`
}

type SavedQuery struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database,omitempty"`
	Statement    string `json:"statement"`
}

type QueryHistoryItem struct {
	ID           string    `json:"id"`
	Timestamp    time.Time `json:"timestamp"`
	ConnectionID string    `json:"connectionId"`
	Database     string    `json:"database,omitempty"`
	Statement    string    `json:"statement"`
	Status       string    `json:"status"` // "success", "failed"
}
