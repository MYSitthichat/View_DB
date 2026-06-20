package export

import (
	"bufio"
	"encoding/json"
	"os"
)

// JSONResult is the standard JSON export envelope (everything in one
// array). Use WriteNDJSON for streaming-friendly format.
type JSONResult struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
	Count   int      `json:"count"`
}

// WriteJSON writes the result as a single pretty-printed JSON object.
// Uses a 64 KiB buffer to avoid per-byte syscalls.
func WriteJSON(filePath string, columns []string, rows [][]any, count int) error {
	f, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	bw := bufio.NewWriterSize(f, 64*1024)
	defer bw.Flush()

	enc := json.NewEncoder(bw)
	enc.SetIndent("", "  ")
	if err := enc.Encode(JSONResult{Columns: columns, Rows: rows, Count: count}); err != nil {
		return err
	}
	// Trailing newline (POSIX-friendly).
	_, _ = bw.WriteString("\n")
	return nil
}

// WriteNDJSON streams rows as newline-delimited JSON (one object per
// line). This format is unbounded — the encoder doesn't need to hold
// the full row array in memory for the file write path, which makes it
// suitable for very large exports. Each line is a self-contained JSON
// object with columns + values keyed by column name.
func WriteNDJSON(filePath string, columns []string, rows [][]any) error {
	f, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	bw := bufio.NewWriterSize(f, 64*1024)
	defer bw.Flush()

	// Header line: column list (so downstream tools can interpret values).
	header, err := json.Marshal(map[string]any{
		"type":    "header",
		"columns": columns,
		"version": 1,
	})
	if err != nil {
		return err
	}
	if _, err := bw.Write(header); err != nil {
		return err
	}
	if _, err := bw.WriteString("\n"); err != nil {
		return err
	}

	for _, row := range rows {
		obj := make(map[string]any, len(columns))
		for i, col := range columns {
			if i < len(row) {
				obj[col] = row[i]
			} else {
				obj[col] = nil
			}
		}
		line, err := json.Marshal(obj)
		if err != nil {
			return err
		}
		if _, err := bw.Write(line); err != nil {
			return err
		}
		if _, err := bw.WriteString("\n"); err != nil {
			return err
		}
	}
	return nil
}
