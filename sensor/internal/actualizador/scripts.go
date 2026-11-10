package actualizador

// Los scripts de copias del nodo (docs/diseno/ca-nodo.md).
//
// Una versión firmada solo trae compose.yml y el Caddyfile: copia.sh y
// restaurar.sh los deja instalar.sh y no cambian al actualizar. Pero los de
// antes no guardan la CA propia del nodo (ca-nodo/), justo en los nodos que
// pasan a ella. No se pueden añadir a la configuración firmada (un
// actualizador viejo rechazaría la versión entera), así que viajan dentro de
// la imagen del actualizador, que es de la versión, y él los pone en la
// carpeta del nodo. Son copia exacta de despliegue/nodo: lo exige una prueba.

import (
	"bytes"
	"embed"
	"os"
	"path/filepath"
)

//go:embed scripts/copia.sh scripts/restaurar.sh
var scriptsDeCopias embed.FS

// ScriptsDeCopias son los nombres de los scripts que lleva el actualizador.
var ScriptsDeCopias = []string{"copia.sh", "restaurar.sh"}

// PonerScriptsDeCopias deja en la carpeta del nodo los scripts de esta
// versión si los que hay son otros. Devuelve los que cambió.
func PonerScriptsDeCopias(dir string) ([]string, error) {
	var cambiados []string
	for _, n := range ScriptsDeCopias {
		nuevo, err := scriptsDeCopias.ReadFile("scripts/" + n)
		if err != nil {
			return cambiados, err
		}
		ruta := filepath.Join(dir, n)
		if fi, err := os.Lstat(ruta); err == nil && fi.Mode().IsRegular() {
			if actual, err := os.ReadFile(ruta); err == nil && bytes.Equal(actual, nuevo) && fi.Mode().Perm() == 0o755 {
				continue
			}
		}
		// Un enlace o lo que haya en su lugar se sustituye: nunca se escribe a través de él.
		if err := escribirAtomico(ruta, nuevo, 0o755); err != nil {
			return cambiados, err
		}
		cambiados = append(cambiados, n)
	}
	return cambiados, nil
}
