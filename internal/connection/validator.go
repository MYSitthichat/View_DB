package connection

import "fmt"

func Validate(profile ConnectionProfile) error {
	if err := profile.Validate(); err != nil {
		return err
	}
	if profile.TimeoutSeconds < 0 {
		return fmt.Errorf("timeout must be >= 0")
	}
	return nil
}
