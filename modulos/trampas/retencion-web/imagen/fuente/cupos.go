// Código propio de SeguridadSI (no viene de go-pot) para la trampa
// retencion-web de Sugardaddy. preparar.sh lo copia a protocol/http/logging/
// y server.go envuelve con él el listener de Fiber.
//
// go-pot no limita las conexiones por IP: una sola IP podía abrir las 4096
// que admite Fiber (Concurrency), y a todos los demás fasthttp les contestaba
// con su texto («The connection cannot be served because Server.Concurrency
// limit exceeded»), que delata la trampa, sin apuntar nada. Su MaxConnsPerIP
// tampoco sirve: contesta con otro texto suyo. Aquí, como mucho porIP
// conexiones abiertas a la vez por IP y total en total (por debajo de
// Concurrency, así que fasthttp nunca llega a su tope). Las de más se cierran
// nada más aceptarlas, sin contestar, y salen en un resumen por minuto (phase
// "rechazos"), no una línea por cada una.
//
// Y ninguna conexión ocupa su hueco sin hacer nada: con ReduceMemoryUsage,
// fasthttp espera el primer byte de la primera petición sin ningún plazo
// (ReadTimeout empieza con ese byte e IdleTimeout con la segunda petición), y
// una conexión callada se quedaba dentro para siempre. Al aceptarla se le da
// un plazo para ese primer byte; cuando llega, fasthttp pone el suyo.
//
// Reparto justo con todo lleno (hallazgo): con solo los dos topes, quien
// tuviera total/porIP IP (20 con 120 MiB) y mantuviera vivas sus conexiones
// (una petición barata antes de cada plazo, o reabriéndolas) ocupaba todo el
// sitio, y las de cualquier otra IP se cerraban sin apuntar nada: la trampa,
// ciega. Ahora, con todo lleno, una IP con menos de garantizadas conexiones
// abiertas entra igualmente si otra tiene al menos dos más que ella: se
// desaloja una de la IP que más tiene (la más antigua sin petición en curso;
// si todas tienen una, la más antigua). Así, para dejar fuera a una IP nueva,
// cada hueco tiene que ser de una IP distinta: hacen falta tantas IP como
// huecos (1.228 con 120 MiB), no total/porIP. La memoria no cambia: el total
// es el mismo. Las desalojadas salen en el mismo resumen por minuto.
//
// Una desalojada no se cierra desde aquí: cerrar el socket mientras fasthttp
// lo usa le hace fallar SetReadDeadline, y ahí fasthttp entra en pánico y se
// cae el proceso. Se marca, y su Read y su Write fallan desde ese momento
// (con un plazo ya vencido para despertar al que esté esperando): fasthttp la
// trata como una de la que se ha ido el cliente y la cierra él, sin contestar.
package logging

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// errDesalojada: lo que devuelve el Write de una conexión desalojada.
var errDesalojada = errors.New("conexión desalojada para dejar sitio a otra IP")

// plazoVencido: el plazo que despierta a quien espera en una desalojada.
var plazoVencido = time.Unix(1, 0)

type limitador struct {
	net.Listener
	porIP, total, garantizadas int
	periodo                    time.Duration
	primerByte                 time.Duration

	mu      sync.Mutex
	activas int
	deIP    map[string]*deUnaIP
	// porCuenta[n]: las IP con n conexiones abiertas (1..porIP), y maxCuenta
	// la n más alta con alguna. Elegir a quién desalojar no recorre todas las
	// IP: con cada conexión que llega o se va, una IP sube o baja uno.
	porCuenta []map[*deUnaIP]struct{}
	maxCuenta int
	rech      rechazos
	parar     chan struct{}
	hecho     chan struct{} // se cierra tras el último resumen (si hay quien los escriba)
	cerrar    sync.Once
}

// deUnaIP: las conexiones abiertas de una IP, de la más antigua a la más nueva.
type deUnaIP struct {
	ip    string
	conns []*conexionLimitada
}

// rechazos del periodo, para su resumen. ips cuenta, de cada IP, sus
// conexiones rechazadas y desalojadas.
type rechazos struct {
	total, global, porIP int
	desalojadas          int
	ips                  map[string]int
	sinContar            int
}

// LimitarConexiones envuelve ln con los topes de conexiones abiertas (por IP
// y en total) y el reparto justo cuando todo está lleno (garantizadas por
// IP), da a cada una primerByte para empezar a hablar y escribe cada periodo
// el resumen de las rechazadas y las desalojadas.
func LimitarConexiones(ln net.Listener, porIP, total, garantizadas int, periodo, primerByte time.Duration) net.Listener {
	l := nuevoLimitador(ln, porIP, total, garantizadas, periodo, primerByte)
	l.hecho = make(chan struct{})
	go func() {
		defer close(l.hecho)
		t := time.NewTicker(periodo)
		defer t.Stop()
		for {
			select {
			case <-l.parar:
				l.resumir()
				return
			case <-t.C:
				l.resumir()
			}
		}
	}()
	return l
}

func nuevoLimitador(ln net.Listener, porIP, total, garantizadas int, periodo, primerByte time.Duration) *limitador {
	porIP, total = max(porIP, 1), max(total, 1)
	l := &limitador{Listener: ln, porIP: porIP, total: total, garantizadas: min(max(garantizadas, 0), porIP),
		periodo: periodo, primerByte: primerByte, deIP: map[string]*deUnaIP{},
		porCuenta: make([]map[*deUnaIP]struct{}, porIP+1), parar: make(chan struct{})}
	for i := range l.porCuenta {
		l.porCuenta[i] = map[*deUnaIP]struct{}{}
	}
	return l
}

func (l *limitador) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		cl := &conexionLimitada{Conn: c, l: l, ip: ipDe(c.RemoteAddr())}
		dentro, desalojada := l.admitir(cl)
		if desalojada != nil {
			// Ya está marcada: su Read y su Write fallan. Esto despierta al
			// que esté esperando en ella. Si falla, es que ya se estaba
			// cerrando.
			_ = desalojada.Conn.SetDeadline(plazoVencido)
		}
		if !dentro {
			// Ni una palabra: se cierra sin leer ni contestar.
			c.Close()
			continue
		}
		// Plazo para el primer byte. Si no llega, fasthttp lo toma por un
		// cierre (io.EOF): cierra sin contestar ni apuntar y el hueco vuelve.
		// Si no se puede poner, fuera: sin plazo no entra ninguna.
		if err := c.SetReadDeadline(time.Now().Add(l.primerByte)); err != nil {
			cl.Close()
			continue
		}
		return cl, nil
	}
}

// Close espera al último resumen: al pararse la trampa no se pierde, y no
// acaba en el registro de lo que venga después.
func (l *limitador) Close() error {
	l.cerrar.Do(func() {
		close(l.parar)
		if l.hecho != nil {
			<-l.hecho
		}
	})
	return l.Listener.Close()
}

// admitir decide si c entra. Con todo lleno, puede entrar desalojando a otra:
// la devuelve ya fuera de las cuentas y marcada, para que Accept la despierte.
func (l *limitador) admitir(c *conexionLimitada) (dentro bool, desalojada *conexionLimitada) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	if d := l.deIP[c.ip]; d != nil {
		n = len(d.conns)
	}
	switch {
	case n >= l.porIP:
		l.rech.porIP++
	case l.activas < l.total:
		l.meter(c)
		return true, nil
	case n < l.garantizadas && l.maxCuenta > n+1:
		desalojada = l.aDesalojar()
		desalojada.desalojada.Store(true)
		l.sacar(desalojada)
		l.rech.desalojadas++
		l.contarIP(desalojada.ip)
		l.meter(c)
		return true, desalojada
	default:
		l.rech.global++
	}
	l.rech.total++
	l.contarIP(c.ip)
	return false, nil
}

// aDesalojar: de una de las IP que más conexiones tienen, la más antigua sin
// una petición en curso; si todas tienen una, la más antigua.
func (l *limitador) aDesalojar() *conexionLimitada {
	var d *deUnaIP
	for d = range l.porCuenta[l.maxCuenta] {
		break
	}
	for _, c := range d.conns {
		if !c.activa.Load() {
			return c
		}
	}
	return d.conns[0]
}

func (l *limitador) contarIP(ip string) {
	if l.rech.ips == nil {
		l.rech.ips = map[string]int{}
	}
	if _, ok := l.rech.ips[ip]; ok || len(l.rech.ips) < maxIPsResumen {
		l.rech.ips[ip]++
	} else {
		l.rech.sinContar++
	}
}

// meter y sacar llevan las cuentas (con l.mu).
func (l *limitador) meter(c *conexionLimitada) {
	d := l.deIP[c.ip]
	if d == nil {
		d = &deUnaIP{ip: c.ip}
		l.deIP[c.ip] = d
	}
	l.mover(d, len(d.conns), len(d.conns)+1)
	d.conns = append(d.conns, c)
	l.activas++
}

func (l *limitador) sacar(c *conexionLimitada) {
	c.fuera = true
	d := l.deIP[c.ip]
	if d == nil {
		return
	}
	i := slices.Index(d.conns, c)
	if i < 0 {
		return
	}
	n := len(d.conns)
	d.conns = slices.Delete(d.conns, i, i+1)
	l.mover(d, n, n-1)
	if n == 1 {
		delete(l.deIP, c.ip)
	}
	l.activas--
}

// mover pasa d de tener de conexiones a tener a (se diferencian en uno).
func (l *limitador) mover(d *deUnaIP, de, a int) {
	if de > 0 {
		delete(l.porCuenta[de], d)
	}
	if a > 0 {
		l.porCuenta[a][d] = struct{}{}
	}
	l.maxCuenta = max(l.maxCuenta, a)
	for l.maxCuenta > 0 && len(l.porCuenta[l.maxCuenta]) == 0 {
		l.maxCuenta--
	}
}

func (l *limitador) soltar(c *conexionLimitada) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !c.fuera {
		l.sacar(c)
	}
}

// resumir escribe el resumen de las rechazadas y las desalojadas en el
// periodo, si las hubo, a nombre de la IP con más de las dos.
func (l *limitador) resumir() {
	l.mu.Lock()
	r := l.rech
	l.rech = rechazos{}
	activas := l.activas
	l.mu.Unlock()
	if r.total == 0 && r.desalojadas == 0 {
		return
	}
	var ip string
	var deIP int
	for k, v := range r.ips {
		if v > deIP || v == deIP && k < ip {
			ip, deIP = k, v
		}
	}
	m := map[string]any{
		"level": "warn", "ts": time.Now().UTC().Format(time.RFC3339Nano), "msg": "", "id": uuid.NewString(),
		"phase": "rechazos", "src_ip": ip, "de_su_ip": deIP, "rechazadas": r.total,
		"por_tope_global": r.global, "por_tope_ip": r.porIP, "desalojadas": r.desalojadas,
		"ips_distintas": len(r.ips), "activas": activas, "periodo_s": int(l.periodo / time.Second),
	}
	if r.sinContar > 0 {
		m["ips_sin_contar"] = r.sinContar
	}
	b, _ := json.Marshal(m)
	b = append(b, '\n')
	if rot := rotadorActivo.Load(); rot != nil {
		_, _ = rot.Write(b)
	} else {
		_, _ = os.Stderr.Write(b)
	}
}

// conexionLimitada devuelve su hueco al cerrarse (una sola vez, aunque
// fasthttp la cierre más de una) o al ser desalojada.
type conexionLimitada struct {
	net.Conn
	l          *limitador
	ip         string
	activa     atomic.Bool // con una petición en curso (MarcarActiva)
	desalojada atomic.Bool // su Read y su Write ya solo fallan
	fuera      bool        // ya sin hueco (con l.mu)
}

// Read de una desalojada: io.EOF, como si se hubiera ido el cliente, también
// para la que esperaba y ha despertado con el plazo vencido. fasthttp la
// cierra entonces sin contestar ni apuntar nada.
func (c *conexionLimitada) Read(b []byte) (int, error) {
	if c.desalojada.Load() {
		return 0, io.EOF
	}
	n, err := c.Conn.Read(b)
	if err != nil && c.desalojada.Load() {
		return n, io.EOF
	}
	return n, err
}

func (c *conexionLimitada) Write(b []byte) (int, error) {
	if c.desalojada.Load() {
		return 0, errDesalojada
	}
	return c.Conn.Write(b)
}

func (c *conexionLimitada) Close() error {
	c.l.soltar(c)
	return c.Conn.Close()
}

// MarcarActiva es para el ConnState de fasthttp: activa mientras lee o
// atiende una petición; si no (esperando su primer byte o la siguiente
// petición), es la primera que se desaloja de su IP.
func MarcarActiva(c net.Conn, activa bool) {
	if cl, ok := c.(*conexionLimitada); ok {
		cl.activa.Store(activa)
	}
}

// Desalojada: si c es una conexión ya desalojada. Lo que falle en ella no es
// de la petición: ni se contesta ni se apunta.
func Desalojada(c net.Conn) bool {
	cl, ok := c.(*conexionLimitada)
	return ok && cl.desalojada.Load()
}

func ipDe(a net.Addr) string {
	if t, ok := a.(*net.TCPAddr); ok {
		return t.IP.String()
	}
	host, _, _ := net.SplitHostPort(a.String())
	return host
}
