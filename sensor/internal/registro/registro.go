// Package registro libera lo ya leído de un registro de trampa. Lo hace el sensor
// (sin sd-motor, como root con DAC_OVERRIDE) o sd-motor por él: el sensor ya no es
// root y el registro lo escribe el usuario del honeypot (docs/diseno/aislamiento-trampas.md).
package registro

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// ErrSinPerforar: en esta plataforma no se saben perforar ficheros.
var ErrSinPerforar = errors.New("punching holes in files is only supported on Linux")

// HayQueLiberar: si leído hasta hasta queda algo que perforar (desde el segundo
// bloque hasta el anterior al último byte leído).
func HayQueLiberar(hasta int64) bool { return finLeido(hasta) > bloque }

const bloque = 4096

// finLeido: hasta el bloque anterior al último byte leído. El seguidor mira ese
// byte para saber que empieza tras un salto de línea.
func finLeido(hasta int64) int64 { return (hasta - 1) / bloque * bloque }

// AbrirEn abre para perforar el registro rel, relativo a raiz, y comprueba lo que
// ha abierto (lo que sd-motor hace por el sensor). Decide y abre con el mismo
// anclaje (os.Root, como borrarDentro): una carpeta cambiada por un enlace que
// lleva fuera no se abre, en vez de comprobar una ruta y abrirla luego otra vez.
// Ya abierto, el descriptor tiene que ser el fichero normal que hay en rel sin
// pasar por ningún enlace, ni siquiera a otra parte de dentro (los discos de las
// trampas son de root y el sensor no los puede tocar). Sin bloquearse ni seguir
// el enlace de la hoja: desde una trampa tomada podrían poner un FIFO o un enlace.
func AbrirEn(raiz *os.Root, rel string) (*os.File, error) {
	f, err := raiz.OpenFile(rel, os.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	if err := esElDeRel(raiz, rel, f); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// esElDeRel: f es un fichero normal y es el que hay ahora en rel, con todas sus
// carpetas de verdad (ninguna un enlace). Se mira después de abrir: si al abrir
// alguna era un enlace a otro fichero, el abierto no es el de rel y no pasa.
func esElDeRel(raiz *os.Root, rel string, f *os.File) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return errors.New(rel + " is not a regular file")
	}
	for d := filepath.Dir(rel); d != "." && d != string(filepath.Separator); d = filepath.Dir(d) {
		di, err := raiz.Lstat(d)
		if err != nil {
			return err
		}
		if !di.IsDir() {
			return fmt.Errorf("%s: %w", d, syscall.ELOOP)
		}
	}
	li, err := raiz.Lstat(rel)
	if err != nil {
		return err
	}
	if !li.Mode().IsRegular() || !os.SameFile(fi, li) {
		return fmt.Errorf("%s: %w", rel, syscall.ELOOP)
	}
	return nil
}
