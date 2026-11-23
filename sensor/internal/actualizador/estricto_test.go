package actualizador

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

type consolaEstricta struct {
	mu       sync.Mutex
	cfg      ConfigEstricto
	caida    bool
	informes []map[string]any
	rutas    []string
}

func (c *consolaEstricta) servidor(t *testing.T) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.caida {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		c.rutas = append(c.rutas, r.URL.Path)
		ruta := strings.Replace(r.URL.Path, RutaAnfitrionSensor, RutaAnfitrionNodo, 1)
		switch ruta {
		case "/api/actualizador/anfitrion":
			_ = json.NewEncoder(w).Encode(c.cfg)
		case "/api/actualizador/anfitrion/cortafuegos":
			var m map[string]any
			_ = json.NewDecoder(r.Body).Decode(&m)
			c.informes = append(c.informes, m)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func nodoEstricto(t *testing.T, c *consolaEstricta) (*EstrictoNodo, *[]string, string) {
	d := t.TempDir()
	_ = os.WriteFile(filepath.Join(d, ".env"), []byte("CONSOLA_PUERTO=443\n"), 0o600)
	_ = os.WriteFile(filepath.Join(d, "versiones.env"), []byte("ACTUALIZADOR_IMAGEN=r/a@sha256:1\n"), 0o600)
	s := c.servidor(t)
	var lanzados []string
	e := &EstrictoNodo{Consola: s.URL, Token: "t", HTTP: s.Client(), Local: d, Anfitrion: "/opt/sugardaddy",
		Publicados: func(context.Context) ([]cortafuegos.Publicado, error) {
			return []cortafuegos.Publicado{{Proto: "tcp", Puerto: 443}, {Proto: "tcp", Puerto: 22}}, nil
		},
		Resolver: func(_ context.Context, h string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("20.0.0.1")}, nil
		},
		Marcar: func(context.Context, string) error { return nil },
		// El doble del auxiliar: como el de verdad, confirma o vuelve atrás.
		Lanzar: func(_ context.Context, _ string, env []string, confirmar func(string) bool) cortafuegos.ResultadoEstricto {
			lanzados = append(lanzados, strings.Join(env, " "))
			if confirmar == nil {
				return cortafuegos.ResultadoEstricto{Estado: cortafuegos.EstrictoQuitado, Detalle: "removed"}
			}
			var est cortafuegos.Estricto
			_ = json.Unmarshal([]byte(strings.TrimPrefix(env[0], "ESTRICTO=")), &est)
			h, _ := cortafuegos.HuellaEstricto(est)
			if !confirmar(h) {
				return cortafuegos.ResultadoEstricto{Estado: cortafuegos.EstrictoRevertido, Huella: h}
			}
			b, _ := os.ReadFile(filepath.Join(d, CarpetaEstricto, "confirmado"))
			if string(b) != h {
				t.Fatal("the confirmation file must carry the fingerprint")
			}
			return cortafuegos.ResultadoEstricto{Estado: cortafuegos.EstrictoAplicado, Huella: h}
		},
	}
	return e, &lanzados, d
}

func TestEstrictoNodoAplicaYRepasa(t *testing.T) {
	c := &consolaEstricta{}
	c.cfg.Estricto = true
	c.cfg.Consola.Estado = "restringida"
	c.cfg.Consola.Redes = []string{"192.0.2.0/24"}
	e, lanzados, d := nodoEstricto(t, c)
	if err := e.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.Estado() != cortafuegos.EstrictoAplicado || len(*lanzados) != 1 {
		t.Fatalf("%s %v", e.Estado(), *lanzados)
	}
	if b, err := os.ReadFile(filepath.Join(d, CarpetaEstricto, "reglas.nft")); err != nil || !strings.Contains(string(b), "192.0.2.0/24") {
		t.Fatal("the confirmed rules must be kept for the boot unit")
	}
	if len(c.informes) != 1 || c.informes[0]["estado"] != "aplicada" {
		t.Fatalf("%v", c.informes)
	}
	// Nada cambia: no se relanza hasta el repaso.
	_ = e.Vuelta(context.Background())
	if len(*lanzados) != 1 {
		t.Fatal("unchanged rules must not relaunch the helper before the review")
	}
	ahora := time.Now().Add(RepasoEstricto + time.Second)
	e.Ahora = func() time.Time { return ahora }
	_ = e.Vuelta(context.Background())
	if len(*lanzados) != 2 {
		t.Fatal("the review must relaunch the helper (a reboot empties the rules)")
	}
	// Cambia la lista: se relanza.
	c.cfg.Consola.Redes = []string{"198.51.100.1"}
	_ = e.Vuelta(context.Background())
	if len(*lanzados) != 3 {
		t.Fatal("a new list must relaunch the helper")
	}
}

// Un sensor remoto: pregunta y cuenta por las rutas del sensor, no abre ningún puerto
// de consola (en su máquina no la hay), sale siempre a su consola y a la copia
// estática, y con proxy, el proxy es lo que se deja y lo que se comprueba.
func TestEstrictoSensorRemoto(t *testing.T) {
	c := &consolaEstricta{}
	c.cfg.Estricto = true
	c.cfg.Consola.Estado = "restringida"
	c.cfg.Consola.Redes = []string{"192.0.2.0/24"}
	c.cfg.Salida.Restringida = true
	c.cfg.Salida.Destinos = []string{"registro.example:443"}
	c.cfg.Salida.Comprobar = []string{"registro.example:443"}
	e, lanzados, d := nodoEstricto(t, c)
	e.Ruta, e.SinConsola = RutaAnfitrionSensor, true
	e.Propios = []string{"consola.empresa.local:443", "raw.githubusercontent.com:443", ""}
	e.Proxy = "10.9.9.9:3128"
	var marcados []string
	e.Marcar = func(_ context.Context, dir string) error {
		marcados = append(marcados, dir)
		return nil
	}
	resueltos := map[string]bool{}
	e.Resolver = func(_ context.Context, h string) ([]netip.Addr, error) {
		resueltos[h] = true
		return []netip.Addr{netip.MustParseAddr("20.0.0.1")}, nil
	}
	if err := e.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.Estado() != cortafuegos.EstrictoAplicado || len(*lanzados) != 1 {
		t.Fatalf("%s %v", e.Estado(), *lanzados)
	}
	for _, r := range c.rutas {
		if !strings.HasPrefix(r, RutaAnfitrionSensor) {
			t.Fatalf("a remote sensor must use the sensor routes, used %s", r)
		}
	}
	var est cortafuegos.Estricto
	_ = json.Unmarshal([]byte(strings.TrimPrefix(strings.Fields((*lanzados)[0])[0], "ESTRICTO=")), &est)
	if est.Consola.Puerto != 0 || len(est.Consola.Redes) != 0 {
		t.Fatalf("no console port on a remote sensor: %+v", est.Consola)
	}
	for _, h := range []string{"registro.example", "consola.empresa.local", "raw.githubusercontent.com"} {
		if !resueltos[h] {
			t.Errorf("%s must be an allowed destination", h)
		}
	}
	proxy := false
	for _, x := range est.Salida.Destinos {
		proxy = proxy || (x.IP == "10.9.9.9" && x.Puerto == 3128)
	}
	if !proxy {
		t.Fatalf("the proxy must be allowed: %+v", est.Salida.Destinos)
	}
	if len(marcados) != 1 || marcados[0] != "10.9.9.9:3128" {
		t.Fatalf("with a proxy, the proxy is what is checked before confirming: %v", marcados)
	}
	b, _ := os.ReadFile(filepath.Join(d, CarpetaEstricto, "reglas.nft"))
	if strings.Contains(string(b), "@consola4 accept") {
		t.Fatal("the kept rules must not open a console port")
	}
}

func TestDestinoDeURL(t *testing.T) {
	for u, esperado := range map[string]string{
		"https://consola.empresa.local":       "consola.empresa.local:443",
		"https://consola.empresa.local:8443/": "consola.empresa.local:8443",
		"http://usuario:clave@proxy:3128":     "proxy:3128",
		"https://[2001:db8::1]/x":             "[2001:db8::1]:443",
		"ftp://x":                             "",
		"":                                    "",
		"proxy:3128":                          "",
	} {
		if r := DestinoDeURL(u); r != esperado {
			t.Errorf("%q: %q, expected %q", u, r, esperado)
		}
	}
}

func TestEstrictoNodoSinConfirmarNoGuardaReglas(t *testing.T) {
	c := &consolaEstricta{}
	c.cfg.Estricto = true
	c.cfg.Consola.Estado = "abierta"
	c.cfg.Salida.Restringida = true
	c.cfg.Salida.Destinos = []string{"panel.example:443", "10.0.0.5:6514"}
	c.cfg.Salida.Comprobar = []string{"panel.example:443"}
	e, _, d := nodoEstricto(t, c)
	e.Marcar = func(context.Context, string) error { return os.ErrDeadlineExceeded } // el panel no responde
	if err := e.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.Estado() != cortafuegos.EstrictoRevertido {
		t.Fatalf("%s", e.Estado())
	}
	if _, err := os.Stat(filepath.Join(d, CarpetaEstricto, "reglas.nft")); err == nil {
		t.Fatal("unconfirmed rules must not be loaded at boot")
	}
	// Las IP resueltas quedan apuntadas.
	b, _ := os.ReadFile(filepath.Join(d, CarpetaEstricto, "resueltas.json"))
	if !strings.Contains(string(b), "20.0.0.1") {
		t.Fatalf("%s", b)
	}
}

func TestEstrictoNodoApagadoYEmergencia(t *testing.T) {
	c := &consolaEstricta{}
	e, lanzados, d := nodoEstricto(t, c)
	_ = e.Vuelta(context.Background())
	if len(*lanzados) != 1 || (*lanzados)[0] != "ESTRICTO_QUITAR=1" || e.Estado() != cortafuegos.EstrictoQuitado {
		t.Fatalf("off: the table must be removed once: %v", *lanzados)
	}
	_ = e.Vuelta(context.Background())
	if len(*lanzados) != 1 {
		t.Fatal("off twice must not relaunch")
	}
	// Encendido y, después, el fichero de emergencia con la consola caída.
	c.cfg.Estricto = true
	c.cfg.Consola.Estado = "abierta"
	_ = e.Vuelta(context.Background())
	if e.Estado() != cortafuegos.EstrictoAplicado {
		t.Fatal(e.Estado())
	}
	_ = os.WriteFile(filepath.Join(d, FicheroAbrir), nil, 0o600)
	c.caida = true
	_ = e.Vuelta(context.Background())
	if e.Estado() != cortafuegos.EstrictoSuspendido || (*lanzados)[len(*lanzados)-1] != "ESTRICTO_QUITAR=1" {
		t.Fatalf("the emergency file must lift the strict firewall even without the console: %s", e.Estado())
	}
	// La consola vuelve y dice que la emergencia sigue: sigue suspendido, sin relanzar.
	_ = os.Remove(filepath.Join(d, FicheroAbrir))
	c.caida = false
	c.cfg.Emergencia = true
	n := len(*lanzados)
	_ = e.Vuelta(context.Background())
	if e.Estado() != cortafuegos.EstrictoSuspendido || len(*lanzados) != n {
		t.Fatal("still suspended during the emergency")
	}
}

func TestEstrictoNodoAislamientoNo(t *testing.T) {
	c := &consolaEstricta{}
	c.cfg.Estricto = true
	e, lanzados, d := nodoEstricto(t, c)
	_ = os.WriteFile(filepath.Join(d, ".env"), []byte("AISLAMIENTO_ANFITRION=no\n"), 0o600)
	_ = e.Vuelta(context.Background())
	if len(*lanzados) != 0 {
		t.Fatal("AISLAMIENTO_ANFITRION=no: the node does not touch the machine firewall")
	}
}

func TestPublicadosDe(t *testing.T) {
	l := []docker.Contenedor{{Ports: []docker.PuertoPublicado{{IP: "0.0.0.0", PublicPort: 22, Type: "tcp"}, {PublicPort: 0, Type: "tcp"}, {PublicPort: 53, Type: "udp"}, {PublicPort: 9, Type: "sctp"}}}}
	p := PublicadosDe(l)
	if len(p) != 2 || p[0].Puerto != 22 || p[1].Proto != "udp" {
		t.Fatalf("%+v", p)
	}
}

func TestConfigCortafuegosAnfitrion(t *testing.T) {
	c := ConfigCortafuegosAnfitrion("r/a@sha256:1", []string{"ESTRICTO={}"}, "/opt/sugardaddy/cortafuegos-anfitrion")
	hc := c["HostConfig"].(map[string]any)
	if hc["NetworkMode"] != "host" || hc["Privileged"] != nil || hc["Binds"].([]string)[0] != "/opt/sugardaddy/cortafuegos-anfitrion:/confirmar:ro" {
		t.Fatalf("%v", c)
	}
}

// Una salida syslog por UDP llega aparte (destinosUdp) y sale con su protocolo.
func TestEstrictoDestinosUDP(t *testing.T) {
	c := &consolaEstricta{}
	c.cfg.Estricto = true
	c.cfg.Consola.Estado = "restringida"
	c.cfg.Consola.Redes = []string{"192.0.2.0/24"}
	c.cfg.Salida.Restringida = true
	c.cfg.Salida.Destinos = []string{"registro.example:443"}
	c.cfg.Salida.DestinosUDP = []string{"siem.example:514", "10.0.0.9:514"}
	c.cfg.Salida.Comprobar = []string{"registro.example:443"}
	e, lanzados, _ := nodoEstricto(t, c)
	e.Marcar = func(context.Context, string) error { return nil }
	e.Resolver = func(_ context.Context, h string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("20.0.0.1")}, nil
	}
	if err := e.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*lanzados) != 1 {
		t.Fatalf("%s %v", e.Estado(), *lanzados)
	}
	var est cortafuegos.Estricto
	_ = json.Unmarshal([]byte(strings.TrimPrefix(strings.Fields((*lanzados)[0])[0], "ESTRICTO=")), &est)
	var udp, tcp []string
	for _, d := range est.Salida.Destinos {
		x := fmt.Sprintf("%s:%d", d.IP, d.Puerto)
		if d.Proto == "udp" {
			udp = append(udp, x)
		} else {
			tcp = append(tcp, x)
		}
	}
	slices.Sort(udp)
	if !slices.Equal(udp, []string{"10.0.0.9:514", "20.0.0.1:514"}) || !slices.Contains(tcp, "20.0.0.1:443") || slices.Contains(tcp, "10.0.0.9:514") {
		t.Fatalf("udp %v tcp %v", udp, tcp)
	}
}
