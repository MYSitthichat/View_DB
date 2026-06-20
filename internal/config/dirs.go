package config

import (
	"os"
	"path/filepath"
)

// GetAppDir returns the path to the application data directory.
func GetAppDir() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "view-db")
	}
	return filepath.Join(".", "data")
}
