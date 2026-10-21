package despliegue

import (
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// ——— las pruebas del reparto de IP propias (hallazgos 3, 7 y 9) ———
//
// El sondeo real (red.Libre) necesita AF_PACKET (Linux): aquí se sustituye
// por uno de mentira que apunta qué candidata se sondeó y responde lo que la
// prueba quiere, igual que el banco sustituye la macvlan por su puente. Y lo
// mismo con las direcciones del anfitrión (net.InterfaceAddrs).

// limpiarIPs vacía el reparto (estado global entre pruebas) y lo vuelve a
// vaciar al acabar: una prueba no le deja direcciones a la siguiente.
func limpiarIPs(t *testing.T) {
	t.Helper()
	vaciar := func() {
		muIP.Lock()
		ipsPropias.por = map[string]string{}
		ipsPropias.de = map[string]string{}
		ipsPropias.mac = map[string]string{}
		ipsPropias.siguiente = map[string]int{}
		ipsPropias.acumuladas = map[string]int{}
		muIP.Unlock()
	}
	vaciar()
	t.Cleanup(vaciar)
}

// sondeoMentira apunta las IP que se sondean y solo da por libres las de su
// lista; las demás, ocupadas.
type sondeoMentira struct {
	mu       sync.Mutex
	sondadas []string
	libres   map[string]bool
}

func (s *sondeoMentira) libre(_ string, ip netip.Addr, _ time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sondadas = append(s.sondadas, ip.String())
	return s.libres[ip.String()], nil
}

func (s *sondeoMentira) cuantas() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sondadas)
}

func (s *sondeoMentira) sondeadasSet() map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	set := map[string]bool{}
	for _, ip := range s.sondadas {
		set[ip] = true
	}
	return set
}

// addrsMentira sustituye a net.InterfaceAddrs con direcciones fijas (como
// *net.IPNet, que es como vienen de verdad).
func addrsMentira(ips ...string) func() ([]net.Addr, error) {
	return func() ([]net.Addr, error) {
		lista := make([]net.Addr, 0, len(ips))
		for _, ip := range ips {
			lista = append(lista, &net.IPNet{IP: net.ParseIP(ip)})
		}
		return lista, nil
	}
}

func opcionesPropias(t *testing.T, rango string) Opciones {
	t.Helper()
	limpiarIPs(t)
	originalSondeo, originalAddrs := sondeoLibre, addrsDelAnfitrion
	t.Cleanup(func() { sondeoLibre, addrsDelAnfitrion = originalSondeo, originalAddrs })
	return Opciones{RedPropia: &RedPropia{Interfaz: "en0", Rango: netip.MustParsePrefix(rango)}}
}

// TestIPPropiaSaltaLasDireccionesDelAnfitrion (hallazgo 3): las IP del
// anfitrión no se pueden sondear por ARP (la sonda sale del propio anfitrión
// y su kernel no contesta a sus tramas transmitidas) — tienen que saltarse
// SIN sondearlas, o el reparto da por libre la IP del sensor mismo.
func TestIPPropiaSaltaLasDireccionesDelAnfitrion(t *testing.T) {
	o := opcionesPropias(t, "10.0.0.0/28")
	// El anfitrión tiene todas las candidatas del rango… menos la 10.0.0.7.
	delAnfitrion := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4",
		"10.0.0.5", "10.0.0.6", "10.0.0.8", "10.0.0.9", "10.0.0.10", "10.0.0.11",
		"10.0.0.12", "10.0.0.13", "10.0.0.14", "192.168.1.5", "127.0.0.1"}
	addrsDelAnfitrion = addrsMentira(delAnfitrion...)
	sondeo := &sondeoMentira{libres: map[string]bool{"10.0.0.7": true}}
	sondeoLibre = sondeo.libre
	ip, err := IPPropia(o, plan.TrampaPlan{ID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	if ip != "10.0.0.7" {
		t.Fatalf("la única candidata que no es del anfitrión es la 10.0.0.7, salió %s", ip)
	}
	// Y ninguna dirección del anfitrión pasó por el sondeo.
	sondeadas := sondeo.sondeadasSet()
	for _, dir := range delAnfitrion {
		if sondeadas[dir] {
			t.Fatalf("la dirección del anfitrión %s se sondeó: el kernel del propio anfitrión no contesta a sus tramas, sondearla es darla por libre", dir)
		}
	}
}

// TestIPPropiaNoSondeaLaDifusion (hallazgo 7): la última dirección del rango
// es la de difusión («la .255» de un /24, la .15 de un /28, la .3 de un /30):
// darle una trampa es pelearse con el protocolo IP mismo.
func TestIPPropiaNoSondeaLaDifusion(t *testing.T) {
	o := opcionesPropias(t, "10.0.0.4/30")
	addrsDelAnfitrion = addrsMentira("192.168.1.5")
	sondeo := &sondeoMentira{libres: map[string]bool{"10.0.0.6": true, "10.0.0.7": true}}
	sondeoLibre = sondeo.libre
	ip, err := IPPropia(o, plan.TrampaPlan{ID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	if ip != "10.0.0.6" {
		t.Fatalf("en un /30 la única candidata útil es la 10.0.0.6 (la .7 es la difusión), salió %s", ip)
	}
	sondeadas := sondeo.sondeadasSet()
	if sondeadas["10.0.0.7"] {
		t.Fatal("la dirección de difusión 10.0.0.7 se sondeó: no es una candidata, es de todo el segmento")
	}
}

// TestIPPropiaTopeDeSondasPorLlamada (hallazgo 9): el sondeo de una candidata
// lleva hasta 3 s y Aplicar corre en el bucle de eventos del sensor; con el
// rango ocupado entero, sondearlo de un tirón (14×3 s aquí; 4096×3 s en el
// tope mayor) congelaría la lectura de registros y la entrega de TODAS las
// trampas. Cada llamada sondea como mucho topeSondas y la siguiente sigue
// por donde se quedó — sin perder el rastreo (cuando el anillo entero queda
// visto y ocupado, se dice eso, no «a la vista»).
func TestIPPropiaTopeDeSondasPorLlamada(t *testing.T) {
	o := opcionesPropias(t, "10.0.0.0/28")
	addrsDelAnfitrion = addrsMentira("192.168.1.5")
	sondeo := &sondeoMentira{libres: map[string]bool{}} // todo ocupado
	sondeoLibre = sondeo.libre
	s := plan.TrampaPlan{ID: "t1"}
	// Primera llamada: tope de sondeos y «sigue en la siguiente».
	_, err1 := IPPropia(o, s)
	if err1 == nil || !strings.Contains(err1.Error(), "a la vista") {
		t.Fatalf("primera llamada con el rango ocupado: %v", err1)
	}
	if sondeo.cuantas() != topeSondas {
		t.Fatalf("la primera llamada sondeó %d candidatas, quería %d (el tope)", sondeo.cuantas(), topeSondas)
	}
	// Segunda llamada: sigue por donde se quedó y termina de ver el anillo.
	_, err2 := IPPropia(o, s)
	if err2 == nil || !strings.Contains(err2.Error(), "equipo en todas") {
		t.Fatalf("segunda llamada con el rango ocupado: %v", err2)
	}
	// El anillo útil de un /28 son 13 candidatas (14 menos la difusión):
	// entre las dos llamadas se vieron TODAS, cada una una sola vez.
	sondeadas := sondeo.sondeadasSet()
	if len(sondeadas) != 13 || sondeo.cuantas() != 13 {
		t.Fatalf("sondeadas %d (distintas %d): el anillo entero son 13 candidatas sin repetir", sondeo.cuantas(), len(sondeadas))
	}
	if sondeadas["10.0.0.15"] {
		t.Fatal("la difusión 10.0.0.15 se sondeó")
	}
}

// TestIPPropiaSinRangoUtil (hallazgos 3 y 7 juntos): un rango donde todo es
// difusión o direcciones del anfitrión no da candidata — error claro, sin
// inventarse una IP.
func TestIPPropiaSinRangoUtil(t *testing.T) {
	o := opcionesPropias(t, "10.0.0.4/30")
	addrsDelAnfitrion = addrsMentira("10.0.0.6")
	sondeo := &sondeoMentira{libres: map[string]bool{}}
	sondeoLibre = sondeo.libre
	_, err := IPPropia(o, plan.TrampaPlan{ID: "t1"})
	if err == nil || !strings.Contains(err.Error(), "ninguna candidata") {
		t.Fatalf("un /30 con la .6 del anfitrión no tiene candidata: %v", err)
	}
	if sondeo.cuantas() != 0 {
		t.Fatal("sin candidatas no se sondea nada")
	}
}

// TestConfigRechazaModoDeRedDesconocido (hallazgo 11): el sensor solo
// entiende UN modo de red («ip-propia»); un manifiesto con cualquier otra
// cosa (aunque el esquema de la consola lo cierre) se rechaza — no se
// despliega en un puente aislado como si nada, que es lo que el dueño de la
// trampa NO pidió.
func TestConfigRechazaModoDeRedDesconocido(t *testing.T) {
	limpiarIPs(t)
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
	for _, modo := range []string{"", "macvlan", "host", "ip-propia "} {
		s := trampa("t1", "r/nueva@sha256:2")
		s.Manifiesto.Red = &plan.RedTrampa{Modo: modo}
		_, _, err := config(o, "s1", "", s)
		if err == nil || !strings.Contains(err.Error(), "ip-propia") {
			t.Fatalf("modo %q: se esperaba el rechazo del sensor, salió %v", modo, err)
		}
	}
	// Y el modo bueno llega al reparto de IP (que aquí, sin sensor «IP
	// propia», es el error claro de «este sensor no lo trae»).
	s := trampa("t1", "r/nueva@sha256:2")
	s.Manifiesto.Red = &plan.RedTrampa{Modo: "ip-propia"}
	_, _, err := config(o, "s1", "", s)
	if err == nil || !strings.Contains(err.Error(), "no lo trae") {
		t.Fatalf("modo «ip-propia» en un sensor sin modo de red: %v", err)
	}
}

// TestSoltarIPsFuera (hallazgo N3 de la re-revisión): una trampa que sale del
// plan suelta su IP (y su MAC); la que se queda en el plan, no. Sin esto el
// registro conservaba la IP de trampas retiradas para siempre y una
// reinstalada con el mismo id heredaba su IP vieja sin sondearla.
func TestSoltarIPsFuera(t *testing.T) {
	limpiarIPs(t)
	muIP.Lock()
	ipsPropias.por = map[string]string{"t1": "10.0.0.2", "t2": "10.0.0.3", "t3": "10.0.0.4"}
	ipsPropias.de = map[string]string{"10.0.0.2": "t1", "10.0.0.3": "t2", "10.0.0.4": "t3"}
	ipsPropias.mac = map[string]string{"t1": "aa:bb", "t2": "bb:cc", "t3": "cc:dd"}
	muIP.Unlock()

	// El plan nuevo solo trae a t2: t1 y t3 se retiraron.
	SoltarIPsFuera(map[string]bool{"t2": true})

	muIP.Lock()
	defer muIP.Unlock()
	if len(ipsPropias.por) != 1 || ipsPropias.por["t2"] != "10.0.0.3" {
		t.Fatalf("solo la trampa que queda en el plan conserva su IP; por=%v", ipsPropias.por)
	}
	if len(ipsPropias.de) != 1 || ipsPropias.de["10.0.0.3"] != "t2" {
		t.Fatalf("el mapa inverso también se limpia; de=%v", ipsPropias.de)
	}
	for _, id := range []string{"t1", "t3"} {
		if _, ok := ipsPropias.mac[id]; ok {
			t.Fatalf("la trampa retirada %s conserva su MAC apuntada", id)
		}
	}
}
