package logger

import (
	"log/slog"
	"os"
	"path/filepath"

	"view-db/internal/config"
)

var file *os.File

// Setup initializes the global slog logger to write to both stdout and a log file.
func Setup() error {
	appDir := config.GetAppDir()
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return err
	}

	logPath := filepath.Join(appDir, "app.log")
	var err error
	file, err = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o666)
	if err != nil {
		return err
	}

	// Use MultiWriter to write to both file and stdout
	multiWriter := &MultiWriter{writers: []*os.File{os.Stdout, file}}
	
	logger := slog.New(slog.NewTextHandler(multiWriter, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	
	slog.SetDefault(logger)
	return nil
}

// Close closes the log file
func Close() {
	if file != nil {
		file.Close()
	}
}

// MultiWriter writes to multiple files
type MultiWriter struct {
	writers []*os.File
}

func (m *MultiWriter) Write(p []byte) (n int, err error) {
	for _, w := range m.writers {
		n, err = w.Write(p)
		if err != nil {
			return
		}
	}
	return len(p), nil
}
