//go:build !linux

package main

import "github.com/kinomakino/sugardaddy/sensor/internal/registro"

// liberarLeido solo sabe perforar ficheros en Linux, que es donde corre el sensor.
func liberarLeido(ruta string, hasta int64) error { return registro.LiberarLeido(ruta, hasta) }
