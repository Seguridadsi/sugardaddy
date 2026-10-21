// Trampa Redis de Sugardaddy. Código propio de SeguridadSI, sin dependencias
// (solo la biblioteca estándar de Go), escrito desde la especificación del
// protocolo RESP. Finge un servidor Redis con AUTH y sesión: responde creíble
// a los comandos normales y marca como ataque grave las secuencias de los
// gusanos reales (SLAVEOF/REPLICAOF, MODULE LOAD, CONFIG SET dir/dbfilename,
// EVAL, FLUSHALL). No ejecuta nada de lo que pide el atacante, nunca abre una
// conexión hacia fuera y solo escribe su propio registro.
//
// Cada trampa parece un servidor distinto y coherente consigo mismo: run_id,
// build id, sistema, rutas y memoria salen de una semilla propia (ver
// identidad.go), no de valores fijos comunes a toda la flota ni del reloj.
//
// Ni un atacante puede cegar la trampa para los demás ni tumbarla: hay cupo de
// conexiones por IP además del global, plazo de lectura y de escritura, un
// presupuesto de memoria de clientes (órdenes a medio leer y colas de MULTI)
// total y por IP (ver memoria.go), y el registro reparte su tope diario en
// bolsas (general, grave, contraseñas, grave compacto y avisos) liberadas por
// horas, con cupo por IP, resumiendo en una línea lo que se calla (ver
// registro.go).
//
// El registro es un fichero JSON por líneas de nombre fijo (redis.json) que no
// puede crecer sin tope en el disco del cliente: rota una vez al día por
// renombrado (redis.json.AAAA_MM_DD, que el sensor sigue) y tiene un tope de
// bytes por día.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// contadorConex: conexiones a la vez, global y por IP. Un solo atacante no
// acapara las plazas de los demás (cupo por IP); al rechazar, se contesta como
// Redis real y se deja un resumen por IP y periodo, no una línea por rechazo.
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

// admitir dice si cabe una conexión más de ip. Si no, la apunta para el
// resumen y dice por qué.
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

// resumen vacía la cuenta de rechazos del periodo y la devuelve.
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

type servidor struct {
	cfg    conf
	id     *identidad
	reg    *registrador
	banco  *banco
	conex  *contadorConex
	mem    *presupuesto // memoria que los clientes hacen crecer (órdenes, colas)
	espera sync.WaitGroup

	// parando: llegó la parada. Cada conexión lo mira antes de esperar otra
	// orden, así que el plazo inmediato de cortarVivas no se pierde aunque
	// una conexión estuviera atendiendo una orden en ese momento.
	parando atomic.Bool

	muVivas sync.Mutex
	vivas   map[net.Conn]struct{} // conexiones abiertas, para cortarlas al parar
}

func nuevoServidor(c conf, id *identidad, reg *registrador) *servidor {
	reg.modoAbierto(c.contrasena == "")
	memTotal := int64(c.maxMemClientesMb) << 20
	return &servidor{
		cfg:   c,
		id:    id,
		reg:   reg,
		banco: nuevoBanco(c, time.Now),
		conex: nuevoContador(c.maxConex, c.maxConexIP),
		// Como el keyspace: una IP no pasa de la octava parte del total.
		mem:   nuevoPresupuesto(memTotal, max(memTotal/8, int64(c.maxComando)*2)),
		vivas: map[net.Conn]struct{}{},
	}
}

// Topes por conexión de la cola de MULTI. Redis no tiene otro límite que la
// memoria; aquí, al pasarse, se cierra la conexión como hace Redis con un
// cliente que supera sus límites de memoria, y queda apuntado.
const (
	maxColaOrdenes = 128
	holguraCola    = 4 << 10 // sobre maxComando: cabe al menos una orden entera
	// plazoParada: lo más que se espera a que las conexiones apunten su
	// cierre cuando llega SIGTERM (docker stop da 10 s antes del SIGKILL).
	plazoParada = 5 * time.Second
)

func main() {
	c := cargarConf()
	arranque := time.Now()

	reg, err := nuevoRegistrador(c.registro, c.maxLogDia, c.resumen, time.Now)
	if err != nil {
		fmt.Fprintln(os.Stderr, "no se pudo abrir el registro:", err)
		os.Exit(1)
	}

	s := nuevoServidor(c, nuevaIdentidad(c, cargarSemilla(c), arranque), reg)
	ln, err := net.Listen("tcp", c.escucha)
	if err != nil {
		fmt.Fprintln(os.Stderr, "no se pudo escuchar:", err)
		reg.cerrar()
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "trampa redis escuchando en", c.escucha)

	// Un solo aviso de parada que miran todos (antes, una señal la recogía
	// una sola de tres goroutines y la trampa no terminaba hasta el SIGKILL).
	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer parar()
	s.servir(ctx, ln)
	reg.cerrar()
}

// servir acepta conexiones hasta que se cancela ctx (SIGTERM) o se cierra el
// listener. Al parar corta las conexiones abiertas para que cada una apunte su
// cierre, espera como mucho plazoParada y deja los resúmenes pendientes.
func (s *servidor) servir(ctx context.Context, ln net.Listener) {
	ctx, cancelar := context.WithCancel(ctx)
	defer cancelar()
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	tareas := make(chan struct{})
	go func() {
		defer close(tareas)
		s.tareasPeriodicas(ctx)
	}()

	pausa := 5 * time.Millisecond
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				break
			}
			// Fallo pasajero (sin descriptores, p. ej.): se espera un poco en
			// vez de girar al 100 % de CPU.
			select {
			case <-ctx.Done():
			case <-time.After(pausa):
			}
			pausa = min(pausa*2, time.Second)
			continue
		}
		pausa = 5 * time.Millisecond
		ip, _ := origen(conn.RemoteAddr())
		if ok, motivo := s.conex.admitir(ip); !ok {
			s.rechazar(conn, ip, motivo)
			continue
		}
		s.apuntarViva(conn, true)
		s.espera.Add(1)
		go func() {
			defer s.espera.Done()
			defer s.conex.soltar(ip)
			defer s.apuntarViva(conn, false)
			s.atender(conn)
		}()
	}

	cancelar()
	s.parando.Store(true)
	s.cortarVivas()
	esperarCon(&s.espera, plazoParada)
	<-tareas
	s.resumirRechazos()
	s.reg.resumirAhora()
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

// cortarVivas pone plazo inmediato a las conexiones abiertas: su lectura falla
// y atender apunta el redis.session.closed antes de soltarla.
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

// rechazar contesta como Redis cuando se queda sin plazas (para no delatar la
// trampa con un RST) y cierra. El evento lo lleva el resumen periódico.
func (s *servidor) rechazar(conn net.Conn, ip, motivo string) {
	_ = motivo
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	conn.Write([]byte("-ERR max number of clients reached\r\n"))
	conn.Close()
}

// tareasPeriodicas: cada cierto tiempo resume rechazos y omitidos, purga el
// keyspace y deja que el registro rote y reabra aunque no lleguen eventos.
// Los últimos resúmenes al parar los deja servir.
func (s *servidor) tareasPeriodicas(ctx context.Context) {
	t := time.NewTicker(minDur(s.cfg.resumen, time.Minute))
	defer t.Stop()
	ultimoResumen := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case ahora := <-t.C:
			s.banco.purgar()
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
		EventID:       "redis.session.rechazos",
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

// cliente: el estado de una conexión mientras dura. Solo lo toca la goroutine
// de su conexión; lo que ven las demás (CLIENT LIST de la misma IP) va en la
// foto, que se publica tras cada orden.
type cliente struct {
	id          int64
	ip          string
	puerto      int
	laddr       string // dirección local que ve el cliente (CLIENT LIST)
	fd          int
	nombre      string
	biblioteca  string
	libVer      string
	db          int
	proto       int
	autenticado bool
	usuario     string
	creado      time.Time
	ultimaOrden string // nombre completo de la última orden (client|list en 7.x)
	vista       *vista
	errores     map[string]int64
	cuota       *cuota
	foto        atomic.Pointer[fotoCliente]

	// MULTI/EXEC.
	enCola     bool
	cola       [][]string
	colaBytes  int64
	multiError bool // una orden mal encolada aborta el EXEC

	// corte: si no está vacío, la conexión se cierra sin contestar por este
	// motivo (tope de memoria) y se apunta redis.session.tope.
	corte string
}

// fotoCliente: lo que CLIENT LIST de otra conexión de la misma IP enseña de
// esta, sin carreras con su goroutine.
type fotoCliente struct {
	id                      int64
	addr, laddr             string
	fd, db, proto, multi    int
	nombre, cmd, usuario    string
	biblioteca, libVer      string
	creado, ultimaActividad time.Time
}

func (cli *cliente) publicar() {
	multi := -1
	if cli.enCola {
		multi = len(cli.cola)
	}
	cli.foto.Store(&fotoCliente{
		id: cli.id, addr: fmt.Sprintf("%s:%d", cli.ip, cli.puerto), laddr: cli.laddr,
		fd: cli.fd, db: cli.db, proto: cli.proto, multi: multi,
		nombre: cli.nombre, cmd: cli.ultimaOrden, usuario: usuarioCliente(cli),
		biblioteca: cli.biblioteca, libVer: cli.libVer,
		creado: cli.creado, ultimaActividad: time.Now(),
	})
}

// vaciarCola deja la conexión fuera de MULTI y suelta lo que retenía su cola.
func (cli *cliente) vaciarCola() {
	cli.enCola = false
	cli.cola = nil
	cli.colaBytes = 0
	cli.multiError = false
	cli.cuota.soltarCola()
}

var contadorCli int64

// atender lleva una conexión entera: parsea órdenes, responde creíble y
// registra cada una. Cada respuesta va con plazo de escritura, así que un
// cliente que no lee no bloquea su goroutine para siempre.
func (s *servidor) atender(conn net.Conn) {
	defer conn.Close()
	ip, puerto := origen(conn.RemoteAddr())
	cli := &cliente{
		id:          atomic.AddInt64(&contadorCli, 1),
		ip:          ip,
		puerto:      puerto,
		laddr:       s.laddrDe(conn),
		fd:          7 + s.conex.activas(),
		proto:       2,
		db:          0,
		autenticado: s.cfg.contrasena == "",
		creado:      time.Now(),
		errores:     map[string]int64{},
		cuota:       s.mem.cuotaPara(ip),
	}
	defer cli.cuota.soltarTodo()
	cli.publicar()
	cli.vista = s.banco.entrar(ip, cli)
	defer s.banco.salir(cli.vista, cli)

	ses := nuevaSesion()
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetReadBuffer(16 << 10)
		tc.SetWriteBuffer(16 << 10)
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(60 * time.Second)
	}

	base := func() evento {
		return evento{
			Cuando:  time.Now().UTC().Format(time.RFC3339Nano),
			Session: ses,
			SrcIP:   ip,
			SrcPort: puerto,
		}
	}
	reg := func(e evento) { s.reg.escribir(e) }

	e := base()
	e.EventID = "redis.session.connect"
	reg(e)

	// Búferes pequeños: son memoria fija por conexión (por 512 conexiones).
	// Las órdenes grandes se leen por trozos y se cuentan en la cuota.
	r := bufio.NewReaderSize(conn, 4<<10)
	w := bufio.NewWriterSize(conn, 4<<10)
	out := &resp{w: w, proto: cli.proto, errores: func(codigo string) { cli.errores[codigo]++ }}

	for {
		conn.SetReadDeadline(time.Now().Add(s.cfg.inactividad))
		if s.parando.Load() {
			break // después de poner el plazo: o se ve aquí, o cortarVivas lo pisa
		}
		args, err := leerComando(r, s.cfg.maxComando, cli.autenticado, cli.cuota)
		if err != nil {
			if pe, ok := err.(errProto); ok {
				conn.SetWriteDeadline(time.Now().Add(s.cfg.plazoEscribir))
				out.err("ERR " + pe.Error())
				w.Flush()
			}
			if errors.Is(err, errMemoria) {
				cli.corte = "orden más grande que lo que le queda a su IP del tope de memoria de clientes"
			}
			break
		}
		if len(args) == 0 {
			continue // línea vacía, *0 o *-1: Redis los ignora
		}
		cmd := nombreComando(args[0])
		cli.ultimaOrden = s.nombreCompleto(cmd, args)

		ev := base()
		ev.Comando = cmd
		ev.Args = unirArgs(args[1:], maxCodArgs)
		if grave := motivoGrave(cmd, args); grave != "" {
			ev.Grave = grave
			ev.EventID = "redis.command.grave"
		} else {
			ev.EventID = "redis.command.input"
		}
		marcarAuth(&ev, cmd, args)
		reg(ev)

		out.proto = cli.proto
		conn.SetWriteDeadline(time.Now().Add(s.cfg.plazoEscribir))
		cerrar := s.responder(out, cli, cmd, args)
		cli.publicar()
		cli.cuota.soltarOrden()
		if err := w.Flush(); err != nil {
			break // el cliente no acepta la respuesta: se suelta la goroutine
		}
		if cerrar {
			break
		}
	}

	if cli.corte != "" {
		t := base()
		t.EventID = "redis.session.tope"
		t.Motivo = cli.corte
		t.Aviso = "conexión cortada sin contestar, como hace Redis con un cliente que pasa sus límites de memoria"
		reg(t)
	}
	fin := base()
	fin.EventID = "redis.session.closed"
	fin.Duracion = strconv.FormatFloat(time.Since(cli.creado).Seconds(), 'f', 3, 64)
	reg(fin)
}

// laddrDe: la dirección local que enseña CLIENT LIST. En el perfil docker es
// la del socket (la IP del contenedor y el 6379, como en la imagen oficial);
// en una máquina, la IP privada de la identidad y el puerto que anuncia INFO.
// Nunca 127.0.0.1 ni 0.0.0.0 para un cliente de fuera.
func (s *servidor) laddrDe(conn net.Conn) string {
	if s.id.perfil == "docker" {
		if a, ok := conn.LocalAddr().(*net.TCPAddr); ok && !a.IP.IsLoopback() && !a.IP.IsUnspecified() {
			return a.String()
		}
	}
	return laddr(s.id)
}

// marcarAuth apunta usuario y contraseña de AUTH y de HELLO ... AUTH, como
// redis.auth (grave: se vigilan los intentos de contraseña), también en modo
// abierto.
func marcarAuth(ev *evento, cmd string, args []string) {
	switch cmd {
	case "AUTH":
		switch len(args) {
		case 2:
			ev.Password = recortarCodificado(args[1], maxCodPassword)
			ev.EventID = "redis.auth"
		default:
			if len(args) >= 3 {
				ev.Usuario = recortarCodificado(args[1], maxCodUsuario)
				ev.Password = recortarCodificado(args[len(args)-1], maxCodPassword)
				ev.EventID = "redis.auth"
			}
		}
	case "HELLO":
		if i := indiceAuth(args); i >= 0 {
			ev.Usuario = recortarCodificado(args[i+1], maxCodUsuario)
			ev.Password = recortarCodificado(args[i+2], maxCodPassword)
			ev.EventID = "redis.auth"
		}
	}
}

// indiceAuth: posición del token AUTH de HELLO si tiene usuario y contraseña
// detrás; -1 si no.
func indiceAuth(args []string) int {
	for i := 1; i+2 < len(args); i++ {
		if strings.EqualFold(args[i], "AUTH") {
			return i
		}
	}
	return -1
}

// motivoGrave devuelve el motivo si el comando es parte de una cadena de
// ataque real, o "" si es tráfico normal.
func motivoGrave(cmd string, args []string) string {
	minus := func(i int) string {
		if i < len(args) {
			return strings.ToLower(args[i])
		}
		return ""
	}
	switch cmd {
	case "SLAVEOF", "REPLICAOF":
		if minus(1) == "no" {
			return "" // SLAVEOF NO ONE: restaura, no es grave por sí solo
		}
		return "réplica hacia servidor del atacante (SLAVEOF/REPLICAOF)"
	case "MODULE":
		if minus(1) == "load" || minus(1) == "loadex" {
			return "carga de módulo nativo (MODULE LOAD): ejecución de código"
		}
	case "EVAL", "EVAL_RO", "EVALSHA", "EVALSHA_RO", "FCALL", "FCALL_RO", "FUNCTION":
		if cmd == "FUNCTION" && !(minus(1) == "load" || minus(1) == "restore") {
			return ""
		}
		return "script en el servidor (EVAL/FUNCTION): posible escape del sandbox Lua (CVE-2022-0543)"
	case "FLUSHALL", "FLUSHDB":
		return "borrado de la base (FLUSHALL/FLUSHDB)"
	case "DEBUG":
		return "DEBUG: comando de depuración peligroso"
	case "CONFIG":
		if minus(1) == "set" {
			// Desde Redis 7 CONFIG SET admite varios pares: se miran todos
			// los parámetros, no solo el primero.
			for i := 2; i < len(args); i += 2 {
				if m := motivoConfig(strings.ToLower(args[i])); m != "" {
					return m
				}
			}
		}
	}
	return ""
}

func motivoConfig(par string) string {
	switch par {
	case "dir", "dbfilename", "dbdir", "appendfilename", "appenddirname":
		return "redirige dónde escribe Redis (CONFIG SET " + par + "): persistencia por fichero"
	case "protected-mode", "requirepass", "replica-read-only", "slave-read-only",
		"stop-writes-on-bgsave-error", "rdbcompression", "appendonly", "aclfile",
		"enable-module-command", "enable-debug-command", "enable-protected-configs",
		"rename-command", "masterauth":
		return "desactiva protecciones (CONFIG SET " + par + ")"
	}
	return ""
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
