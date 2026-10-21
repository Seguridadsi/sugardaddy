//go:build !linux

package main

// liberarLeido solo sabe perforar ficheros en Linux, que es donde corre el sensor.
func liberarLeido(string, int64) error { return errSinPerforar }
