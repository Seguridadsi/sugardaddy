//go:build !linux

package intermediario

// PrepararDatos: fuera de Linux (el banco en un Mac) no hay nada que cambiar.
func PrepararDatos(datos string, uid int) error { return nil }
