//go:build !linux

package registro

// LiberarLeido solo sabe perforar ficheros en Linux, que es donde corre el sensor.
func LiberarLeido(string, int64) error { return ErrSinPerforar }
