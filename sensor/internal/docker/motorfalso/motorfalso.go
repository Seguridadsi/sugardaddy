// Package motorfalso ayuda a las pruebas a hacerse pasar por un motor de
// contenedores concreto: contesta a GET /version como él y, como él, rechaza
// lo que se le pida en una versión de la API que no admite. Lo demás se lo
// pasa, ya sin el prefijo de versión, al manejador de cada prueba.
package motorfalso

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Motor es lo que un motor dice de sí mismo, recortado a lo que se mira.
type Motor struct {
	Nombre     string // de la plataforma
	Version    string
	API        string // la más alta que admite
	APIMinima  string
	Componente string // el primero de Components («Engine» en Docker)
}

// Los motores de la matriz. Docker 20.10.10, 24, 27, 29.0 y 29.3 y Podman 4
// contestan esto de verdad (comprobado con las imágenes docker:<versión>-dind
// y quay.io/podman/stable); 20.10.5 y 19.03 son los de su documentación,
// Podman 3 el de sus notas de versión, y el futuro, inventado.
var (
	Docker20_10_5 = Motor{"Docker Engine - Community", "20.10.5+dfsg1", "1.41", "1.12", "Engine"}
	// El docker.io de Ubuntu 20.04: el número es anterior a la 20.10.10, pero
	// trae el parche de clone3 (LP #1943049). Los paquetes de las
	// distribuciones no suelen poner nombre de plataforma.
	Docker20_10_7Ubuntu = Motor{"", "20.10.7", "1.41", "1.12", "Engine"}
	Docker20_10_10      = Motor{"Docker Engine - Community", "20.10.10", "1.41", "1.12", "Engine"}
	Docker24            = Motor{"Docker Engine - Community", "24.0.9", "1.43", "1.12", "Engine"}
	Docker27            = Motor{"Docker Engine - Community", "27.5.1", "1.47", "1.24", "Engine"}
	// Docker 29.0 a 29.2 subieron la mínima a la 1.44; la 29.3 la volvió a bajar.
	Docker29_0 = Motor{"Docker Engine - Community", "29.0.4", "1.52", "1.44", "Engine"}
	Docker29_3 = Motor{"Docker Engine - Community", "29.3.1", "1.54", "1.40", "Engine"}
	// Un Docker futuro que sube la mínima por encima de lo que conocemos.
	DockerFuturo = Motor{"Docker Engine - Community", "31.0.0", "1.60", "1.55", "Engine"}
	Docker19     = Motor{"Docker Engine - Community", "19.03.15", "1.40", "1.12", "Engine"}
	Podman4      = Motor{"linux/amd64/fedora-39", "4.9.3", "1.41", "1.24", "Podman Engine"}
	Podman3      = Motor{"linux/amd64/ubuntu-22.04", "3.4.4", "1.40", "1.24", "Podman Engine"}
)

// JSON de GET /version.
func (m Motor) JSON() string {
	return fmt.Sprintf(`{"Platform":{"Name":%q},"Components":[{"Name":%q,"Version":%q}],"Version":%q,"ApiVersion":%q,"MinAPIVersion":%q,"Os":"linux","Arch":"amd64","KernelVersion":"6.8.0-45-generic"}`,
		m.Nombre, m.Componente, m.Version, m.Version, m.API, m.APIMinima)
}

var prefijo = regexp.MustCompile(`^/v(\d+\.\d+)(/.*)$`)

// Envolver responde como el motor m: GET /version (con o sin prefijo) y el
// error 400 de Docker ante una versión que no admite; el resto llega a h sin
// el prefijo de versión.
func Envolver(m Motor, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ruta := r.URL.Path
		if p := prefijo.FindStringSubmatch(ruta); p != nil {
			v := p[1]
			if menor(m.API, v) {
				rechazar(w, fmt.Sprintf("client version %s is too new. Maximum supported API version is %s", v, m.API))
				return
			}
			if menor(v, m.APIMinima) {
				rechazar(w, fmt.Sprintf("client version %s is too old. Minimum supported API version is %s, please upgrade your client to a newer version", v, m.APIMinima))
				return
			}
			ruta = p[2]
		}
		if r.Method == http.MethodGet && ruta == "/version" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(m.JSON()))
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = ruta
		r2.URL.RawPath = ""
		h.ServeHTTP(w, r2)
	})
}

func rechazar(w http.ResponseWriter, mensaje string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = fmt.Fprintf(w, `{"message":%q}`, mensaje)
}

// menor: la versión a va antes que la b («1.9» < «1.41»).
func menor(a, b string) bool {
	pa, pb := strings.SplitN(a, ".", 2), strings.SplitN(b, ".", 2)
	for i := range 2 {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			return x < y
		}
	}
	return false
}

// Sondas hace de motor para los contenedores efímeros de las sondas: los
// crea, los «arranca», dice con qué código salen y qué han escrito (lo que
// diga Salida según su orden) y los borra. Apunta cada creación y cada
// borrado para que la prueba los mire.
type Sondas struct {
	Salida func(orden []string) (codigo int, texto string)

	mu       sync.Mutex
	vivas    map[string]sondaFalsa // por id y por nombre
	Creadas  []map[string]any
	Borradas []string
}

type sondaFalsa struct {
	id, nombre string
	orden      []string
}

var rutaContenedor = regexp.MustCompile(`^/containers/([^/]+)(/start|/wait|/logs)?$`)

// Atender contesta si lo que se pide es de una sonda; si no, devuelve false.
func (s *Sondas) Atender(w http.ResponseWriter, r *http.Request) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.vivas == nil {
		s.vivas = map[string]sondaFalsa{}
	}
	if r.Method == http.MethodPost && r.URL.Path == "/containers/create" {
		var cuerpo map[string]any
		_ = json.NewDecoder(r.Body).Decode(&cuerpo)
		nombre := r.URL.Query().Get("name")
		if _, ya := s.vivas[nombre]; ya {
			w.WriteHeader(http.StatusConflict)
			_, _ = fmt.Fprintf(w, `{"message":"Conflict. The container name %q is already in use"}`, "/"+nombre)
			return true
		}
		var orden []string
		if l, ok := cuerpo["Cmd"].([]any); ok {
			for _, x := range l {
				orden = append(orden, fmt.Sprint(x))
			}
		}
		c := sondaFalsa{id: fmt.Sprintf("sonda%d", len(s.Creadas)+1), nombre: nombre, orden: orden}
		s.vivas[c.id], s.vivas[nombre] = c, c
		s.Creadas = append(s.Creadas, cuerpo)
		_, _ = fmt.Fprintf(w, `{"Id":%q}`, c.id)
		return true
	}
	m := rutaContenedor.FindStringSubmatch(r.URL.Path)
	if m == nil {
		return false
	}
	c, existe := s.vivas[m[1]]
	switch {
	case r.Method == http.MethodDelete && m[2] == "":
		if !existe {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"No such container"}`))
			return true
		}
		delete(s.vivas, c.id)
		delete(s.vivas, c.nombre)
		s.Borradas = append(s.Borradas, m[1])
		w.WriteHeader(http.StatusNoContent)
	case !existe:
		return false
	case m[2] == "/start":
		w.WriteHeader(http.StatusNoContent)
	case m[2] == "/wait":
		codigo, _ := s.Salida(c.orden)
		_, _ = fmt.Fprintf(w, `{"StatusCode":%d}`, codigo)
	case m[2] == "/logs":
		_, texto := s.Salida(c.orden)
		// Sin terminal, cada trozo lleva 8 bytes de cabecera: flujo y tamaño.
		n := len(texto)
		_, _ = w.Write(append([]byte{1, 0, 0, 0, byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}, texto...))
	default:
		return false
	}
	return true
}
