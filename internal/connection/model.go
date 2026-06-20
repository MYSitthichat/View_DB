package connection

import "fmt"

type InfluxVersion string

const (
	InfluxV1 InfluxVersion = "v1"
	InfluxV2 InfluxVersion = "v2"
	InfluxV3 InfluxVersion = "v3"
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
	TLSInsecure     bool          `json:"tlsInsecure"`
	TimeoutSeconds  int           `json:"timeoutSeconds"`
}

func (p ConnectionProfile) Validate() error {
	if p.Name == "" {
		return fmt.Errorf("connection name is required")
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
