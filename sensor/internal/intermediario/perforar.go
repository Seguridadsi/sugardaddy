package intermediario

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/registro"
)

// RutaPerforar: el sensor pide liberar lo ya leído de un registro de trampa. Lo
// escribe el usuario del honeypot, y el sensor, que ya no es root, no puede
// abrirlo para escribir; sd-motor sí, pero solo un registro dentro de la carpeta
// de registros de una trampa.
const RutaPerforar = "/sd/v1/perforar"

// PeticionPerforar es lo que manda el sensor.
type PeticionPerforar struct {
	Ruta  string `json:"ruta"`
	Hasta int64  `json:"hasta"`
}

// RespuestaPerforar: Errno del fallo (0 si ninguno), para que el sensor lo
// clasifique igual que si lo hubiera hecho él.
type RespuestaPerforar struct {
	Errno int    `json:"errno,omitempty"`
	Error string `json:"error,omitempty"`
}

// RegistroDeTrampa: la ruta es un fichero bajo la carpeta de registros de una
// trampa (la de la máquina o la de su disco), sin «..». Devuelve la ruta relativa
// a la carpeta del sensor. Solo mira la cadena: los enlaces los decide la apertura
// (registro.AbrirEn), con el mismo anclaje con que se perfora, porque el sensor
// puede cambiar una carpeta por un enlace entre una comprobación y la apertura.
func (r Reglas) RegistroDeTrampa(ruta string) (string, error) {
	if !filepath.IsAbs(ruta) || filepath.Clean(ruta) != ruta {
		return "", rechazar("invalid log path")
	}
	datos := filepath.Clean(r.Datos)
	rel, err := filepath.Rel(datos, ruta)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", rechazar("the log is outside the sensor folder")
	}
	partes := strings.Split(rel, string(filepath.Separator))
	switch {
	case len(partes) >= 3 && partes[0] == "registros" && idValido.MatchString(partes[1]):
	case len(partes) >= 4 && partes[0] == discos.Carpeta && idValido.MatchString(partes[1]) && partes[2] == "registros":
	default:
		return "", rechazar("only a decoy log can be freed")
	}
	return rel, nil
}

func (s *Servidor) perforar(w http.ResponseWriter, r *http.Request) error {
	var p PeticionPerforar
	b, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
	if err != nil || json.Unmarshal(b, &p) != nil {
		return rechazar("the request is not JSON")
	}
	rel, err := s.Reglas.RegistroDeTrampa(p.Ruta)
	if err != nil {
		return err
	}
	var res RespuestaPerforar
	if err := s.liberarEn(rel, p.Hasta); err != nil {
		res.Error = err.Error()
		var en syscall.Errno
		if errors.As(err, &en) {
			res.Errno = int(en)
		} else if errors.Is(err, registro.ErrSinPerforar) {
			res.Errno = int(syscall.ENOSYS)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(res)
}

// liberarEn abre el registro dentro de la carpeta del sensor (os.Root, sin salir
// por enlaces) y perfora el descriptor abierto: lo que se comprueba es lo que se
// perfora, no una ruta que se vuelve a resolver.
func (s *Servidor) liberarEn(rel string, hasta int64) error {
	if !registro.HayQueLiberar(hasta) {
		return nil
	}
	raiz, err := os.OpenRoot(s.Reglas.Datos)
	if err != nil {
		return err
	}
	defer raiz.Close()
	f, err := registro.AbrirEn(raiz, rel)
	if err != nil {
		return err
	}
	defer f.Close()
	return liberar(f, hasta)
}

// liberar, variable para las pruebas.
var liberar = registro.PerforarLeido
