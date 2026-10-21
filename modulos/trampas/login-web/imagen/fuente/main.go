package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Trampa de portal de login web de Sugardaddy. Código propio de SeguridadSI,
// sin dependencias (solo la biblioteca estándar de Go), escrito desde el
// comportamiento observable de un portal web de login: formulario GET + POST
// con credenciales, páginas de error verosímiles, 404 plausibles en rutas que
// no existen. Finge la web interna de acceso (intranet, panel de
// administración o portal del empleado) en el 8080.
//
// No ejecuta NADA de lo que pide el atacante, nunca abre una conexión hacia
// fuera y solo escribe su propio registro, acotado por IP y en total (ver
// registro.go). Registra el usuario y la contraseña probados ENTEROS, el
// User-Agent, la ruta y el método; la entrada con la credencial cebo (que solo
// puede venir de un robo de datos) sube a alta, la inyección SQL y el Path
// Traversal se marcan como comando, y las sondas (nmap -sV, http-title,
// escáneres) salen con severidad baja, para no llenar la consola de alertas
// en cada barrido. Cada trampa parece un portal distinto: el token de la
// cookie de sesión sale de una semilla propia (ver identidad.go).

// contadorConex: conexiones a la vez, global y por IP. Un solo atacante no
// acapara las plazas de los demás; al rechazar, se hace lo que un servidor
// web real al quedarse sin plazas: la conexión se cierra en cuanto entra, y
// el rechazo queda resumido por IP y periodo (web.session.rechazos).
type contadorConex struct {
	mu    sync.Mutex
	total int
	porIP map[string]int
	max   int
	maxIP int

	rechTotal, rechGlobal, rechIP int64
	rechPorIP                     map[string]int64
	rechSinContar                 int64
}

func nuevoContador(max, maxIP int) *contadorConex {
	return &contadorConex{porIP: map[string]int{}, rechPorIP: map[string]int64{}, max: max, maxIP: maxIP}
}

func (c *contadorConex) admitir(ip string) (bool, string) {
	k := claveIP(ip)
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case c.total >= c.max:
		c.rechGlobal++
	case c.porIP[k] >= c.maxIP:
		c.rechIP++
	default:
		c.total++
		c.porIP[k]++
		return true, ""
	}
	c.rechTotal++
	if _, visto := c.rechPorIP[k]; visto || len(c.rechPorIP) < maxIPsResumen {
		c.rechPorIP[k]++
	} else {
		c.rechSinContar++
	}
	motivo := "tope total de conexiones"
	if c.rechGlobal == 0 || c.porIP[k] >= c.maxIP {
		motivo = "tope de conexiones de su IP"
	}
	return false, motivo
}

func (c *contadorConex) soltar(ip string) {
	k := claveIP(ip)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total--
	if c.porIP[k]--; c.porIP[k] <= 0 {
		delete(c.porIP, k)
	}
}

func (c *contadorConex) resumen() (total, global, porIP, sinContar int64, ipTop string, deIP int64, ips int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	total, global, porIP, sinContar = c.rechTotal, c.rechGlobal, c.rechIP, c.rechSinContar
	ips = len(c.rechPorIP)
	for k, v := range c.rechPorIP {
		if v > deIP || v == deIP && k < ipTop {
			ipTop, deIP = k, v
		}
	}
	c.rechTotal, c.rechGlobal, c.rechIP, c.rechSinContar = 0, 0, 0, 0
	c.rechPorIP = map[string]int64{}
	return
}

func (c *contadorConex) activas() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

// servidor: la trampa entera. El servidor HTTP es net/http; la admission de
// conexiones y los topes van en el oyente envuelto y en la conexión envuelta
// (debajo de net/http, que ya topa cabeceras y plazos).
type servidor struct {
	cfg       conf
	id        *identidad
	reg       *registrador
	conex     *contadorConex
	plantilla plantilla
	inicio    time.Time // arranque
	vivas     sync.WaitGroup

	parando atomic.Bool
}

// plazoParada: lo más que se espera a que las conexiones apunten su cierre
// cuando llega SIGTERM (docker stop da 10 s antes del SIGKILL).
const plazoParada = 5 * time.Second

func nuevoServidor(c conf, id *identidad, reg *registrador) *servidor {
	return &servidor{
		cfg:       c,
		id:        id,
		reg:       reg,
		conex:     nuevoContador(c.maxConex, c.maxConexIP),
		plantilla: plantillaDe(c.plantilla),
		inicio:    time.Now(),
	}
}

func ahoraRFC3339() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func main() {
	c := cargarConf()
	reg, err := nuevoRegistrador(c.registro, c.maxLogDia, c.resumen, time.Now)
	if err != nil {
		fmt.Fprintln(os.Stderr, "no se pudo abrir el registro:", err)
		os.Exit(1)
	}
	s := nuevoServidor(c, nuevaIdentidad(c, cargarSemilla(c)), reg)
	ln, err := net.Listen("tcp", c.escucha)
	if err != nil {
		fmt.Fprintln(os.Stderr, "no se pudo escuchar:", err)
		reg.cerrar()
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "trampa login-web escuchando en", c.escucha)

	// net/http de la biblioteca estándar, con sus topes y plazos: cabeceras
	// de 16 KiB, 10 s para la primera línea y las cabeceras (una conexión
	// callada no ocupa su hueco para siempre), plazos de lectura y escritura,
	// y las conexiones vivas sin petición se sueltan tras el plazo de reposo.
	srv := &http.Server{
		Handler:           http.HandlerFunc(s.atenderHTTP),
		ConnContext:       contextoConn,
		MaxHeaderBytes:    16 << 10,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	hechos := make(chan error, 1)
	go func() {
		hechos <- srv.Serve(&escuchaTrampa{ln: ln, s: s})
	}()
	ctxTareas, pararTareas := context.WithCancel(context.Background())
	defer pararTareas()
	go s.tareasPeriodicas(ctxTareas)

	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer parar()
	<-ctx.Done()
	parar()

	// Apagado limpio: se dejan terminar las peticiones en marcha (y sus
	// eventos), se cierran las conexiones en reposo, se apuntan los cierres
	// y se resumen los rechazos y lo omitido antes de callar.
	s.parando.Store(true)
	pararTareas()
	bctx, cancelar := context.WithTimeout(context.Background(), plazoParada)
	_ = srv.Shutdown(bctx)
	cancelar()
	_ = srv.Close()
	esperarCon(&s.vivas, 3*time.Second)
	<-hechos
	s.resumirRechazos()
	s.reg.resumirAhora()
	reg.cerrar()
}

func esperarCon(wg *sync.WaitGroup, plazo time.Duration) bool {
	hecho := make(chan struct{})
	go func() {
		wg.Wait()
		close(hecho)
	}()
	select {
	case <-hecho:
		return true
	case <-time.After(plazo):
		return false
	}
}

// escuchaTrampa: el oyente envuelto que net/http acepta. Cada conexión se
// cuenta (total y por IP) ANTES de servirse; a la que no cabe se la cierra en
// cuanto entra, como un servidor web real sin plazas, y el rechazo queda en
// el resumen periódico, no una línea por rechazo. A la que cabe se le apunta
// su conexión (evento web.session.connect) y se envuelve con su sesión.
type escuchaTrampa struct {
	ln net.Listener
	s  *servidor
}

func (e *escuchaTrampa) Accept() (net.Conn, error) {
	for {
		conn, err := e.ln.Accept()
		if err != nil {
			return nil, err
		}
		ip, _ := origen(conn.RemoteAddr())
		if ok, _ := e.s.conex.admitir(ip); !ok {
			// Sin plaza: cerrada en cuanto entra, sin contestar nada que
			// delate otra cosa (como el real). net/http la descartará al
			// leer el corte.
			conn.Close()
			continue
		}
		return e.s.apuntarConn(conn, ip), nil
	}
}

func (e *escuchaTrampa) Close() error   { return e.ln.Close() }
func (e *escuchaTrampa) Addr() net.Addr { return e.ln.Addr() }

// connTrampa: la conexión con su sesión (la misma para todas las peticiones
// de una conexión keep-alive) y su contador de peticiones legibles. Al
// cerrarse se apunta el cierre con su duración; una conexión que se va sin
// haber logrado una sola petición legible (bytes que no son HTTP, sonda binaria
// de nmap, un puerto sondeado a ciegas) es una sonda y sale como tal (baja),
// SIEMPRE: la trampa no pierde la señal por muy raro que sea lo que llegó.
type connTrampa struct {
	net.Conn
	s          *servidor
	ses        string
	ip         string
	puerto     int
	creado     time.Time
	peticiones atomic.Int64
	cerrar     sync.Once
}

func (s *servidor) apuntarConn(conn net.Conn, ip string) net.Conn {
	_, puerto := origen(conn.RemoteAddr())
	ct := &connTrampa{Conn: conn, s: s, ses: nuevaSesion(), ip: ip, puerto: puerto, creado: time.Now()}
	s.vivas.Add(1)
	ev := evento{
		Cuando:  ahoraRFC3339(),
		EventID: "web.session.connect",
		Session: ct.ses,
		SrcIP:   ip,
		SrcPort: puerto,
	}
	s.reg.escribir(ev)
	return ct
}

func (c *connTrampa) Close() error {
	var err error
	c.cerrar.Do(func() {
		err = c.Conn.Close()
		c.s.conex.soltar(c.ip)
		c.s.vivas.Done()
		fin := evento{
			Cuando:   ahoraRFC3339(),
			EventID:  "web.session.closed",
			Session:  c.ses,
			SrcIP:    c.ip,
			SrcPort:  c.puerto,
			Duracion: strconv.FormatFloat(time.Since(c.creado).Seconds(), 'f', 3, 64),
		}
		c.s.reg.escribir(fin)
		if c.peticiones.Load() == 0 {
			son := evento{
				Cuando:  ahoraRFC3339(),
				EventID: "web.sondeo",
				Session: c.ses,
				SrcIP:   c.ip,
				SrcPort: c.puerto,
				Motivo:  "conexión cerrada sin una petición legible (sonda que no habla HTTP)",
			}
			c.s.reg.escribir(son)
		}
	})
	return err
}

func (s *servidor) resumirRechazos() {
	total, global, porIP, sinContar, ipTop, deIP, ips := s.conex.resumen()
	if total == 0 {
		return
	}
	s.reg.escribir(evento{
		EventID:       "web.session.rechazos",
		SrcIP:         ipTop,
		Rechazadas:    total,
		PorTopeGlobal: global,
		PorTopeIP:     porIP,
		IPsDistintas:  ips,
		IPsSinContar:  sinContar,
		DeSuIP:        deIP,
		Activas:       s.conex.activas(),
		PeriodoS:      int(s.cfg.resumen / time.Second),
		Aviso:         "conexiones rechazadas por tope; de_su_ip es de la IP con más rechazos",
	})
}

// tareasPeriodicas mantiene el registro al día (bolsas por hora) y resume los
// rechazos por periodo, como el resto de las trampas.
func (s *servidor) tareasPeriodicas(ctx context.Context) {
	t := time.NewTicker(minDur(s.cfg.resumen, time.Minute))
	defer t.Stop()
	ultimoResumen := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case ahora := <-t.C:
			s.reg.tic()
			if ahora.Sub(ultimoResumen) >= s.cfg.resumen {
				s.resumirRechazos()
				ultimoResumen = ahora
			}
		}
	}
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
