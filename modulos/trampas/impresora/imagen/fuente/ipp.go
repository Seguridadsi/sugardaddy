package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"net"
	"strings"
)

// Codificador y decodificador mínimos de IPP (RFC 8010), escritos desde la
// especificación: código propio, sin dependencias. Solo lo justo para que un
// cliente real (ipptool, CUPS, un driver) crea que habla con una impresora:
// responde Get-Printer-Attributes con todos los atributos que espera ipptool y
// acepta (sin imprimir nada) los trabajos, de los que guarda solo huella y
// tamaño.

// Etiquetas de grupo (delimitadores).
const (
	tagOperation = 0x01
	tagJob       = 0x02
	tagEnd       = 0x03
	tagPrinter   = 0x04
	tagUnsupp    = 0x05
)

// Etiquetas de valor.
const (
	tagInteger    = 0x21
	tagBoolean    = 0x22
	tagEnum       = 0x23
	tagText       = 0x41
	tagName       = 0x42
	tagKeyword    = 0x44
	tagURI        = 0x45
	tagCharset    = 0x47
	tagLanguage   = 0x48
	tagMimeType   = 0x49
	tagResolution = 0x32
	tagRange      = 0x33
	tagBegColl    = 0x34
	tagEndColl    = 0x37
	tagMemberName = 0x4a
)

// Operaciones IPP.
const (
	opPrintJob        = 0x0002
	opValidateJob     = 0x0004
	opCreateJob       = 0x0005
	opSendDocument    = 0x0006
	opCancelJob       = 0x0008
	opGetJobAttrs     = 0x0009
	opGetJobs         = 0x000a
	opGetPrinterAttrs = 0x000b
)

// Códigos de estado.
const (
	estOK           = 0x0000
	estNoSoportada  = 0x0501 // server-error-operation-not-supported
	estVersionNoSop = 0x0503 // server-error-version-not-supported
	estPeticionMala = 0x0400 // client-error-bad-request
)

// peticionIPP: lo que se saca de una petición IPP sin fiarse de su contenido.
type peticionIPP struct {
	verMajor, verMinor byte
	operacion          uint16
	requestID          uint32
	usuario            string // requesting-user-name
	jobName            string // job-name
	formato            string // document-format
	jobIDPedido        int32  // job-id (Get-Job-Attributes / Cancel-Job)
	docOffset          int    // dónde empieza el documento tras el fin de atributos
	ok                 bool   // se pudo leer la cabecera

	// Para validar la petición como exige RFC 8011 §4.1 (lo que comprueba
	// ipptool): dónde aparecen attributes-charset y attributes-natural-language
	// dentro del grupo de operación (deben ser el 0 y el 1), si viene
	// printer-uri y cuántos atributos de operación hay.
	opAttrs    int
	idxCharset int
	idxLang    int
	tieneURI   bool

	// requested-attributes: qué atributos pide el cliente. Si no viene ninguno,
	// o viene "all", se devuelven todos (pideTodos). Si pide una lista, solo
	// esos: lo exige RFC 8011 §4.2.5 y lo comprueba ipptool (ipp-1.1.test).
	pide      map[string]bool
	pideTodos bool
}

// quiere dice si un atributo debe ir en la respuesta según requested-attributes.
func (p peticionIPP) quiere(nombre string) bool {
	if p.pideTodos || len(p.pide) == 0 {
		return true
	}
	return p.pide[nombre]
}

const maxValIPP = 1024 // bytes de un valor de atributo que se guardan

// decodificarIPP lee la cabecera y los atributos de operación de una petición
// IPP con comprobación de límites en cada paso: una longitud enorme o un
// paquete cortado no provoca pánico ni reserva memoria sin medida.
func decodificarIPP(b []byte) peticionIPP {
	p := peticionIPP{idxCharset: -1, idxLang: -1}
	if len(b) < 8 {
		return p
	}
	p.verMajor, p.verMinor = b[0], b[1]
	p.operacion = binary.BigEndian.Uint16(b[2:4])
	p.requestID = binary.BigEndian.Uint32(b[4:8])
	p.ok = true
	p.docOffset = len(b)
	grupo := byte(0)
	ultNombre := "" // nombre del último atributo con nombre (para multivalor)
	pos := 8
	for pos < len(b) {
		tag := b[pos]
		pos++
		if tag == tagEnd {
			p.docOffset = pos
			break
		}
		if tag <= 0x0f {
			// Etiqueta de grupo (operation/job/printer/unsupported): no lleva
			// nombre ni valor.
			grupo = tag
			continue
		}
		// Atributo: nombre (uint16 + bytes) y valor (uint16 + bytes).
		if pos+2 > len(b) {
			break
		}
		nlen := int(binary.BigEndian.Uint16(b[pos:]))
		pos += 2
		if nlen < 0 || pos+nlen > len(b) {
			break
		}
		nombre := string(b[pos : pos+nlen])
		pos += nlen
		if pos+2 > len(b) {
			break
		}
		vlen := int(binary.BigEndian.Uint16(b[pos:]))
		pos += 2
		if vlen < 0 || pos+vlen > len(b) {
			break
		}
		valor := b[pos : pos+vlen]
		pos += vlen

		// nlen==0 es un valor más del atributo anterior (atributo multivalor):
		// requested-attributes suele venir así (varios keywords), por eso se
		// atiende ANTES de descartar los valores sin nombre.
		efName := nombre
		if efName == "" {
			efName = ultNombre
		}
		if grupo == tagOperation && efName == "requested-attributes" && vlen <= maxValIPP {
			switch v := string(valor); v {
			case "all":
				p.pideTodos = true
			case "":
			default:
				if p.pide == nil {
					p.pide = map[string]bool{}
				}
				p.pide[v] = true
			}
		}
		if nombre != "" {
			ultNombre = nombre
		}
		if nombre == "" {
			continue
		}
		if grupo == tagOperation {
			switch nombre {
			case "attributes-charset":
				if p.idxCharset < 0 {
					p.idxCharset = p.opAttrs
				}
			case "attributes-natural-language":
				if p.idxLang < 0 {
					p.idxLang = p.opAttrs
				}
			case "printer-uri", "job-uri":
				p.tieneURI = true
			}
			p.opAttrs++
		}
		if vlen > maxValIPP {
			continue
		}
		switch nombre {
		case "requesting-user-name":
			if p.usuario == "" {
				p.usuario = string(valor)
			}
		case "job-name":
			if p.jobName == "" {
				p.jobName = string(valor)
			}
		case "document-format":
			if p.formato == "" {
				p.formato = string(valor)
			}
		case "job-id":
			if vlen == 4 && p.jobIDPedido == 0 {
				p.jobIDPedido = int32(binary.BigEndian.Uint32(valor))
			}
		}
	}
	return p
}

// validar comprueba la petición como lo hace un cliente real (ipptool, CUPS)
// según RFC 8011 §4.1: versión soportada, request-id > 0, y el grupo de
// operación con attributes-charset primero, attributes-natural-language después
// y un printer-uri. Devuelve estOK si está bien, o el estado de error que
// devolvería una impresora de verdad. Que la trampa conteste estos errores la
// hace indistinguible de una impresora ante quien la sondea con ipptool.
func (p peticionIPP) validar() uint16 {
	if !p.ok {
		return estPeticionMala
	}
	// Solo soportamos 1.x y 2.x; la 0.0 (y cualquier major 0) no.
	if p.verMajor == 0 {
		return estVersionNoSop
	}
	if p.requestID == 0 {
		return estPeticionMala
	}
	// attributes-charset y attributes-natural-language son obligatorios y en ese
	// orden; sin ellos (o desordenados) la petición es inválida.
	if p.idxCharset != 0 || p.idxLang != 1 {
		return estPeticionMala
	}
	if !p.tieneURI {
		return estPeticionMala
	}
	return estOK
}

// ---- codificador ------------------------------------------------------------

func putName(buf *bytes.Buffer, tag byte, nombre string) {
	buf.WriteByte(tag)
	var l [2]byte
	binary.BigEndian.PutUint16(l[:], uint16(len(nombre)))
	buf.Write(l[:])
	buf.WriteString(nombre)
}

func putVal(buf *bytes.Buffer, b []byte) {
	var l [2]byte
	binary.BigEndian.PutUint16(l[:], uint16(len(b)))
	buf.Write(l[:])
	buf.Write(b)
}

func attrStr(buf *bytes.Buffer, tag byte, nombre, valor string) {
	putName(buf, tag, nombre)
	putVal(buf, []byte(valor))
}

func attrStrMulti(buf *bytes.Buffer, tag byte, nombre string, valores []string) {
	for i, v := range valores {
		if i == 0 {
			putName(buf, tag, nombre)
		} else {
			putName(buf, tag, "") // valores adicionales: nombre vacío
		}
		putVal(buf, []byte(v))
	}
}

func attrInt(buf *bytes.Buffer, nombre string, v int32) {
	putName(buf, tagInteger, nombre)
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], uint32(v))
	putVal(buf, b[:])
}

func attrBool(buf *bytes.Buffer, nombre string, v bool) {
	putName(buf, tagBoolean, nombre)
	var b byte
	if v {
		b = 1
	}
	putVal(buf, []byte{b})
}

func attrEnum(buf *bytes.Buffer, nombre string, v int32) {
	putName(buf, tagEnum, nombre)
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], uint32(v))
	putVal(buf, b[:])
}

func attrEnumMulti(buf *bytes.Buffer, nombre string, valores []int32) {
	for i, v := range valores {
		if i == 0 {
			putName(buf, tagEnum, nombre)
		} else {
			putName(buf, tagEnum, "")
		}
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], uint32(v))
		putVal(buf, b[:])
	}
}

// versionResp devuelve la versión con la que se contesta: la misma que pidió el
// cliente (ipptool la exige), o 1.1 si no se pudo leer.
func versionResp(p peticionIPP) (byte, byte) {
	if !p.ok || p.verMajor == 0 {
		return 1, 1
	}
	return p.verMajor, p.verMinor
}

// cabeceraIPP escribe versión, estado, request-id y el grupo de atributos de
// operación con el juego de caracteres y el idioma (obligatorios).
func cabeceraIPP(buf *bytes.Buffer, verMajor, verMinor byte, estado uint16, reqID uint32) {
	buf.WriteByte(verMajor)
	buf.WriteByte(verMinor)
	var s [2]byte
	binary.BigEndian.PutUint16(s[:], estado)
	buf.Write(s[:])
	var r [4]byte
	binary.BigEndian.PutUint32(r[:], reqID)
	buf.Write(r[:])
	buf.WriteByte(tagOperation)
	attrStr(buf, tagCharset, "attributes-charset", "utf-8")
	attrStr(buf, tagLanguage, "attributes-natural-language", "en")
}

// hostSolo devuelve el host (sin puerto ni corchetes) de una cabecera Host, o
// def si viene vacía. Las URI de IPP se construyen con el host por el que llegó
// el cliente —como hace CUPS—, no con una IP inventada que no cuadra con la red.
func hostSolo(host, def string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return def
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return def
	}
	return host
}

// respGetPrinterAttributes arma una respuesta Get-Printer-Attributes creíble.
// Respeta requested-attributes: si el cliente pide una lista concreta, solo se
// devuelven esos atributos (RFC 8011 §4.2.5, comprobado por ipptool). Las URI
// se construyen con el host de la petición.
func (s *servidor) respGetPrinterAttributes(pet peticionIPP, host string) []byte {
	p := s.persona
	h := hostSolo(host, p.ipLocal)
	uri := fmt.Sprintf("ipp://%s:%d/ipp/print", h, p.puertoIpp)
	masInfo := fmt.Sprintf("http://%s:%d/", h, p.puertoWeb)
	maj, min := versionResp(pet)

	var buf bytes.Buffer
	cabeceraIPP(&buf, maj, min, estOK, pet.requestID)
	buf.WriteByte(tagPrinter)

	// Emisores que solo escriben el atributo si el cliente lo pide (o pide todos).
	eStr := func(tag byte, nombre, valor string) {
		if pet.quiere(nombre) {
			attrStr(&buf, tag, nombre, valor)
		}
	}
	eStrM := func(tag byte, nombre string, v []string) {
		if pet.quiere(nombre) {
			attrStrMulti(&buf, tag, nombre, v)
		}
	}
	eInt := func(nombre string, v int32) {
		if pet.quiere(nombre) {
			attrInt(&buf, nombre, v)
		}
	}
	eBool := func(nombre string, v bool) {
		if pet.quiere(nombre) {
			attrBool(&buf, nombre, v)
		}
	}
	eEnum := func(nombre string, v int32) {
		if pet.quiere(nombre) {
			attrEnum(&buf, nombre, v)
		}
	}

	eStr(tagCharset, "charset-configured", "utf-8")
	eStrM(tagCharset, "charset-supported", []string{"utf-8", "us-ascii"})
	eStrM(tagKeyword, "compression-supported", []string{"none", "gzip"})
	eStr(tagMimeType, "document-format-default", "application/octet-stream")
	// Sin application/postscript: la trampa no interpreta PostScript, así que no
	// lo anuncia (si no, un PRET en modo ps esperaría una respuesta que no llega
	// y la delataría). Sigue detectando y registrando los ataques en PS que
	// aun así lleguen por el 9100 (ver pjl.go, impresora.ps.peligroso).
	eStrM(tagMimeType, "document-format-supported", []string{
		"application/octet-stream", "application/pdf",
		"application/vnd.hp-PCL", "image/jpeg", "image/urf", "image/pwg-raster", "text/plain",
	})
	eStrM(tagLanguage, "generated-natural-language-supported", []string{"en", "es"})
	eStrM(tagKeyword, "ipp-versions-supported", []string{"1.0", "1.1", "2.0"})
	if pet.quiere("media-col-default") {
		mediaColDefault(&buf, "media-col-default")
	}
	eStr(tagLanguage, "natural-language-configured", "en")
	if pet.quiere("operations-supported") {
		attrEnumMulti(&buf, "operations-supported", []int32{
			opPrintJob, opValidateJob, opCreateJob, opSendDocument,
			opCancelJob, opGetJobAttrs, opGetJobs, opGetPrinterAttrs,
		})
	}
	eStr(tagText, "printer-info", p.modelo)
	eBool("printer-is-accepting-jobs", true)
	eStr(tagText, "printer-location", p.ubicacion)
	eStr(tagText, "printer-make-and-model", p.modelo)
	eStr(tagURI, "printer-more-info", masInfo)
	eStr(tagName, "printer-name", p.nombre)
	// pdl-override-supported es obligatorio (RFC 8011 §4.2.5); "not-attempted"
	// es lo normal en una impresora de oficina.
	eStr(tagKeyword, "pdl-override-supported", "not-attempted")
	eEnum("printer-state", 3) // 3 = idle
	eStrM(tagKeyword, "printer-state-reasons", []string{"none"})
	// printer-up-time debe ser > 0; recién arrancada la impresora aún daría 0.
	subida := p.uptime(s.reloj())
	if subida < 1 {
		subida = 1
	}
	eInt("printer-up-time", int32(subida))
	eStr(tagURI, "printer-uri-supported", uri)
	eStrM(tagKeyword, "uri-authentication-supported", []string{"none"})
	eStrM(tagKeyword, "uri-security-supported", []string{"none"})

	// Extra, para verse como una impresora moderna ante CUPS/driver.
	eStr(tagText, "printer-dns-sd-name", p.nombre)
	eStr(tagURI, "printer-uuid", p.uuid)
	eStrM(tagKeyword, "media-supported", []string{"iso_a4_210x297mm", "na_letter_8.5x11in", "iso_a5_148x210mm"})
	eStr(tagKeyword, "media-default", "iso_a4_210x297mm")
	eStrM(tagKeyword, "print-color-mode-supported", []string{"monochrome", "color"})
	eStrM(tagKeyword, "sides-supported", []string{"one-sided", "two-sided-long-edge", "two-sided-short-edge"})
	eInt("printer-config-change-time", 1)
	eInt("queued-job-count", 0)

	buf.WriteByte(tagEnd)
	return buf.Bytes()
}

// mediaColDefault escribe un atributo de colección media-col con una media-size
// (colección anidada) y una media-type, para satisfacer a ipptool.
func mediaColDefault(buf *bytes.Buffer, nombre string) {
	// begCollection con el nombre del atributo y valor vacío.
	putName(buf, tagBegColl, nombre)
	putVal(buf, nil)

	// miembro media-size (colección anidada).
	putName(buf, tagMemberName, "")
	putVal(buf, []byte("media-size"))
	putName(buf, tagBegColl, "")
	putVal(buf, nil)
	putName(buf, tagMemberName, "")
	putVal(buf, []byte("x-dimension"))
	attrInt(buf, "", 21000)
	putName(buf, tagMemberName, "")
	putVal(buf, []byte("y-dimension"))
	attrInt(buf, "", 29700)
	putName(buf, tagEndColl, "")
	putVal(buf, nil)

	// miembro media-type.
	putName(buf, tagMemberName, "")
	putVal(buf, []byte("media-type"))
	putName(buf, tagKeyword, "")
	putVal(buf, []byte("stationery"))

	// fin de la colección media-col.
	putName(buf, tagEndColl, "")
	putVal(buf, nil)
}

// respTrabajoIPP arma la respuesta a Print-Job / Create-Job / Send-Document:
// acepta el trabajo (sin imprimirlo) y devuelve sus atributos.
func (s *servidor) respTrabajoIPP(pet peticionIPP, jobID int32, host string) []byte {
	p := s.persona
	h := hostSolo(host, p.ipLocal)
	maj, min := versionResp(pet)
	var buf bytes.Buffer
	cabeceraIPP(&buf, maj, min, estOK, pet.requestID)
	buf.WriteByte(tagJob)
	attrInt(&buf, "job-id", jobID)
	attrStr(&buf, tagURI, "job-uri", fmt.Sprintf("ipp://%s:%d/jobs/%d", h, p.puertoIpp, jobID))
	attrEnum(&buf, "job-state", 3) // 3 = pending
	attrStrMulti(&buf, tagKeyword, "job-state-reasons", []string{"none"})
	buf.WriteByte(tagEnd)
	return buf.Bytes()
}

// respGetJobAttributes contesta Get-Job-Attributes (anunciada en
// operations-supported) de forma coherente: el trabajo referido aparece ya
// completado. Un CUPS que sigue un trabajo tras Print-Job lo consulta y espera
// esto, no un «no soportada».
func (s *servidor) respGetJobAttributes(pet peticionIPP, host string) []byte {
	p := s.persona
	h := hostSolo(host, p.ipLocal)
	jobID := pet.jobIDPedido
	if jobID <= 0 {
		jobID = 1
	}
	maj, min := versionResp(pet)
	var buf bytes.Buffer
	cabeceraIPP(&buf, maj, min, estOK, pet.requestID)
	buf.WriteByte(tagJob)
	attrInt(&buf, "job-id", jobID)
	attrStr(&buf, tagURI, "job-uri", fmt.Sprintf("ipp://%s:%d/jobs/%d", h, p.puertoIpp, jobID))
	attrStr(&buf, tagURI, "job-printer-uri", fmt.Sprintf("ipp://%s:%d/ipp/print", h, p.puertoIpp))
	usuario := pet.usuario
	if usuario == "" {
		usuario = "anonymous"
	}
	attrStr(&buf, tagName, "job-name", "Trabajo")
	attrStr(&buf, tagName, "job-originating-user-name", prefijo(usuario, 127))
	attrEnum(&buf, "job-state", 9) // 9 = completed
	attrStrMulti(&buf, tagKeyword, "job-state-reasons", []string{"job-completed-successfully"})
	attrInt(&buf, "job-impressions-completed", 1)
	attrInt(&buf, "time-at-creation", 1)
	attrInt(&buf, "time-at-processing", 1)
	attrInt(&buf, "time-at-completed", 2)
	attrInt(&buf, "job-printer-up-time", int32(maxN(p.uptime(s.reloj()), 1)))
	buf.WriteByte(tagEnd)
	return buf.Bytes()
}

func maxN(a int64, b int64) int64 {
	if a < b {
		return b
	}
	return a
}

// respValidateIPP: la validación de un trabajo que se acepta.
func respValidateIPP(pet peticionIPP) []byte {
	maj, min := versionResp(pet)
	var buf bytes.Buffer
	cabeceraIPP(&buf, maj, min, estOK, pet.requestID)
	buf.WriteByte(tagEnd)
	return buf.Bytes()
}

// respGetJobsIPP: ninguna cola de trabajos (impresora en reposo).
func respGetJobsIPP(pet peticionIPP) []byte {
	maj, min := versionResp(pet)
	var buf bytes.Buffer
	cabeceraIPP(&buf, maj, min, estOK, pet.requestID)
	buf.WriteByte(tagEnd)
	return buf.Bytes()
}

// respErrorIPP: estado de error con la cabecera obligatoria.
func respErrorIPP(pet peticionIPP, estado uint16) []byte {
	maj, min := versionResp(pet)
	var buf bytes.Buffer
	cabeceraIPP(&buf, maj, min, estado, pet.requestID)
	buf.WriteByte(tagEnd)
	return buf.Bytes()
}
