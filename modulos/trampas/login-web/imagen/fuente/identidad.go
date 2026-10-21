package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// identidad: lo que hace que cada trampa parezca un portal distinto y
// coherente consigo mismo. El token de la cookie de sesión que se planta tras
// el login cebo (y el que se enseña en el contenido falso) sale de una semilla
// propia de la trampa, así que se mantiene entre reinicios (dos logins cebo no
// pueden delatarla por cambiar de token) y es distinto en cada cliente. La
// imagen es la misma para todos: la semilla se lee al arrancar, no se compila.
type identidad struct {
	semilla string
}

const nombreSemilla = ".semilla-loginweb"

// cargarSemilla: la de SD_LOGINWEB_SEMILLA; si no hay, la guardada junto al
// registro; si no hay, una nueva al azar que se guarda ahí. Si la carpeta no
// se puede escribir, el nombre del equipo (el del contenedor), que al menos es
// distinto en cada trampa.
func cargarSemilla(c conf) string {
	if c.semilla != "" {
		return c.semilla
	}
	ruta := filepath.Join(filepath.Dir(c.registro), nombreSemilla)
	if b, err := os.ReadFile(ruta); err == nil {
		if s := strings.TrimSpace(string(b)); len(s) >= 16 && len(s) <= 128 {
			return s
		}
	}
	s := aleatorioHex(16)
	if err := os.WriteFile(ruta, []byte(s+"\n"), 0o600); err != nil {
		if h, err := os.Hostname(); err == nil && h != "" {
			return "equipo:" + h
		}
	}
	return s
}

// generador: un entero de 64 bits derivado de la semilla y unas etiquetas, para
// sacar datos estables y distintos por trampa sin depender del reloj.
func generador(semilla string, etiquetas ...string) uint64 {
	h := sha256.New()
	h.Write([]byte(semilla))
	for _, e := range etiquetas {
		h.Write([]byte{0})
		h.Write([]byte(e))
	}
	return binary.BigEndian.Uint64(h.Sum(nil)[:8])
}

func nuevaIdentidad(c conf, semilla string) *identidad {
	return &identidad{semilla: semilla}
}

// tokenSesion: el valor de la cookie que se planta tras el login cebo. Estable
// por semilla para la misma sesión de conexión (no delata la trampa cambiando
// entre dos peticiones seguidas) y distinto en cada trampa.
func (id *identidad) tokenSesion(ses string) string {
	h := sha256.New()
	h.Write([]byte(id.semilla))
	h.Write([]byte{0})
	h.Write([]byte(ses))
	return "s" + hex.EncodeToString(h.Sum(nil))[:24]
}
