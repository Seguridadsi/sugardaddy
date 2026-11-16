package actualizador

// Cortafuegos estricto de la máquina (docs/diseno/cortafuegos-anfitrion.md, plan
// de fortificación §1.3). El actualizador pregunta a la consola si está encendido y
// con qué (la lista de la consola, el SSH de administración, la salida), junta los
// puertos que Docker publica para el nodo y sus trampas, y lanza el auxiliar
// «cortafuegos-anfitrion» (red de la máquina, NET_ADMIN, nada más) que deja la
// tabla nftables «inet sugardaddy».
//
// Interruptor de hombre muerto: el auxiliar aplica y espera hasta Plazo a que el
// actualizador escriba la huella en cortafuegos-anfitrion/confirmado. El
// actualizador solo la escribe si, con las reglas nuevas puestas, sigue hablando
// con la consola y (con la salida restringida) llega al panel o al proxy. Si no, o
// si el actualizador se cae a medias, el auxiliar vuelve solo a la tabla de antes.
//
// La última tabla confirmada queda en cortafuegos-anfitrion/reglas.nft: el appliance
// la carga al arrancar, antes que Docker (sugardaddy-cortafuegos.service).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// CarpetaEstricto, dentro de la carpeta del nodo: la confirmación, las reglas
// confirmadas y las IP resueltas de los destinos.
const CarpetaEstricto = "cortafuegos-anfitrion"

// NombreCortafuegosAnfitrion es el contenedor del auxiliar; su nombre hace de cerrojo.
const NombreCortafuegosAnfitrion = "sugardaddy-cortafuegos-anfitrion"

// RepasoEstricto: cada cuánto se vuelve a mirar la tabla aunque nada cambie (un
// reinicio o un «nft flush ruleset» la quitan).
const RepasoEstricto = 5 * time.Minute

// PlazoEstricto por defecto: lo que espera el auxiliar a la confirmación.
const PlazoEstricto = 90 * time.Second

// VidaResueltas: una IP de un destino se sigue permitiendo este tiempo después de
// verla por última vez (los CDN rotan sus direcciones).
const VidaResueltas = 24 * time.Hour

// ConfigEstricto es lo que contesta GET /api/actualizador/anfitrion.
type ConfigEstricto struct {
	Estricto   bool `json:"estricto"`
	Emergencia bool `json:"emergencia"`
	Consola    struct {
		Estado string   `json:"estado"` // pendiente, restringida o abierta
		Redes  []string `json:"redes"`
	} `json:"consola"`
	SSH struct {
		Puerto int      `json:"puerto"`
		Redes  []string `json:"redes"`
	} `json:"ssh"`
	Salida struct {
		Restringida bool     `json:"restringida"`
		Destinos    []string `json:"destinos"`  // host:puerto
		Comprobar   []string `json:"comprobar"` // host:puerto que tiene que responder para confirmar
	} `json:"salida"`
	Plazo int `json:"plazo"` // segundos; 0, el de serie
}

// EstrictoNodo lleva la cuenta entre vueltas.
type EstrictoNodo struct {
	Docker    *docker.Cliente
	Consola   string
	Token     string
	HTTP      *http.Client
	Local     string // la carpeta del nodo en este contenedor
	Anfitrion string // la misma carpeta vista desde la máquina
	Log       func(string, ...any)

	// Dobles para las pruebas.
	Publicados func(ctx context.Context) ([]cortafuegos.Publicado, error)
	Resolver   func(ctx context.Context, host string) ([]netip.Addr, error)
	Marcar     func(ctx context.Context, direccion string) error
	Lanzar     func(ctx context.Context, imagen string, env []string, confirmar func(huella string) bool) cortafuegos.ResultadoEstricto
	Ahora      func() time.Time

	huella        string
	cuando        time.Time
	estado        string
	ultimoDetalle string
	registrado    string
	resueltoEn    time.Time
}

func (e *EstrictoNodo) ahora() time.Time {
	if e.Ahora != nil {
		return e.Ahora()
	}
	return time.Now()
}

var errSinRutaAnfitrion = errors.New("the console does not manage the host firewall yet")

// Vuelta aplica (o quita) la tabla si toca y le cuenta a la consola cómo ha quedado.
func (e *EstrictoNodo) Vuelta(ctx context.Context) error {
	env, _ := LeerEnv(filepath.Join(e.Local, ".env"))
	// Quien no quiere que Sugardaddy toque su máquina pone él sus reglas.
	if env["AISLAMIENTO_ANFITRION"] == "no" {
		return nil
	}
	emergencia := e.hayEmergencia()
	cfg, err := e.pedir(ctx)
	if err != nil {
		if errors.Is(err, errSinRutaAnfitrion) {
			return nil
		}
		// Sin consola no se cambia nada, salvo la salida de emergencia, que no depende de ella.
		if emergencia && e.estado != cortafuegos.EstrictoQuitado && e.estado != cortafuegos.EstrictoSuspendido {
			r := e.quitar(ctx)
			e.anotar(cortafuegos.EstrictoSuspendido, "emergency file: "+r.Detalle, "")
		}
		return err
	}
	switch {
	case emergencia || cfg.Emergencia:
		if e.estado != cortafuegos.EstrictoSuspendido {
			r := e.quitar(ctx)
			e.anotar(cortafuegos.EstrictoSuspendido, "console opened in an emergency: strict host firewall suspended ("+r.Detalle+")", "")
		}
	case !cfg.Estricto:
		if e.estado != cortafuegos.EstrictoQuitado {
			r := e.quitar(ctx)
			e.anotar(r.Estado, r.Detalle, "")
		}
	default:
		if err := e.aplicar(ctx, env, cfg); err != nil {
			e.anotar(cortafuegos.ConError, err.Error(), "")
		}
	}
	return e.informar(ctx)
}

func (e *EstrictoNodo) hayEmergencia() bool {
	st, err := os.Stat(filepath.Join(e.Local, FicheroAbrir))
	return err == nil && e.ahora().Sub(st.ModTime()) <= VidaEmergencia
}

func (e *EstrictoNodo) anotar(estado, detalle, huella string) {
	if estado != cortafuegos.EstrictoAplicado {
		e.huella = ""
	} else {
		e.huella = huella
	}
	e.estado, e.cuando = estado, e.ahora()
	if e.Log != nil && estado+detalle != e.registrado {
		e.registrado = estado + detalle
		e.Log("strict host firewall", "estado", estado, "detalle", detalle)
	}
	e.ultimoDetalle = detalle
}

// Estado devuelve el último estado anotado (para las pruebas y el informe).
func (e *EstrictoNodo) Estado() string { return e.estado }

func (e *EstrictoNodo) aplicar(ctx context.Context, env map[string]string, cfg ConfigEstricto) error {
	puerto := 443
	if p, err := strconv.Atoi(strings.TrimSpace(env["CONSOLA_PUERTO"])); err == nil {
		puerto = p
	}
	publicados := e.Publicados
	if publicados == nil {
		publicados = e.publicadosDocker
	}
	pub, err := publicados(ctx)
	if err != nil {
		return fmt.Errorf("published ports: %w", err)
	}
	est := cortafuegos.Estricto{
		Consola:    cortafuegos.ConsolaEstricta{Puerto: puerto, Abierta: cfg.Consola.Estado != "restringida", Redes: cfg.Consola.Redes},
		Publicados: pub,
	}
	if est.Consola.Abierta {
		est.Consola.Redes = nil
	}
	if len(cfg.SSH.Redes) > 0 {
		est.SSH = cortafuegos.SSHEstricto{Puerto: cfg.SSH.Puerto, Redes: cfg.SSH.Redes}
		if est.SSH.Puerto == 0 {
			est.SSH.Puerto = 22
		}
	}
	if cfg.Salida.Restringida {
		ds, err := e.destinos(ctx, cfg.Salida.Destinos)
		if err != nil {
			return err
		}
		est.Salida = cortafuegos.SalidaEstricta{Restringida: true, Destinos: ds}
	}
	huella, err := cortafuegos.HuellaEstricto(est)
	if err != nil {
		return err
	}
	if huella == e.huella && e.ahora().Sub(e.cuando) < RepasoEstricto {
		return nil
	}
	plazo := PlazoEstricto
	if cfg.Plazo >= 30 && cfg.Plazo <= 600 {
		plazo = time.Duration(cfg.Plazo) * time.Second
	}
	b, _ := json.Marshal(est)
	confirmar := e.confirmador(cfg)
	lanzar := e.Lanzar
	if lanzar == nil {
		lanzar = e.lanzar
	}
	carpeta := filepath.Join(e.Local, CarpetaEstricto)
	if err := os.MkdirAll(carpeta, 0o700); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(carpeta, "confirmado"))
	versiones, _ := LeerEnv(filepath.Join(e.Local, "versiones.env"))
	imagen := versiones["ACTUALIZADOR_IMAGEN"]
	if imagen == "" {
		return errors.New("versiones.env does not say which updater image to use for the host firewall helper")
	}
	r := lanzar(ctx, imagen, []string{"ESTRICTO=" + string(b), "ESTRICTO_PLAZO=" + strconv.Itoa(int(plazo/time.Second))}, confirmar)
	e.anotar(r.Estado, r.Detalle, r.Huella)
	if r.Estado == cortafuegos.EstrictoAplicado {
		if t, err := cortafuegos.ReglasEstricto(est); err == nil {
			_ = escribirAtomico(filepath.Join(carpeta, "reglas.nft"), []byte(t), 0o600)
		}
	} else {
		// Lo que no se ha confirmado no se carga al arrancar.
		_ = os.Remove(filepath.Join(carpeta, "reglas.nft"))
	}
	return nil
}

// confirmador: con las reglas nuevas puestas, ¿sigue el nodo hablando con su
// consola y, con la salida restringida, llega a lo que tiene que llegar? Si sí,
// escribe la huella para el auxiliar.
func (e *EstrictoNodo) confirmador(cfg ConfigEstricto) func(huella string) bool {
	return func(huella string) bool {
		ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelar()
		if _, err := e.pedir(ctx); err != nil {
			return false
		}
		if cfg.Salida.Restringida && len(cfg.Salida.Comprobar) > 0 {
			marcar := e.Marcar
			if marcar == nil {
				marcar = func(ctx context.Context, d string) error {
					c, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", d)
					if err == nil {
						c.Close()
					}
					return err
				}
			}
			alguno := false
			for _, d := range cfg.Salida.Comprobar {
				if marcar(ctx, d) == nil {
					alguno = true
					break
				}
			}
			if !alguno {
				return false
			}
		}
		return escribirAtomico(filepath.Join(e.Local, CarpetaEstricto, "confirmado"), []byte(huella), 0o600) == nil
	}
}

func (e *EstrictoNodo) quitar(ctx context.Context) cortafuegos.ResultadoEstricto {
	_ = os.Remove(filepath.Join(e.Local, CarpetaEstricto, "reglas.nft"))
	versiones, _ := LeerEnv(filepath.Join(e.Local, "versiones.env"))
	imagen := versiones["ACTUALIZADOR_IMAGEN"]
	if imagen == "" {
		return cortafuegos.ResultadoEstricto{Estado: cortafuegos.ConError, Detalle: "versiones.env does not say which updater image to use"}
	}
	lanzar := e.Lanzar
	if lanzar == nil {
		lanzar = e.lanzar
	}
	return lanzar(ctx, imagen, []string{"ESTRICTO_QUITAR=1"}, nil)
}

// publicadosDocker: los puertos que Docker publica en la máquina para los
// servicios del nodo y para las trampas. Lo de otros contenedores no pasa.
func (e *EstrictoNodo) publicadosDocker(ctx context.Context) ([]cortafuegos.Publicado, error) {
	var r []cortafuegos.Publicado
	for _, et := range []string{EtiquetaServicio, "sugardaddy.trampa"} {
		l, err := e.Docker.ListarConEtiqueta(ctx, et)
		if err != nil {
			return nil, err
		}
		r = append(r, PublicadosDe(l)...)
	}
	return r, nil
}

// PublicadosDe saca los puertos publicados de una lista de contenedores.
func PublicadosDe(l []docker.Contenedor) []cortafuegos.Publicado {
	var r []cortafuegos.Publicado
	for _, c := range l {
		for _, p := range c.Ports {
			if p.PublicPort > 0 && (p.Type == "tcp" || p.Type == "udp") {
				r = append(r, cortafuegos.Publicado{Proto: p.Type, Puerto: p.PublicPort})
			}
		}
	}
	return r
}

type resueltas map[string]map[string]time.Time // destino → IP → vista por última vez

// destinos resuelve los host:puerto de la lista (cada diez minutos) y devuelve
// las IP vistas en las últimas 24 horas, para que un CDN que rota no deje la
// salida cortada ni cambie la tabla en cada vuelta.
func (e *EstrictoNodo) destinos(ctx context.Context, lista []string) ([]cortafuegos.Destino, error) {
	_ = os.MkdirAll(filepath.Join(e.Local, CarpetaEstricto), 0o700)
	ruta := filepath.Join(e.Local, CarpetaEstricto, "resueltas.json")
	res := resueltas{}
	if b, err := os.ReadFile(ruta); err == nil {
		_ = json.Unmarshal(b, &res)
	}
	ahora := e.ahora()
	resolver := e.Resolver
	if resolver == nil {
		resolver = func(ctx context.Context, h string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", h)
		}
	}
	refrescar := ahora.Sub(e.resueltoEn) >= 10*time.Minute
	vivos := map[string]bool{}
	var r []cortafuegos.Destino
	for _, d := range lista {
		host, ps, err := net.SplitHostPort(strings.TrimSpace(d))
		p, errP := strconv.Atoi(ps)
		if err != nil || errP != nil || p < 1 || p > 65535 || host == "" {
			return nil, fmt.Errorf("invalid outbound destination %q", d)
		}
		vivos[d] = true
		if a, err := netip.ParseAddr(host); err == nil {
			r = append(r, cortafuegos.Destino{IP: a.Unmap().String(), Puerto: p})
			continue
		}
		if res[d] == nil {
			res[d] = map[string]time.Time{}
		}
		if refrescar || len(res[d]) == 0 {
			rctx, cancelar := context.WithTimeout(ctx, 5*time.Second)
			ips, err := resolver(rctx, host)
			cancelar()
			if err == nil {
				for _, a := range ips {
					res[d][a.Unmap().String()] = ahora
				}
			} else if e.Log != nil {
				e.Log("strict host firewall: cannot resolve an outbound destination", "destino", d, "err", err)
			}
		}
		for ip, visto := range res[d] {
			if ahora.Sub(visto) > VidaResueltas {
				delete(res[d], ip)
				continue
			}
			r = append(r, cortafuegos.Destino{IP: ip, Puerto: p})
		}
	}
	for d := range res {
		if !vivos[d] {
			delete(res, d)
		}
	}
	if refrescar {
		e.resueltoEn = ahora
	}
	if b, err := json.Marshal(res); err == nil {
		_ = escribirAtomico(ruta, b, 0o600)
	}
	sort.Slice(r, func(i, j int) bool { return r[i].IP+strconv.Itoa(r[i].Puerto) < r[j].IP+strconv.Itoa(r[j].Puerto) })
	return r, nil
}

func (e *EstrictoNodo) pedir(ctx context.Context) (ConfigEstricto, error) {
	var c ConfigEstricto
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.Consola+"/api/actualizador/anfitrion", nil)
	req.Header.Set("Authorization", "Bearer "+e.Token)
	resp, err := e.HTTP.Do(req)
	if err != nil {
		return c, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return c, errSinRutaAnfitrion
	}
	if resp.StatusCode != http.StatusOK {
		return c, fmt.Errorf("consola: %s", resp.Status)
	}
	return c, json.NewDecoder(io.LimitReader(resp.Body, topeRespuestaConsola)).Decode(&c)
}

// informar le cuenta a la consola el último estado (en cada vuelta: la consola deja
// de darlo por bueno si pasan diez minutos sin noticias).
func (e *EstrictoNodo) informar(ctx context.Context) error {
	if e.estado == "" {
		return nil
	}
	b, _ := json.Marshal(map[string]any{"estado": e.estado, "detalle": e.ultimoDetalle, "huella": e.huella})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.Consola+"/api/actualizador/anfitrion/cortafuegos", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+e.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.HTTP.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	return nil
}

// lanzar arranca el auxiliar y, mientras espera a que termine, va pasándole la
// confirmación (el auxiliar la lee del fichero, cada segundo).
func (e *EstrictoNodo) lanzar(ctx context.Context, imagen string, env []string, confirmar func(string) bool) cortafuegos.ResultadoEstricto {
	fallo := func(m string, err error) cortafuegos.ResultadoEstricto {
		return cortafuegos.ResultadoEstricto{Estado: cortafuegos.ConError, Detalle: m + ": " + err.Error()}
	}
	if !RutaDatosValida(e.Anfitrion) {
		return cortafuegos.ResultadoEstricto{Estado: cortafuegos.ConError, Detalle: "NODO_DIR is not a plain path"}
	}
	if err := e.Docker.Borrar(ctx, NombreCortafuegosAnfitrion); err != nil && !docker.NoExiste(err) {
		return fallo("previous host firewall helper", err)
	}
	if err := e.Docker.AsegurarImagen(ctx, imagen); err != nil {
		return fallo("updater image", err)
	}
	id, err := e.Docker.Crear(ctx, NombreCortafuegosAnfitrion, ConfigCortafuegosAnfitrion(imagen, env, filepath.Join(e.Anfitrion, CarpetaEstricto)))
	if err != nil {
		return fallo("host firewall helper", err)
	}
	defer func() { _ = e.Docker.Borrar(context.WithoutCancel(ctx), id) }()
	if err := e.Docker.Arrancar(ctx, id); err != nil {
		return fallo("host firewall helper", err)
	}
	espera, cancelar := context.WithTimeout(ctx, 12*time.Minute)
	defer cancelar()
	fin := make(chan struct{})
	if confirmar != nil {
		go func() {
			// La huella que espera el auxiliar es la de las reglas que genera él: la
			// misma que calcula aquí cortafuegos.HuellaEstricto con el mismo estado.
			var est cortafuegos.Estricto
			for _, v := range env {
				if t, ok := strings.CutPrefix(v, "ESTRICTO="); ok {
					_ = json.Unmarshal([]byte(t), &est)
				}
			}
			huella, err := cortafuegos.HuellaEstricto(est)
			if err != nil {
				return
			}
			for {
				select {
				case <-fin:
					return
				case <-espera.Done():
					return
				case <-time.After(2 * time.Second):
				}
				if confirmar(huella) {
					return
				}
			}
		}()
	}
	codigo, err := e.Docker.Esperar(espera, id)
	close(fin)
	if err != nil {
		return fallo("host firewall helper", err)
	}
	salida, _ := e.Docker.Salida(ctx, id, 20)
	return LeerResultadoEstricto(salida, codigo)
}

// LeerResultadoEstricto saca el resultado de la última línea JSON del auxiliar.
func LeerResultadoEstricto(salida string, codigo int) cortafuegos.ResultadoEstricto {
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	for i := len(lineas) - 1; i >= 0; i-- {
		var r cortafuegos.ResultadoEstricto
		if json.Unmarshal([]byte(lineas[i]), &r) == nil && r.Estado != "" {
			return r
		}
	}
	return cortafuegos.ResultadoEstricto{Estado: cortafuegos.ConError, Detalle: fmt.Sprintf("the host firewall helper ended with code %d and said nothing", codigo)}
}

// ConfigCortafuegosAnfitrion es el auxiliar: red de la máquina, NET_ADMIN y NET_RAW,
// y la carpeta de la confirmación, solo de lectura. Nada más.
func ConfigCortafuegosAnfitrion(imagen string, env []string, carpetaAnfitrion string) map[string]any {
	c := ConfigCortafuegos(imagen, cortafuegos.Pedido{})
	c["Cmd"] = []string{"cortafuegos-anfitrion"}
	c["Env"] = env
	c["Labels"] = map[string]string{"sugardaddy.auxiliar": "cortafuegos-anfitrion"}
	hc := c["HostConfig"].(map[string]any)
	hc["Binds"] = []string{carpetaAnfitrion + ":/confirmar:ro"}
	return c
}
