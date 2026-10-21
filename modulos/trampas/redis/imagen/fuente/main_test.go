package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---- Utilidades de prueba ---------------------------------------------------

func servidorPrueba(t *testing.T, c conf) *servidor {
	t.Helper()
	c = c.conMinimos()
	if c.version == "" {
		c.version = "7.2.4"
	}
	if c.registro == "" {
		c.registro = filepath.Join(t.TempDir(), "redis.json")
	}
	reg, err := nuevoRegistrador(c.registro, c.maxLogDia, c.resumen, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.cerrar)
	return nuevoServidor(c, nuevaIdentidad(c, "semilla-de-prueba-fija-0001", time.Now().Add(-2*time.Hour)), reg)
}

func clientePrueba(s *servidor, ip string) *cliente {
	cli := &cliente{id: atomic.AddInt64(&contadorCli, 1), ip: ip, puerto: 51000, proto: 2,
		autenticado: s.cfg.contrasena == "", laddr: laddr(s.id),
		creado: time.Now(), errores: map[string]int64{}}
	cli.vista = s.banco.entrar(ip, cli)
	return cli
}

// ejecutar pasa una orden por responder y devuelve lo que contesta.
func ejecutar(s *servidor, cli *cliente, args ...string) (string, bool) {
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	o := &resp{w: w, proto: cli.proto, errores: func(c string) { cli.errores[c]++ }}
	cmd := nombreComando(args[0])
	cli.ultimaOrden = s.nombreCompleto(cmd, args)
	cerrar := s.responder(o, cli, cmd, args)
	w.Flush()
	cli.proto = o.proto
	return buf.String(), cerrar
}

func leer(entrada string, maxBytes int, autenticado bool) ([]string, error) {
	return leerComando(bufio.NewReader(strings.NewReader(entrada)), maxBytes, autenticado, nil)
}

// ---- F0: tamaño acotado de la línea del registro ----------------------------

func TestLineaRegistroAcotadaConComandoEnorme(t *testing.T) {
	// Antes: un comando de 65.000 '<' daba una línea de ~390 KB (x6 por el
	// escape JSON). Ahora el nombre se recorta y no hay amplificación.
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.7")
	ejecutar(s, cli, strings.Repeat("<", 65000), strings.Repeat("<", 65000))

	b, err := os.ReadFile(s.cfg.registro)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
		if len(l) > 4096 {
			t.Fatalf("línea del registro demasiado larga: %d bytes", len(l))
		}
	}
	// El comando guardado está recortado.
	var ultimo evento
	ls := bytes.Split(bytes.TrimSpace(b), []byte("\n"))
	json.Unmarshal(ls[len(ls)-1], &ultimo)
	if len(ultimo.Comando) > maxCodComando {
		t.Fatalf("comando no recortado: %d bytes", len(ultimo.Comando))
	}
}

func TestRespuestaUnknownRecortada(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.7")
	out, _ := ejecutar(s, cli, strings.Repeat("Z", 65000))
	if len(out) > 1024 {
		t.Fatalf("la respuesta 'unknown command' no está recortada: %d bytes", len(out))
	}
	if !strings.HasPrefix(out, "-ERR unknown command") {
		t.Fatalf("respuesta inesperada: %q", out[:40])
	}
}

func TestEscapeHTMLDesactivado(t *testing.T) {
	// '<' no debe convertirse en < (x6).
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.7")
	ejecutar(s, cli, "GET", "a<b>c&d")
	b, _ := os.ReadFile(s.cfg.registro)
	if bytes.Contains(b, []byte("\\u003c")) {
		t.Fatalf("el registro escapa HTML (amplifica x6): %s", b)
	}
}

// ---- F1: tope de conexiones por IP y rechazos -------------------------------

func TestTopeConexionesPorIP(t *testing.T) {
	c := nuevoContador(100, 4)
	ip := "198.51.100.9"
	for i := 0; i < 4; i++ {
		if ok, _ := c.admitir(ip); !ok {
			t.Fatalf("la conexión %d de la IP debería caber", i)
		}
	}
	if ok, motivo := c.admitir(ip); ok {
		t.Fatalf("la quinta conexión de la misma IP debería rechazarse")
	} else if !strings.Contains(motivo, "IP") {
		t.Fatalf("el motivo debería ser por IP, es %q", motivo)
	}
	// Otra IP sí entra: una sola IP no acapara las plazas.
	if ok, _ := c.admitir("203.0.113.9"); !ok {
		t.Fatalf("otra IP debería poder conectar")
	}
}

func TestResumenRechazos(t *testing.T) {
	c := nuevoContador(2, 2)
	c.admitir("198.51.100.1")
	c.admitir("198.51.100.1")
	// Estas dos se rechazan por tope global.
	c.admitir("203.0.113.1")
	c.admitir("203.0.113.2")
	total, _, _, _, _, _, ips := c.resumen()
	if total != 2 {
		t.Fatalf("deberían contarse 2 rechazos, hay %d", total)
	}
	if ips != 2 {
		t.Fatalf("deberían verse 2 IP distintas, hay %d", ips)
	}
	// Tras el resumen, la cuenta se reinicia.
	if total, _, _, _, _, _, _ := c.resumen(); total != 0 {
		t.Fatalf("el resumen no reinició la cuenta: %d", total)
	}
}

// ---- F2: el tope diario del registro se reparte por IP y por bolsa ----------

func TestUnaIPNoAgotaElRegistro(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 23, 0, 0, 0, time.UTC)} // última hora: casi todo el cupo
	reg, err := nuevoRegistrador(ruta, 64<<10, time.Hour, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	// Una IP intenta llenarlo con órdenes normales.
	for i := 0; i < 20000; i++ {
		reg.escribir(evento{EventID: "redis.command.input", Comando: "PING",
			Args: strings.Repeat("x", 100), SrcIP: "198.51.100.50"})
	}
	// Otra IP, con un evento grave, tiene que entrar.
	reg.escribir(evento{EventID: "redis.command.grave", Comando: "SLAVEOF",
		Grave: "réplica", SrcIP: "203.0.113.50"})
	reg.cerrar()

	ls := lineas(t, ruta)
	vista := false
	for _, m := range ls {
		if m["eventid"] == "redis.command.grave" && m["src_ip"] == "203.0.113.50" {
			vista = true
		}
	}
	if !vista {
		t.Fatalf("el evento grave de otra IP debería registrarse pese a la ráfaga de la primera")
	}
}

func TestBolsaGraveReservada(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 23, 0, 0, 0, time.UTC)}
	reg, _ := nuevoRegistrador(ruta, 64<<10, time.Hour, rel.ahora)
	// Muchas IP distintas llenan la bolsa general.
	for i := 0; i < 20000; i++ {
		reg.escribir(evento{EventID: "redis.command.input", Comando: "PING",
			Args: strings.Repeat("x", 100), SrcIP: ipPrueba(i)})
	}
	// Una auténtica prueba de contraseña (bolsa importante) de una IP nueva.
	reg.escribir(evento{EventID: "redis.auth", Password: "secreta-123", SrcIP: "203.0.113.77"})
	reg.cerrar()

	for _, m := range lineas(t, ruta) {
		if m["eventid"] == "redis.auth" && m["password"] == "secreta-123" {
			return
		}
	}
	t.Fatalf("la bolsa de lo importante debería dejar hueco para la contraseña")
}

func TestResumenOmitidos(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	reg, _ := nuevoRegistrador(ruta, 32<<10, time.Hour, rel.ahora)
	for i := 0; i < 50000; i++ {
		reg.escribir(evento{EventID: "redis.command.input", Comando: "PING",
			Args: strings.Repeat("x", 100), SrcIP: "198.51.100.90"})
	}
	// Pasa el periodo (dentro del mismo día): se escribe el resumen de lo omitido.
	rel.t = rel.t.Add(90 * time.Minute)
	reg.tic()
	reg.cerrar()

	hayResumen := false
	for _, m := range lineas(t, ruta) {
		if m["eventid"] == "redis.log.omitidos" && m["omitidos"] != nil {
			hayResumen = true
		}
	}
	if !hayResumen {
		t.Fatalf("debería haber una línea redis.log.omitidos con la cuenta de lo callado")
	}
}

func ipPrueba(i int) string {
	return "198.51." + itoa(i/254%254) + "." + itoa(i%254+1)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// ---- F3: INFO coherente, CONFIG, errores, MULTI, keyspace -------------------

func TestInfoRunIDEstableYAleatorio(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	a := s.infoTexto(cli, []string{"INFO", "server"})
	b := s.infoTexto(cli, []string{"INFO", "server"})
	runA := campo(a, "run_id")
	runB := campo(b, "run_id")
	if runA != runB {
		t.Fatalf("run_id debería ser fijo por proceso: %q vs %q", runA, runB)
	}
	if len(runA) != 40 {
		t.Fatalf("run_id debería tener 40 hex, tiene %d: %q", len(runA), runA)
	}
	if strings.HasPrefix(runA, "0000000000000000") {
		t.Fatalf("run_id con ceros a la izquierda delata la trampa: %q", runA)
	}
	// build_id también estable.
	if campo(a, "redis_build_id") != campo(b, "redis_build_id") {
		t.Fatalf("redis_build_id debería ser fijo por proceso")
	}
}

func TestInfoRunIDDistintoPorSemilla(t *testing.T) {
	c := conf{version: "7.2.4"}.conMinimos()
	i1 := nuevaIdentidad(c, "equipo-uno", time.Now())
	i2 := nuevaIdentidad(c, "equipo-dos", time.Now())
	// run_id sale de crypto/rand al arrancar: nunca coincide entre procesos
	// (ni entre trampas de la flota).
	if i1.runID == i2.runID {
		t.Fatalf("run_id no debería coincidir entre instancias")
	}
	// Y lo derivado de la semilla (sistema, build id, rutas, memoria) hace que
	// cada trampa parezca un servidor distinto; algo tiene que diferir.
	if i1.sistema == i2.sistema && i1.buildID == i2.buildID && i1.dir == i2.dir &&
		i1.memSistema == i2.memSistema && i1.perfil == i2.perfil {
		t.Fatalf("dos trampas con semilla distinta deberían diferir en algo visible")
	}
}

func TestIdentidadReproducible(t *testing.T) {
	// La misma semilla da la misma instalación (sin romper la imagen): tras un
	// reinicio, la trampa se ve igual salvo run_id/replid (que son por proceso).
	c := conf{version: "7.0.15"}.conMinimos()
	i1 := nuevaIdentidad(c, "equipo-fijo", time.Now())
	i2 := nuevaIdentidad(c, "equipo-fijo", time.Now())
	if i1.sistema != i2.sistema || i1.buildID != i2.buildID || i1.dir != i2.dir ||
		i1.perfil != i2.perfil || i1.memSistema != i2.memSistema {
		t.Fatalf("la misma semilla debería dar la misma instalación")
	}
}

func TestInfoUptimeDesdeArranque(t *testing.T) {
	c := conf{version: "7.2.4"}.conMinimos()
	s := &servidor{cfg: c, id: nuevaIdentidad(c, "x", time.Now().Add(-3*time.Hour)),
		banco: nuevoBanco(c, time.Now), conex: nuevoContador(10, 10)}
	s.reg, _ = nuevoRegistrador(filepath.Join(t.TempDir(), "r.json"), 0, time.Minute, time.Now)
	cli := clientePrueba(s, "198.51.100.1")
	up := campo(s.infoTexto(cli, []string{"INFO", "server"}), "uptime_in_seconds")
	if up == "" || up == "0" {
		t.Fatalf("uptime debería contar desde el arranque, es %q", up)
	}
	n := 0
	for _, r := range up {
		n = n*10 + int(r-'0')
	}
	if n < 10000 || n > 11000 {
		t.Fatalf("uptime de ~10800 s esperado, es %d", n)
	}
}

func TestInfoKeyspaceCoherenteConDBSize(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	ejecutar(s, cli, "SET", "a", "b")
	if out, _ := ejecutar(s, cli, "DBSIZE"); out != ":1\r\n" {
		t.Fatalf("DBSIZE debería ser 1, dio %q", out)
	}
	info := s.infoTexto(cli, []string{"INFO", "keyspace"})
	if !strings.Contains(info, "db0:keys=1") {
		t.Fatalf("INFO keyspace debería decir keys=1:\n%s", info)
	}
	// Sin claves no sale la línea db0.
	ejecutar(s, cli, "DEL", "a")
	if strings.Contains(s.infoTexto(cli, []string{"INFO", "keyspace"}), "db0:") {
		t.Fatalf("sin claves no debería salir db0")
	}
}

func TestConfigSetGetPersisteEn62(t *testing.T) {
	s := servidorPrueba(t, conf{version: "6.2.14"})
	cli := clientePrueba(s, "198.51.100.1")
	ejecutar(s, cli, "CONFIG", "SET", "dir", "/var/spool/cron")
	out, _ := ejecutar(s, cli, "CONFIG", "GET", "dir")
	if !strings.Contains(out, "/var/spool/cron") {
		t.Fatalf("CONFIG GET dir debería devolver lo puesto, dio %q", out)
	}
}

func TestConfigSetDirProtegidoEn7(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	out, _ := ejecutar(s, cli, "CONFIG", "SET", "dir", "/var/spool/cron")
	if !strings.HasPrefix(out, "-ERR") {
		t.Fatalf("CONFIG SET dir en 7.x debería fallar (protegido), dio %q", out)
	}
}

func TestMultiExec(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	if out, _ := ejecutar(s, cli, "MULTI"); out != "+OK\r\n" {
		t.Fatalf("MULTI debería dar +OK, dio %q", out)
	}
	if out, _ := ejecutar(s, cli, "SET", "k", "v"); out != "+QUEUED\r\n" {
		t.Fatalf("dentro de MULTI debería encolar (+QUEUED), dio %q", out)
	}
	if out, _ := ejecutar(s, cli, "GET", "k"); out != "+QUEUED\r\n" {
		t.Fatalf("GET debería encolar, dio %q", out)
	}
	out, _ := ejecutar(s, cli, "EXEC")
	if !strings.HasPrefix(out, "*2\r\n") || !strings.Contains(out, "+OK") || !strings.Contains(out, "v") {
		t.Fatalf("EXEC debería devolver los dos resultados, dio %q", out)
	}
}

func TestSaveContestaOK(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	if out, _ := ejecutar(s, cli, "SAVE"); out != "+OK\r\n" {
		t.Fatalf("SAVE debería dar +OK (como Redis real), dio %q", out)
	}
}

func TestKeysFiltra(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	ejecutar(s, cli, "SET", "foo1", "a")
	ejecutar(s, cli, "SET", "foo2", "a")
	ejecutar(s, cli, "SET", "bar", "a")
	out, _ := ejecutar(s, cli, "KEYS", "foo*")
	if strings.Contains(out, "bar") || !strings.Contains(out, "foo1") || !strings.Contains(out, "foo2") {
		t.Fatalf("KEYS foo* no filtró bien: %q", out)
	}
	if out, _ := ejecutar(s, cli, "KEYS", "zzz*"); out != "*0\r\n" {
		t.Fatalf("KEYS zzz* debería no devolver nada, dio %q", out)
	}
}

func TestSelectFueraDeRango(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	if out, _ := ejecutar(s, cli, "SELECT", "999"); !strings.HasPrefix(out, "-ERR DB index is out of range") {
		t.Fatalf("SELECT 999 debería dar fuera de rango, dio %q", out)
	}
	if out, _ := ejecutar(s, cli, "SELECT", "3"); out != "+OK\r\n" {
		t.Fatalf("SELECT 3 debería valer, dio %q", out)
	}
}

func TestClientInfoMuestraIPReal(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "203.0.113.45")
	cli.puerto = 44321
	out, _ := ejecutar(s, cli, "CLIENT", "INFO")
	if !strings.Contains(out, "addr=203.0.113.45:44321") {
		t.Fatalf("CLIENT INFO debería mostrar la IP y el puerto reales, dio %q", out)
	}
	if strings.Contains(out, "127.0.0.1:0") {
		t.Fatalf("CLIENT INFO no debería mostrar 127.0.0.1:0 (delata la trampa)")
	}
}

func TestProtocoloCeroSeIgnora(t *testing.T) {
	// *0 y *-1: Redis los ignora, no corta la conexión.
	for _, e := range []string{"*0\r\n", "*-1\r\n"} {
		args, err := leer(e, 65536, true)
		if err != nil || args != nil {
			t.Fatalf("%q debería ignorarse (nil, nil), dio %v, %v", e, args, err)
		}
	}
}

func TestKeyspaceLlenoDesalojaSinOOM(t *testing.T) {
	s := servidorPrueba(t, conf{maxClaves: 3, maxClavesIP: 3})
	cli := clientePrueba(s, "198.51.100.1")
	for _, k := range []string{"a", "b", "c", "d", "e"} {
		if out, _ := ejecutar(s, cli, "SET", k, "x"); out != "+OK\r\n" {
			t.Fatalf("SET %s debería dar +OK (sin OOM), dio %q", k, out)
		}
	}
	// maxmemory sigue siendo 0 (coherente con que no da OOM).
	if out, _ := ejecutar(s, cli, "CONFIG", "GET", "maxmemory"); !strings.Contains(out, "0") {
		t.Fatalf("maxmemory debería ser 0, dio %q", out)
	}
	// La más antigua ('a') se desalojó.
	if out, _ := ejecutar(s, cli, "GET", "a"); !strings.Contains(out, "-1") {
		t.Fatalf("la clave más antigua debería haberse desalojado, GET a dio %q", out)
	}
}

// ---- F4: HELLO AUTH ---------------------------------------------------------

func TestHelloAuthCorrecta(t *testing.T) {
	s := servidorPrueba(t, conf{contrasena: "Prueba-2026"})
	cli := clientePrueba(s, "198.51.100.1")
	out, _ := ejecutar(s, cli, "HELLO", "3", "AUTH", "default", "Prueba-2026")
	if !cli.autenticado {
		t.Fatalf("HELLO AUTH correcta debería autenticar")
	}
	if cli.proto != 3 {
		t.Fatalf("HELLO 3 debería pasar a proto 3, está en %d", cli.proto)
	}
	if !strings.HasPrefix(out, "%7") {
		t.Fatalf("HELLO 3 debería contestar un mapa RESP3 (%%7), dio %q", out[:8])
	}
}

func TestHelloAuthIncorrecta(t *testing.T) {
	s := servidorPrueba(t, conf{contrasena: "Prueba-2026"})
	cli := clientePrueba(s, "198.51.100.1")
	out, _ := ejecutar(s, cli, "HELLO", "3", "AUTH", "default", "mala")
	if cli.autenticado {
		t.Fatalf("HELLO AUTH con contraseña mala no debería autenticar")
	}
	if !strings.HasPrefix(out, "-WRONGPASS") {
		t.Fatalf("HELLO AUTH mala debería dar -WRONGPASS, dio %q", out)
	}
}

func TestHelloSinAuthNoAutenticado(t *testing.T) {
	s := servidorPrueba(t, conf{contrasena: "Prueba-2026"})
	cli := clientePrueba(s, "198.51.100.1")
	out, _ := ejecutar(s, cli, "HELLO", "3")
	if !strings.HasPrefix(out, "-NOAUTH") {
		t.Fatalf("HELLO sin AUTH y sin autenticar debería dar -NOAUTH, dio %q", out)
	}
}

func TestHelloProtoMalo(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	if out, _ := ejecutar(s, cli, "HELLO", "4"); !strings.HasPrefix(out, "-NOPROTO") {
		t.Fatalf("HELLO 4 debería dar -NOPROTO, dio %q", out)
	}
}

func TestHelloAuthSeRegistra(t *testing.T) {
	// La contraseña de HELLO ... AUTH queda como redis.auth con su contraseña.
	var ev evento
	marcarAuth(&ev, "HELLO", []string{"HELLO", "3", "AUTH", "default", "secreta"})
	if ev.EventID != "redis.auth" {
		t.Fatalf("HELLO AUTH debería marcarse como redis.auth, es %q", ev.EventID)
	}
	if ev.Password != "secreta" || ev.Usuario != "default" {
		t.Fatalf("debería guardar usuario y contraseña: %q / %q", ev.Usuario, ev.Password)
	}
}

// ---- F5: motivoGrave y troceado inline --------------------------------------

func TestConfigSetVariosPares(t *testing.T) {
	// Redis 7: CONFIG SET maxmemory 0 dir /x. El dir peligroso no debe
	// esconderse detrás del primer par.
	m := motivoGrave("CONFIG", []string{"CONFIG", "SET", "maxmemory", "0", "dir", "/var/spool/cron"})
	if !strings.Contains(m, "persistencia") {
		t.Fatalf("CONFIG SET con varios pares debería marcar el dir como grave, dio %q", m)
	}
}

func TestInlineConComillas(t *testing.T) {
	args, err := leer(`CONFIG SET "dir" "/var/spool/cron"`+"\r\n", 65536, true)
	if err != nil {
		t.Fatalf("troceado con comillas falló: %v", err)
	}
	if len(args) != 4 || args[2] != "dir" || args[3] != "/var/spool/cron" {
		t.Fatalf("las comillas deberían quitarse: %#v", args)
	}
	if motivoGrave("CONFIG", args) == "" {
		t.Fatalf("CONFIG SET \"dir\" ... debería marcarse grave")
	}
}

func TestInlineFlushallEntreComillas(t *testing.T) {
	args, err := leer(`"FLUSHALL"`+"\r\n", 65536, true)
	if err != nil {
		t.Fatalf("troceado falló: %v", err)
	}
	if len(args) != 1 || args[0] != "FLUSHALL" {
		t.Fatalf("\"FLUSHALL\" debería dar el comando FLUSHALL, dio %#v", args)
	}
}

func TestInlineComillaSinCerrar(t *testing.T) {
	if _, err := leer(`SET "k`+"\r\n", 65536, true); err == nil {
		t.Fatalf("una comilla sin cerrar debería ser error de protocolo")
	}
}

func TestInlineEscapeHex(t *testing.T) {
	args, err := leer(`SET k "a\x41b"`+"\r\n", 65536, true)
	if err != nil {
		t.Fatalf("escape hex falló: %v", err)
	}
	if args[2] != "aAb" {
		t.Fatalf("\\x41 debería ser 'A': %q", args[2])
	}
}

// ---- F7: el registro se recupera de un fallo de escritura -------------------

func TestRegistroSeRecuperaDeFalloDeEscritura(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)}
	reg, err := nuevoRegistrador(ruta, 0, time.Minute, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	reg.escribir(evento{EventID: "redis.command.input", Comando: "PING", SrcIP: "198.51.100.1"})

	// Se simula un disco que no acepta escrituras cerrando el fichero por
	// debajo y poniendo uno de solo lectura.
	reg.mu.Lock()
	reg.f.Close()
	ro, _ := os.OpenFile(filepath.Join(dir, "ro"), os.O_CREATE|os.O_RDONLY, 0o400)
	reg.f = ro
	reg.mu.Unlock()

	reg.escribir(evento{EventID: "redis.command.input", Comando: "GET", SrcIP: "198.51.100.1"})
	if reg.fallo == "" {
		t.Fatalf("debería haberse anotado el fallo de escritura")
	}

	// Se "arregla el disco": se reabre el fichero bueno.
	reg.mu.Lock()
	ro.Close()
	f, _ := os.OpenFile(ruta, os.O_WRONLY|os.O_APPEND, 0o644)
	reg.f = f
	reg.mu.Unlock()

	reg.escribir(evento{EventID: "redis.command.input", Comando: "INFO", SrcIP: "198.51.100.1"})
	reg.cerrar()

	hayError, hayInfo := false, false
	for _, m := range lineas(t, ruta) {
		switch m["eventid"] {
		case "redis.log.error":
			hayError = true
			if m["perdidos"] == nil {
				t.Fatalf("redis.log.error debería decir cuántos eventos se perdieron")
			}
		case "redis.command.input":
			if m["comando"] == "INFO" {
				hayInfo = true
			}
		}
	}
	if !hayError {
		t.Fatalf("al recuperarse debería dejar una línea redis.log.error")
	}
	if !hayInfo {
		t.Fatalf("tras recuperarse debería volver a registrar (INFO)")
	}
}

func TestRotarReabreTrasFalloDeApertura(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 23, 59, 0, 0, time.UTC)}
	reg, _ := nuevoRegistrador(ruta, 0, time.Minute, rel.ahora)
	reg.escribir(evento{EventID: "x", SrcIP: "198.51.100.1"})
	// Falla la apertura al rotar (carpeta de solo lectura).
	reg.mu.Lock()
	reg.f.Close()
	reg.f = nil
	reg.mu.Unlock()
	os.Chmod(dir, 0o500)
	rel.t = time.Date(2026, 10, 17, 0, 1, 0, 0, time.UTC)
	reg.tic() // intenta rotar/reabrir y falla
	os.Chmod(dir, 0o755)
	// Pasa el minuto de reintento.
	rel.t = rel.t.Add(2 * time.Minute)
	reg.tic()
	reg.escribir(evento{EventID: "y", Comando: "GET", SrcIP: "198.51.100.1"})
	reg.cerrar()
	recuperado := false
	for _, m := range lineas(t, ruta) {
		if m["eventid"] == "y" {
			recuperado = true
		}
	}
	if !recuperado {
		t.Fatalf("tras fallar la apertura, el registro debería reabrirse en el reintento")
	}
}

// ---- F8: keyspace por IP y caducidad ----------------------------------------

func TestKeyspaceSeparadoPorIP(t *testing.T) {
	s := servidorPrueba(t, conf{})
	a := clientePrueba(s, "198.51.100.1")
	b := clientePrueba(s, "203.0.113.2")
	ejecutar(s, a, "SET", "c2", "config-del-atacante")
	// Otro atacante desde otra IP no ve la clave: la IP del cliente no sirve
	// de buzón entre terceros.
	if out, _ := ejecutar(s, b, "GET", "c2"); !strings.Contains(out, "-1") {
		t.Fatalf("otra IP no debería ver la clave: %q", out)
	}
	// La misma IP sí la ve.
	if out, _ := ejecutar(s, a, "GET", "c2"); !strings.Contains(out, "config-del-atacante") {
		t.Fatalf("la misma IP debería ver su clave: %q", out)
	}
}

func TestClavesCaducan(t *testing.T) {
	rel := &reloj{t: time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)}
	c := conf{maxClaves: 10, maxClavesIP: 10, maxValorKb: 1, maxBancoMb: 1, vidaClaves: 10 * time.Minute}.conMinimos()
	b := nuevoBanco(c, rel.ahora)
	cli := &cliente{}
	v := b.entrar("198.51.100.1", cli)
	b.set(v, 0, "k", "val", time.Time{}, false)
	if _, ok := b.get(v, 0, "k"); !ok {
		t.Fatalf("la clave debería estar recién puesta")
	}
	// Pasa la vida: desaparece.
	rel.t = rel.t.Add(11 * time.Minute)
	if _, ok := b.get(v, 0, "k"); ok {
		t.Fatalf("la clave debería haber caducado tras su vida")
	}
}

func TestTTLYExpire(t *testing.T) {
	s := servidorPrueba(t, conf{})
	cli := clientePrueba(s, "198.51.100.1")
	ejecutar(s, cli, "SET", "k", "v")
	// Sin plazo pedido: TTL -1, como Redis.
	if out, _ := ejecutar(s, cli, "TTL", "k"); out != ":-1\r\n" {
		t.Fatalf("TTL de una clave sin plazo debería ser -1, dio %q", out)
	}
	// EXPIRE aplica un plazo.
	if out, _ := ejecutar(s, cli, "EXPIRE", "k", "100"); out != ":1\r\n" {
		t.Fatalf("EXPIRE debería dar 1, dio %q", out)
	}
	if out, _ := ejecutar(s, cli, "TTL", "k"); out == ":-1\r\n" || out == ":-2\r\n" {
		t.Fatalf("tras EXPIRE, TTL debería ser positivo, dio %q", out)
	}
	// TTL de una clave que no existe: -2.
	if out, _ := ejecutar(s, cli, "TTL", "nope"); out != ":-2\r\n" {
		t.Fatalf("TTL de clave inexistente debería ser -2, dio %q", out)
	}
}

// ---- F9: id de sesión de 64 bits --------------------------------------------

func TestSesion64Bits(t *testing.T) {
	a := nuevaSesion()
	if len(a) != 16 {
		t.Fatalf("la sesión debería tener 16 hex (64 bits), tiene %d: %q", len(a), a)
	}
	vistas := map[string]bool{}
	for i := 0; i < 10000; i++ {
		s := nuevaSesion()
		if vistas[s] {
			t.Fatalf("colisión de sesión en %d intentos: %q", i, s)
		}
		vistas[s] = true
	}
}

// ---- Parseo RESP defensivo (se conserva de la versión anterior) -------------

func TestLeerComandoArray(t *testing.T) {
	args, err := leer("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n", 65536, true)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(args) != 3 || args[0] != "SET" || args[1] != "k" || args[2] != "v" {
		t.Fatalf("mal parseado: %#v", args)
	}
}

func TestLeerComandoInline(t *testing.T) {
	args, err := leer("PING\r\n", 65536, true)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(args) != 1 || args[0] != "PING" {
		t.Fatalf("mal parseado: %#v", args)
	}
}

func TestLeerComandoDefensivo(t *testing.T) {
	casos := []struct {
		nombre  string
		entrada string
		maxB    int
	}{
		{"demasiados argumentos", "*2000\r\n", 65536},
		{"tipo de elemento no es bulk", "*1\r\n+OK\r\n", 65536},
		{"longitud de bulk negativa", "*1\r\n$-3\r\n", 65536},
		{"bulk pasa del tope", "*1\r\n$10\r\nabc\r\n", 4},
		{"total pasa del tope", "*2\r\n$3\r\nabc\r\n$3\r\ndef\r\n", 5},
		{"línea inline gigante", strings.Repeat("A", 100), 8},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			if _, err := leer(c.entrada, c.maxB, true); err == nil {
				t.Fatalf("se esperaba error de protocolo y no lo hubo")
			}
		})
	}
}

func TestLimitesNoAutenticado(t *testing.T) {
	// Sin autenticar, no más de 10 argumentos ni bulks de más de 16 KB
	// (CVE-2021-32675): no se reserva memoria por un atacante sin login.
	if _, err := leer("*11\r\n", 1<<20, false); err == nil {
		t.Fatalf("11 argumentos sin autenticar debería rechazarse")
	}
	if _, err := leer("*1\r\n$20000\r\n", 1<<20, false); err == nil {
		t.Fatalf("un bulk de 20 KB sin autenticar debería rechazarse")
	}
	// Autenticado sí se permite.
	if _, err := leer("*11\r\n"+strings.Repeat("$1\r\nx\r\n", 11), 1<<20, true); err != nil {
		t.Fatalf("autenticado, 11 argumentos deberían valer: %v", err)
	}
}

// ---- Glob -------------------------------------------------------------------

func TestGlobRedis(t *testing.T) {
	casos := []struct {
		patron, s string
		quiere    bool
	}{
		{"*", "cualquiera", true},
		{"foo*", "foobar", true},
		{"foo*", "barfoo", false},
		{"h?llo", "hello", true},
		{"h[ae]llo", "hallo", true},
		{"h[^e]llo", "hello", false},
		{"h[a-c]llo", "hbllo", true},
		{"\\*", "*", true},
		{"\\*", "x", false},
	}
	for _, c := range casos {
		if globRedis(c.patron, c.s) != c.quiere {
			t.Fatalf("globRedis(%q,%q)=%v, se esperaba %v", c.patron, c.s, !c.quiere, c.quiere)
		}
	}
}

// ---- Rotación y tope (se conservan de la versión anterior) ------------------

type reloj struct{ t time.Time }

func (r *reloj) ahora() time.Time { return r.t }

func lineas(t *testing.T, ruta string) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(ruta)
	if err != nil {
		return nil
	}
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("línea no es JSON: %q (%v)", l, err)
		}
		out = append(out, m)
	}
	return out
}

func TestRotacionDiariaPorRenombrado(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 23, 59, 0, 0, time.UTC)}

	reg, err := nuevoRegistrador(ruta, 0, time.Minute, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	reg.escribir(evento{EventID: "redis.command.input", Comando: "PING", SrcIP: "198.51.100.1"})

	rel.t = time.Date(2026, 10, 17, 0, 0, 1, 0, time.UTC)
	reg.escribir(evento{EventID: "redis.command.input", Comando: "INFO", SrcIP: "198.51.100.1"})
	reg.cerrar()

	rotado := ruta + ".2026_10_16"
	if _, err := os.Stat(rotado); err != nil {
		t.Fatalf("no se creó el rotado %s: %v", filepath.Base(rotado), err)
	}
	if ls := lineas(t, rotado); len(ls) != 1 || ls[0]["comando"] != "PING" {
		t.Fatalf("el rotado debería tener solo la línea de ayer (PING), tiene %#v", ls)
	}
	if ls := lineas(t, ruta); len(ls) != 1 || ls[0]["comando"] != "INFO" {
		t.Fatalf("el activo debería tener solo la línea de hoy (INFO), tiene %#v", ls)
	}
}

func TestTopeDeBytesPorDiaNoSePasa(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	// Última hora del día: el cupo del día ya está liberado entero.
	rel := &reloj{t: time.Date(2026, 10, 16, 23, 30, 0, 0, time.UTC)}
	tope := int64(32 << 10)

	reg, err := nuevoRegistrador(ruta, tope, time.Hour, rel.ahora)
	if err != nil {
		t.Fatal(err)
	}
	// Muchísimas órdenes desde muchas IP: no caben todas.
	for i := 0; i < 50000; i++ {
		reg.escribir(evento{EventID: "redis.command.input", Comando: "PING",
			Args: "relleno-para-ocupar-espacio", SrcIP: ipPrueba(i)})
	}
	reg.cerrar()

	// El tope duro del día se respeta: el disco del cliente está acotado.
	fi, _ := os.Stat(ruta)
	if fi.Size() > tope {
		t.Fatalf("el registro se pasó del tope diario: %d > %d", fi.Size(), tope)
	}
	// Y no se queda mudo sin explicar: hay avisos de lo que se calla.
	avisos := false
	for _, m := range lineas(t, ruta) {
		if m["eventid"] == "redis.log.omitidos" || m["eventid"] == "redis.log.tope" {
			avisos = true
		}
	}
	if !avisos {
		t.Fatalf("al llenarse debería dejar constancia (omitidos o tope)")
	}
}

func TestRotacionReiniciaElCupo(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 23, 30, 0, 0, time.UTC)}
	reg, _ := nuevoRegistrador(ruta, 8<<10, time.Hour, rel.ahora)
	for i := 0; i < 50000; i++ {
		reg.escribir(evento{EventID: "redis.command.input", Comando: "PING",
			Args: "relleno", SrcIP: ipPrueba(i)})
	}
	// Al día siguiente vuelve a registrar: no se queda ciega hasta las 00:00
	// y más allá.
	rel.t = time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	reg.escribir(evento{EventID: "redis.command.input", Comando: "GET", SrcIP: "198.51.100.1"})
	reg.cerrar()
	ls := lineas(t, ruta)
	if len(ls) != 1 || ls[0]["comando"] != "GET" {
		t.Fatalf("tras rotar, el activo debería tener solo la línea nueva (GET), tiene %#v", ls)
	}
}

func TestReinicioElMismoDiaNoRotaDeMas(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "redis.json")
	rel := &reloj{t: time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)}

	reg, _ := nuevoRegistrador(ruta, 0, time.Minute, rel.ahora)
	reg.escribir(evento{EventID: "redis.command.input", Comando: "PING", SrcIP: "198.51.100.1"})
	reg.cerrar()

	reg2, _ := nuevoRegistrador(ruta, 0, time.Minute, rel.ahora)
	reg2.escribir(evento{EventID: "redis.command.input", Comando: "INFO", SrcIP: "198.51.100.1"})
	reg2.cerrar()

	if ls := lineas(t, ruta); len(ls) != 2 {
		t.Fatalf("reiniciar el mismo día debería añadir, no rotar: %d líneas", len(ls))
	}
	entradas, _ := os.ReadDir(dir)
	for _, e := range entradas {
		if e.Name() != "redis.json" && e.Name() != nombreSemilla {
			t.Fatalf("no debería haber rotados tras un reinicio el mismo día, hay %s", e.Name())
		}
	}
}

func campo(info, clave string) string {
	for _, l := range strings.Split(info, "\r\n") {
		if strings.HasPrefix(l, clave+":") {
			return strings.TrimPrefix(l, clave+":")
		}
	}
	return ""
}
