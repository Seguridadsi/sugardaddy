package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"net"
	"strings"
	"time"
)

// UEL (Universal Exit Language): el separador que precede a cada bloque PJL y
// cierra un trabajo de impresión.
const uel = "\x1b%-12345X"

// atender9100 lleva una conexión al puerto RAW/JetDirect (9100): habla PJL
// como una impresora de red y, cuando llegan datos de impresión (PCL,
// PostScript, lo que sea), guarda solo su huella (sha256) y su tamaño, nunca
// el contenido (puede llevar datos personales de un trabajo real). No ejecuta
// nada ni guarda ningún fichero.
func (s *servidor) atender9100(conn net.Conn) {
	defer conn.Close()
	ip, puerto := origen(conn.RemoteAddr())
	ses := nuevaSesion()

	base := func() evento {
		return evento{Cuando: time.Now().UTC().Format(time.RFC3339Nano), Session: ses, SrcIP: ip, SrcPort: puerto, Servicio: "raw"}
	}
	ec := base()
	ec.EventID = "impresora.session.connect"
	s.reg.escribir(ec)

	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetReadBuffer(16 << 10)
		tc.SetWriteBuffer(16 << 10)
	}
	br := bufio.NewReaderSize(conn, 16<<10)
	w := bufio.NewWriterSize(conn, 16<<10)

	var job *trabajo // trabajo de impresión en curso (datos no-PJL)
	var corte string
	cerrarJob := func() {
		if job == nil {
			return
		}
		// Un trabajo que no es PCL sino PostScript con operadores peligrosos
		// (robo/borrado de ficheros o control del servidor, estilo PRET en modo
		// ps) no es una impresión normal: se avisa aparte, como crítico, con la
		// lista de operadores vistos. No se guarda el contenido, solo se escanea
		// el principio del trabajo.
		if ops := operadoresPS(job.scan); len(ops) > 0 {
			e := base()
			e.EventID = "impresora.ps.peligroso"
			e.Comando = "POSTSCRIPT"
			e.Args = recortarCodificado(prefijo(strings.Join(ops, " "), maxCodArgs), maxCodArgs)
			e.Grave = "operadores PostScript peligrosos en un trabajo por el 9100 (robo/borrado de ficheros o control del servidor): " + strings.Join(ops, ", ")
			s.reg.escribir(e)
		}
		e := base()
		e.EventID = "impresora.pjl.job"
		e.Huella = job.resumen()
		e.Tam = job.tam
		s.reg.escribir(e)
		job = nil
	}

	for {
		conn.SetReadDeadline(time.Now().Add(s.cfg.inactividad))
		if s.parando.Load() {
			break
		}
		var sink func([]byte)
		if job != nil {
			sink = job.sink
		}
		linea, total, completa, err := leerLinea(br, s.cfg.maxLinea, sink)
		if total == 0 && err != nil {
			break
		}
		t := strings.TrimRight(quitarUEL(string(linea)), "\r\n\f \t")
		tieneUEL := strings.Contains(string(linea), uel)

		switch {
		case esPJL(t):
			cerrarJob()
			resp := s.manejarPJL(base, t)
			if resp != "" {
				conn.SetWriteDeadline(time.Now().Add(s.cfg.plazoEscribir))
				w.WriteString(resp)
				if w.Flush() != nil {
					corte = ""
					goto fin
				}
			}
		case t == "":
			// Línea vacía o solo-UEL: cierra el trabajo si lo había, nada más.
			if tieneUEL {
				cerrarJob()
			}
		default:
			// Datos de impresión (no PJL): se empieza (o sigue) un trabajo y
			// se cuenta su huella y su tamaño; el contenido no se guarda.
			if job == nil {
				job = nuevoTrabajo(int64(s.cfg.maxTrabajo))
			}
			job.anotar(linea, total)
		}
		if err != nil {
			break
		}
		// Protección: una sola conexión no puede hacernos leer sin fin texto
		// que no es PJL ni un trabajo razonable.
		if !completa && job == nil && len(linea) >= s.cfg.maxLinea {
			corte = "línea más larga que el tope sin ser PJL ni trabajo"
			break
		}
	}
fin:
	cerrarJob()
	if corte != "" {
		e := base()
		e.EventID = "impresora.session.tope"
		e.Motivo = corte
		s.reg.escribir(e)
	}
}

// trabajo acumula la huella y el tamaño de un trabajo de impresión sin guardar
// su contenido. La huella se calcula sobre los primeros max bytes (suficiente
// para distinguir trabajos); el tamaño se cuenta entero. Además retiene un
// trozo pequeño del principio (scan) solo para buscar operadores PostScript
// peligrosos: nunca se registra ni se escribe en disco.
type trabajo struct {
	h      hash.Hash
	hashed int64
	tam    int64
	max    int64
	scan   []byte
}

// psScanMax: bytes del principio del trabajo que se escanean en busca de
// operadores PostScript peligrosos. Los ataques estilo PRET ps los ponen al
// principio; con esto basta y la memoria queda acotada.
const psScanMax = 8192

func nuevoTrabajo(max int64) *trabajo {
	if max <= 0 {
		max = 1 << 20
	}
	return &trabajo{h: sha256.New(), max: max}
}

// anotar cuenta una línea de datos: su parte acotada va a la huella (el
// desbordamiento ya lo recibió sink durante la lectura si el trabajo estaba
// abierto) y su tamaño entero (total) al contador. Retiene el principio para el
// escaneo PostScript.
func (t *trabajo) anotar(capado []byte, total int64) {
	t.sink(capado)
	t.tam += total
	if len(t.scan) < psScanMax {
		falta := psScanMax - len(t.scan)
		if len(capado) <= falta {
			t.scan = append(t.scan, capado...)
		} else {
			t.scan = append(t.scan, capado[:falta]...)
		}
	}
}

func (t *trabajo) sink(b []byte) {
	if t.hashed >= t.max {
		return
	}
	n := t.max - t.hashed
	if int64(len(b)) < n {
		n = int64(len(b))
	}
	t.h.Write(b[:n])
	t.hashed += n
}

func (t *trabajo) resumen() string {
	return "sha256:" + hex.EncodeToString(t.h.Sum(nil))
}

// psPeligrosos: operadores PostScript que no tiene por qué usar un trabajo de
// impresión normal y que PRET (modo ps) y similares usan para leer, escribir o
// borrar ficheros del dispositivo o para controlar el servidor.
var psPeligrosos = []string{
	"filenameforall", "deletefile", "renamefile", "exitserver", "startjob",
	"setsystemparams", "currentsystemparams", "setpassword", "file",
}

// operadoresPS devuelve los operadores PostScript peligrosos (y "..") que
// aparecen en el principio de un trabajo. No guarda nada: solo mira el trozo ya
// retenido. "file" solo cuenta como token aparte (no dentro de deletefile,
// renamefile ni filenameforall), gracias al chequeo de fronteras.
func operadoresPS(datos []byte) []string {
	if len(datos) == 0 {
		return nil
	}
	s := strings.ToLower(string(datos))
	var out []string
	for _, op := range psPeligrosos {
		if contieneToken(s, op) {
			out = append(out, op)
		}
	}
	if strings.Contains(s, "..") {
		out = append(out, "..")
	}
	return out
}

// contieneToken dice si op aparece en s como palabra (sin letras pegadas antes
// ni después), para no confundir "file" dentro de "deletefile".
func contieneToken(s, op string) bool {
	for i := 0; ; {
		j := strings.Index(s[i:], op)
		if j < 0 {
			return false
		}
		j += i
		antes := j == 0 || !esLetra(s[j-1])
		fin := j + len(op)
		despues := fin >= len(s) || !esLetra(s[fin])
		if antes && despues {
			return true
		}
		i = j + 1
	}
}

func esLetra(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// leerLinea lee hasta '\n' (incluido) o EOF, devolviendo como mucho max bytes
// de la línea en memoria propia. Si la línea es más larga, el resto se pasa a
// sink (para la huella del trabajo) o se descarta. total es el tamaño real de
// la línea; completa dice si terminó en '\n'.
func leerLinea(br *bufio.Reader, max int, sink func([]byte)) (linea []byte, total int64, completa bool, err error) {
	b := make([]byte, 0, 256)
	for {
		trozo, e := br.ReadSlice('\n')
		total += int64(len(trozo))
		if len(b) < max {
			falta := max - len(b)
			if len(trozo) <= falta {
				b = append(b, trozo...)
			} else {
				b = append(b, trozo[:falta]...)
				if sink != nil {
					sink(trozo[falta:])
				}
			}
		} else if sink != nil {
			sink(trozo)
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		return b, total, e == nil, e
	}
}

// quitarUEL quita todas las apariciones del separador UEL de una línea.
func quitarUEL(s string) string {
	if !strings.Contains(s, uel) {
		return s
	}
	return strings.ReplaceAll(s, uel, "")
}

// esPJL dice si la línea (ya sin UEL y recortada) es una orden PJL.
func esPJL(t string) bool {
	return len(t) >= 4 && strings.EqualFold(t[:4], "@PJL")
}

// manejarPJL interpreta una orden PJL, la registra con su acción y severidad y
// devuelve la respuesta que daría la impresora (vacía si es silenciosa).
func (s *servidor) manejarPJL(base func() evento, linea string) string {
	// Quita "@PJL" y parte en campos conservando NAME="..." y DISPLAY="...".
	resto := strings.TrimSpace(linea[4:])
	verbo := strings.ToUpper(primeraPalabra(resto))
	e := base()
	e.Comando = recortarCodificado(prefijo(verbo, maxCodComando), maxCodComando)
	e.Args = recortarCodificado(prefijo(strings.TrimSpace(resto[min(len(resto), len(verbo)):]), maxCodArgs), maxCodArgs)

	switch verbo {
	case "INFO":
		cat := strings.ToUpper(primeraPalabra(strings.TrimSpace(resto[len("INFO"):])))
		e.EventID = "impresora.pjl.info"
		e.Comando = "INFO " + recortarCodificado(prefijo(cat, maxCodComando), maxCodComando)
		s.reg.escribir(e)
		return s.respInfo(cat)

	case "FSQUERY", "FSDIRLIST", "FSUPLOAD":
		nombre := valorEtiqueta(resto, "NAME")
		e.Ruta = recortarCodificado(prefijo(nombre, maxCodRuta), maxCodRuta)
		if esTraversal(nombre) {
			e.EventID = "impresora.pjl.traversal"
			e.Grave = "acceso a ficheros fuera de la impresora (recorrido de rutas, estilo PRET): " + verbo
		} else {
			e.EventID = "impresora.pjl.fs"
		}
		s.reg.escribir(e)
		return s.respFSLectura(verbo, nombre)

	case "FSDOWNLOAD", "FSDELETE", "FSMKDIR", "FSINIT", "FSAPPEND":
		nombre := valorEtiqueta(resto, "NAME")
		e.Ruta = recortarCodificado(prefijo(nombre, maxCodRuta), maxCodRuta)
		e.EventID = "impresora.pjl.escritura"
		e.Grave = "intento de escribir o borrar en los ficheros de la impresora: " + verbo
		if esTraversal(nombre) {
			e.Grave += " (con recorrido de rutas)"
		}
		s.reg.escribir(e)
		return "" // silenciosa, como una impresora real

	case "RDYMSG", "OPMSG", "STMSG":
		disp := valorEtiqueta(resto, "DISPLAY")
		e.Texto = recortarCodificado(prefijo(disp, maxCodTexto), maxCodTexto)
		e.EventID = "impresora.pjl.control"
		e.Grave = "cambia el mensaje del panel de la impresora (desfiguración): " + verbo
		s.reg.escribir(e)
		return ""

	case "DEFAULT", "SET":
		if esVariableSensible(resto) {
			e.EventID = "impresora.pjl.control"
			e.Grave = "cambia una variable de configuración o de seguridad de la impresora"
		} else {
			e.EventID = "impresora.pjl.info"
		}
		s.reg.escribir(e)
		return ""

	case "JOB":
		if strings.Contains(strings.ToUpper(resto), "PASSWORD") {
			e.EventID = "impresora.pjl.control"
			e.Grave = "intento con contraseña de trabajo (bloqueo/desbloqueo del panel)"
		} else {
			e.EventID = "impresora.pjl.info"
		}
		s.reg.escribir(e)
		return ""

	default:
		// ENTER LANGUAGE, EOJ, ECHO, USTATUS, COMMENT, DMCMD, etc.: se apuntan
		// como orden PJL normal y la impresora no contesta (salvo ECHO).
		e.EventID = "impresora.pjl.info"
		s.reg.escribir(e)
		if verbo == "ECHO" {
			return "@PJL ECHO " + recortarCodificado(prefijo(strings.TrimSpace(resto[len("ECHO"):]), 128), 128) + "\r\n\x0c"
		}
		return ""
	}
}

// ---- respuestas creíbles -----------------------------------------------------

func (s *servidor) respInfo(cat string) string {
	p := s.persona
	switch cat {
	case "ID":
		return fmt.Sprintf("@PJL INFO ID\r\n\"%s\"\r\n\x0c", escapar(p.modelo))
	case "STATUS":
		return "@PJL INFO STATUS\r\nCODE=10001\r\nDISPLAY=\"Preparada\"\r\nONLINE=TRUE\r\n\x0c"
	case "PAGECOUNT":
		return fmt.Sprintf("@PJL INFO PAGECOUNT\r\nPAGECOUNT=%d\r\n\x0c", p.paginas)
	case "FILESYS":
		return "@PJL INFO FILESYS\r\n" +
			"VOLUME TOTAL SIZE FREE SPACE LOCATION LABEL STATUS\r\n" +
			"0:     1048576000 943718400 DISK RAM READ-WRITE\r\n" +
			"1:     8388608    7340032   FLASH     READ-WRITE\r\n\x0c"
	case "MEMORY":
		return "@PJL INFO MEMORY\r\nTOTAL=268435456\r\nLARGEST=201326592\r\n\x0c"
	case "CONFIG":
		// LANGUAGES sin POSTSCRIPT: la trampa no lo interpreta y no debe
		// anunciarlo (coherente con IPP). FIRMWARE va en formato PJL; no se mete
		// una clave en español ("MODELO=") dentro del protocolo.
		return fmt.Sprintf("@PJL INFO CONFIG\r\n"+
			"IN TRAYS [3 ENUMERATED]\r\n\tINTRAY1 BANDEJA MULTIUSO\r\n\tINTRAY2 BANDEJA 2\r\n\tINTRAY3 BANDEJA 3\r\n"+
			"OUT TRAYS [1 ENUMERATED]\r\n\tOUTTRAY1 BANDEJA SUPERIOR\r\n"+
			"PAPERS [6 ENUMERATED]\r\n\tA4\r\n\tA5\r\n\tLETTER\r\n\tLEGAL\r\n\tEXECUTIVE\r\n\tCOM10\r\n"+
			"LANGUAGES [2 ENUMERATED]\r\n\tPCL\r\n\tPCLXL\r\n"+
			"USTATUS [4 ENUMERATED]\r\n\tDEVICE\r\n\tJOB\r\n\tPAGE\r\n\tTIMED\r\n"+
			"FIRMWARE=%s\r\n\x0c", escapar(p.firmware))
	case "VARIABLES":
		return fmt.Sprintf("@PJL INFO VARIABLES\r\n" +
			"COPIES=1 [2 RANGE]\r\n\t1\r\n\t999\r\n" +
			"PAPER=A4 [6 ENUMERATED]\r\n\tA4\r\n\tLETTER\r\n\tLEGAL\r\n\tA5\r\n\tEXECUTIVE\r\n\tCOM10\r\n" +
			"RESOLUTION=600 [3 ENUMERATED]\r\n\t300\r\n\t600\r\n\t1200\r\n" +
			"TIMEOUT=15 [2 RANGE]\r\n\t5\r\n\t300\r\n" +
			"PERSONALITY=AUTO [3 ENUMERATED]\r\n\tAUTO\r\n\tPCL\r\n\tPCLXL\r\n\x0c")
	case "PRODINFO":
		return fmt.Sprintf("@PJL INFO PRODINFO\r\n\"%s\"\r\nSERIAL=\"%s\"\r\nFIRMWARE=\"%s\"\r\n\x0c",
			escapar(s.persona.modelo), escapar(s.persona.serie), escapar(s.persona.firmware))
	default:
		// Categoría desconocida: una impresora real responde con el eco de la
		// categoría y nada más.
		return fmt.Sprintf("@PJL INFO %s\r\n\x0c", escapar(prefijo(cat, 32)))
	}
}

// fsNodo: un nodo del sistema de ficheros inventado de la impresora.
type fsNodo struct {
	dir       bool
	hijos     []string // nombres de los hijos (sin ruta), para FSDIRLIST
	contenido string   // para ficheros: contenido inventado (lo que da FSUPLOAD)
}

// fsArbol: un árbol FIJO y pequeño. No es infinito (FSDIRLIST de un directorio
// lista sus hijos reales, no a sí mismo), FSQUERY distingue DIR de FILE, y el
// SIZE que da FSQUERY es el mismo que devuelve FSUPLOAD (la longitud real del
// contenido). Nada aquí es un fichero de verdad.
var fsArbol = map[string]fsNodo{
	`0:\`:                      {dir: true, hijos: []string{"webServer", "PostScript", "saveDevice", "jobs", "default.cfg"}},
	`0:\webServer`:             {dir: true, hijos: []string{"home.html", "device.html"}},
	`0:\webServer\home.html`:   {contenido: "<html><head><title>Impresora</title></head><body>OK</body></html>\r\n"},
	`0:\webServer\device.html`: {contenido: "<html><body>Estado: preparada</body></html>\r\n"},
	`0:\PostScript`:            {dir: true, hijos: []string{}},
	`0:\saveDevice`:            {dir: true, hijos: []string{}},
	`0:\jobs`:                  {dir: true, hijos: []string{}},
	`0:\default.cfg`:           {contenido: "; configuracion del dispositivo\r\nDUPLEX=OFF\r\nECONOMODE=OFF\r\n"},
	`1:\`:                      {dir: true, hijos: []string{}},
}

// normalizarFS pasa un nombre PJL ("0:/web/", "0:\\web\\\\x") a su forma
// canónica ("0:\web", "0:\web\x") para buscarlo en el árbol.
func normalizarFS(nombre string) string {
	n := strings.TrimSpace(nombre)
	n = strings.ReplaceAll(n, "/", `\`)
	for strings.Contains(n, `\\`) {
		n = strings.ReplaceAll(n, `\\`, `\`)
	}
	if len(n) == 2 && n[1] == ':' { // "0:" -> "0:\"
		n += `\`
	}
	if len(n) > 3 && strings.HasSuffix(n, `\`) { // quitar barra final salvo raíz
		n = strings.TrimRight(n, `\`)
	}
	return n
}

func unirFS(padre, hijo string) string {
	if strings.HasSuffix(padre, `\`) {
		return padre + hijo
	}
	return padre + `\` + hijo
}

// respFSLectura responde a FSQUERY/FSDIRLIST/FSUPLOAD de forma coherente sobre
// un árbol fijo e inventado, sin revelar ningún fichero real. A un recorrido de
// rutas y a lo que no existe se les contesta "no encontrado" (FILEERROR=3),
// como una impresora que no deja salir de sus volúmenes.
func (s *servidor) respFSLectura(verbo, nombre string) string {
	nm := escapar(prefijo(nombre, 256))
	errNoHay := fmt.Sprintf("@PJL %s NAME=\"%s\"\r\nFILEERROR=3\r\n\x0c", verbo, nm)
	if esTraversal(nombre) {
		return errNoHay
	}
	norm := normalizarFS(nombre)
	nodo, ok := fsArbol[norm]
	switch verbo {
	case "FSDIRLIST":
		if !ok || !nodo.dir {
			return errNoHay
		}
		var b strings.Builder
		fmt.Fprintf(&b, "@PJL FSDIRLIST NAME=\"%s\" ENTRY=1\r\n. TYPE=DIR\r\n.. TYPE=DIR\r\n", nm)
		for _, hijo := range nodo.hijos {
			hn := fsArbol[unirFS(norm, hijo)]
			if hn.dir {
				fmt.Fprintf(&b, "%s TYPE=DIR\r\n", escapar(prefijo(hijo, 64)))
			} else {
				fmt.Fprintf(&b, "%s TYPE=FILE SIZE=%d\r\n", escapar(prefijo(hijo, 64)), len(hn.contenido))
			}
		}
		b.WriteString("\x0c")
		return b.String()
	case "FSQUERY":
		if !ok {
			return errNoHay
		}
		if nodo.dir {
			return fmt.Sprintf("@PJL FSQUERY NAME=\"%s\" TYPE=DIR\r\n\x0c", nm)
		}
		return fmt.Sprintf("@PJL FSQUERY NAME=\"%s\" TYPE=FILE SIZE=%d\r\n\x0c", nm, len(nodo.contenido))
	case "FSUPLOAD":
		if !ok || nodo.dir {
			return errNoHay
		}
		return fmt.Sprintf("@PJL FSUPLOAD FORMAT:BINARY NAME=\"%s\" OFFSET=0 SIZE=%d\r\n%s\x0c",
			nm, len(nodo.contenido), nodo.contenido)
	}
	return ""
}

// ---- utilidades de parseo PJL -----------------------------------------------

func primeraPalabra(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == ' ' || s[i] == '\t' || s[i] == '=' {
			return s[:i]
		}
	}
	return s
}

// valorEtiqueta saca el valor de ETIQUETA="..." o ETIQUETA=valor de una línea
// PJL, sin distinguir mayúsculas en la etiqueta.
func valorEtiqueta(linea, etiqueta string) string {
	up := strings.ToUpper(linea)
	et := strings.ToUpper(etiqueta) + "="
	i := strings.Index(up, et)
	if i < 0 {
		return ""
	}
	j := i + len(et)
	if j < len(linea) && linea[j] == '"' {
		j++
		if k := strings.IndexByte(linea[j:], '"'); k >= 0 {
			return linea[j : j+k]
		}
		return linea[j:]
	}
	return primeraPalabra(linea[j:])
}

// esTraversal dice si un nombre de fichero PJL intenta salir de los volúmenes
// de la impresora (recorrido de rutas, rutas unix absolutas): lo que hace PRET
// para leer /etc/passwd o la web.xml de un servidor de impresión.
func esTraversal(nombre string) bool {
	if nombre == "" {
		return false
	}
	n := strings.ToLower(nombre)
	if strings.Contains(n, "..") {
		return true
	}
	// Una impresora usa volúmenes tipo "0:\...". Una barra unix o una ruta
	// absoluta unix es un intento de salirse.
	if strings.HasPrefix(n, "/") {
		return true
	}
	for _, s := range []string{"/etc/", "/proc/", "/root/", "/home/", "passwd", "shadow", "web.xml", "\\windows\\", "boot.ini"} {
		if strings.Contains(n, s) {
			return true
		}
	}
	return false
}

// esVariableSensible: un DEFAULT/SET que toca seguridad o bloqueo del panel.
func esVariableSensible(resto string) bool {
	up := strings.ToUpper(resto)
	for _, v := range []string{"PASSWORD", "LOCK", "CONTROLPANELACCESS", "JOBMEDIA", "DISKLOCK", "SERVICE"} {
		if strings.Contains(up, v) {
			return true
		}
	}
	return false
}

// escapar quita comillas y controles de un texto que se mete en una respuesta
// PJL entre comillas, para no romper el formato ni reflejar bytes de control.
func escapar(s string) string {
	s = strings.ReplaceAll(s, "\"", "'")
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	return s
}
