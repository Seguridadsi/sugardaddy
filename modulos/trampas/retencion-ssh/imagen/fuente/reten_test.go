package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// banco: una trampa de verdad en 127.0.0.1, con tiempos cortos y su registro
// en una carpeta temporal.
type banco struct {
	t      *testing.T
	s      *servidor
	dir    string
	addr   string
	parar  context.CancelFunc
	acabar chan struct{}
}

func cfgPrueba(t *testing.T) config {
	t.Helper()
	c, err := leerConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	c.retardo = 20 * time.Millisecond
	c.esperaPrimera = 200 * time.Millisecond
	c.plazoEscribir = time.Second
	c.resumen = time.Hour // las pruebas llaman a resumir() cuando quieren
	return c
}

func nuevoBanco(t *testing.T, c config) *banco {
	t.Helper()
	dir := t.TempDir()
	c.registro = filepath.Join(dir, "reten.json")
	reg, err := nuevoRegistrador(c.registro, c.topeDia, nil)
	if err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, parar := context.WithCancel(context.Background())
	b := &banco{t: t, s: nuevoServidor(c, reg), dir: dir, addr: l.Addr().String(), parar: parar, acabar: make(chan struct{})}
	go func() {
		b.s.servir(ctx, l)
		close(b.acabar)
	}()
	t.Cleanup(func() {
		parar()
		select {
		case <-b.acabar:
		case <-time.After(5 * time.Second):
			t.Error("la trampa no se para")
		}
		reg.cerrar()
	})
	return b
}

func (b *banco) conectar() net.Conn {
	b.t.Helper()
	c, err := net.DialTimeout("tcp", b.addr, 2*time.Second)
	if err != nil {
		b.t.Fatal(err)
	}
	b.t.Cleanup(func() { c.Close() })
	return c
}

// eventos lee el registro: una línea JSON por evento.
func (b *banco) eventos() []map[string]any {
	b.t.Helper()
	datos, err := os.ReadFile(filepath.Join(b.dir, "reten.json"))
	if err != nil {
		b.t.Fatal(err)
	}
	var evs []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(datos)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			b.t.Fatalf("línea que no es JSON: %q", l)
		}
		evs = append(evs, m)
	}
	return evs
}

// esperar a que haya un evento que cumpla f; lo devuelve.
func (b *banco) esperar(que string, f func(map[string]any) bool) map[string]any {
	b.t.Helper()
	fin := time.Now().Add(5 * time.Second)
	for time.Now().Before(fin) {
		for _, e := range b.eventos() {
			if f(e) {
				return e
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	b.t.Fatalf("no aparece %s; registro: %v", que, b.eventos())
	return nil
}

func es(evento string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["evento"] == evento }
}

// Esperar a que la conexión esté cerrada por la trampa (lee hasta EOF).
func cerradaPorLaTrampa(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.Copy(io.Discard, c); err != nil {
		t.Fatalf("la trampa no ha cerrado la conexión: %v", err)
	}
}

func TestModoSSH(t *testing.T) {
	b := nuevoBanco(t, cfgPrueba(t))
	c := b.conectar()
	if _, err := c.Write([]byte("SSH-2.0-OpenSSH_10.0\r\n")); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(c)
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	aviso := avisoDeLaTrampa("")
	for i := range len(aviso) + 2 {
		l, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("línea %d: %v", i, err)
		}
		// El aviso de la trampa, línea a línea, y vuelta a empezar.
		if l != aviso[i%len(aviso)]+"\r\n" {
			t.Fatalf("línea %d: %q, quiero %q", i, l, aviso[i%len(aviso)])
		}
	}
	c.Close()

	fin := b.esperar("el fin", es("fin"))
	if fin["motivo"] != motivoCliente || fin["modo"] != "ssh" {
		t.Fatalf("fin: %v", fin)
	}
	if fin["bytes"].(float64) < 50 || fin["recibidos"].(float64) != 22 {
		t.Fatalf("bytes del fin: %v", fin)
	}
	con := b.esperar("la conexión", es("conexion"))
	cli := b.esperar("el cliente", es("cliente"))
	if cli["datos"] != "SSH-2.0-OpenSSH_10.0" {
		t.Fatalf("cliente: %v", cli)
	}
	if con["src_ip"] != "127.0.0.1" || con["src_port"].(float64) == 0 {
		t.Fatalf("origen: %v", con)
	}
	if con["id"] != cli["id"] || cli["id"] != fin["id"] {
		t.Fatalf("los tres eventos tienen que llevar la misma sesión: %v %v %v", con, cli, fin)
	}
	if _, err := time.Parse(time.RFC3339Nano, con["ts"].(string)); err != nil {
		t.Fatalf("ts: %v", err)
	}
	// El orden: conexión, cliente, fin.
	evs := b.eventos()
	if len(evs) != 3 || evs[0]["evento"] != "conexion" || evs[1]["evento"] != "cliente" || evs[2]["evento"] != "fin" {
		t.Fatalf("orden: %v", evs)
	}
}

func TestModoBanner(t *testing.T) {
	c := cfgPrueba(t)
	c.modo = "banner"
	c.banner = "220 (vsFTPd 3.0.5)"
	b := nuevoBanco(t, c)
	con := b.conectar()
	r := bufio.NewReader(con)
	con.SetReadDeadline(time.Now().Add(2 * time.Second))
	l, err := r.ReadString('\n')
	if err != nil || l != c.banner+"\r\n" {
		t.Fatalf("saludo: %q %v", l, err)
	}
	con.Write([]byte("USER anonymous\r\n"))
	// Y nada más: no contesta.
	con.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if n, err := r.Read(make([]byte, 16)); n != 0 || err == nil {
		t.Fatalf("en modo banner no tiene que contestar: %d %v", n, err)
	}
	cli := b.esperar("el cliente", es("cliente"))
	if cli["datos"] != "USER anonymous" || cli["modo"] != "banner" {
		t.Fatalf("cliente: %v", cli)
	}
	con.Close()
	fin := b.esperar("el fin", es("fin"))
	if fin["motivo"] != motivoCliente || fin["bytes"].(float64) != float64(len(c.banner)+2) {
		t.Fatalf("fin: %v", fin)
	}
}

func TestPrimeraLineaSinSalto(t *testing.T) {
	b := nuevoBanco(t, cfgPrueba(t))
	c := b.conectar()
	c.Write([]byte("\x16\x03\x01abc")) // p. ej. el principio de un ClientHello de TLS
	cli := b.esperar("el cliente", es("cliente"))
	if cli["datos"] != "...abc" {
		t.Fatalf("datos: %q", cli["datos"])
	}
}

func TestTopePorIPYResumen(t *testing.T) {
	cfg := cfgPrueba(t)
	cfg.maxPorIP = 2
	b := nuevoBanco(t, cfg)
	b.conectar()
	b.conectar()
	b.esperar("dos conexiones", func(map[string]any) bool {
		n := 0
		for _, e := range b.eventos() {
			if e["evento"] == "conexion" {
				n++
			}
		}
		return n == 2
	})
	for range 3 {
		cerradaPorLaTrampa(t, b.conectar())
	}
	// Las rechazadas no dejan una línea cada una.
	for _, e := range b.eventos() {
		if e["evento"] != "conexion" {
			t.Fatalf("una rechazada ha dejado línea: %v", e)
		}
	}
	b.s.resumir()
	r := b.esperar("el resumen", es("rechazos"))
	if r["rechazadas"].(float64) != 3 || r["por_tope_ip"].(float64) != 3 || r["por_tope_global"].(float64) != 0 ||
		r["src_ip"] != "127.0.0.1" || r["de_su_ip"].(float64) != 3 || r["ips_distintas"].(float64) != 1 || r["activas"].(float64) != 2 {
		t.Fatalf("resumen: %v", r)
	}
	// Un periodo sin rechazos no escribe nada.
	n := len(b.eventos())
	b.s.resumir()
	if len(b.eventos()) != n {
		t.Fatal("un periodo sin rechazos no tiene que dejar línea")
	}
}

func TestTopeGlobal(t *testing.T) {
	cfg := cfgPrueba(t)
	cfg.maxConex = 1
	b := nuevoBanco(t, cfg)
	b.conectar()
	b.esperar("la conexión", es("conexion"))
	cerradaPorLaTrampa(t, b.conectar())
	b.s.resumir()
	r := b.esperar("el resumen", es("rechazos"))
	if r["por_tope_global"].(float64) != 1 || r["por_tope_ip"].(float64) != 0 {
		t.Fatalf("resumen: %v", r)
	}
}

func TestSeLiberaElHueco(t *testing.T) {
	cfg := cfgPrueba(t)
	cfg.maxPorIP = 1
	b := nuevoBanco(t, cfg)
	c := b.conectar()
	b.esperar("la conexión", es("conexion"))
	c.Close()
	b.esperar("el fin", es("fin"))
	// Ido el primero, el segundo entra.
	c2 := b.conectar()
	r := bufio.NewReader(c2)
	c2.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := r.ReadString('\n'); err != nil {
		t.Fatalf("el segundo no entra: %v", err)
	}
}

func TestResumenAcotaLasIPs(t *testing.T) {
	cfg := cfgPrueba(t)
	cfg.maxConex = 0 // todo se rechaza
	reg, err := nuevoRegistrador(filepath.Join(t.TempDir(), "reten.json"), 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reg.cerrar()
	s := nuevoServidor(cfg, reg)
	for i := range maxIPsResumen + 500 {
		s.admitir(net.IPv4(10, byte(i>>16), byte(i>>8), byte(i)).String())
	}
	s.admitir("10.0.0.1")
	if len(s.rech.ips) != maxIPsResumen || s.rech.sinContar != 500 || s.rech.total != maxIPsResumen+501 {
		t.Fatalf("ips=%d sinContar=%d total=%d", len(s.rech.ips), s.rech.sinContar, s.rech.total)
	}
	s.resumir()
	if s.rech.total != 0 || s.rech.ips != nil {
		t.Fatal("el resumen tiene que vaciar el periodo")
	}
}

func TestDuracionMaxima(t *testing.T) {
	cfg := cfgPrueba(t)
	cfg.duracionMax = 150 * time.Millisecond
	b := nuevoBanco(t, cfg)
	c := b.conectar()
	cerradaPorLaTrampa(t, c)
	fin := b.esperar("el fin", es("fin"))
	if fin["motivo"] != motivoTiempo {
		t.Fatalf("fin: %v", fin)
	}
}

func TestExcesoDeDatos(t *testing.T) {
	cfg := cfgPrueba(t)
	cfg.maxLeido = 4096
	b := nuevoBanco(t, cfg)
	c := b.conectar()
	go c.Write([]byte(strings.Repeat("A", 64<<10)))
	fin := b.esperar("el fin", es("fin"))
	if fin["motivo"] != motivoExceso {
		t.Fatalf("fin: %v", fin)
	}
	cli := b.esperar("el cliente", es("cliente"))
	if len(cli["datos"].(string)) != maxPrimera {
		t.Fatalf("la primera línea tiene que quedarse en %d bytes: %d", maxPrimera, len(cli["datos"].(string)))
	}
}

func TestParadaSueltaATodos(t *testing.T) {
	b := nuevoBanco(t, cfgPrueba(t))
	b.conectar()
	b.conectar()
	b.esperar("las conexiones", func(map[string]any) bool { return len(b.eventos()) == 2 })
	b.parar()
	select {
	case <-b.acabar:
	case <-time.After(3 * time.Second):
		t.Fatal("servir no acaba al parar")
	}
	n := 0
	for _, e := range b.eventos() {
		if e["evento"] == "fin" {
			if e["motivo"] != motivoParada {
				t.Fatalf("fin: %v", e)
			}
			n++
		}
	}
	if n != 2 {
		t.Fatalf("esperaba 2 fines por parada, hay %d", n)
	}
}

// Lo que delataba la trampa a la primera: líneas de letras al azar, cada
// retardo exacto, iguales en toda la flota (la firma de Endlessh). Ahora un
// aviso legal propio de cada trampa, a ritmo variable.
func TestAvisoPorTrampa(t *testing.T) {
	distintos := map[string]bool{}
	for i := range 60 {
		semilla := fmt.Sprint("trampa-", i)
		a := avisoDeLaTrampa(semilla)
		if strings.Join(a, "\n") != strings.Join(avisoDeLaTrampa(semilla), "\n") {
			t.Fatal("con la misma semilla, el mismo aviso")
		}
		if len(a) < 3 || a[len(a)-1] != "" {
			t.Fatalf("aviso: %q", a)
		}
		for _, l := range a {
			if strings.HasPrefix(l, "SSH-") || len(l) > 80 || !utf8.ValidString(l) || strings.ContainsAny(l, "\r\n") {
				t.Fatalf("línea que no vale: %q", l)
			}
			// La prueba del módulo (prueba.yaml) busca esto en la salida de ssh -v.
			if strings.Contains(l, "Authenticat") || strings.Contains(l, "protocol version") {
				t.Fatalf("línea que confunde la prueba: %q", l)
			}
		}
		distintos[strings.Join(a, "\n")] = true
	}
	if len(distintos) < 15 {
		t.Fatalf("solo %d avisos distintos de 60 trampas", len(distintos))
	}
	for _, texto := range avisos {
		for _, l := range texto {
			if strings.HasPrefix(l, "SSH-") || len([]rune(l))+4 > 80 {
				t.Fatalf("línea de aviso que no vale: %q", l)
			}
		}
	}
}

func TestEsperaVaria(t *testing.T) {
	vistas := map[time.Duration]bool{}
	for range 200 {
		d := espera(10 * time.Second)
		if d < 5*time.Second || d > 15*time.Second {
			t.Fatalf("espera fuera de rango: %v", d)
		}
		vistas[d] = true
	}
	if len(vistas) < 100 {
		t.Fatalf("la espera no varía: %d valores distintos", len(vistas))
	}
}

func TestLimpio(t *testing.T) {
	casos := []struct{ entra, sale string }{
		{"SSH-2.0-OpenSSH_10.0\r\n", "SSH-2.0-OpenSSH_10.0"},
		{"USER anonymous\n", "USER anonymous"},
		{"a\x00b\x1bc\td", "a.b.c.d"},
		{"\xff\xfeok", "..ok"},
		{"ñandú", "ñandú"},
	}
	for _, c := range casos {
		if got := limpio([]byte(c.entra), 256); got != c.sale {
			t.Errorf("limpio(%q) = %q, quiero %q", c.entra, got, c.sale)
		}
	}
	// No parte un carácter de dos bytes al recortar.
	if got := limpio([]byte("abñ"), 3); got != "ab" {
		t.Errorf("recorte: %q", got)
	}
	if got := limpio([]byte(strings.Repeat("x", 300)), 256); len(got) != 256 {
		t.Errorf("recorte: %d", len(got))
	}
}

// Lo que pide el adaptador de los sensores 0.12, que no lee fechas en
// segundos desde 1970 ni puertos entre comillas: "ts" en RFC 3339 como texto
// y el puerto como número. Revisado en todos los eventos: reten no necesita
// sensorMinimo.
func TestFormatoCompatible012(t *testing.T) {
	cfg := cfgPrueba(t)
	cfg.maxPorIP = 1
	b := nuevoBanco(t, cfg)
	c := b.conectar()
	c.Write([]byte("SSH-2.0-Go\r\n"))
	b.esperar("el cliente", es("cliente"))
	cerradaPorLaTrampa(t, b.conectar())
	c.Close()
	b.esperar("el fin", es("fin"))
	b.s.resumir()
	b.esperar("el resumen", es("rechazos"))
	evs := b.eventos()

	ruta := filepath.Join(t.TempDir(), "reten.json")
	r, err := nuevoRegistradorCon(ruta, 1300, 1000, 250, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 6 {
		r.escribir("conexion", campos{"id": nuevoID(), "modo": "ssh", "src_ip": fmt.Sprint("192.0.2.", i%3), "src_port": 40000 + i}, nil)
	}
	r.resumirCallados("ssh", time.Minute)
	r.cerrar()
	datos, _ := os.ReadFile(ruta)
	for _, l := range strings.Split(strings.TrimSpace(string(datos)), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatal(err)
		}
		evs = append(evs, m)
	}

	vistos := map[string]bool{}
	for _, e := range evs {
		vistos[e["evento"].(string)] = true
		ts, ok := e["ts"].(string)
		if !ok {
			t.Fatalf("ts no es texto: %v", e)
		}
		if _, err := time.Parse(time.RFC3339Nano, ts); err != nil || !strings.HasSuffix(ts, "Z") {
			t.Fatalf("ts %q no es RFC 3339 en UTC: %v", ts, err)
		}
		if p, ok := e["src_port"]; ok {
			if _, ok := p.(float64); !ok {
				t.Fatalf("src_port no es número: %v", e)
			}
		}
	}
	for _, ev := range []string{"conexion", "cliente", "fin", "rechazos", "callados", "tope"} {
		if !vistos[ev] {
			t.Fatalf("falta el evento %s: %v", ev, vistos)
		}
	}
}

func TestBannerPorDefectoCoherente(t *testing.T) {
	// Lo que dice vsftpd 3.0.5 de verdad: sin nombre de equipo ni «ready».
	if bannerPorDefecto != "220 (vsFTPd 3.0.5)" {
		t.Fatalf("saludo por defecto: %q", bannerPorDefecto)
	}
}
