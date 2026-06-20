package export

import (
	"encoding/csv"
	"fmt"
	"os"
)

func WriteCSV(filePath string, columns []string, rows [][]any) error {
	f, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	w := csv.NewWriter(f)
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
