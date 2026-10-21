//go:build linux

package main

import (
	"errors"
	"os"
	"syscall"
)

// liberarLeido devuelve al disco lo ya leído de un registro que el honeypot
// sigue escribiendo, perforando el fichero (FALLOC_FL_PUNCH_HOLE) desde el
// segundo bloque hasta hasta. No cambia su tamaño, ni su inodo, ni el sitio
// por el que escribe el honeypot (aunque no use O_APPEND), ni su huella (el
// primer bloque se queda): el sensor sigue leyendo desde donde iba.
func liberarLeido(ruta string, hasta int64) error {
	const bloque = 4096
	// Hasta el bloque anterior al último byte leído: el seguidor mira ese
	// byte para saber que empieza tras un salto de línea.
	fin := (hasta - 1) / bloque * bloque
	if fin <= bloque {
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
		return errors.New(ruta + " no es un fichero normal")
	}
	const perforar, mismoTamano = 0x02, 0x01
	return syscall.Fallocate(int(f.Fd()), perforar|mismoTamano, bloque, fin-bloque)
}
