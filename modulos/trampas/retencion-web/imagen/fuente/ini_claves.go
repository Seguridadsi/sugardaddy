// Código propio de SeguridadSI (no viene de go-pot) para la trampa
// retencion-web de Sugardaddy. preparar.sh lo copia a generator/encoder/ y
// hace que el codificador INI (ini.go) lo use.
//
// El codificador INI de go-pot solo sabía escribir secciones: de cada valor
// suelto (las claves de los secretos, una lista) dejaba una sección vacía con
// su nombre («[codecov-access-token]» y nada debajo), un fichero que no es
// de nadie. Ahora un valor suelto va como «clave = valor» antes de las
// secciones, como en un .env, un .npmrc o unas credenciales.
package encoder

import (
	"encoding/json"

	"gopkg.in/ini.v1"
)

func valorIniSuelto(file *ini.File, clave string, valor any) {
	s, ok := valor.(string)
	if !ok {
		b, err := json.Marshal(valor)
		if err != nil {
			return
		}
		s = string(b)
	}
	_, _ = file.Section(ini.DefaultSection).NewKey(clave, s)
}
