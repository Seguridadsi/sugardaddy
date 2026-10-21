//go:build !linux && !darwin

package main

// libreEn: en esta plataforma el sensor no sabe cuánto disco libre queda.
func libreEn(string) (int64, bool) { return 0, false }
