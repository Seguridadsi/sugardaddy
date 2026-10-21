//go:build !unix

package seguidor

import (
	"errors"
	"os"
)

// InodoDe: sin inodos, el registro (y sus rotados) se reconoce por su huella.
func InodoDe(os.FileInfo) uint64 { return 0 }

// abrirRegistro abre para leer, solo si es un fichero normal.
func abrirRegistro(ruta string) (*os.File, error) {
	f, err := os.Open(ruta)
	if err != nil {
		return nil, err
	}
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		f.Close()
		if err == nil {
			err = errors.New(ruta + " no es un fichero normal")
		}
		return nil, err
	}
	return f, nil
}
