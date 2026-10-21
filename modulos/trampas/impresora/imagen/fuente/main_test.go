package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// servidorPrueba monta un servidor con un registrador a un fichero temporal y
// devuelve la función para leer los eventos escritos.
func servidorPrueba(t *testing.T) (*servidor, func() []map[string]any) {
	t.Helper()
	dir := t.TempDir()
	ruta := filepath.Join(dir, "impresora.json")
	reg, err := nuevoRegistrador(ruta, 64<<20, time.Minute, time.Now)
	if err != nil {
		t.Fatalf("registrador: %v", err)
	}
	c := cargarConf()
	c.registro = ruta
	p := nuevaPersona(c, "semilla-de-prueba", time.Now())
	s := nuevoServidor(c, p, reg)
	leer := func() []map[string]any {
		reg.resumirAhora()
		b, err := os.ReadFile(ruta)
		if err != nil {
			t.Fatalf("leer registro: %v", err)
		}
		var evs []map[string]any
		for _, l := range bytes.Split(b, []byte("\n")) {
			if len(bytes.TrimSpace(l)) == 0 {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal(l, &m); err != nil {
				t.Fatalf("línea no JSON: %v\n%s", err, l)
			}
			evs = append(evs, m)
		}
		return evs
	}
	return s, leer
}

func tieneEvento(evs []map[string]any, eventid string) map[string]any {
	for _, e := range evs {
		if e["eventid"] == eventid {
			return e
		}
	}
	return nil
}

// --- IPP ---------------------------------------------------------------------

func TestIPPDecodeMalformado(t *testing.T) {
	casos := [][]byte{
		nil,
		{},
		{0x02},
		{0x02, 0x00, 0x00, 0x0b}, // sin request-id
		// nlen enorme: no debe desbordar ni reservar memoria.
		append([]byte{0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 1, 0x01, 0x47, 0xff, 0xff}, []byte("utf-8")...),
		// vlen enorme tras un nombre válido.
		{0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 1, 0x01, 0x47, 0, 3, 'a', 'b', 'c', 0xff, 0xff},
		bytes.Repeat([]byte{0x41}, 1024),
	}
	for i, c := range casos {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("caso %d: pánico %v", i, r)
				}
			}()
			_ = decodificarIPP(c)
		}()
	}
}

func TestIPPRespuestaCompleta(t *testing.T) {
	s, _ := servidorPrueba(t)
	resp := s.respGetPrinterAttributes(peticionIPP{ok: true, verMajor: 2, verMinor: 0, requestID: 42}, "127.0.0.1:631")
	if len(resp) < 12 {
		t.Fatal("respuesta IPP demasiado corta")
	}
	if resp[0] != 2 || resp[1] != 0 {
		t.Fatalf("versión IPP %d.%d", resp[0], resp[1])
	}
	if est := binary.BigEndian.Uint16(resp[2:4]); est != estOK {
		t.Fatalf("estado %#x", est)
	}
	if id := binary.BigEndian.Uint32(resp[4:8]); id != 42 {
		t.Fatalf("request-id %d", id)
	}
	if resp[len(resp)-1] != tagEnd {
		t.Fatal("no termina en end-of-attributes")
	}
	// Tiene que llevar los atributos clave como texto plano en el cuerpo.
	for _, a := range []string{"printer-make-and-model", "printer-state", "printer-name", "operations-supported", "media-col-default"} {
		if !bytes.Contains(resp, []byte(a)) {
			t.Fatalf("falta el atributo %q", a)
		}
	}
}

// recorrerIPP comprueba que una respuesta se puede recorrer entera sin salirse
// (estructura de etiquetas y longitudes coherente), como haría ipptool.
func recorrerIPP(t *testing.T, b []byte) {
	t.Helper()
	pos := 8
	for pos < len(b) {
		tag := b[pos]
		pos++
		if tag == tagEnd {
			return
		}
		if tag <= 0x0f {
			continue
		}
		if pos+2 > len(b) {
			t.Fatal("nombre sin longitud")
		}
		nlen := int(binary.BigEndian.Uint16(b[pos:]))
		pos += 2 + nlen
		if pos+2 > len(b) {
			t.Fatalf("valor sin longitud en pos %d", pos)
		}
		vlen := int(binary.BigEndian.Uint16(b[pos:]))
		pos += 2 + vlen
		if pos > len(b) {
			t.Fatalf("longitud fuera de rango: pos %d > %d", pos, len(b))
		}
	}
	t.Fatal("no se encontró end-of-attributes")
}

func TestIPPRespuestaRecorrible(t *testing.T) {
	s, _ := servidorPrueba(t)
	pet := peticionIPP{ok: true, verMajor: 2, verMinor: 0, requestID: 1}
	recorrerIPP(t, s.respGetPrinterAttributes(pet, "127.0.0.1:631"))
	recorrerIPP(t, s.respTrabajoIPP(pet, 7, "127.0.0.1:631"))
	recorrerIPP(t, respValidateIPP(pet))
	// Versión 1.1 (ipptool por defecto) debe reflejarse en la respuesta.
	v11 := s.respGetPrinterAttributes(peticionIPP{ok: true, verMajor: 1, verMinor: 1, requestID: 5}, "127.0.0.1:631")
	if v11[0] != 1 || v11[1] != 1 {
		t.Fatalf("no refleja la versión pedida: %d.%d", v11[0], v11[1])
	}
}

// --- PJL ---------------------------------------------------------------------

func TestEsTraversal(t *testing.T) {
	trav := []string{`0:\..\..\etc\passwd`, `/etc/passwd`, `0:/../../boot.ini`, `..\..\web.xml`}
	noTrav := []string{`0:\webServer\home.html`, `0:\PostScript`, `1:\default.cfg`, ``}
	for _, n := range trav {
		if !esTraversal(n) {
			t.Errorf("%q debería ser recorrido de rutas", n)
		}
	}
	for _, n := range noTrav {
		if esTraversal(n) {
			t.Errorf("%q no debería serlo", n)
		}
	}
}

func TestValorEtiqueta(t *testing.T) {
	l := `FSUPLOAD FORMAT:BINARY NAME="0:\..\passwd" OFFSET=0 SIZE=10`
	if v := valorEtiqueta(l, "NAME"); v != `0:\..\passwd` {
		t.Fatalf("NAME = %q", v)
	}
	if v := valorEtiqueta(`RDYMSG DISPLAY="HACKEADA"`, "DISPLAY"); v != "HACKEADA" {
		t.Fatalf("DISPLAY = %q", v)
	}
}

func TestManejarPJL(t *testing.T) {
	s, leer := servidorPrueba(t)
	base := func() evento { return evento{SrcIP: "198.51.100.5", Servicio: "raw"} }

	if r := s.manejarPJL(base, "@PJL INFO ID"); !strings.Contains(r, s.persona.modelo) {
		t.Fatalf("INFO ID no devuelve el modelo: %q", r)
	}
	s.manejarPJL(base, `@PJL FSUPLOAD FORMAT:BINARY NAME="0:\..\..\etc\passwd" OFFSET=0 SIZE=4`)
	s.manejarPJL(base, `@PJL FSDIRLIST NAME="0:\" ENTRY=1 COUNT=20`)
	s.manejarPJL(base, `@PJL RDYMSG DISPLAY="PWNED"`)
	s.manejarPJL(base, `@PJL FSDOWNLOAD FORMAT:BINARY SIZE=10 NAME="0:\exploit"`)

	evs := leer()
	for _, id := range []string{"impresora.pjl.info", "impresora.pjl.traversal", "impresora.pjl.fs", "impresora.pjl.control", "impresora.pjl.escritura"} {
		if tieneEvento(evs, id) == nil {
			t.Errorf("falta el evento %s", id)
		}
	}
	trav := tieneEvento(evs, "impresora.pjl.traversal")
	if trav["grave"] == nil || trav["grave"] == "" {
		t.Error("el traversal no lleva motivo grave")
	}
}

func TestLeerLineaAcotada(t *testing.T) {
	// Una línea de 1 MB sin salto no debe retener en memoria más que el tope.
	grande := bytes.Repeat([]byte("A"), 1<<20)
	br := bufio.NewReaderSize(bytes.NewReader(grande), 4096)
	var contado int64
	linea, total, completa, _ := leerLinea(br, 8192, func(b []byte) { contado += int64(len(b)) })
	if len(linea) > 8192 {
		t.Fatalf("la línea retenida (%d) pasa del tope", len(linea))
	}
	if total != 1<<20 {
		t.Fatalf("total %d != %d", total, 1<<20)
	}
	if contado != 1<<20-8192 {
		t.Fatalf("sink recibió %d, se esperaba %d", contado, 1<<20-8192)
	}
	if completa {
		t.Fatal("no debería estar completa (sin salto de línea)")
	}
}

// --- Web ---------------------------------------------------------------------

func TestCredenciales(t *testing.T) {
	// Basic auth.
	p := peticionHTTP{autoriz: "Basic YWRtaW46MTIzNA=="} // admin:1234
	u, c, ok := credenciales(p)
	if !ok || u != "admin" || c != "1234" {
		t.Fatalf("basic: %q %q %v", u, c, ok)
	}
	// Formulario.
	p = peticionHTTP{metodo: "POST", ruta: "/login", cuerpo: []byte("username=root&password=toor")}
	u, c, ok = credenciales(p)
	if !ok || u != "root" || c != "toor" {
		t.Fatalf("form: %q %q %v", u, c, ok)
	}
}

func TestCambioServidorPassback(t *testing.T) {
	s, _ := servidorPrueba(t)
	def := valoresConfig(s.persona)

	// Un servidor LDAP nuevo es passback.
	cs := cambioServidor([]byte("ldap_server=203.0.113.9&ldap_base=dc=corp"), def)
	pb := filtrarPassback(cs, true)
	if len(pb) != 1 || pb[0].valor != "203.0.113.9" || pb[0].campo != "ldap_server" {
		t.Fatalf("passback no detectado: %+v", cs)
	}
	// Un cambio de nombre no es passback, pero sí es un cambio de config.
	cs = cambioServidor([]byte("device_name=Recepcion"), def)
	if len(filtrarPassback(cs, true)) != 0 {
		t.Fatal("device_name no debería ser passback")
	}
	if len(filtrarPassback(cs, false)) != 1 {
		t.Fatal("device_name debería ser un cambio de config")
	}
	// Guardar sin tocar nada (todos los valores por defecto) no es nada.
	formDefecto := "ldap_server=" + def["ldap_server"] + "&ldap_base=" + def["ldap_base"] +
		"&ldap_user=" + def["ldap_user"] + "&ldap_password=" + def["ldap_password"] +
		"&smtp_server=" + def["smtp_server"]
	if cs := cambioServidor([]byte(formDefecto), def); len(cs) != 0 {
		t.Fatalf("guardar sin cambios no debería ser passback ni config: %+v", cs)
	}
	// Formulario completo de paginaConfig cambiando SOLO el SMTP: el passback
	// debe apuntar al servidor SMTP del atacante, no al LDAP por defecto.
	formSMTP := "ldap_server=" + def["ldap_server"] + "&ldap_base=" + def["ldap_base"] +
		"&ldap_user=" + def["ldap_user"] + "&ldap_password=" + def["ldap_password"] +
		"&smtp_server=203.0.113.90"
	pb = filtrarPassback(cambioServidor([]byte(formSMTP), def), true)
	if len(pb) != 1 || pb[0].campo != "smtp_server" || pb[0].valor != "203.0.113.90" {
		t.Fatalf("passback de SMTP mal detectado: %+v", pb)
	}
	// URL ldap:// también parece host (antes la '/' la descartaba).
	if !pareceHost("ldap://203.0.113.81:389") || !pareceHost("ldaps://evil.example.com") {
		t.Fatal("pareceHost debería aceptar URL ldap://")
	}
}

// TestPassbackConCredenciales: la precedencia (servidor antes que login) hace
// que un passback que trae también credenciales (formulario o Basic auth) no se
// pierda como un simple intento de login.
func TestPassbackConCredenciales(t *testing.T) {
	s, leer := servidorPrueba(t)

	// Formulario con servidor + username/password.
	cuerpo := []byte("ldap_server=203.0.113.77&username=cn=svc&password=Secreta1")
	p := peticionHTTP{metodo: "POST", ruta: "/config", proto: "HTTP/1.1", keepAlive: true, cuerpo: cuerpo}
	base := func() evento { return evento{SrcIP: "198.51.100.7", Servicio: "web"} }
	w := bufio.NewWriter(io.Discard)
	s.responderHTTP(w, base, p, "198.51.100.7")

	// Basic auth + servidor por formulario.
	p2 := peticionHTTP{metodo: "POST", ruta: "/config", proto: "HTTP/1.1", keepAlive: true,
		autoriz: "Basic YWRtaW46YWRtaW4=", cuerpo: []byte("ldap_server=203.0.113.80")}
	s.responderHTTP(bufio.NewWriter(io.Discard), base, p2, "198.51.100.8")

	evs := leer()
	pbs := 0
	for _, e := range evs {
		if e["eventid"] == "impresora.web.passback" {
			pbs++
			if e["servidor"] == "" || e["password"] == "" {
				t.Fatalf("passback sin servidor o sin credenciales: %v", e)
			}
		}
	}
	if pbs != 2 {
		t.Fatalf("se esperaban 2 passback con credenciales, hubo %d", pbs)
	}
	if tieneEvento(evs, "impresora.web.login") != nil {
		t.Fatal("un passback con credenciales no debe quedar como login")
	}
}

func TestLeerPeticionHTTPGrande(t *testing.T) {
	// Content-Length enorme con poco cuerpo: la lectura se acota y no cuelga.
	s, _ := servidorPrueba(t)
	s.cfg.maxCuerpoMem = 1024
	s.cfg.maxTrabajo = 4096
	cuerpo := bytes.Repeat([]byte("x"), 2000)
	req := "POST /ipp/print HTTP/1.1\r\nHost: x\r\nContent-Type: application/ipp\r\nContent-Length: 2000\r\n\r\n"
	br := bufio.NewReaderSize(bytes.NewReader(append([]byte(req), cuerpo...)), 512)
	w := bufio.NewWriter(io.Discard)
	p, err := s.leerPeticionHTTP(br, w)
	if err != nil {
		t.Fatalf("leer: %v", err)
	}
	s.presup.soltar(p.tomado)
	if len(p.cuerpo) > 1024 {
		t.Fatalf("cuerpo en memoria %d > tope", len(p.cuerpo))
	}
	if p.cuerpoTam != 2000 {
		t.Fatalf("tamaño declarado %d", p.cuerpoTam)
	}
	if p.recibido != 2000 {
		t.Fatalf("recibido %d != 2000", p.recibido)
	}
}

// TestPresupuestoGlobalMemoria: muchas peticiones con cuerpos grandes a la vez
// nunca retienen en memoria más que el presupuesto global, sea cual sea el
// número de conexiones (el fallo de OOM del hallazgo). Cada petición toma del
// presupuesto; la suma de lo tomado no pasa del tope.
func TestPresupuestoGlobalMemoria(t *testing.T) {
	s, _ := servidorPrueba(t)
	const tope = 1 << 20
	s.presup = nuevoPresupuesto(tope)
	s.cfg.maxCuerpoMem = 64 << 10
	s.cfg.maxTrabajo = 1 << 20

	var tomados []int64
	var suma int64
	cuerpo := bytes.Repeat([]byte("z"), 200000)
	for i := 0; i < 64; i++ {
		req := "POST /ipp/print HTTP/1.1\r\nHost: x\r\nContent-Type: application/ipp\r\nContent-Length: 200000\r\n\r\n"
		br := bufio.NewReaderSize(bytes.NewReader(append([]byte(req), cuerpo...)), 4096)
		p, err := s.leerPeticionHTTP(br, bufio.NewWriter(io.Discard))
		if err != nil {
			t.Fatalf("petición %d: %v", i, err)
		}
		tomados = append(tomados, p.tomado)
		suma += p.tomado
		if len(p.cuerpo) > s.cfg.maxCuerpoMem {
			t.Fatalf("petición %d: cuerpo en memoria %d > tope por conexión", i, len(p.cuerpo))
		}
		// Sin soltar todavía: simulamos 64 conexiones vivas a la vez.
		if suma > tope {
			t.Fatalf("en vuelo %d > presupuesto %d tras %d conexiones", suma, tope, i+1)
		}
	}
	// Con el presupuesto agotado, las siguientes toman 0 (no reservan memoria).
	if s.presup.disponible() != 0 && suma < tope {
		t.Fatalf("presupuesto sin repartir del todo: disp=%d suma=%d", s.presup.disponible(), suma)
	}
	for _, n := range tomados {
		s.presup.soltar(n)
	}
	if s.presup.disponible() != tope {
		t.Fatalf("al soltar todo, disponible=%d != %d", s.presup.disponible(), tope)
	}
}

// TestWebCodigos: la web ya no contesta 200 a todo. 404 para rutas que no
// existen, 405 para métodos raros, HEAD sin cuerpo y cabecera Date siempre.
func TestWebCodigos(t *testing.T) {
	s, _ := servidorPrueba(t)
	pedir := func(metodo, ruta string) string {
		p := peticionHTTP{metodo: metodo, ruta: ruta, proto: "HTTP/1.1", keepAlive: false}
		var sb strings.Builder
		w := bufio.NewWriter(&sb)
		base := func() evento { return evento{SrcIP: "198.51.100.9", Servicio: "web"} }
		s.responderHTTP(w, base, p, "198.51.100.9")
		w.Flush()
		return sb.String()
	}
	if r := pedir("GET", "/.git/HEAD"); !strings.Contains(r, "404 Not Found") {
		t.Fatalf("/.git/HEAD debería dar 404:\n%s", primeraLinea(r))
	}
	if r := pedir("GET", "/"); !strings.Contains(r, "200 OK") {
		t.Fatalf("/ debería dar 200:\n%s", primeraLinea(r))
	}
	if r := pedir("DELETE", "/"); !strings.Contains(r, "405 Method Not Allowed") {
		t.Fatalf("DELETE debería dar 405:\n%s", primeraLinea(r))
	}
	if r := pedir("GET", "/"); !strings.Contains(r, "\r\nDate:") {
		t.Fatal("falta la cabecera Date")
	}
	// HEAD / no debe llevar cuerpo (solo cabeceras).
	r := pedir("HEAD", "/")
	cab, cuerpo, _ := strings.Cut(r, "\r\n\r\n")
	if !strings.Contains(cab, "200 OK") {
		t.Fatalf("HEAD / debería dar 200:\n%s", primeraLinea(r))
	}
	if cuerpo != "" {
		t.Fatalf("HEAD no debe llevar cuerpo, llevó %d bytes", len(cuerpo))
	}
}

func primeraLinea(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// --- integración por socket --------------------------------------------------

// pipe corre un atendedor contra un extremo y devuelve el otro para el ataque.
func pipe(atender func(net.Conn)) (net.Conn, chan struct{}) {
	a, b := net.Pipe()
	fin := make(chan struct{})
	go func() {
		atender(b)
		close(fin)
	}()
	return a, fin
}

func TestAtender9100InfoID(t *testing.T) {
	s, _ := servidorPrueba(t)
	cli, fin := pipe(func(c net.Conn) { s.atender9100(c) })
	// La sonda que manda nmap.
	cli.SetDeadline(time.Now().Add(5 * time.Second))
	cli.Write([]byte(uel + "@PJL INFO ID\r\n" + uel + "\r\n"))
	buf := make([]byte, 256)
	n, _ := cli.Read(buf)
	if !bytes.Contains(buf[:n], []byte("@PJL INFO ID")) || !bytes.Contains(buf[:n], []byte(s.persona.modelo)) {
		t.Fatalf("respuesta inesperada: %q", buf[:n])
	}
	cli.Close()
	<-fin
}

func TestAtender9100Basura(t *testing.T) {
	// Bytes al azar no deben provocar pánico ni bloqueo.
	s, _ := servidorPrueba(t)
	cli, fin := pipe(func(c net.Conn) { s.atender9100(c) })
	cli.SetDeadline(time.Now().Add(5 * time.Second))
	cli.Write(bytes.Repeat([]byte{0x00, 0x1b, 0xff, 0x41, 0x0a}, 5000))
	cli.Close()
	select {
	case <-fin:
	case <-time.After(5 * time.Second):
		t.Fatal("el atendedor no termina con basura")
	}
}

func TestAtenderHTTPIPP(t *testing.T) {
	s, leer := servidorPrueba(t)
	cli, fin := pipe(func(c net.Conn) { s.atenderHTTP(c, "ipp") })
	cli.SetDeadline(time.Now().Add(5 * time.Second))
	// Get-Printer-Attributes mínimo.
	var ipp bytes.Buffer
	ipp.Write([]byte{0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 9})
	ipp.WriteByte(tagOperation)
	attrStr(&ipp, tagCharset, "attributes-charset", "utf-8")
	attrStr(&ipp, tagLanguage, "attributes-natural-language", "en")
	attrStr(&ipp, tagURI, "printer-uri", "ipp://x/ipp/print")
	ipp.WriteByte(tagEnd)
	cuerpo := ipp.Bytes()
	req := "POST /ipp/print HTTP/1.1\r\nHost: x\r\nContent-Type: application/ipp\r\nContent-Length: " +
		itoa(len(cuerpo)) + "\r\nConnection: close\r\n\r\n"
	cli.Write(append([]byte(req), cuerpo...))
	buf := make([]byte, 4096)
	n, _ := cli.Read(buf)
	if !bytes.Contains(buf[:n], []byte("application/ipp")) {
		t.Fatalf("no responde IPP: %q", buf[:min(n, 200)])
	}
	cli.Close()
	<-fin
	if tieneEvento(leer(), "impresora.ipp.peticion") == nil {
		t.Fatal("no se registró la petición IPP")
	}
}

func TestAtenderHTTPBasura(t *testing.T) {
	s, _ := servidorPrueba(t)
	cli, fin := pipe(func(c net.Conn) { s.atenderHTTP(c, "web") })
	cli.SetDeadline(time.Now().Add(5 * time.Second))
	cli.Write(bytes.Repeat([]byte("A"), 100000)) // sin estructura HTTP
	cli.Close()
	select {
	case <-fin:
	case <-time.After(5 * time.Second):
		t.Fatal("el atendedor HTTP no termina con basura")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
