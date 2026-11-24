//go:build !linux && !darwin

package salud

// disco: en esta plataforma el sensor no mide su disco.
func disco(string) *Capacidad { return nil }
