package config

import (
	"os"
	"path/filepath"
)

type Storage struct {
	Path string
}

func NewStorage(path string) *Storage {
	return &Storage{Path: path}
}

func (s *Storage) ReadFile() ([]byte, error) {
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func (s *Storage) WriteFile(data []byte) error {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.Path, data, 0o600)
}
