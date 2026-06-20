package connection

// ConnectionUpsert is the DTO used over the Wails bridge.
// It includes secrets (Password/Token) so the UI can submit them,
// while ConnectionProfile remains safe to return from ListConnections.
type ConnectionUpsert struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Version         InfluxVersion `json:"version"`
	URL             string        `json:"url"`
	Username        string        `json:"username,omitempty"`
	Password        string        `json:"password,omitempty"`
	Token           string        `json:"token,omitempty"`
	Organization    string        `json:"organization,omitempty"`
	Bucket          string        `json:"bucket,omitempty"`
	Database        string        `json:"database,omitempty"`
	RetentionPolicy string        `json:"retentionPolicy,omitempty"`
	// PostgreSQL-specific.
	Host        string            `json:"host,omitempty"`
	Port        int               `json:"port,omitempty"`
	SSLMode     string            `json:"sslMode,omitempty"`
	Schema      string            `json:"schema,omitempty"`
	TLSConfig   map[string]string `json:"tlsConfig,omitempty"`
	TLSInsecure bool              `json:"tlsInsecure"`
	TimeoutSeconds int `json:"timeoutSeconds"`
}

func (u ConnectionUpsert) Profile() ConnectionProfile {
	return ConnectionProfile{
		ID:              u.ID,
		Name:            u.Name,
		Version:         u.Version,
		URL:             u.URL,
		Username:        u.Username,
		Password:        "",
		Token:           "",
		Organization:    u.Organization,
		Bucket:          u.Bucket,
		Database:        u.Database,
		RetentionPolicy: u.RetentionPolicy,
		Host:            u.Host,
		Port:            u.Port,
		SSLMode:         u.SSLMode,
		Schema:          u.Schema,
		TLSConfig:       u.TLSConfig,
		TLSInsecure:     u.TLSInsecure,
		TimeoutSeconds:  u.TimeoutSeconds,
	}
}
