package intermediario

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// CabeceraManifiesto lleva, en la creación de una trampa, su manifiesto en JSON y
// en base64: el que el sensor recibe de la consola y sd-motor mide contra el
// catálogo firmado. Docker la ignora, así que el sensor la manda siempre.
const CabeceraManifiesto = "X-Sugardaddy-Manifiesto"

// Rutas propias de sd-motor, fuera de la forma de Docker.
const (
	RutaAislamiento = "/sd/v1/aislamiento"
	RutaDiscos      = "/sd/v1/discos"
)

// Servidor atiende el socket de sd-motor y reenvía a Docker lo que deja pasar.
type Servidor struct {
	// Docker: el socket del motor de verdad.
	Docker string
	Reglas Reglas
	// UsarRunsc: gVisor si el motor lo tiene (por defecto, sí).
	UsarRunsc bool
	// AppArmor: el perfil que ha cargado el instalador ("" si ninguno).
	AppArmor string
	// Discos atiende la petición de discos (nil: esta máquina no los da así).
	Discos *Discos

	cliente *http.Client
	proxy   *httputil.ReverseProxy
	una     sync.Once

	mu          sync.Mutex
	aislamiento *Aislamiento
	cuando      time.Time
}

func (s *Servidor) preparar() {
	s.una.Do(func() {
		tr := &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", s.Docker)
			},
		}
		s.cliente = &http.Client{Transport: tr, Timeout: time.Minute}
		s.proxy = &httputil.ReverseProxy{
			Rewrite: func(p *httputil.ProxyRequest) {
				p.Out.URL.Scheme, p.Out.URL.Host, p.Out.Host = "http", "docker", "docker"
				p.Out.Header.Del(CabeceraManifiesto)
			},
			Transport:     tr,
			FlushInterval: -1,
			ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
				escribirError(w, http.StatusBadGateway, "sd-motor: the container engine does not answer: "+err.Error())
			},
		}
		if s.Reglas.UsuarioImagen == nil {
			s.Reglas.UsuarioImagen = s.usuarioImagen
		}
		if s.Reglas.VolumenesImagen == nil {
			s.Reglas.VolumenesImagen = s.volumenesImagen
		}
		if s.Reglas.TrampaDe == nil {
			s.Reglas.TrampaDe = s.trampaDe
		}
	})
}

// La versión de la API delante de cada ruta (/v1.43/containers/…).
var prefijoVersion = regexp.MustCompile(`^/v[0-9]+\.[0-9]+`)

var (
	rutaContenedor = regexp.MustCompile(`^/containers/([^/]+)(/(json|start|stop|wait|logs|archive|kill))?$`)
	rutaRed        = regexp.MustCompile(`^/networks/([^/]+)(/(connect|disconnect))?$`)
	rutaImagen     = regexp.MustCompile(`^/images/(.+)/json$`)
	rutaVolumen    = regexp.MustCompile(`^/volumes/([^/]+)$`)
)

func (s *Servidor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.preparar()
	ruta := prefijoVersion.ReplaceAllString(r.URL.Path, "")
	err := s.decidir(w, r, ruta)
	if err == nil || err == errRespondido {
		return
	}
	var rz *Rechazo
	if errors.As(err, &rz) {
		slog.Warn("sd-motor: request refused", "metodo", r.Method, "ruta", ruta, "codigo", rz.Codigo, "motivo", rz.Texto)
		escribirError(w, http.StatusForbidden, rz.Error()+" ["+rz.Codigo+"]")
		return
	}
	escribirError(w, http.StatusBadGateway, "sd-motor: "+err.Error())
}

// decidir deja pasar (reenviando) o devuelve el rechazo. Lo que no está aquí no existe.
func (s *Servidor) decidir(w http.ResponseWriter, r *http.Request, ruta string) error {
	m := r.Method
	switch {
	case m == http.MethodGet && ruta == RutaAislamiento:
		a, err := s.Aislamiento(r.Context())
		if err != nil {
			return err
		}
		w.Header().Set("Content-Type", "application/json")
		return json.NewEncoder(w).Encode(a)
	case m == http.MethodPost && ruta == RutaPerforar:
		return s.perforar(w, r)
	case m == http.MethodPost && ruta == RutaBorrarRegistros:
		return s.borrarRegistros(w, r)
	case m == http.MethodPost && ruta == RutaDiscos:
		if s.Discos == nil {
			return rechazar("this machine has no disk service")
		}
		return s.Discos.Atender(w, r)
	case (m == http.MethodGet || m == http.MethodHead) && (ruta == "/_ping" || ruta == "/version" || ruta == "/info"):
	case m == http.MethodGet && ruta == "/containers/json":
		if !filtraNuestras(r.URL.Query().Get("filters")) {
			return rechazar("only the sensor's containers can be listed")
		}
	case m == http.MethodPost && ruta == "/containers/create":
		return s.crear(w, r)
	case rutaContenedor.MatchString(ruta):
		g := rutaContenedor.FindStringSubmatch(ruta)
		accion := g[3]
		permitido := (m == http.MethodDelete && accion == "") ||
			(m == http.MethodGet && (accion == "json" || accion == "logs" || accion == "archive")) ||
			(m == http.MethodHead && accion == "archive") ||
			(m == http.MethodPost && (accion == "start" || accion == "stop" || accion == "wait" || accion == "kill"))
		if !permitido {
			return rechazar("%s on a container is not allowed", strings.TrimSpace(m+" "+accion))
		}
		if err := s.esNuestro(r.Context(), g[1], w); err != nil {
			return err
		}
	case m == http.MethodPost && ruta == "/images/create":
		if err := ValidarImagen(r.URL.Query().Get("fromImage")); err != nil {
			return err
		}
	case m == http.MethodGet && rutaImagen.MatchString(ruta):
	case m == http.MethodPost && ruta == "/networks/create":
		cuerpo, err := leerJSON(r)
		if err != nil {
			return err
		}
		if err := ValidarRed(cuerpo); err != nil {
			return err
		}
	case rutaRed.MatchString(ruta):
		g := rutaRed.FindStringSubmatch(ruta)
		nombre, _ := url.PathUnescape(g[1])
		switch {
		case m == http.MethodGet && g[3] == "":
		case m == http.MethodDelete && g[3] == "" && strings.HasPrefix(nombre, "sugardaddy-trampas"):
		default:
			// connect/disconnect: las trampas se unen a su red al crearse.
			return rechazar("%s on network %q is not allowed", m, nombre)
		}
	case m == http.MethodGet && ruta == "/volumes":
	case m == http.MethodDelete && rutaVolumen.MatchString(ruta):
		nombre, _ := url.PathUnescape(rutaVolumen.FindStringSubmatch(ruta)[1])
		if !VolumenNuestro(nombre) {
			return rechazar("volume %q is not a decoy volume", nombre)
		}
	default:
		return rechazar("%s %s is not allowed", m, ruta)
	}
	s.proxy.ServeHTTP(w, r)
	return nil
}

// filtraNuestras: el listado tiene que ir filtrado por una etiqueta de Sugardaddy.
func filtraNuestras(filtros string) bool {
	var f map[string][]string
	if json.Unmarshal([]byte(filtros), &f) != nil {
		// Docker también acepta {"label":{"k=v":true}}.
		var g map[string]map[string]bool
		if json.Unmarshal([]byte(filtros), &g) != nil {
			return false
		}
		for k := range g["label"] {
			f = map[string][]string{"label": append(f["label"], k)}
		}
	}
	for _, e := range f["label"] {
		if strings.HasPrefix(e, "sugardaddy.") {
			return true
		}
	}
	return false
}

func (s *Servidor) crear(w http.ResponseWriter, r *http.Request) error {
	cfg, err := leerJSON(r)
	if err != nil {
		return err
	}
	var man *plan.Manifiesto
	if c := r.Header.Get(CabeceraManifiesto); c != "" {
		b, err := base64.StdEncoding.DecodeString(c)
		if err != nil {
			return rechazar("the manifest header is not base64")
		}
		var m plan.Manifiesto
		if err := json.Unmarshal(b, &m); err != nil {
			return rechazar("the manifest header is not a manifest")
		}
		man = &m
	}
	p := Peticion{Nombre: r.URL.Query().Get("name"), Config: cfg, Manifiesto: man}
	tipo, err := s.Reglas.Validar(p)
	if err != nil {
		return err
	}
	if tipo == TipoTrampa {
		a, err := s.Aislamiento(r.Context())
		if err != nil {
			return err
		}
		con := a.Endurecer(cfg, man.Red != nil)
		slog.Info("sd-motor: decoy created", "trampa", etiquetas(cfg)[EtiquetaTrampa], "aislamiento", con)
	}
	b, _ := json.Marshal(cfg)
	r.Body = io.NopCloser(bytes.NewReader(b))
	r.ContentLength = int64(len(b))
	r.Header.Set("Content-Length", fmt.Sprint(len(b)))
	s.proxy.ServeHTTP(w, r)
	return nil
}

// leerJSON lee el cuerpo (con tope) y lo deja otra vez para reenviarlo.
func leerJSON(r *http.Request) (map[string]any, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, rechazar("the request body is not JSON")
	}
	r.Body = io.NopCloser(bytes.NewReader(b))
	r.ContentLength = int64(len(b))
	return m, nil
}

// esNuestro: el contenedor existe y es del sensor. Si no existe, contesta el 404
// de Docker (el sensor lo espera al borrar algo que ya no está).
func (s *Servidor) esNuestro(ctx context.Context, id string, w http.ResponseWriter) error {
	et, existe, err := s.etiquetasDe(ctx, id)
	if err != nil {
		return err
	}
	if !existe {
		escribirError(w, http.StatusNotFound, "No such container: "+id)
		return errRespondido
	}
	if !EtiquetasNuestras(et) {
		return rechazar("container %q is not the sensor's", recortar(id, 40))
	}
	return nil
}

// errRespondido: ya se ha contestado; ServeHTTP no añade nada.
var errRespondido = &Rechazo{Codigo: "respondido"}

func (s *Servidor) etiquetasDe(ctx context.Context, id string) (map[string]string, bool, error) {
	var c struct {
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	cod, err := s.pedir(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/json", &c)
	if cod == http.StatusNotFound {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return c.Config.Labels, true, nil
}

func (s *Servidor) trampaDe(contenedor string) (string, bool) {
	et, existe, err := s.etiquetasDe(context.Background(), contenedor)
	if err != nil || !existe || et[EtiquetaTrampa] == "" {
		return "", false
	}
	return et[EtiquetaTrampa], true
}

func (s *Servidor) usuarioImagen(imagen string) (string, error) {
	var i struct {
		Config struct {
			User string `json:"User"`
		} `json:"Config"`
	}
	_, err := s.pedir(context.Background(), http.MethodGet, "/images/"+url.PathEscape(imagen)+"/json", &i)
	return i.Config.User, err
}

func (s *Servidor) volumenesImagen(imagen string) ([]string, error) {
	var i struct {
		Config struct {
			Volumes map[string]any `json:"Volumes"`
		} `json:"Config"`
	}
	_, err := s.pedir(context.Background(), http.MethodGet, "/images/"+url.PathEscape(imagen)+"/json", &i)
	var r []string
	for v := range i.Config.Volumes {
		r = append(r, v)
	}
	return r, err
}

// pedir habla con Docker directamente (sin versión: la ruta sin prefijo vale).
func (s *Servidor) pedir(ctx context.Context, metodo, ruta string, salida any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, metodo, "http://docker"+ruta, nil)
	if err != nil {
		return 0, err
	}
	resp, err := s.cliente.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
		return resp.StatusCode, fmt.Errorf("docker %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return resp.StatusCode, json.NewDecoder(resp.Body).Decode(salida)
}

// Aislamiento: lo que sd-motor aplica a las trampas, medido con lo que dice el
// motor (se vuelve a mirar cada minuto: el appliance puede ganar runsc al actualizarse).
func (s *Servidor) Aislamiento(ctx context.Context) (Aislamiento, error) {
	s.preparar()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.aislamiento != nil && time.Since(s.cuando) < time.Minute {
		return *s.aislamiento, nil
	}
	var info struct {
		Runtimes map[string]any `json:"Runtimes"`
	}
	if _, err := s.pedir(ctx, http.MethodGet, "/info", &info); err != nil {
		return Aislamiento{}, err
	}
	var rts []string
	for k := range info.Runtimes {
		rts = append(rts, k)
	}
	a := Decidir(rts, s.UsarRunsc, s.AppArmor)
	s.aislamiento, s.cuando = &a, time.Now()
	return a, nil
}

func escribirError(w http.ResponseWriter, codigo int, mensaje string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(codigo)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": mensaje})
}

// Escuchar abre el socket de sd-motor con permisos solo para su grupo (el del
// sensor) y atiende hasta que se cancela el contexto.
func (s *Servidor) Escuchar(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{Handler: s, MaxHeaderBytes: 4 << 20, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancelar := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelar()
		_ = srv.Shutdown(c)
	}()
	err := srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
