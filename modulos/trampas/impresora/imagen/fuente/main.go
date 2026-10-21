// Trampa de impresora de red de Sugardaddy (H69). Código propio de SeguridadSI,
// sin dependencias (solo la biblioteca estándar de Go), escrito desde las
// especificaciones de PJL, IPP (RFC 8010) y HTTP. Finge una impresora de
// oficina realista en tres servicios:
//
//   - 9100/tcp RAW/JetDirect: habla PJL (@PJL INFO ID/STATUS/CONFIG/FILESYS,
//     FSQUERY/FSDIRLIST/FSUPLOAD/FSDOWNLOAD como las que usa PRET, RDYMSG para
//     desfigurar el panel) y, cuando le mandan un trabajo de impresión, guarda
//     solo su huella (sha256) y su tamaño, nunca el contenido.
//   - 631/tcp IPP: responde Get-Printer-Attributes de forma creíble para
//     ipptool, CUPS y los drivers, y acepta (sin imprimir) los trabajos.
//   - 80/tcp web de administración: registra los intentos de inicio de sesión
//     (usuario y contraseña completos) y, sobre todo, el cambio del servidor
//     LDAP/SMTP por el del atacante (passback de credenciales), la señal más
//     valiosa de esta trampa.
//
// No ejecuta nada de lo que pide el atacante, nunca abre una conexión hacia
// fuera y solo escribe su propio registro. Cada trampa parece una impresora
// distinta y coherente: modelo, serie, firmware, MAC, UUID e IP salen de una
// semilla propia (ver persona.go). El registro es un JSON por líneas de nombre
// fijo (impresora.json) que no crece sin tope en el disco: rota a diario por
// renombrado y reparte su tope en bolsas con cupo por IP (ver registro.go).
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// contadorConex: conexiones a la vez, global y por IP. Un solo atacante no
// acapara las plazas de los demás (cupo por IP); al rechazar, deja un resumen
// por periodo, no una línea por rechazo.
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

// presupuestoGlobal: tope total de bytes de cuerpos HTTP/IPP retenidos en
// memoria a la vez, SUMANDO todas las conexiones. Aunque maxConex × maxCuerpoMem
// ya quede holgado (256 × 32 KiB = 8 MiB), este presupuesto es la defensa de
// fondo: con cualquier combinación de conexiones y cuerpos lentos, la memoria
// viva de los cuerpos nunca pasa de aquí, muy por debajo de memoriaMb (64 MiB).
const presupuestoGlobal = 16 << 20

// presupuesto reparte un número fijo de bytes entre las conexiones que leen un
// cuerpo. Quien pide más de lo que queda recibe solo lo disponible (o 0): el
// cuerpo se trunca en memoria y el resto se pasa en flujo a la huella, sin
// guardarse. Nunca bloquea.
type presupuesto struct {
	mu   sync.Mutex
	disp int64
}

func nuevoPresupuesto(max int64) *presupuesto {
	if max <= 0 {
		max = presupuestoGlobal
	}
	return &presupuesto{disp: max}
}

// tomar concede hasta n bytes (0..n) según lo que quede libre.
func (b *presupuesto) tomar(n int64) int64 {
	if n <= 0 {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.disp <= 0 {
		return 0
	}
	if n > b.disp {
		n = b.disp
	}
	b.disp -= n
	return n
}

func (b *presupuesto) soltar(n int64) {
	if n <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.disp += n
}

func (b *presupuesto) disponible() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.disp
}

type servidor struct {
	cfg      conf
	persona  *persona
	reg      *registrador
	conex    *contadorConex
	presup   *presupuesto
	recuerda *recuerdos
	reloj    func() time.Time

	jobID atomic.Int64

	parando atomic.Bool
	espera  sync.WaitGroup
	muVivas sync.Mutex
	vivas   map[net.Conn]struct{}
}

func nuevoServidor(c conf, p *persona, reg *registrador) *servidor {
	return &servidor{
		cfg:      c,
		persona:  p,
		reg:      reg,
		conex:    nuevoContador(c.maxConex, c.maxConexIP),
		presup:   nuevoPresupuesto(presupuestoGlobal),
		recuerda: nuevosRecuerdos(time.Now),
		reloj:    time.Now,
		vivas:    map[net.Conn]struct{}{},
	}
}

func (s *servidor) nuevoJobID() int32 {
	return int32(s.jobID.Add(1)%100000 + 1)
}

// plazoParada: lo más que se espera a que las conexiones apunten su cierre.
const plazoParada = 5 * time.Second

func main() {
	c := cargarConf()
	arranque := time.Now()

	reg, err := nuevoRegistrador(c.registro, c.maxLogDia, c.resumen, time.Now)
	if err != nil {
		fmt.Fprintln(os.Stderr, "no se pudo abrir el registro:", err)
		os.Exit(1)
	}
	p := nuevaPersona(c, cargarSemilla(c), arranque)
	s := nuevoServidor(c, p, reg)

	// Un escuchador por servicio encendido.
	type servicio struct {
		on      bool
		esc     string
		nombre  string
		atender func(net.Conn)
	}
	tipos := []servicio{
		{c.raw, c.rawEsc, "9100/RAW", func(cn net.Conn) { s.atender9100(cn) }},
		{c.ipp, c.ippEsc, "631/IPP", func(cn net.Conn) { s.atenderHTTP(cn, "ipp") }},
		{c.web, c.webEsc, "80/web", func(cn net.Conn) { s.atenderHTTP(cn, "web") }},
	}
	var lns []net.Listener
	var atienden []func(net.Conn)
	for _, t := range tipos {
		if !t.on {
			continue
		}
		ln, err := net.Listen("tcp", t.esc)
		if err != nil {
			fmt.Fprintf(os.Stderr, "no se pudo escuchar en %s (%s): %v\n", t.esc, t.nombre, err)
			for _, l := range lns {
				l.Close()
			}
			reg.cerrar()
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "trampa impresora: %s en %s\n", t.nombre, t.esc)
		lns = append(lns, ln)
		atienden = append(atienden, t.atender)
	}
	if len(lns) == 0 {
		fmt.Fprintln(os.Stderr, "ningún servicio encendido")
		reg.cerrar()
		os.Exit(1)
	}

	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer parar()
	s.servir(ctx, lns, atienden)
	reg.cerrar()
}

// servir acepta en todos los escuchadores hasta que se cancela ctx (SIGTERM) o
// se cierran. Al parar corta las conexiones abiertas, espera un plazo y deja
// los resúmenes pendientes.
func (s *servidor) servir(ctx context.Context, lns []net.Listener, atienden []func(net.Conn)) {
	ctx, cancelar := context.WithCancel(ctx)
	defer cancelar()
	go func() {
		<-ctx.Done()
		for _, ln := range lns {
			ln.Close()
		}
	}()

	tareas := make(chan struct{})
	go func() {
		defer close(tareas)
		s.tareasPeriodicas(ctx)
	}()

	var aceptando sync.WaitGroup
	for i := range lns {
		aceptando.Add(1)
		go func(ln net.Listener, atender func(net.Conn)) {
			defer aceptando.Done()
			s.aceptar(ctx, ln, atender)
		}(lns[i], atienden[i])
	}
	aceptando.Wait()

	cancelar()
	s.parando.Store(true)
	s.cortarVivas()
	esperarCon(&s.espera, plazoParada)
	<-tareas
	s.resumirRechazos()
	s.reg.resumirAhora()
}

func (s *servidor) aceptar(ctx context.Context, ln net.Listener, atender func(net.Conn)) {
	pausa := 5 * time.Millisecond
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(pausa):
			}
			pausa = min(pausa*2, time.Second)
			continue
		}
		pausa = 5 * time.Millisecond
		ip, _ := origen(conn.RemoteAddr())
		if ok, motivo := s.conex.admitir(ip); !ok {
			s.rechazar(conn, motivo)
			continue
		}
		s.apuntarViva(conn, true)
		s.espera.Add(1)
		go func() {
			defer s.espera.Done()
			defer s.conex.soltar(ip)
			defer s.apuntarViva(conn, false)
			atender(conn)
		}()
	}
}

func (s *servidor) apuntarViva(conn net.Conn, viva bool) {
	s.muVivas.Lock()
	defer s.muVivas.Unlock()
	if viva {
		s.vivas[conn] = struct{}{}
	} else {
		delete(s.vivas, conn)
	}
}

func (s *servidor) cortarVivas() {
	s.muVivas.Lock()
	defer s.muVivas.Unlock()
	for c := range s.vivas {
		c.SetDeadline(time.Now())
	}
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

// rechazar cierra sin más una conexión que no cabe en los topes (una impresora
// saturada deja de aceptar). El evento lo lleva el resumen periódico.
func (s *servidor) rechazar(conn net.Conn, motivo string) {
	_ = motivo
	conn.Close()
}

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

func (s *servidor) resumirRechazos() {
	total, global, porIP, sinContar, ipTop, deIP, ips := s.conex.resumen()
	if total == 0 {
		return
	}
	s.reg.escribir(evento{
		EventID:       "impresora.session.rechazos",
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

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
