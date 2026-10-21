package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// errPeticionMala: la línea de petición no tiene forma de HTTP. Se contesta 400,
// como un servidor real, en vez de cortar en silencio (eso delataba la trampa).
var errPeticionMala = errors.New("línea de petición mal formada")

// atenderHTTP lleva una conexión HTTP (puerto 631 para IPP y la web, o 80 para
// la web de administración). Reparte: un POST con cuerpo IPP va al servidor
// IPP; lo demás, a la web de administración, que registra los intentos de
// inicio de sesión (usuario y contraseña completos) y, sobre todo, el cambio
// del servidor LDAP/SMTP por el del atacante (passback de credenciales), que es
// la señal más valiosa de esta trampa.
func (s *servidor) atenderHTTP(conn net.Conn, servicio string) {
	defer conn.Close()
	ip, puerto := origen(conn.RemoteAddr())
	ses := nuevaSesion()
	base := func() evento {
		return evento{Cuando: time.Now().UTC().Format(time.RFC3339Nano), Session: ses, SrcIP: ip, SrcPort: puerto, Servicio: servicio}
	}
	ec := base()
	ec.EventID = "impresora.session.connect"
	s.reg.escribir(ec)

	br := bufio.NewReaderSize(conn, 16<<10)
	w := bufio.NewWriterSize(conn, 16<<10)

	for req := 0; req < 64; req++ {
		conn.SetReadDeadline(time.Now().Add(s.cfg.inactividad))
		if s.parando.Load() {
			return
		}
		p, err := s.leerPeticionHTTP(br, w)
		if err != nil {
			s.presup.soltar(p.tomado)
			if errors.Is(err, errPeticionMala) {
				// Contestar 400 (y cerrar) como haría un servidor real.
				conn.SetWriteDeadline(time.Now().Add(s.cfg.plazoEscribir))
				p.keepAlive = false
				escribirResp(w, p, s.persona, 400, "text/html; charset=utf-8", []byte(paginaError(s.persona, 400)))
				w.Flush()
			}
			return
		}
		conn.SetWriteDeadline(time.Now().Add(s.cfg.plazoEscribir))
		seguir := s.responderHTTP(w, base, p, ip)
		s.presup.soltar(p.tomado)
		if w.Flush() != nil || !seguir {
			return
		}
	}
}

// peticionHTTP: lo leído de una petición, todo acotado.
type peticionHTTP struct {
	metodo    string
	destino   string
	ruta      string // destino sin query
	proto     string
	host      string // cabecera Host (host[:puerto]) que usó el cliente
	tipo      string // Content-Type
	agente    string // User-Agent
	autoriz   string // Authorization
	keepAlive bool
	espera100 bool // el cliente mandó Expect: 100-continue
	chunked   bool // Transfer-Encoding: chunked
	cuerpo    []byte
	cuerpoTam int64 // tamaño declarado del cuerpo (Content-Length), aunque se recorte
	recibido  int64 // bytes del cuerpo realmente recibidos (leídos + drenados)
	completo  bool  // llegó todo el cuerpo declarado
	tomado    int64 // bytes del presupuesto global que retiene esta petición
}

func (s *servidor) leerPeticionHTTP(br *bufio.Reader, w *bufio.Writer) (peticionHTTP, error) {
	var p peticionHTTP
	linea, _, _, _ := leerLinea(br, s.cfg.maxLinea, nil)
	if len(linea) == 0 {
		// Nada que leer: la conexión se cerró (keep-alive agotado). No es error.
		return p, io.EOF
	}
	campos := strings.Fields(strings.TrimRight(string(linea), "\r\n"))
	if len(campos) < 2 {
		return p, errPeticionMala
	}
	p.metodo = prefijo(campos[0], 16)
	p.destino = prefijo(campos[1], 2048)
	if len(campos) >= 3 {
		p.proto = campos[2]
		// La tercera parte de una petición HTTP/1.x es "HTTP/x.y". Si no lo es,
		// la línea está mal formada.
		if !strings.HasPrefix(p.proto, "HTTP/") {
			return p, errPeticionMala
		}
	}
	// Un método que no es una palabra de letras (p. ej. binario) también es
	// una petición mal formada.
	if !metodoRazonable(p.metodo) {
		return p, errPeticionMala
	}
	p.ruta = p.destino
	if i := strings.IndexByte(p.ruta, '?'); i >= 0 {
		p.ruta = p.ruta[:i]
	}
	// HTTP/1.1 es keep-alive por defecto; HTTP/1.0 y HTTP/0.9, cierre.
	p.keepAlive = strings.HasSuffix(p.proto, "1.1")

	clen := -1
	for i := 0; i < 128; i++ {
		l, _, _, e := leerLinea(br, s.cfg.maxLinea, nil)
		ss := strings.TrimRight(string(l), "\r\n")
		if ss == "" {
			break
		}
		clave, valor, ok := strings.Cut(ss, ":")
		if !ok {
			continue
		}
		valor = strings.TrimSpace(valor)
		switch strings.ToLower(strings.TrimSpace(clave)) {
		case "host":
			p.host = prefijo(valor, 255)
		case "content-type":
			p.tipo = prefijo(valor, 128)
		case "content-length":
			if n, err := strconv.Atoi(strings.TrimSpace(valor)); err == nil && n >= 0 {
				clen = n
			}
		case "user-agent":
			p.agente = prefijo(valor, 256)
		case "authorization":
			p.autoriz = prefijo(valor, 1024)
		case "connection":
			switch strings.ToLower(valor) {
			case "close":
				p.keepAlive = false
			case "keep-alive":
				p.keepAlive = true
			}
		case "expect":
			if strings.Contains(strings.ToLower(valor), "100-continue") {
				p.espera100 = true
			}
		case "transfer-encoding":
			if strings.Contains(strings.ToLower(valor), "chunked") {
				p.chunked = true
			}
		}
		if e != nil {
			break
		}
	}

	// Expect: 100-continue (ipptool y CUPS lo usan): la impresora responde
	// "100 Continue" antes de que el cliente mande el cuerpo.
	if p.espera100 && (clen != 0 || p.chunked) {
		w.WriteString("HTTP/1.1 100 Continue\r\n\r\n")
		if w.Flush() != nil {
			return p, io.EOF
		}
	}

	switch {
	case p.chunked:
		// IPP y CUPS mandan los trabajos con codificación por trozos.
		p.cuerpo, p.recibido, p.tomado = s.leerTroceado(br)
		p.cuerpoTam = p.recibido
		p.completo = true // el cuerpo chunked termina en su trozo final
	case clen > 0:
		p.cuerpoTam = int64(clen)
		// Solo se RETIENE en memoria un poco (los atributos IPP y los
		// formularios caben); el resto del documento se drena sin guardarse.
		// Un presupuesto global acota, además, la suma de todos los cuerpos.
		enMem := clen
		if enMem > s.cfg.maxCuerpoMem {
			enMem = s.cfg.maxCuerpoMem
		}
		conc := s.presup.tomar(int64(enMem))
		p.tomado = conc
		var recibido int64
		if conc > 0 {
			buf := make([]byte, conc)
			n, _ := io.ReadFull(br, buf)
			p.cuerpo = buf[:n]
			recibido = int64(n)
		}
		// El resto se consume (sin guardarlo) hasta el tope de trabajo, para
		// contar su tamaño real y liberar el socket.
		if resto := int64(clen) - recibido; resto > 0 {
			tope := int64(s.cfg.maxTrabajo)
			if resto < tope {
				tope = resto
			}
			dren, _ := io.CopyN(io.Discard, br, tope)
			recibido += dren
			if resto > tope {
				// Queda más de lo que vamos a leer: cerramos tras responder.
				p.keepAlive = false
			}
		}
		p.recibido = recibido
		p.completo = recibido >= int64(clen)
	default:
		p.completo = true
	}
	return p, nil
}

// metodoRazonable: un método HTTP es una palabra de letras ASCII (GET, POST,
// FOO…). Cualquier otra cosa (bytes de control, binario) es basura.
func metodoRazonable(m string) bool {
	if m == "" || len(m) > 16 {
		return false
	}
	for i := 0; i < len(m); i++ {
		c := m[i]
		if (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return true
}

// leerTroceado lee un cuerpo con codificación chunked: retiene en memoria hasta
// maxCuerpoMem y cuenta SOLO los bytes realmente recibidos (no el tamaño que
// declara el atacante, que podía desbordar int64), descartando lo que pase del
// tope de trabajo. Devuelve lo retenido, los bytes recibidos y lo tomado del
// presupuesto global. Con comprobación de límites para no colgarse ni reservar
// sin medida.
func (s *servidor) leerTroceado(br *bufio.Reader) ([]byte, int64, int64) {
	var buf []byte
	var total int64   // bytes de cuerpo realmente recibidos
	var drenado int64 // bytes recibidos que no se retienen en memoria
	tomado := s.presup.tomar(int64(s.cfg.maxCuerpoMem))
	maxMem := tomado
	maxDren := int64(s.cfg.maxTrabajo)
	for i := 0; i < 1<<20; i++ {
		linea, _, _, _ := leerLinea(br, 64, nil)
		txt := strings.TrimSpace(string(linea))
		if j := strings.IndexByte(txt, ';'); j >= 0 {
			txt = txt[:j] // extensiones de chunk
		}
		n64, e := strconv.ParseInt(txt, 16, 64)
		if e != nil || n64 < 0 {
			return buf, total, tomado
		}
		if n64 == 0 {
			// Último trozo: se consumen los tráileres hasta la línea en blanco.
			for k := 0; k < 64; k++ {
				l, _, _, er := leerLinea(br, s.cfg.maxLinea, nil)
				if strings.TrimSpace(string(l)) == "" || er != nil {
					break
				}
			}
			return buf, total, tomado
		}
		porLeer := n64
		for porLeer > 0 {
			paso := porLeer
			if paso > 32<<10 {
				paso = 32 << 10
			}
			tmp := make([]byte, paso)
			m, er := io.ReadFull(br, tmp)
			tmp = tmp[:m]
			porLeer -= int64(m)
			total += int64(m) // solo lo recibido de verdad
			if int64(len(buf)) < maxMem {
				falta := maxMem - int64(len(buf))
				if int64(len(tmp)) <= falta {
					buf = append(buf, tmp...)
				} else {
					buf = append(buf, tmp[:falta]...)
					drenado += int64(len(tmp)) - falta
				}
			} else {
				drenado += int64(len(tmp))
			}
			if er != nil {
				return buf, total, tomado
			}
			if drenado > maxDren {
				return buf, total, tomado
			}
		}
		// CRLF que cierra el trozo.
		leerLinea(br, 8, nil)
	}
	return buf, total, tomado
}

// responderHTTP decide qué hacer con una petición y escribe la respuesta.
// Devuelve si la conexión puede seguir (keep-alive).
func (s *servidor) responderHTTP(w *bufio.Writer, base func() evento, p peticionHTTP, ip string) bool {
	// IPP: POST con cuerpo de tipo application/ipp.
	if p.metodo == "POST" && strings.Contains(strings.ToLower(p.tipo), "application/ipp") {
		s.responderIPP(w, base, p)
		return p.keepAlive
	}

	// Métodos que una web de impresora no sirve: 405 (como un servidor real),
	// con cuerpo solo si no es HEAD.
	if p.metodo != "GET" && p.metodo != "HEAD" && p.metodo != "POST" {
		ev := base()
		ev.Metodo = p.metodo
		ev.Ruta = recortarCodificado(prefijo(p.ruta, maxCodRuta), maxCodRuta)
		ev.EventID = "impresora.web.get"
		s.reg.escribir(ev)
		escribirResp(w, p, s.persona, 405, "text/html; charset=utf-8", []byte(paginaError(s.persona, 405)))
		return p.keepAlive
	}

	ev := base()
	ev.Metodo = p.metodo
	ev.Ruta = recortarCodificado(prefijo(p.ruta, maxCodRuta), maxCodRuta)
	ev.Agente = recortarCodificado(p.agente, 256)

	// En un POST, lo primero es mirar si cambia un servidor LDAP/SMTP/syslog
	// (passback): es la señal estrella y nunca debe perderse por culpa de que
	// la petición traiga también credenciales (Basic auth o username/password).
	var cambios []cambio
	if p.metodo == "POST" && len(p.cuerpo) > 0 {
		cambios = cambioServidor(p.cuerpo, valoresConfig(s.persona))
		// Recordar lo enviado para devolverlo si el atacante recarga la página.
		if recordables := soloCambiosConfig(cambios); len(recordables) > 0 {
			s.recuerda.guardar(ip, recordables)
		}
	}
	usuario, clave, hayCred := credenciales(p)

	passbacks := filtrarPassback(cambios, true)
	configs := filtrarPassback(cambios, false)

	switch {
	case len(passbacks) > 0:
		// Un passback por cada servidor cambiado; las credenciales (si las hay)
		// viajan en el mismo evento, para que no se pierda ni el servidor del
		// atacante ni la cuenta de servicio.
		for _, c := range passbacks {
			e := base()
			e.Metodo = p.metodo
			e.Ruta = ev.Ruta
			e.Agente = ev.Agente
			e.EventID = "impresora.web.passback"
			e.Campo = recortarCodificado(prefijo(c.campo, 64), 64)
			e.Servidor = recortarCodificado(prefijo(c.valor, maxCodValor), maxCodValor)
			if hayCred {
				e.Usuario = recortarCodificado(prefijo(usuario, maxCodUsuario), maxCodUsuario)
				e.Password = recortarCodificado(prefijo(clave, maxCodClave), maxCodClave)
			}
			e.Grave = "apunta un servidor de autenticación (LDAP/SMTP/syslog) al del atacante: robo de la cuenta de servicio"
			s.reg.escribir(e)
		}
		escribirResp(w, p, s.persona, 200, "text/html; charset=utf-8",
			[]byte(s.paginaConfigIP(ip)))
		return p.keepAlive

	case hayCred:
		ev.EventID = "impresora.web.login"
		ev.Usuario = recortarCodificado(prefijo(usuario, maxCodUsuario), maxCodUsuario)
		ev.Password = recortarCodificado(prefijo(clave, maxCodClave), maxCodClave)
		s.reg.escribir(ev)
		escribirResp(w, p, s.persona, 200, "text/html; charset=utf-8", []byte(paginaLogin(s.persona, true)))
		return p.keepAlive

	case len(configs) > 0:
		for _, c := range configs {
			e := base()
			e.Metodo = p.metodo
			e.Ruta = ev.Ruta
			e.Agente = ev.Agente
			e.EventID = "impresora.web.config"
			e.Campo = recortarCodificado(prefijo(c.campo, 64), 64)
			e.Valor = recortarCodificado(prefijo(c.valor, maxCodValor), maxCodValor)
			s.reg.escribir(e)
		}
		escribirResp(w, p, s.persona, 200, "text/html; charset=utf-8",
			[]byte(s.paginaConfigIP(ip)))
		return p.keepAlive
	}

	// Navegación normal (GET/HEAD, o un POST sin credenciales ni cambios).
	cuerpo, tipo, codigo := s.paginaDe(p.ruta, p.host, ip)
	ev.EventID = "impresora.web.get"
	s.reg.escribir(ev)
	escribirResp(w, p, s.persona, codigo, tipo, []byte(cuerpo))
	return p.keepAlive
}

func (s *servidor) responderIPP(w *bufio.Writer, base func() evento, p peticionHTTP) {
	pet := decodificarIPP(p.cuerpo)
	ev := base()
	ev.Recurso = recortarCodificado(prefijo(p.ruta, maxCodRuta), maxCodRuta)
	// Una petición mal formada (ilegible, sin los atributos obligatorios, mala
	// versión, request-id 0) se contesta con el mismo error que daría una
	// impresora real: así ipptool y los drivers la ven como válida.
	if est := pet.validar(); est != estOK {
		ev.EventID = "impresora.ipp.peticion"
		if pet.ok {
			ev.Operacion = nombreOperacion(pet.operacion)
		} else {
			ev.Operacion = "petición IPP ilegible"
		}
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, respErrorIPP(pet, est))
		return
	}
	nombre := nombreOperacion(pet.operacion)
	switch pet.operacion {
	case opGetPrinterAttrs:
		ev.EventID = "impresora.ipp.peticion"
		ev.Operacion = nombre
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, s.respGetPrinterAttributes(pet, p.host))

	case opPrintJob, opSendDocument:
		// Trabajo con documento: se guarda huella y tamaño, nunca el contenido.
		h := sha256.New()
		doc := []byte{}
		if pet.docOffset <= len(p.cuerpo) {
			doc = p.cuerpo[pet.docOffset:]
		}
		h.Write(doc)
		tam := pet.cuerpoTamDoc(p)
		ev.EventID = "impresora.ipp.trabajo"
		ev.Operacion = nombre
		ev.Usuario = recortarCodificado(prefijo(pet.usuario, maxCodUsuario), maxCodUsuario)
		ev.Huella = "sha256:" + hex.EncodeToString(h.Sum(nil))
		ev.Tam = tam
		// El tamaño es MEDIDO (lo recibido), no el declarado por el atacante; si
		// no llegó todo lo declarado, se marca incompleto para no fiarse de él.
		if !p.completo && p.cuerpoTam > tam {
			ev.Aviso = fmt.Sprintf("trabajo incompleto: llegaron %d de %d bytes declarados", p.recibido, p.cuerpoTam)
		}
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, s.respTrabajoIPP(pet, s.nuevoJobID(), p.host))

	case opCreateJob:
		ev.EventID = "impresora.ipp.peticion"
		ev.Operacion = nombre
		ev.Usuario = recortarCodificado(prefijo(pet.usuario, maxCodUsuario), maxCodUsuario)
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, s.respTrabajoIPP(pet, s.nuevoJobID(), p.host))

	case opValidateJob:
		ev.EventID = "impresora.ipp.peticion"
		ev.Operacion = nombre
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, respValidateIPP(pet))

	case opGetJobs:
		ev.EventID = "impresora.ipp.peticion"
		ev.Operacion = nombre
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, respGetJobsIPP(pet))

	case opGetJobAttrs:
		// Anunciamos Get-Job-Attributes en operations-supported (RFC 8011 lo
		// exige), así que hay que responderlo de forma coherente: un trabajo ya
		// completado. Un CUPS que sigue un trabajo tras Print-Job lo espera.
		ev.EventID = "impresora.ipp.peticion"
		ev.Operacion = nombre
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, s.respGetJobAttributes(pet, p.host))

	case opCancelJob:
		// También anunciado: se responde como si el trabajo se cancelara.
		ev.EventID = "impresora.ipp.peticion"
		ev.Operacion = nombre
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, respValidateIPP(pet))

	default:
		ev.EventID = "impresora.ipp.peticion"
		ev.Operacion = nombre
		s.reg.escribir(ev)
		escribirHTTPBytes(w, p, 200, "application/ipp", s.persona, respErrorIPP(pet, estNoSoportada))
	}
}

// cuerpoTamDoc: tamaño del documento de un trabajo IPP (lo que va tras el fin
// de atributos), contando también lo que no cupo en memoria. Se basa en los
// bytes REALMENTE recibidos, no en el Content-Length que declara el atacante.
func (pet peticionIPP) cuerpoTamDoc(p peticionHTTP) int64 {
	if p.recibido > int64(pet.docOffset) {
		return p.recibido - int64(pet.docOffset)
	}
	if pet.docOffset <= len(p.cuerpo) {
		return int64(len(p.cuerpo) - pet.docOffset)
	}
	return 0
}

// ---- credenciales y detección de passback -----------------------------------

// credenciales saca usuario y contraseña de una petición: Basic auth o un
// formulario de login.
func credenciales(p peticionHTTP) (usuario, clave string, ok bool) {
	if strings.HasPrefix(strings.ToLower(p.autoriz), "basic ") {
		if dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(p.autoriz[6:])); err == nil {
			u, c, _ := strings.Cut(string(dec), ":")
			return u, c, true
		}
	}
	if p.metodo != "POST" || len(p.cuerpo) == 0 {
		return "", "", false
	}
	if !esRutaLogin(p.ruta) && !cuerpoTieneLogin(p.cuerpo) {
		return "", "", false
	}
	vals := parseForm(p.cuerpo)
	u := primerCampo(vals, "username", "user", "usuario", "login", "name", "j_username", "loginname")
	c := primerCampo(vals, "password", "pass", "passwd", "contrasena", "clave", "pin", "j_password")
	if u == "" && c == "" {
		return "", "", false
	}
	return u, c, true
}

func esRutaLogin(ruta string) bool {
	r := strings.ToLower(ruta)
	for _, s := range []string{"login", "signin", "auth", "session", "j_security_check"} {
		if strings.Contains(r, s) {
			return true
		}
	}
	return false
}

func cuerpoTieneLogin(cuerpo []byte) bool {
	s := strings.ToLower(string(cuerpo[:min(len(cuerpo), 4096)]))
	return strings.Contains(s, "password") || strings.Contains(s, "passwd") ||
		strings.Contains(s, "contrasena") || strings.Contains(s, "j_password")
}

// cambio: un campo del formulario de configuración que cambia respecto al
// valor por defecto que vería la persona.
type cambio struct {
	campo    string
	valor    string
	passback bool // el valor nuevo parece una dirección de host/IP (servidor)
}

// candidatosServidor: nombres de campo que, si apuntan a un host, son passback.
var candidatosServidor = []string{
	"ldap_server", "ldapserver", "ldap_host", "ldaphost", "ldap_address",
	"smtp_server", "smtpserver", "smtp_host", "smtphost", "mail_server", "mailserver",
	"syslog_server", "syslogserver", "syslog_host",
	"server", "host", "hostname", "address", "ip", "servidor",
}

// candidatosConfig: otros campos de configuración que no son servidores.
var candidatosConfig = []string{"community", "admin_password", "snmp_community", "device_name", "location"}

// cambioServidor compara el formulario con los valores por defecto de la
// persona y devuelve SOLO los campos que cambian de verdad: así el passback
// apunta al servidor que el atacante pone (no al primer campo de la lista con
// su valor por defecto), y pulsar «Guardar» sin tocar nada no genera un
// passback falso. Si cambian varios servidores, se devuelven todos.
func cambioServidor(cuerpo []byte, def map[string]string) []cambio {
	vals := parseForm(cuerpo)
	var out []cambio
	visto := map[string]bool{}
	ver := func(campo, v string, passback bool) {
		if v == "" || visto[campo] {
			return
		}
		if d, hay := def[campo]; hay && v == d {
			return // igual al valor por defecto: no es un cambio
		}
		visto[campo] = true
		out = append(out, cambio{campo: campo, valor: v, passback: passback})
	}
	for _, c := range candidatosServidor {
		if v, ok := vals[c]; ok {
			ver(c, v, pareceHost(v))
		}
	}
	// Cualquier campo cuyo nombre sugiera servidor LDAP/SMTP/syslog.
	for k, v := range vals {
		lk := strings.ToLower(k)
		if (strings.Contains(lk, "ldap") || strings.Contains(lk, "smtp") || strings.Contains(lk, "syslog")) &&
			(strings.Contains(lk, "server") || strings.Contains(lk, "host") || strings.Contains(lk, "addr") || strings.Contains(lk, "ip")) {
			ver(k, v, pareceHost(v))
		}
	}
	for _, c := range candidatosConfig {
		if v, ok := vals[c]; ok {
			ver(c, v, false)
		}
	}
	return out
}

func filtrarPassback(cs []cambio, passback bool) []cambio {
	var out []cambio
	for _, c := range cs {
		if c.passback == passback {
			out = append(out, c)
		}
	}
	return out
}

// soloCambiosConfig: los cambios en forma de mapa campo→valor, para recordarlos.
func soloCambiosConfig(cs []cambio) map[string]string {
	if len(cs) == 0 {
		return nil
	}
	m := make(map[string]string, len(cs))
	for _, c := range cs {
		m[c.campo] = c.valor
	}
	return m
}

// pareceHost dice si un valor parece una dirección de host o IP (lo que pondría
// un atacante que redirige el servidor a su máquina). Acepta también las formas
// de URL ldap://, ldaps:// y smtp://, sacando el host con net/url.
func pareceHost(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > 255 {
		return false
	}
	// URL con esquema (ldap://host:389, ldaps://host, smtp://host): el host va
	// entre "://" y la primera "/".
	if strings.Contains(v, "://") {
		if u, err := url.Parse(v); err == nil && u.Host != "" {
			v = u.Host
		}
	}
	if ip := net.ParseIP(v); ip != nil {
		return true
	}
	hv := v
	if h, _, err := net.SplitHostPort(v); err == nil {
		hv = h
	}
	if net.ParseIP(hv) != nil {
		return true
	}
	return strings.Contains(hv, ".") && !strings.ContainsAny(hv, " \t/\\")
}

// parseForm interpreta un cuerpo application/x-www-form-urlencoded en un mapa
// (clave en minúsculas), acotando número y tamaño.
func parseForm(cuerpo []byte) map[string]string {
	m := map[string]string{}
	s := string(cuerpo[:min(len(cuerpo), 65536)])
	for i, par := range strings.Split(s, "&") {
		if i >= 256 {
			break
		}
		k, v, _ := strings.Cut(par, "=")
		k = strings.ToLower(strings.TrimSpace(desURL(k)))
		v = desURL(v)
		if k == "" || len(k) > 64 {
			continue
		}
		if _, ya := m[k]; !ya {
			m[k] = prefijo(v, maxCodValor)
		}
	}
	return m
}

func desURL(s string) string {
	if u, err := url.QueryUnescape(s); err == nil {
		return u
	}
	return s
}

func primerCampo(m map[string]string, claves ...string) string {
	for _, k := range claves {
		if v, ok := m[k]; ok {
			return v
		}
	}
	return ""
}

// ---- escritura HTTP ---------------------------------------------------------

func estadoHTTP(codigo int) string {
	switch codigo {
	case 200:
		return "OK"
	case 400:
		return "Bad Request"
	case 401:
		return "Unauthorized"
	case 404:
		return "Not Found"
	case 405:
		return "Method Not Allowed"
	case 501:
		return "Not Implemented"
	}
	return "OK"
}

func escribirHTTPBytes(w *bufio.Writer, p peticionHTTP, codigo int, tipo string, pers *persona, cuerpo []byte) {
	escribirResp(w, p, pers, codigo, tipo, cuerpo)
}

// escribirResp escribe una respuesta HTTP creíble: código real (no todo 200),
// cabecera Date, Connection coherente con si se va a cerrar, y SIN cuerpo
// cuando el método es HEAD (una impresora real tampoco lo manda).
func escribirResp(w *bufio.Writer, p peticionHTTP, pers *persona, codigo int, tipo string, cuerpo []byte) {
	fmt.Fprintf(w, "HTTP/1.1 %d %s\r\n", codigo, estadoHTTP(codigo))
	fmt.Fprintf(w, "Server: %s Embedded Web Server\r\n", escaparCabecera(pers.fabricante))
	fmt.Fprintf(w, "Date: %s\r\n", time.Now().UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT"))
	fmt.Fprintf(w, "Content-Type: %s\r\n", tipo)
	fmt.Fprintf(w, "Content-Length: %d\r\n", len(cuerpo))
	if p.keepAlive {
		w.WriteString("Connection: keep-alive\r\n\r\n")
	} else {
		w.WriteString("Connection: close\r\n\r\n")
	}
	if p.metodo != "HEAD" {
		w.Write(cuerpo)
	}
}

func escaparCabecera(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}
