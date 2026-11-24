//go:build linux

package registro

import (
	"errors"
	"os"
	"syscall"
)

// LiberarLeido devuelve al disco lo ya leído de un registro que el honeypot
// sigue escribiendo, perforando el fichero (FALLOC_FL_PUNCH_HOLE) desde el
// segundo bloque hasta hasta. No cambia su tamaño, ni su inodo, ni el sitio
// por el que escribe el honeypot (aunque no use O_APPEND), ni su huella (el
// primer bloque se queda): el sensor sigue leyendo desde donde iba. Es lo que
// hace el sensor por sí mismo; sd-motor usa AbrirEn y PerforarLeido.
func LiberarLeido(ruta string, hasta int64) error {
	if !HayQueLiberar(hasta) {
		return nil
	}
	// Sin bloquearse ni seguir enlaces: desde una trampa tomada podrían poner
	// un FIFO o un enlace en su lugar.
	f, err := os.OpenFile(ruta, os.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return errors.New(ruta + " is not a regular file")
	}
	return PerforarLeido(f, hasta)
}

// PerforarLeido perfora el fichero ya abierto (ver LiberarLeido): sobre el
// descriptor, sin volver a resolver ninguna ruta.
func PerforarLeido(f *os.File, hasta int64) error {
	fin := finLeido(hasta)
	if fin <= bloque {
		return nil
	}
	const perforar, mismoTamano = 0x02, 0x01
	return syscall.Fallocate(int(f.Fd()), perforar|mismoTamano, bloque, fin-bloque)
}
