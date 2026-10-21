// Pruebas de server.go y robots.go (cambios de SeguridadSI sobre go-pot).
// Corren al construir la imagen (Dockerfile): si fallan, no hay imagen.
package http

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"strings"
	"testing"
	"time"

	"github.com/ryanolee/go-pot/config"
	"github.com/ryanolee/go-pot/protocol/http/logging"
	"go.uber.org/fx/fxtest"
	"go.uber.org/zap"
)

type banco struct {
	s    *Server
	addr string
	dir  string
}

// servidorDePrueba arranca el servidor de verdad (sin el tarpit: las rutas
// que llegan a él no se piden aquí) en un puerto libre de 127.0.0.1.
func servidorDePrueba(t *testing.T) *banco {
	t.Helper()
	return servidorDePruebaCon(t, nil)
}

// servidorDePruebaCon: lo mismo, con algo cambiado antes de arrancar.
func servidorDePruebaCon(t *testing.T, cambiar func(*Server)) *banco {
	t.Helper()
	t.Setenv("SD_SEMILLA", "")
	libre, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	puerto := libre.Addr().(*net.TCPAddr).Port
	libre.Close()
	dir := t.TempDir()
	cfg := &config.Config{}
	cfg.Server.Host, cfg.Server.Port, cfg.Server.Network = "127.0.0.1", puerto, "tcp4"
	cfg.Server.AccessLog.Mode = "both"
	cfg.Server.AccessLog.Path = "rotar://" + filepath.Join(dir, "go-pot.json") + "?tope_mb=60"
	cfg.Server.AccessLog.FieldsToLog = strings.Split("id,phase,src_ip,src_port,method,host,path,qs,user_agent,duration", ",")
	al, err := logging.NewHttpAccessLogger(cfg, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	s := NewServer(fxtest.NewLifecycle(t), nil, cfg, nil, nil, al)
	if cambiar != nil {
		cambiar(s)
	}
	go s.Start()
	t.Cleanup(func() { _ = s.App.Shutdown() })
	b := &banco{s: s, addr: fmt.Sprintf("127.0.0.1:%d", puerto), dir: dir}
	for range 100 {
		if c, err := net.Dial("tcp4", b.addr); err == nil {
			c.Close()
			return b
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("el servidor no arranca")
	return nil
}

// pedir manda una petición en crudo y lee la respuesta.
func (b *banco) pedir(t *testing.T, crudo string) (*http.Response, string) {
	t.Helper()
	c, err := net.Dial("tcp4", b.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.WriteString(c, crudo); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("sin respuesta a %q: %v", crudo[:min(len(crudo), 40)], err)
	}
	cuerpo, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, string(cuerpo)
}

func (b *banco) lineas(t *testing.T) []map[string]any {
	t.Helper()
	datos, _ := os.ReadFile(filepath.Join(b.dir, "go-pot.json"))
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(datos)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("línea que no es JSON: %q", l)
		}
		out = append(out, m)
	}
	return out
}

func (b *banco) esperarError(t *testing.T, status int) map[string]any {
	t.Helper()
	return b.esperarErrorDesde(t, 0, status)
}

// esperarErrorDesde: la primera línea de error con ese código a partir de la
// línea desde (las anteriores son de otras peticiones).
func (b *banco) esperarErrorDesde(t *testing.T, desde, status int) map[string]any {
	t.Helper()
	for range 150 {
		ls := b.lineas(t)
		for _, l := range ls[min(desde, len(ls)):] {
			if l["phase"] == "error" && l["status"] == float64(status) {
				return l
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no se ha apuntado la petición con %d: %v", status, b.lineas(t))
	return nil
}

// legible comprueba que una línea de error lleva el método y la ruta que se
// pidieron; ilegible, que no lleva ningún campo de la petición (fasthttp no
// la ha podido leer: serían los de por defecto, «GET /»).
func legible(t *testing.T, l map[string]any, metodo, ruta string) {
	t.Helper()
	if l["method"] != metodo || l["path"] != ruta || l["peticion"] != nil {
		t.Fatalf("quiero %s %s: %v", metodo, ruta, l)
	}
}

func ilegible(t *testing.T, l map[string]any) {
	t.Helper()
	for _, k := range []string{"method", "path", "host", "qs", "user_agent"} {
		if _, ok := l[k]; ok {
			t.Fatalf("una petición ilegible no lleva %s: %v", k, l)
		}
	}
	if l["peticion"] != "ilegible" || l["src_ip"] != "127.0.0.1" {
		t.Fatalf("línea: %v", l)
	}
}

// cerrada: el servidor ha cerrado la conexión (lo que quede por leer, fuera).
func cerrada(c net.Conn, en time.Duration) bool {
	c.SetReadDeadline(time.Now().Add(en))
	_, err := io.Copy(io.Discard, c)
	var ne net.Error
	return !(errors.As(err, &ne) && ne.Timeout())
}

// El hallazgo alto: con el BodyLimit de 4 MiB de Fiber, cada conexión con un
// cuerpo grande a medias retenía ~4 MiB antes de enrutar, y unas decenas
// mataban el contenedor (OOM). Ahora se corta al leer la cabecera: 413 sin
// esperar al cuerpo, y la conexión se cierra.
func TestServidorLimiteDeCuerpo(t *testing.T) {
	b := servidorDePrueba(t)
	if n := b.s.App.Server().MaxRequestBodySize; n != limiteCuerpo || limiteCuerpo > 64<<10 {
		t.Fatalf("MaxRequestBodySize = %d", n)
	}
	c, err := net.Dial("tcp4", b.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	inicio := time.Now()
	fmt.Fprintf(c, "POST /subida HTTP/1.1\r\nHost: srv\r\nContent-Length: %d\r\n\r\n", 4<<20-1)
	c.Write(make([]byte, 1024)) // solo el principio del cuerpo
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("sin respuesta: %v", err)
	}
	cuerpo, _ := io.ReadAll(res.Body)
	if res.StatusCode != 413 || string(cuerpo) != "Request Entity Too Large" || time.Since(inicio) > 2*time.Second {
		t.Fatalf("%d %q en %v", res.StatusCode, cuerpo, time.Since(inicio))
	}
	// Y no se queda esperando el resto: cierra.
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("la conexión sigue abierta")
	}
	l := b.esperarError(t, 413)
	if l["method"] != "POST" || l["path"] != "/subida" {
		t.Fatalf("línea: %v", l)
	}
}

// Ni «200 {}» a todo (go-pot) ni los textos de Fiber: lo que contestaría un
// servidor web cualquiera. Y todo queda apuntado: con su método y su ruta si
// se han podido leer y, si no (hallazgo: salían como «GET /»), sin ellos.
func TestServidorRespuestasDeError(t *testing.T) {
	b := servidorDePrueba(t)
	casos := []struct {
		crudo        string
		status       int
		cuerpo       string
		metodo, ruta string // vacíos: ilegible
	}{
		{"POST /.env HTTP/1.1\r\nHost: srv\r\nContent-Length: 4\r\n\r\nx=1&", 405, "Method Not Allowed", "POST", "/.env"},
		{"OPTIONS / HTTP/1.1\r\nHost: srv\r\n\r\n", 405, "Method Not Allowed", "OPTIONS", "/"},
		{"FOO /x HTTP/1.1\r\nHost: srv\r\n\r\n", 501, "Not Implemented", "FOO", "/x"},
		// Sin una sola cabecera (lo que mandan muchos escáneres): se leyó.
		{"FOO /sin-cabeceras HTTP/1.0\r\n\r\n", 501, "Not Implemented", "FOO", "/sin-cabeceras"},
		{"GARBAGE\r\n\r\n", 400, "Bad Request", "", ""},
		{"GET /x HTTP/1.1\r\nHost: srv\r\nX-Relleno: " + strings.Repeat("a", 8192) + "\r\n\r\n", 431, "Request Header Fields Too Large", "", ""},
		{"GET /x HTTP/1.1\r\nHost: srv\r\nTransfer-Encoding: gzip\r\n\r\n", 400, "Bad Request", "", ""},
		// El cuerpo troceado no se lee (TestServidorTroceado): su exploit
		// queda con su método y su ruta, no como un 400 de «GET /».
		{"POST /cgi-bin/x HTTP/1.1\r\nHost: srv\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nbasura\r\n", 405, "Method Not Allowed", "POST", "/cgi-bin/x"},
	}
	for _, c := range casos {
		desde := len(b.lineas(t))
		res, cuerpo := b.pedir(t, c.crudo)
		if res.StatusCode != c.status || cuerpo != c.cuerpo {
			t.Errorf("%q: %d %q, quiero %d %q", c.crudo[:min(len(c.crudo), 30)], res.StatusCode, cuerpo, c.status, c.cuerpo)
		}
		if c.status == 405 && res.Header.Get("Allow") != "GET, HEAD" {
			t.Errorf("405 sin Allow: %v", res.Header)
		}
		l := b.esperarErrorDesde(t, desde, c.status)
		if c.metodo == "" {
			ilegible(t, l)
		} else {
			legible(t, l, c.metodo, c.ruta)
		}
	}
	l := b.esperarError(t, 405)
	if l["method"] != "POST" || l["path"] != "/.env" || l["src_ip"] != "127.0.0.1" {
		t.Fatalf("línea: %v", l)
	}
	if _, ok := l["src_port"].(float64); !ok {
		t.Fatalf("src_port: %v", l)
	}
}

// El cuerpo tiene plazoCuerpo desde la cabecera: a medias, 408 y fuera. La
// petición la vacía fasthttp al fallar el cuerpo: ilegible.
func TestServidorPlazoCuerpo(t *testing.T) {
	b := servidorDePrueba(t)
	c, err := net.Dial("tcp4", b.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(plazoCuerpo + 3*time.Second))
	ini := time.Now()
	io.WriteString(c, "POST /subida HTTP/1.1\r\nHost: srv\r\nContent-Length: 100\r\n\r\n0123456789")
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("sin respuesta: %v", err)
	}
	cuerpo, _ := io.ReadAll(res.Body)
	if d := time.Since(ini); res.StatusCode != 408 || string(cuerpo) != "Request Timeout" || d < plazoCuerpo-time.Second || d > plazoCuerpo+2*time.Second {
		t.Fatalf("%d %q a los %v", res.StatusCode, cuerpo, d)
	}
	ilegible(t, b.esperarError(t, 408))
}

func TestServidorRobotsDeLaTrampa(t *testing.T) {
	b := servidorDePrueba(t)
	res, cuerpo := b.pedir(t, "GET /robots.txt HTTP/1.1\r\nHost: srv\r\n\r\n")
	semilla, err := os.ReadFile(filepath.Join(b.dir, ".semilla"))
	if err != nil {
		t.Fatalf("no ha guardado su semilla: %v", err)
	}
	if res.StatusCode != 200 || cuerpo != robotsDeLaTrampa(strings.TrimSpace(string(semilla))) {
		t.Fatalf("%d %q", res.StatusCode, cuerpo)
	}
}

// Hallazgo: el robots.txt por trampa había perdido «Disallow: /», y los
// rastreadores que lo respetan entraban al tarpit y daban eventos. En todas
// las semillas, «Disallow: /» justo bajo «User-agent: *», ningún Allow que
// lo deshaga, y aun así distinto de una trampa a otra.
func TestRobotsPorTrampa(t *testing.T) {
	distintos := map[string]bool{}
	for i := range 2000 {
		r := robotsDeLaTrampa(fmt.Sprint("semilla-", i))
		if r != robotsDeLaTrampa(fmt.Sprint("semilla-", i)) {
			t.Fatal("con la misma semilla, el mismo robots.txt")
		}
		lineas := strings.Split(strings.TrimSuffix(r, "\n"), "\n")
		if !strings.HasSuffix(r, "\n") || len(lineas) < 5 || lineas[0] != "User-agent: *" || lineas[1] != "Disallow: /" {
			t.Fatalf("robots.txt: %q", r)
		}
		for _, l := range lineas[2:] {
			if !strings.HasPrefix(l, "Disallow: /") || l == "Disallow: /" {
				t.Fatalf("línea %q en %q", l, r)
			}
		}
		distintos[r] = true
	}
	if len(distintos) < 1500 {
		t.Fatalf("solo %d robots.txt distintos de 2000 trampas", len(distintos))
	}
}

// Una IP no ocupa más de conexionesPorIP: las de más se cierran sin
// contestar (ni el 503 ni el 429 de fasthttp, con sus textos).
func TestServidorCuposDeConexiones(t *testing.T) {
	b := servidorDePrueba(t)
	var conns []net.Conn
	for range conexionesPorIP + 6 {
		c, err := net.Dial("tcp4", b.addr)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		conns = append(conns, c)
	}
	time.Sleep(300 * time.Millisecond)
	cerradas := 0
	for _, c := range conns {
		c.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		n, err := c.Read(make([]byte, 256))
		if n > 0 {
			t.Fatalf("una conexión callada ha recibido algo")
		}
		if err == io.EOF {
			cerradas++
		}
	}
	if cerradas != 6 {
		t.Fatalf("cerradas: %d, quiero 6", cerradas)
	}
}

// Hallazgo: fasthttp no pone plazo al primer byte de una conexión y el
// limitador solo libera el hueco al cerrarla: conexionesPorIP calladas por
// IP se quedaban dentro para siempre (con 63 IP, la trampa ciega). Ahora se
// cierran pasado plazoPrimerByte, sin contestar nada, y el hueco vuelve. La
// que empieza a hablar a tiempo pasa a los plazos de fasthttp y acaba
// aunque el resto llegue después.
func TestServidorCalladaCaduca(t *testing.T) {
	const plazo = 600 * time.Millisecond
	b := servidorDePruebaCon(t, func(s *Server) { s.plazoPrimerByte = plazo })
	if b.s.plazoPrimerByte != plazo || plazoPrimerByte > 30*time.Second {
		t.Fatalf("plazo del primer byte: %v", plazoPrimerByte)
	}
	marcar := func() (net.Conn, time.Time) {
		c, err := net.Dial("tcp4", b.addr)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c, time.Now()
	}
	var calladas []net.Conn
	var ini time.Time
	for i := range conexionesPorIP - 1 {
		c, cuando := marcar()
		if i == 0 {
			ini = cuando
		}
		calladas = append(calladas, c)
	}
	tardia, _ := marcar()
	deMas, _ := marcar()
	if !cerrada(deMas, 300*time.Millisecond) {
		t.Fatal("con el cupo de la IP lleno, entra una más")
	}
	// La tardía dice su primer byte a tiempo y el resto pasado el plazo.
	time.Sleep(plazo / 2)
	io.WriteString(tardia, "G")
	time.Sleep(plazo)
	io.WriteString(tardia, "ET /robots.txt HTTP/1.1\r\nHost: srv\r\n\r\n")
	tardia.SetReadDeadline(time.Now().Add(3 * time.Second))
	res, err := http.ReadResponse(bufio.NewReader(tardia), nil)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("la que empieza a tiempo no acaba: %v %v", res, err)
	}
	// Las calladas, cerradas sin recibir nada.
	for _, c := range calladas {
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, err := c.Read(make([]byte, 64))
		if n > 0 || err != io.EOF {
			t.Fatalf("una callada: %d bytes, %v", n, err)
		}
	}
	if d := time.Since(ini); d < plazo {
		t.Fatalf("cerradas antes de su plazo (%v)", d)
	}
	// Y su IP vuelve a tener sitio.
	if res, _ := b.pedir(t, "GET /robots.txt HTTP/1.1\r\nHost: srv\r\n\r\n"); res.StatusCode != 200 {
		t.Fatalf("después: %d", res.StatusCode)
	}
}

// Hallazgo (memoria): fasthttp guarda cada línea de la cabecera y cada nombre
// de Trailer en una entrada propia: 4 KiB de líneas cortas eran ~85 KiB por
// conexión, y de comas en Trailer, ~130 KiB, retenidos mientras llegaba el
// cuerpo. Con más de maxSeparadores, 431 al momento, sin esperar el cuerpo,
// y se cierra; con su método y su ruta, que sí se han leído. Por debajo, normal.
func TestServidorCabeceraCostosa(t *testing.T) {
	b := servidorDePrueba(t)
	lineas := func(n int) string {
		var s strings.Builder
		for i := range n {
			fmt.Fprintf(&s, "a%d:b\r\n", i%10)
		}
		return s.String()
	}
	casos := []struct{ nombre, crudo, ruta string }{
		{"líneas cortas", "POST /x HTTP/1.1\r\nHost: srv\r\n" + lineas(600) + "Content-Length: 4096\r\n\r\n" + strings.Repeat("A", 100), "/x"},
		{"Trailer", "POST /y HTTP/1.1\r\nHost: srv\r\nTrailer: " + strings.Repeat("a,", 1500) + "a\r\nContent-Length: 4096\r\n\r\n", "/y"},
		// Antes que el enrutado: ni robots.txt.
		{"líneas cortas en un GET", "GET /robots.txt HTTP/1.1\r\nHost: srv\r\n" + lineas(200) + "\r\n", "/robots.txt"},
	}
	for _, caso := range casos {
		desde := len(b.lineas(t))
		c, err := net.Dial("tcp4", b.addr)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(2 * time.Second))
		ini := time.Now()
		io.WriteString(c, caso.crudo)
		res, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatalf("%s: sin respuesta: %v", caso.nombre, err)
		}
		cuerpo, _ := io.ReadAll(res.Body)
		if res.StatusCode != 431 || string(cuerpo) != "Request Header Fields Too Large" || !res.Close || time.Since(ini) > time.Second {
			t.Fatalf("%s: %d %q close=%v en %v", caso.nombre, res.StatusCode, cuerpo, res.Close, time.Since(ini))
		}
		if !cerrada(c, time.Second) {
			t.Fatalf("%s: la conexión sigue abierta", caso.nombre)
		}
		legible(t, b.esperarErrorDesde(t, desde, 431), map[bool]string{true: "GET", false: "POST"}[strings.HasPrefix(caso.crudo, "GET")], caso.ruta)
	}
	// Una petición corriente, aunque con bastantes cabeceras, sigue igual.
	if res, _ := b.pedir(t, "GET /robots.txt HTTP/1.1\r\nHost: srv\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n"+lineas(80)+"\r\n"); res.StatusCode != 200 || res.Close {
		t.Fatalf("una petición normal: %d close=%v", res.StatusCode, res.Close)
	}
}

func vivoYPilas() uint64 {
	runtime.GC()
	runtime.GC()
	s := []metrics.Sample{{Name: "/gc/heap/live:bytes"}, {Name: "/memory/classes/heap/stacks:bytes"}}
	metrics.Read(s)
	return s[0].Value.Uint64() + s[1].Value.Uint64()
}

// Hallazgo nuevo (fasthttp 1.54): al leer el tráiler de un cuerpo troceado,
// vuelve a añadir todas sus líneas cada vez que le llega un trozo sin acabar.
// Un tráiler mandado línea a línea eran 28 MiB de una sola conexión en medio
// segundo. El cuerpo troceado ya no se lee: se contesta en cuanto llega la
// cabecera (con su método y su ruta) y se cierra.
func TestServidorTroceado(t *testing.T) {
	b := servidorDePrueba(t)
	c, err := net.Dial("tcp4", b.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	io.WriteString(c, "POST /cgi-bin/x HTTP/1.1\r\nHost: srv\r\nTransfer-Encoding: chunked\r\nExpect: 100-continue\r\n\r\n0\r\na:\r\n")
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("sin respuesta con el tráiler a medias: %v", err)
	}
	if res.StatusCode != 405 || !res.Close {
		t.Fatalf("%d close=%v", res.StatusCode, res.Close)
	}
	legible(t, b.esperarError(t, 405), "POST", "/cgi-bin/x")
	// Un GET troceado, igual: contesta y cierra.
	if res, _ := b.pedir(t, "GET /robots.txt HTTP/1.1\r\nHost: srv\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhola!\r\n0\r\n\r\n"); res.StatusCode != 200 || !res.Close {
		t.Fatalf("GET troceado: %d close=%v", res.StatusCode, res.Close)
	}
	// El ataque: tráiler línea a línea. La memoria no se mueve.
	antes := vivoYPilas()
	c2, err := net.Dial("tcp4", b.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	io.WriteString(c2, "POST /x HTTP/1.1\r\nHost: srv\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n")
	for range 950 {
		if _, err := io.WriteString(c2, "a:\r\n"); err != nil {
			break // ya cerrada
		}
		time.Sleep(500 * time.Microsecond)
	}
	if d := int64(vivoYPilas()) - int64(antes); d > 2<<20 {
		t.Fatalf("el tráiler troceado ha costado %d KiB", d>>10)
	}
}

// Hallazgo (memoria): el tope de conexiones no cabía en memoriaMb con el
// peor caso de cada una. Con el servidor de verdad, conexionesParaMemoria
// conexiones a la vez (con 120 MiB) desde 127.0.x.y, conexionesPorIP por IP
// por el limitador, para cada peor caso: ninguna pasa de costePorConexion,
// así que todas juntas, con go-pot en reposo y el margen del recolector,
// caben en GOMEMLIMIT. Necesita poder conectar desde 127.0.x.y (Linux, que
// es donde se construye la imagen); en otro sistema se salta.
func TestServidorMemoriaPeorCaso(t *testing.T) {
	variasIPs(t)
	n := conexionesParaMemoria(memoriaPorDefecto)
	if n < 1000 || n > maximoConexiones || memoriaBase+margenRecolector+int64(n)*costePorConexion > memoriaPorDefecto {
		t.Fatalf("%d conexiones no caben en %d MiB", n, memoriaPorDefecto>>20)
	}
	// Que las goroutines de fasthttp de un caso no sirvan al siguiente (cada
	// caso cuenta las pilas de las suyas) y que ningún plazo cierre las
	// conexiones antes de medir, aunque la máquina sea lenta.
	b := servidorDePruebaCon(t, func(s *Server) {
		s.App.Server().MaxIdleWorkerDuration = 100 * time.Millisecond
		s.App.Server().ReadTimeout = time.Minute
		s.plazoPrimerByte, s.plazoCuerpo = time.Minute, time.Minute
	})
	if b.s.conexionesEnTotal != n {
		t.Fatalf("el servidor admite %d, no %d", b.s.conexionesEnTotal, n)
	}
	_, puerto, _ := net.SplitHostPort(b.addr)
	var cortas strings.Builder
	for i := 0; cortas.Len() < 3900; i++ {
		fmt.Fprintf(&cortas, "a%d:b\r\n", i%10)
	}
	var justas strings.Builder // por debajo de maxSeparadores
	for i := range maxSeparadores - 8 {
		fmt.Fprintf(&justas, "a%d:%s\r\n", i%10, strings.Repeat("b", 24))
	}
	var mezcla strings.Builder // líneas y nombres de Trailer, por debajo
	for i := range maxSeparadores - 33 {
		fmt.Fprintf(&mezcla, "a%d:%s\r\n", i%10, strings.Repeat("b", 30))
	}
	mezcla.WriteString("Trailer: " + strings.Repeat("ab,", 25) + "a\r\n")
	cuerpo := strings.Repeat("A", limiteCuerpo-1)
	casos := []struct {
		nombre, crudo string
		abiertas      bool // si se quedan esperando (lo que retiene memoria)
	}{
		{"una cabecera de 3,9 KiB y el cuerpo a medias", "POST /x HTTP/1.1\r\nHost: srv\r\nX-Relleno: " + strings.Repeat("a", 3900) +
			"\r\nContent-Length: 4096\r\n\r\n" + cuerpo, true},
		{"justo por debajo de maxSeparadores y el cuerpo a medias", "POST /x HTTP/1.1\r\nHost: srv\r\n" + justas.String() +
			"Content-Length: 4096\r\n\r\n" + cuerpo, true},
		{"líneas y Trailer por debajo de maxSeparadores, cuerpo a medias", "POST /x HTTP/1.1\r\nHost: srv\r\n" + mezcla.String() +
			"Content-Length: 4096\r\n\r\n" + cuerpo, true},
		{"cabecera a medias de líneas cortas", "GET /x HTTP/1.1\r\nHost: srv\r\n" + cortas.String(), true},
		{"calladas", "", true},
		{"líneas cortas y el cuerpo a medias (431)", "POST /x HTTP/1.1\r\nHost: srv\r\n" + cortas.String() +
			"Content-Length: 4096\r\n\r\n" + cuerpo, false},
		{"Trailer de 3,9 KiB y el cuerpo a medias (431)", "POST /x HTTP/1.1\r\nHost: srv\r\nTrailer: " + strings.Repeat("a,", 1950) +
			"a\r\nContent-Length: 4096\r\n\r\n" + cuerpo, false},
	}
	for _, caso := range casos {
		time.Sleep(1500 * time.Millisecond) // que se vayan las del caso anterior
		antes := vivoYPilas()
		gAntes := runtime.NumGoroutine()
		conns := make([]net.Conn, 0, n)
		for i := range n {
			ip := net.IPv4(127, 0, byte(1+i/conexionesPorIP/250), byte(1+(i/conexionesPorIP)%250))
			d := net.Dialer{LocalAddr: &net.TCPAddr{IP: ip}}
			c, err := d.Dial("tcp4", net.JoinHostPort("127.0.0.1", puerto))
			if err != nil {
				t.Fatalf("%s: conexión %d: %v", caso.nombre, i, err)
			}
			conns = append(conns, c)
			if caso.crudo != "" {
				if _, err := io.WriteString(c, caso.crudo); err != nil {
					t.Fatalf("%s: %v", caso.nombre, err)
				}
			}
		}
		// Hasta que el servidor lo haya leído todo: la memoria deja de moverse.
		despues := vivoYPilas()
		for range 30 {
			time.Sleep(500 * time.Millisecond)
			m := vivoYPilas()
			quieta := max(m, despues)-min(m, despues) < despues/100
			despues = m
			if quieta {
				break
			}
		}
		gDespues := runtime.NumGoroutine()
		siguen := 0
		for _, c := range conns[:100] {
			espera := 5 * time.Millisecond
			if !caso.abiertas {
				espera = 2 * time.Second
			}
			if !cerrada(c, espera) {
				siguen++
			}
		}
		for _, c := range conns {
			c.Close()
		}
		porConexion := (int64(despues) - int64(antes)) / int64(n)
		t.Logf("%-64s %d conexiones: %+5.1f KiB cada una, %3d de 100 siguen abiertas, %+d goroutines",
			caso.nombre, n, float64(porConexion)/1024, siguen, gDespues-gAntes)
		if caso.abiertas && siguen < 100 || !caso.abiertas && siguen > 0 {
			t.Fatalf("%s: siguen abiertas %d de 100", caso.nombre, siguen)
		}
		if porConexion > costePorConexion {
			t.Fatalf("%s: %d KiB por conexión, más que costePorConexion (%d KiB): con %d no caben en %d MiB",
				caso.nombre, porConexion>>10, costePorConexion>>10, n, memoriaPorDefecto>>20)
		}
	}
}

// El total sale del límite de memoria: sin límite, el de trampa.yaml; con
// más memoria, más conexiones; nunca por encima de concurrencia ni por
// debajo de unas pocas IP llenas.
func TestServidorConexionesParaMemoria(t *testing.T) {
	porDefecto := conexionesParaMemoria(memoriaPorDefecto)
	if conexionesParaMemoria(0) != porDefecto || conexionesParaMemoria(1<<63-1) != porDefecto {
		t.Fatal("sin GOMEMLIMIT, el de trampa.yaml")
	}
	if porDefecto != int((memoriaPorDefecto-memoriaBase-margenRecolector)/costePorConexion) {
		t.Fatalf("con 120 MiB: %d", porDefecto)
	}
	if conexionesParaMemoria(400<<20) <= porDefecto || conexionesParaMemoria(8<<30) != maximoConexiones || maximoConexiones >= concurrencia {
		t.Fatal("no crece con la memoria o pasa de concurrencia")
	}
	if conexionesParaMemoria(32<<20) != minimoConexiones {
		t.Fatal("mínimo")
	}
}

// variasIPs: la prueba necesita conectar desde 127.0.x.y, no solo desde
// 127.0.0.1. En Linux (donde se construye la imagen) se puede; en otro
// sistema, se salta.
func variasIPs(t *testing.T) {
	t.Helper()
	if l, err := net.Listen("tcp4", "127.0.1.1:0"); err != nil {
		if runtime.GOOS == "linux" {
			t.Fatalf("en Linux tiene que poder usar 127.0.1.1: %v", err)
		}
		t.Skipf("sin 127.0.x.y en %s: corre al construir la imagen", runtime.GOOS)
	} else {
		l.Close()
	}
}

// desde: una conexión al servidor desde ip (127.0.x.y).
func (b *banco) desde(t *testing.T, ip string) net.Conn {
	t.Helper()
	d := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP(ip)}, Timeout: 2 * time.Second}
	c, err := d.Dial("tcp4", b.addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// Hallazgo: con el tope total sacado de la memoria (1.228 con 120 MiB) y 64
// por IP, 20 IP que mantuvieran vivas sus conexiones (una petición barata,
// como robots.txt, antes de cada plazo) ocupaban todo el sitio: a cualquier
// otra IP se le cerraba la conexión sin contestar y su petición no se
// apuntaba. Con el servidor de verdad y 4 huecos llenos desde una IP (entre
// peticiones o a media petición), la de otra IP entra, se le contesta y se
// apunta. De la que acapara se va la más antigua, sin recibir nada y sin
// apuntarse como un error suyo, y las demás siguen como estaban.
func TestServidorRepartoJusto(t *testing.T) {
	variasIPs(t)
	peticion := "GET /robots.txt HTTP/1.1\r\nHost: srv\r\n"
	for _, caso := range []struct {
		nombre  string
		enMedio bool // las que acaparan tienen la cabecera a medias
	}{{"entre peticiones", false}, {"a media petición", true}} {
		t.Run(caso.nombre, func(t *testing.T) {
			b := servidorDePruebaCon(t, func(s *Server) { s.conexionesEnTotal = 4 })
			var llenas []net.Conn
			var lectores []*bufio.Reader
			for range 4 {
				c := b.desde(t, "127.0.0.1")
				c.SetDeadline(time.Now().Add(6 * time.Second))
				r := bufio.NewReader(c)
				if caso.enMedio {
					io.WriteString(c, peticion)
				} else {
					io.WriteString(c, peticion+"\r\n")
					res, err := http.ReadResponse(r, nil)
					if err != nil || res.StatusCode != 200 {
						t.Fatalf("llenando: %v %v", res, err)
					}
					io.Copy(io.Discard, res.Body)
					res.Body.Close()
				}
				llenas, lectores = append(llenas, c), append(lectores, r)
			}
			time.Sleep(300 * time.Millisecond) // que fasthttp haya leído lo suyo
			desde := len(b.lineas(t))
			nueva := b.desde(t, "127.0.0.2")
			nueva.SetDeadline(time.Now().Add(3 * time.Second))
			io.WriteString(nueva, "POST /.env HTTP/1.1\r\nHost: srv\r\nUser-Agent: escaner\r\nContent-Length: 0\r\n\r\n")
			res, err := http.ReadResponse(bufio.NewReader(nueva), nil)
			if err != nil || res.StatusCode != 405 {
				t.Fatalf("con todo lleno desde otra IP, la nueva no entra: %v %v", res, err)
			}
			l := b.esperarErrorDesde(t, desde, 405)
			if l["src_ip"] != "127.0.0.2" || l["method"] != "POST" || l["path"] != "/.env" || l["user_agent"] != "escaner" {
				t.Fatalf("línea: %v", l)
			}
			// Una de la que acapara (cuál, lo prueba TestCuposRepartoJusto),
			// cerrada sin recibir nada; las demás siguen como estaban.
			var siguen []int
			for i := range llenas {
				llenas[i].SetReadDeadline(time.Now().Add(500 * time.Millisecond))
				n, err := lectores[i].Read(make([]byte, 64))
				var ne net.Error
				switch {
				case n > 0:
					t.Fatalf("a una de las que acaparan le llega algo (%d bytes)", n)
				case errors.As(err, &ne) && ne.Timeout():
					siguen = append(siguen, i)
				case err != io.EOF:
					t.Fatalf("la desalojada: %v", err)
				}
			}
			if len(siguen) != 3 {
				t.Fatalf("desalojadas de la IP que acapara: %d, quiero 1", 4-len(siguen))
			}
			for _, i := range siguen {
				llenas[i].SetDeadline(time.Now().Add(3 * time.Second))
				if caso.enMedio {
					io.WriteString(llenas[i], "\r\n")
				} else {
					io.WriteString(llenas[i], peticion+"\r\n")
				}
				res, err := http.ReadResponse(lectores[i], nil)
				if err != nil || res.StatusCode != 200 {
					t.Fatalf("una que no se desaloja: %v %v", res, err)
				}
				io.Copy(io.Discard, res.Body)
				res.Body.Close()
			}
			// La desalojada no sale como una petición fallida de su IP (solo
			// en el resumen de rechazos, que es de cada minuto).
			time.Sleep(200 * time.Millisecond)
			for _, l := range b.lineas(t)[desde:] {
				if l["src_ip"] == "127.0.0.1" && l["phase"] != "rechazos" {
					t.Fatalf("la desalojada se apunta: %v", l)
				}
			}
		})
	}
}
