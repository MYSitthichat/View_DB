package connection

import "sync"

type Manager struct {
	mu       sync.RWMutex
	profiles map[string]ConnectionProfile
	storage  *Storage
}

func NewManager() *Manager {
	return &Manager{profiles: map[string]ConnectionProfile{}}
}

func NewManagerWithStorage(storage *Storage) *Manager {
	return &Manager{profiles: map[string]ConnectionProfile{}, storage: storage}
}

func (m *Manager) Load() error {
	if m.storage == nil {
		return nil
	}
	profiles, err := m.storage.LoadConnections()
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, profile := range profiles {
		m.profiles[profile.ID] = profile
	}
	return nil
}

func (m *Manager) Save(profile ConnectionProfile) error {
	if err := profile.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.profiles[profile.ID] = profile
	return m.persistLocked()
}

func (m *Manager) Get(id string) (ConnectionProfile, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.profiles[id]
	return p, ok
}

func (m *Manager) List() []ConnectionProfile {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]ConnectionProfile, 0, len(m.profiles))
	for _, p := range m.profiles {
		out = append(out, p)
	}
	return out
}

func (m *Manager) Delete(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.profiles[id]; !ok {
		return false
	}
	delete(m.profiles, id)
	_ = m.persistLocked()
	return true
}

func (m *Manager) persistLocked() error {
	if m.storage == nil {
		return nil
	}
	profiles := make([]ConnectionProfile, 0, len(m.profiles))
	for _, profile := range m.profiles {
		profiles = append(profiles, profile)
	}
	return m.storage.SaveConnections(profiles)
}
