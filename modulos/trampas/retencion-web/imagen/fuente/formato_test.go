// Pruebas de formato.go (código propio de SeguridadSI). Corren al construir
// la imagen (Dockerfile): si fallan, no hay imagen.
package logging

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/ryanolee/go-pot/config"
	"go.uber.org/zap"
)

const camposDelManifiesto = "id,phase,src_ip,src_port,method,host,path,qs,user_agent,duration"

func registroDePrueba(t *testing.T) (*HttpAccessLogger, string) {
	t.Helper()
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	cfg := &config.Config{}
	cfg.Server.AccessLog.Mode = "both"
	cfg.Server.AccessLog.Path = "rotar://" + ruta + "?tope_mb=60"
	cfg.Server.AccessLog.FieldsToLog = strings.Split(camposDelManifiesto, ",")
	l, err := NewHttpAccessLogger(cfg, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	return l, ruta
}

// Lo que pide el adaptador de los sensores 0.12: "ts" en RFC 3339 como texto
// (time.Parse(time.RFC3339Nano, ...)) y el puerto como número JSON.
func compatible012(t *testing.T, o map[string]any) time.Time {
	t.Helper()
	ts, ok := o["ts"].(string)
	if !ok {
		t.Fatalf("ts no es texto: %v", o)
	}
	cuando, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil || !strings.HasSuffix(ts, "Z") {
		t.Fatalf("ts %q no es RFC 3339 en UTC: %v", ts, err)
	}
	if p, ok := o["src_port"]; ok {
		if _, ok := p.(float64); !ok {
			t.Fatalf("src_port no es número: %v", o)
		}
	}
	return cuando
}

func TestFormatoLineasDelRegistro(t *testing.T) {
	l, ruta := registroDePrueba(t)
	app := fiber.New(fiber.Config{DisableStartupMessage: true, Immutable: true})
	app.Get("/*", func(c *fiber.Ctx) error {
		e := l.Start(c)
		l.End(e, 1500*time.Millisecond)
		return c.SendString("ok")
	})
	app.Post("/*", func(c *fiber.Ctx) error {
		l.Rechazada(c, fiber.StatusMethodNotAllowed, true)
		return c.SendStatus(fiber.StatusMethodNotAllowed)
	})
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go app.Listener(ln)
	defer app.Shutdown()

	c, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	puerto := c.LocalAddr().(*net.TCPAddr).Port
	fmt.Fprintf(c, "GET /.env?a=1 HTTP/1.1\r\nHost: srv\r\nUser-Agent: Nuclei\r\n\r\n")
	fmt.Fprintf(c, "POST /cgi-bin/x HTTP/1.1\r\nHost: srv\r\nContent-Length: 0\r\n\r\n")
	br := bufio.NewReader(c)
	for range 2 {
		res, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}
	l.logger.Sync()

	objs := objetos(t, ruta)
	if len(objs) != 3 {
		t.Fatalf("esperaba inicio, fin y error: %v", objs)
	}
	ini, fin, rech := objs[0], objs[1], objs[2]
	for _, o := range objs {
		cuando := compatible012(t, o)
		if time.Since(cuando) > time.Minute || o["src_port"] != float64(puerto) || o["src_ip"] != "127.0.0.1" {
			t.Fatalf("línea: %v (puerto %d)", o, puerto)
		}
		if _, ok := o["caller"]; ok {
			t.Fatalf("sin caller: %v", o)
		}
	}
	if ini["phase"] != "start" || ini["path"] != "/.env" || ini["qs"] != "a=1" || ini["user_agent"] != "Nuclei" || ini["duration"] != nil {
		t.Fatalf("inicio: %v", ini)
	}
	if fin["phase"] != "end" || fin["duration"] != "1.500" || fin["id"] != ini["id"] || fin["path"] != "/.env" {
		t.Fatalf("fin: %v", fin)
	}
	if rech["phase"] != "error" || rech["method"] != "POST" || rech["path"] != "/cgi-bin/x" || rech["status"] != float64(405) ||
		rech["id"] == ini["id"] || rech["duration"] != nil {
		t.Fatalf("rechazada: %v", rech)
	}
	// Las líneas propias del registro, en el mismo formato.
	r := rotadorActivo.Load()
	r.Write([]byte(`{"phase":"start","src_ip":"192.0.2.1"}` + "\n"))
	r.mu.Lock()
	r.callar("192.0.2.1", motivoCupoIP)
	aviso := r.lineaTope()
	r.mu.Unlock()
	r.resumir(time.Minute)
	r.Write(aviso)
	for _, o := range objetos(t, ruta)[3:] {
		if o["phase"] == "start" {
			continue
		}
		compatible012(t, o)
	}
}

func TestSemillaDeLaTrampa(t *testing.T) {
	t.Setenv("SD_SEMILLA", "")
	dir := t.TempDir()
	cfg := "rotar://" + filepath.Join(dir, "go-pot.json") + "?tope_mb=60"
	a := SemillaDeLaTrampa(cfg)
	if len(a) != 32 {
		t.Fatalf("semilla: %q", a)
	}
	if b := SemillaDeLaTrampa(cfg); b != a {
		t.Fatalf("la semilla tiene que ser la misma tras un reinicio: %q y %q", a, b)
	}
	if b, err := os.ReadFile(filepath.Join(dir, ".semilla")); err != nil || strings.TrimSpace(string(b)) != a {
		t.Fatalf("no se ha guardado: %q %v", b, err)
	}
	if b := SemillaDeLaTrampa("rotar://" + filepath.Join(t.TempDir(), "go-pot.json")); b == a {
		t.Fatal("dos trampas no pueden tener la misma semilla")
	}
	// Sin carpeta escribible, el nombre del contenedor.
	h, _ := os.Hostname()
	if b := SemillaDeLaTrampa("rotar:///no/existe/go-pot.json"); b != h {
		t.Fatalf("sin carpeta: %q", b)
	}
	t.Setenv("SD_SEMILLA", "srv-web07")
	if b := SemillaDeLaTrampa(cfg); b != "srv-web07" {
		t.Fatalf("SD_SEMILLA: %q", b)
	}
}

// Hallazgo: si fasthttp no llega a leer la petición (o la vacía al fallar el
// cuerpo), su método y su ruta son los de por defecto: se apuntaba «GET /»,
// que el atacante nunca pidió. Ilegible: sin los campos de la petición y con
// "peticion":"ilegible"; lo demás (IP, puerto, código), igual.
func TestFormatoRechazadaIlegible(t *testing.T) {
	l, ruta := registroDePrueba(t)
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/*", func(c *fiber.Ctx) error {
		l.Rechazada(c, fiber.StatusBadRequest, false)
		return c.SendStatus(fiber.StatusBadRequest)
	})
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go app.Listener(ln)
	defer app.Shutdown()
	c, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "GET /x?a=1 HTTP/1.1\r\nHost: srv\r\nUser-Agent: Nuclei\r\n\r\n")
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	l.logger.Sync()
	objs := objetos(t, ruta)
	if len(objs) != 1 {
		t.Fatalf("líneas: %v", objs)
	}
	o := objs[0]
	compatible012(t, o)
	for _, k := range []string{"method", "path", "qs", "host", "user_agent"} {
		if _, ok := o[k]; ok {
			t.Fatalf("una petición ilegible no lleva %s: %v", k, o)
		}
	}
	if o["phase"] != "error" || o["status"] != float64(400) || o["peticion"] != "ilegible" || o["src_ip"] != "127.0.0.1" || o["id"] == nil {
		t.Fatalf("línea: %v", o)
	}
}
