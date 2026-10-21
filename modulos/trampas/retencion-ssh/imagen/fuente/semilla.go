package main

import (
	crand "crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// semillaDeLaTrampa da un valor propio de cada trampa, fijo mientras exista:
// de él sale lo que no puede ser igual en toda la flota (el aviso del modo
// ssh). Se guarda la primera vez, al azar, en .semilla junto al registro (la
// carpeta que monta el sensor, una por trampa, que sobrevive a reinicios y a
// actualizaciones de la imagen; el sensor solo mira los ficheros que empiezan
// por el nombre del registro). Si no se puede, el nombre del contenedor. La
// imagen no lleva ninguna: sigue siendo reproducible.
func semillaDeLaTrampa(registro string) string {
	fichero := filepath.Join(filepath.Dir(registro), ".semilla")
	if s := leerSemilla(fichero); s != "" {
		return s
	}
	b := make([]byte, 16)
	if _, err := crand.Read(b); err == nil {
		if f, err := os.OpenFile(fichero, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644); err == nil {
			_, err = f.WriteString(hex.EncodeToString(b) + "\n")
			f.Close()
			if err == nil {
				return hex.EncodeToString(b)
			}
		} else if s := leerSemilla(fichero); s != "" {
			return s // la ha creado otro a la vez
		}
	}
	h, _ := os.Hostname()
	return h
}

func leerSemilla(fichero string) string {
	b, err := os.ReadFile(fichero)
	if s := strings.TrimSpace(string(b)); err == nil && len(s) >= 16 {
		return s
	}
	return ""
}
