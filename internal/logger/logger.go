// Package logger wraps log/slog so the rest of the app can call slog.Info
// while writes are mirrored to both stdout and a per-app log file. We
// also install a redaction handler that scrubs likely-secret values
// (passwords, tokens, DSN fragments) before they land on disk.
package logger

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"view-db/internal/config"
)

var file *os.File

// Setup initializes the global slog logger to write to both stdout and a
// log file. Output is filtered through RedactingHandler so credentials
// never reach the log even if a caller logs them by mistake.
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

	multiWriter := &MultiWriter{writers: []*os.File{os.Stdout, file}}

	base := slog.NewTextHandler(multiWriter, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})

	slog.SetDefault(slog.New(&RedactingHandler{inner: base}))
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

// RedactingHandler wraps another slog.Handler and redacts the values
// of attributes whose keys look like credentials. Recognised keys:
// password, token, secret, dsn, key. The handler also scans string values
// for embedded libpq-style password tokens and replaces them.
type RedactingHandler struct {
	inner slog.Handler
}

func (h *RedactingHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.inner.Enabled(ctx, l)
}

func (h *RedactingHandler) Handle(ctx context.Context, r slog.Record) error {
	out := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		out.AddAttrs(redactAttr(a))
		return true
	})
	return h.inner.Handle(ctx, out)
}

func (h *RedactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	redacted := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		redacted[i] = redactAttr(a)
	}
	return &RedactingHandler{inner: h.inner.WithAttrs(redacted)}
}

func (h *RedactingHandler) WithGroup(name string) slog.Handler {
	return &RedactingHandler{inner: h.inner.WithGroup(name)}
}

func redactAttr(a slog.Attr) slog.Attr {
	key := strings.ToLower(a.Key)
	if isSecretKey(key) {
		return slog.String(a.Key, "[REDACTED]")
	}
	if a.Value.Kind() == slog.KindString {
		v := a.Value.String()
		if looksLikeDsn(v) {
			return slog.String(a.Key, redactDsn(v))
		}
	}
	return a
}

var secretKeys = map[string]bool{
	"password":   true,
	"token":      true,
	"secret":     true,
	"dsn":        true,
	"key":        true,
	"apikey":     true,
	"api_key":    true,
	"credential": true,
}

func isSecretKey(k string) bool {
	return secretKeys[k] || strings.HasSuffix(k, "_password") || strings.HasSuffix(k, "_token") || strings.HasSuffix(k, "_key")
}

// looksLikeDsn returns true when the string contains a libpq keyword
// segment whose value we should mask.
func looksLikeDsn(s string) bool {
	if !strings.Contains(s, " ") && !strings.Contains(s, "://") {
		return false
	}
	for _, k := range []string{"password=", "sslpassword="} {
		if strings.Contains(strings.ToLower(s), k) {
			return true
		}
	}
	return false
}

func redactDsn(s string) string {
	// Mask "password=<value>" / "sslpassword=<value>" in libpq keyword form.
	// We track searchFrom so we don't re-find our own redaction marker.
	out := s
	searchFrom := 0
	for {
		lower := strings.ToLower(out[searchFrom:])
		idx := strings.Index(lower, "password=")
		if idx < 0 {
			break
		}
		absIdx := searchFrom + idx
		valueStart := absIdx + len("password=")
		end := len(out)
		for j := valueStart; j < len(out); j++ {
			c := out[j]
			if c == ' ' || c == '\t' {
				end = j
				break
			}
		}
		out = out[:valueStart] + "[REDACTED]" + out[end:]
		// Advance past the marker so the next iteration can't re-find it.
		searchFrom = valueStart + len("[REDACTED]")
	}

	// URI form: "scheme://user:pass@host" → "scheme://user:[REDACTED]@host"
	if i := strings.Index(out, "://"); i >= 0 {
		if j := strings.Index(out[i+3:], "@"); j >= 0 {
			authSeg := out[i+3 : i+3+j]
			if k := strings.Index(authSeg, ":"); k >= 0 {
				out = out[:i+3+k+1] + "[REDACTED]" + out[i+3+j:]
			}
		}
	}
	return out
}
