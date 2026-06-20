package connection

import "fmt"

type InfluxVersion string

const (
	InfluxV1 InfluxVersion = "v1"
	InfluxV2 InfluxVersion = "v2"
	InfluxV3 InfluxVersion = "v3"
	InfluxPg InfluxVersion = "pg"
)

type ConnectionProfile struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Version         InfluxVersion `json:"version"`
	URL             string        `json:"url"`
	Username        string        `json:"username,omitempty"`
	Password        string        `json:"-"`
	Token           string        `json:"-"`
	HasPassword     bool          `json:"hasPassword"`
	HasToken        bool          `json:"hasToken"`
	Organization    string        `json:"organization,omitempty"`
	Bucket          string        `json:"bucket,omitempty"`
	Database        string        `json:"database,omitempty"`
	RetentionPolicy string        `json:"retentionPolicy,omitempty"`
	// PostgreSQL-specific connection fields.
	Host           string            `json:"host,omitempty"`
	Port           int               `json:"port,omitempty"`
	SSLMode        string            `json:"sslMode,omitempty"`
	Schema         string            `json:"schema,omitempty"`
	TLSConfig      map[string]string `json:"tlsConfig,omitempty"` // sslrootcert, etc.
	TLSInsecure    bool              `json:"tlsInsecure"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
}

func (p ConnectionProfile) Validate() error {
	if p.Name == "" {
		return fmt.Errorf("connection name is required")
	}
	if p.Version == InfluxPg {
		if p.Host == "" {
			return fmt.Errorf("host is required for PostgreSQL")
		}
		if p.Username == "" {
			return fmt.Errorf("username is required for PostgreSQL")
		}
		if p.Database == "" {
			return fmt.Errorf("database name is required for PostgreSQL")
		}
		if p.Port <= 0 {
			p.Port = 5432
		}
		if p.Schema == "" {
			p.Schema = "public"
		}
		// Note: we do NOT synthesise a postgres:// URL into p.URL here.
		// The frontend no longer shows the URL field for pg, and the
		// backend's buildDSN builds the libpq string from Host/Port/etc.
		// Synthesising a URL was causing confusion when users typed
		// http://host into the URL field.
		return nil
	}
	if p.URL == "" {
		return fmt.Errorf("connection url is required")
	}
	switch p.Version {
	case InfluxV1, InfluxV2, InfluxV3:
		if p.Version == InfluxV3 && p.Database == "" {
			return fmt.Errorf("database name is required for InfluxDB v3")
		}
		return nil
	default:
		return fmt.Errorf("unsupported influx version: %s", p.Version)
	}
}
