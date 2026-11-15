//go:build linux

package main

import "github.com/kinomakino/sugardaddy/sensor/internal/registro"

// liberarLeido: ver registro.LiberarLeido. Con sd-motor lo hace él (s.motorSeguro).
func liberarLeido(ruta string, hasta int64) error { return registro.LiberarLeido(ruta, hasta) }
