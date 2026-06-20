package connection

import (
	"encoding/json"
	"os"

	"view-db/internal/config"
)

type Storage struct {
	backend *config.Storage
}

func NewStorage(path string) *Storage {
	return &Storage{backend: config.NewStorage(path)}
}

func (s *Storage) LoadConnections() ([]ConnectionProfile, error) {
	data, err := s.backend.ReadFile()
	if err != nil {
		if os.IsNotExist(err) {
			return []ConnectionProfile{}, nil
		}
		return nil, err
	}
	var profiles []ConnectionProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, err
	}
	return profiles, nil
}

func (s *Storage) SaveConnections(profiles []ConnectionProfile) error {
	data, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return err
	}
	return s.backend.WriteFile(data)
}
