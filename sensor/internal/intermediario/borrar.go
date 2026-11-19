package intermediario

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
)

// RutaBorrarRegistros: el sensor pide borrar lo que una trampa ha creado en su
// carpeta de registros (subcarpetas, con lo de dentro) o la carpeta de registros
// entera de una trampa retirada. Lo de dentro es del usuario del honeypot, y el
// sensor, que ya no es root, no puede borrarlo (F16); sd-motor sí, pero solo eso.
const RutaBorrarRegistros = "/sd/v1/borrar-registros"

// PeticionBorrarRegistros es lo que manda el sensor.
type PeticionBorrarRegistros struct {
	Ruta string `json:"ruta"`
}

// CarpetaDeRegistros: la ruta es la carpeta de registros de una trampa (la de la
// máquina, registros/<id>) o algo justo dentro de ella o de la de su disco
// (registros/<id>/<nombre>, discos/<id>/registros/<nombre>). Nada más arriba ni más
// abajo, y sin «..».
func (r Reglas) CarpetaDeRegistros(ruta string) (string, error) {
	if !filepath.IsAbs(ruta) || filepath.Clean(ruta) != ruta {
		return "", rechazar("invalid path")
	}
	rel, err := filepath.Rel(filepath.Clean(r.Datos), ruta)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", rechazar("the path is outside the sensor folder")
	}
	p := strings.Split(rel, string(filepath.Separator))
	nombre := func(s string) bool { return s != "" && s != "." && s != ".." }
	switch {
	case len(p) == 2 && p[0] == "registros" && idValido.MatchString(p[1]):
	case len(p) == 3 && p[0] == "registros" && idValido.MatchString(p[1]) && nombre(p[2]):
	case len(p) == 4 && p[0] == discos.Carpeta && idValido.MatchString(p[1]) && p[2] == "registros" && nombre(p[3]):
	default:
		return "", rechazar("only what is inside a decoy's logs folder can be removed")
	}
	return rel, nil
}

func (s *Servidor) borrarRegistros(w http.ResponseWriter, r *http.Request) error {
	var p PeticionBorrarRegistros
	b, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
	if err != nil || json.Unmarshal(b, &p) != nil {
		return rechazar("the request is not JSON")
	}
	rel, err := s.Reglas.CarpetaDeRegistros(p.Ruta)
	if err != nil {
		return err
	}
	var res RespuestaPerforar
	if err := borrarDentro(s.Reglas.Datos, rel); err != nil {
		res.Error = err.Error()
		var en syscall.Errno
		if errors.As(err, &en) {
			res.Errno = int(en)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(res)
}

// borrarDentro borra rel (y lo de dentro) sin salir de la carpeta del sensor ni seguir
// enlaces (os.Root): una carpeta cambiada por un enlace no lleva a borrar fuera. Lo
// que no existe ya está borrado.
func borrarDentro(datos, rel string) error {
	raiz, err := os.OpenRoot(datos)
	if err != nil {
		return err
	}
	defer raiz.Close()
	// Su carpeta madre, una carpeta de verdad (no un enlace a otra de dentro).
	madre := filepath.Dir(rel)
	for d := madre; d != "."; d = filepath.Dir(d) {
		fi, err := raiz.Lstat(d)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			return rechazar("%s is not a plain folder", d)
		}
	}
	// Lo que creó la trampa es de su usuario y puede llevar el bit pegajoso (en una
	// carpeta pegajosa solo borra el dueño de la carpeta o el de la entrada, o quien
	// tiene CAP_FOWNER, que sd-motor no tiene). Con CAP_CHOWN, sus carpetas pasan
	// antes a root, y entonces sí: también la propia entrada, aunque su carpeta madre
	// (la de registros, pegajosa) sea del sensor.
	_ = fs.WalkDir(raiz.FS(), rel, func(ruta string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = raiz.Lchown(ruta, 0, 0)
		}
		return nil
	})
	return raiz.RemoveAll(rel)
}
