//go:build unix

package seguidor

import (
	"errors"
	"os"
	"syscall"
)

// InodoDe devuelve el inodo del fichero (0 si no se sabe).
func InodoDe(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Ino)
	}
	return 0
}

// abrirRegistro abre para leer sin seguir enlaces y sin bloquearse (un FIFO en
// lugar del registro dejaría parado al sensor entero), y solo si es un fichero
// normal.
func abrirRegistro(ruta string) (*os.File, error) {
	f, err := os.OpenFile(ruta, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
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
