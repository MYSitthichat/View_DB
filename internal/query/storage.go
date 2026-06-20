package query

import (
	"encoding/json"
	"path/filepath"

	"view-db/internal/config"
)

type Storage struct {
	historyPath    string
	savedPath      string
	configStorage  *config.Storage
	configSavedStorage *config.Storage
}

func NewStorage() *Storage {
	appDir := config.GetAppDir()
	historyPath := filepath.Join(appDir, "history.json")
	savedPath := filepath.Join(appDir, "saved_queries.json")
	return &Storage{
		historyPath:    historyPath,
		savedPath:      savedPath,
		configStorage:  config.NewStorage(historyPath),
		configSavedStorage: config.NewStorage(savedPath),
	}
}

func (s *Storage) ReadHistory() ([]QueryHistoryItem, error) {
	data, err := s.configStorage.ReadFile()
	if err != nil {
		return []QueryHistoryItem{}, nil // Return empty if file not found
	}
	var history []QueryHistoryItem
	if err := json.Unmarshal(data, &history); err != nil {
		return []QueryHistoryItem{}, err
	}
	return history, nil
}

func (s *Storage) WriteHistory(history []QueryHistoryItem) error {
	data, err := json.MarshalIndent(history, "", "  ")
	if err != nil {
		return err
	}
	return s.configStorage.WriteFile(data)
}

func (s *Storage) ReadSavedQueries() ([]SavedQuery, error) {
	data, err := s.configSavedStorage.ReadFile()
	if err != nil {
		return []SavedQuery{}, nil
	}
	var queries []SavedQuery
	if err := json.Unmarshal(data, &queries); err != nil {
		return []SavedQuery{}, err
	}
	return queries, nil
}

func (s *Storage) WriteSavedQueries(queries []SavedQuery) error {
	data, err := json.MarshalIndent(queries, "", "  ")
	if err != nil {
		return err
	}
	return s.configSavedStorage.WriteFile(data)
}
