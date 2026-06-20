package config

import (
	"fmt"

	"github.com/zalando/go-keyring"
)

type Secrets struct {
	service string
}

func NewSecrets(service string) *Secrets {
	if service == "" {
		service = "view-db"
	}
	return &Secrets{service: service}
}

func (s *Secrets) passwordKey(connectionID string) string {
	return fmt.Sprintf("connection:%s:password", connectionID)
}
func (s *Secrets) tokenKey(connectionID string) string {
	return fmt.Sprintf("connection:%s:token", connectionID)
}

func (s *Secrets) SetConnectionPassword(connectionID, password string) error {
	if connectionID == "" {
		return fmt.Errorf("connection id is required")
	}
	return keyring.Set(s.service, s.passwordKey(connectionID), password)
}

func (s *Secrets) GetConnectionPassword(connectionID string) (string, error) {
	if connectionID == "" {
		return "", fmt.Errorf("connection id is required")
	}
	return keyring.Get(s.service, s.passwordKey(connectionID))
}

func (s *Secrets) SetConnectionToken(connectionID, token string) error {
	if connectionID == "" {
		return fmt.Errorf("connection id is required")
	}
	return keyring.Set(s.service, s.tokenKey(connectionID), token)
}

func (s *Secrets) GetConnectionToken(connectionID string) (string, error) {
	if connectionID == "" {
		return "", fmt.Errorf("connection id is required")
	}
	return keyring.Get(s.service, s.tokenKey(connectionID))
}

func (s *Secrets) DeleteConnectionPassword(connectionID string) error {
	if connectionID == "" {
		return fmt.Errorf("connection id is required")
	}
	return keyring.Delete(s.service, s.passwordKey(connectionID))
}

func (s *Secrets) DeleteConnectionToken(connectionID string) error {
	if connectionID == "" {
		return fmt.Errorf("connection id is required")
	}
	return keyring.Delete(s.service, s.tokenKey(connectionID))
}
