//go:build linux

package intermediario

import (
	"io/fs"
	"os"
	"path/filepath"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
)

// PrepararDatos deja la carpeta del sensor a su usuario, que ya no es root. Es
// para los nodos de antes, donde todo era de root. Lo que escriben las trampas
// (sus registros y sus discos) no cambia de dueño: el honeypot sigue siendo quien
// escribe en ellos. Solo sus carpetas de registros pasan al sensor (1777, con el
// bit pegajoso), para que pueda borrar lo rotado que ya ha leído.
func PrepararDatos(datos string, uid int) error {
	if err := os.MkdirAll(datos, 0o700); err != nil {
		return err
	}
	_ = os.Lchown(datos, uid, uid)
	entradas, err := os.ReadDir(datos)
	if err != nil {
		return err
	}
	for _, e := range entradas {
		ruta := filepath.Join(datos, e.Name())
		switch e.Name() {
		case "registros":
			_ = os.Lchown(ruta, uid, uid)
			carpetasDe(ruta, "", uid)
		case discos.Carpeta:
			_ = os.Lchown(ruta, uid, uid)
			carpetasDe(ruta, "registros", uid)
		default:
			// Lo que escribe el sensor: su estado, sus colas, la configuración de las trampas.
			_ = filepath.WalkDir(ruta, func(p string, _ fs.DirEntry, err error) error {
				if err == nil {
					_ = os.Lchown(p, uid, uid)
				}
				return nil
			})
		}
	}
	return nil
}

// carpetasDe: raiz/<id>[/sub] pasa a ser del sensor, sin tocar lo de dentro.
func carpetasDe(raiz, sub string, uid int) {
	ids, _ := os.ReadDir(raiz)
	for _, i := range ids {
		if !i.IsDir() {
			continue
		}
		d := filepath.Join(raiz, i.Name(), sub)
		if fi, err := os.Lstat(d); err == nil && fi.IsDir() {
			_ = os.Lchown(d, uid, uid)
		}
	}
}
