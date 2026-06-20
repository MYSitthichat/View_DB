package export

import (
	"encoding/json"
	"os"
)

type JSONResult struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
	Count   int      `json:"count"`
}

func WriteJSON(filePath string, columns []string, rows [][]any, count int) error {
	f, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(JSONResult{Columns: columns, Rows: rows, Count: count})
}
