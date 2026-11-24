//go:build !linux

package registro

import "os"

// LiberarLeido solo sabe perforar ficheros en Linux, que es donde corre el sensor.
func LiberarLeido(string, int64) error { return ErrSinPerforar }

// PerforarLeido solo sabe perforar ficheros en Linux.
func PerforarLeido(*os.File, int64) error { return ErrSinPerforar }
