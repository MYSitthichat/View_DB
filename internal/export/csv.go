// Package export writes query results to disk in CSV, JSON, or NDJSON
// formats. All writers are buffered (bufio.Writer) to avoid per-row
// syscalls on Windows, where each Write() is otherwise a syscall.
package export

import (
	"bufio"
	"encoding/csv"
	"fmt"
	"io"
	"os"
)

// MaxExportRows is the hard cap on rows per export. Larger result sets
// must be filtered / LIMIT'd before exporting. We surface a warning
// rather than fail silently so the user knows data was truncated.
const MaxExportRows = 500_000

// WriteCSV writes columns + rows to filePath as RFC 4180 CSV.
func WriteCSV(filePath string, columns []string, rows [][]any) error {
	return writeCSV(filePath, columns, rows, nil)
}

// WriteCSVCapped is like WriteCSV but emits a warning when the input
// is truncated to MaxExportRows.
func WriteCSVCapped(filePath string, columns []string, rows [][]any) (truncated bool, err error) {
	if len(rows) > MaxExportRows {
		rows = rows[:MaxExportRows]
		truncated = true
	}
	err = writeCSV(filePath, columns, rows, nil)
	return
}

func writeCSV(filePath string, columns []string, rows [][]any, closer io.Closer) error {
	f, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	// 64 KiB buffer: enough for ~64 typical CSV rows.
	bw := bufio.NewWriterSize(f, 64*1024)
	defer bw.Flush()

	w := csv.NewWriter(bw)
	if len(columns) > 0 {
		if err := w.Write(columns); err != nil {
			return err
		}
	}
	for _, row := range rows {
		rec := make([]string, 0, len(row))
		for _, cell := range row {
			rec = append(rec, fmt.Sprint(cell))
		}
		if err := w.Write(rec); err != nil {
			return err
		}
	}
	w.Flush()
	return w.Error()
}
