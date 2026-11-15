package intermediario

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
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
// trampa (la de la máquina o la de su disco), sin «..» ni salir por enlaces.
func (r Reglas) RegistroDeTrampa(ruta string) error {
	if !filepath.IsAbs(ruta) || filepath.Clean(ruta) != ruta {
		return rechazar("invalid log path")
	}
	datos := filepath.Clean(r.Datos)
	rel, err := filepath.Rel(datos, ruta)
	if err != nil || strings.HasPrefix(rel, "..") {
		return rechazar("the log is outside the sensor folder")
	}
	partes := strings.Split(rel, string(filepath.Separator))
	switch {
	case len(partes) >= 3 && partes[0] == "registros" && idValido.MatchString(partes[1]):
	case len(partes) >= 4 && partes[0] == discos.Carpeta && idValido.MatchString(partes[1]) && partes[2] == "registros":
	default:
		return rechazar("only a decoy log can be freed")
	}
	// La carpeta en la que está, sin enlaces que lleven fuera (el fichero se abre sin seguirlos).
	return sinEnlaceFuera(filepath.Dir(ruta), datos)
}

func (s *Servidor) perforar(w http.ResponseWriter, r *http.Request) error {
	var p PeticionPerforar
	b, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
	if err != nil || json.Unmarshal(b, &p) != nil {
		return rechazar("the request is not JSON")
	}
	if err := s.Reglas.RegistroDeTrampa(p.Ruta); err != nil {
		return err
	}
	var res RespuestaPerforar
	if err := liberar(p.Ruta, p.Hasta); err != nil {
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

// liberar, variable para las pruebas.
var liberar = registro.LiberarLeido
