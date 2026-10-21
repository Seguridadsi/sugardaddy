package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// ---- RESP: lector del protocolo ---------------------------------------------

// errProto es un error de protocolo con el texto exacto que da Redis. Tras
// contestarlo se cierra la conexión, como hace Redis.
type errProto string

func (e errProto) Error() string { return string(e) }

const (
	errMultibulk      errProto = "Protocol error: invalid multibulk length"
	errBulk           errProto = "Protocol error: invalid bulk length"
	errComillas       errProto = "Protocol error: unbalanced quotes in request"
	errInline         errProto = "Protocol error: too big inline request"
	errMbulkGrande    errProto = "Protocol error: too big mbulk count string"
	errBulkGrande     errProto = "Protocol error: too big bulk count string"
	errMultibulkNoAut errProto = "Protocol error: unauthenticated multibulk length"
	errBulkNoAut      errProto = "Protocol error: unauthenticated bulk length"
)

const (
	// maxArgs: argumentos de una orden. Redis admite más, pero ningún ataque
	// conocido pasa de unos pocos y así la memoria está acotada.
	maxArgs = 1024
	// Desde la 6.2.6, un cliente sin autenticar no puede mandar más de 10
	// argumentos ni argumentos de más de 16 KB (CVE-2021-32675).
	maxArgsNoAut  = 10
	maxBulkNoAut  = 16384
	maxLineaCifra = 64
)

// leerComando lee una orden del cliente. Acepta el RESP de array de bulk
// strings (lo que mandan redis-cli y las librerías) y el "inline" (lo que
// manda un atacante con netcat), troceado como lo trocea Redis (comillas y
// escapes incluidos). Topes de tamaño para no agotar memoria, y lo que la
// orden retiene se cuenta en la cuota de la conexión (q, que puede ser nil):
// si no cabe, devuelve errMemoria. Devuelve nil sin error si no hay orden
// (línea vacía, *0 o *-1: Redis los ignora).
func leerComando(r *bufio.Reader, maxBytes int, autenticado bool, q *cuota) ([]string, error) {
	primera, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	if primera != '*' {
		if err := r.UnreadByte(); err != nil {
			return nil, err
		}
		linea, err := leerLinea(r, maxBytes, errInline, q)
		if err != nil {
			return nil, err
		}
		return partirArgs(linea, q)
	}
	n, err := leerCifra(r, errMbulkGrande, errMultibulk)
	if err != nil {
		return nil, err
	}
	if n <= 0 {
		return nil, nil
	}
	if n > maxArgs {
		return nil, errMultibulk
	}
	if !autenticado && n > maxArgsNoAut {
		return nil, errMultibulkNoAut
	}
	if !q.tomarOrden(24 + 16*n) {
		return nil, errMemoria
	}
	args := make([]string, 0, n)
	total := 0
	for i := 0; i < n; i++ {
		tipo, err := r.ReadByte()
		if err != nil {
			return nil, err
		}
		if tipo != '$' {
			return nil, errProto(fmt.Sprintf("Protocol error: expected '$', got '%c'", tipo))
		}
		l, err := leerCifra(r, errBulkGrande, errBulk)
		if err != nil {
			return nil, err
		}
		if l < 0 {
			return nil, errBulk
		}
		if !autenticado && l > maxBulkNoAut {
			return nil, errBulkNoAut
		}
		total += l
		if l > maxBytes || total > maxBytes {
			return nil, errBulk
		}
		if !q.tomarOrden(l) {
			return nil, errMemoria
		}
		s, err := leerBulk(r, l)
		if err != nil {
			return nil, err
		}
		args = append(args, s)
	}
	return args, nil
}

// leerBulk lee l bytes y el CRLF que los sigue, con una sola reserva de
// memoria (la del propio argumento).
func leerBulk(r *bufio.Reader, l int) (string, error) {
	var sb strings.Builder
	sb.Grow(l)
	for falta := l; falta > 0; {
		p, err := r.Peek(min(falta, r.Size()))
		sb.Write(p)
		r.Discard(len(p))
		falta -= len(p)
		if err != nil && falta > 0 {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return "", err
		}
	}
	if _, err := r.Discard(2); err != nil {
		return "", err
	}
	return sb.String(), nil
}

// leerLinea lee hasta el salto de línea (sin él ni el \r de antes). Si pasa de
// max bytes, devuelve demasiado. Lo que acumula se cuenta en q (puede ser nil).
// La línea devuelta puede apuntar al búfer del lector: vale hasta la próxima
// lectura.
func leerLinea(r *bufio.Reader, max int, demasiado error, q *cuota) ([]byte, error) {
	var acum []byte
	for {
		trozo, err := r.ReadSlice('\n')
		if len(acum)+len(trozo) > max+2 {
			return nil, demasiado
		}
		if err == bufio.ErrBufferFull || (err == nil && acum != nil) {
			antes := cap(acum)
			acum = append(acum, trozo...)
			if !q.tomarOrden(cap(acum) - antes) {
				return nil, errMemoria
			}
			if err == bufio.ErrBufferFull {
				continue
			}
		}
		if err != nil {
			return nil, err
		}
		linea := trozo
		if acum != nil {
			linea = acum
		}
		linea = linea[:len(linea)-1]
		if n := len(linea); n > 0 && linea[n-1] == '\r' {
			linea = linea[:n-1]
		}
		return linea, nil
	}
}

func leerCifra(r *bufio.Reader, demasiado, invalida error) (int, error) {
	linea, err := leerLinea(r, maxLineaCifra, demasiado, nil)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(string(linea))
	if err != nil {
		return 0, invalida
	}
	return n, nil
}

// partirArgs trocea una orden inline como sdssplitargs de Redis: espacios
// fuera de comillas separan; entre comillas dobles valen los escapes \n \r \t
// \b \a \\ \" y \xHH; entre simples, solo \'. Una comilla sin cerrar, o una
// de cierre pegada a otra cosa, es error de protocolo. Como en C, un byte nulo
// acaba la línea. Como en RESP, no más de maxArgs argumentos (una línea de
// 64 KB daba 21.800 y retenía once veces lo enviado), y cada argumento se
// cuenta en q con su cabecera.
func partirArgs(linea []byte, q *cuota) ([]string, error) {
	if i := bytes.IndexByte(linea, 0); i >= 0 {
		linea = linea[:i]
	}
	at := func(i int) byte {
		if i < len(linea) {
			return linea[i]
		}
		return 0
	}
	var args []string
	var cur []byte
	p := 0
	for {
		for p < len(linea) && esEspacio(linea[p]) {
			p++
		}
		if p >= len(linea) {
			return args, nil
		}
		if len(args) >= maxArgs {
			return nil, errInline
		}
		cur = cur[:0]
		dobles, simples, hecho := false, false, false
		for !hecho {
			c := at(p)
			switch {
			case dobles:
				switch {
				case c == '\\' && at(p+1) == 'x' && esHex(at(p+2)) && esHex(at(p+3)):
					cur = append(cur, valorHex(at(p+2))<<4|valorHex(at(p+3)))
					p += 3
				case c == '\\' && at(p+1) != 0:
					p++
					switch at(p) {
					case 'n':
						cur = append(cur, '\n')
					case 'r':
						cur = append(cur, '\r')
					case 't':
						cur = append(cur, '\t')
					case 'b':
						cur = append(cur, '\b')
					case 'a':
						cur = append(cur, '\a')
					default:
						cur = append(cur, at(p))
					}
				case c == '"':
					if at(p+1) != 0 && !esEspacio(at(p+1)) {
						return nil, errComillas
					}
					hecho = true
				case c == 0:
					return nil, errComillas
				default:
					cur = append(cur, c)
				}
			case simples:
				switch {
				case c == '\\' && at(p+1) == '\'':
					p++
					cur = append(cur, '\'')
				case c == '\'':
					if at(p+1) != 0 && !esEspacio(at(p+1)) {
						return nil, errComillas
					}
					hecho = true
				case c == 0:
					return nil, errComillas
				default:
					cur = append(cur, c)
				}
			default:
				switch c {
				case ' ', '\n', '\r', '\t', 0:
					hecho = true
				case '"':
					dobles = true
				case '\'':
					simples = true
				default:
					cur = append(cur, c)
				}
			}
			if p < len(linea) {
				p++
			}
		}
		if !q.tomarOrden(len(cur) + 16) {
			return nil, errMemoria
		}
		args = append(args, string(cur))
	}
}

func esEspacio(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r'
}

func esHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func valorHex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

// ---- RESP: escritura de respuestas ------------------------------------------

// resp escribe respuestas en RESP2 o RESP3 (lo que pida HELLO). No vuelca: lo
// hace quien atiende la conexión, una vez por orden y con plazo.
type resp struct {
	w     *bufio.Writer
	proto int
	// errores, si no es nil, cuenta cada error por su código (ERR,
	// NOAUTH...) para INFO errorstats.
	errores func(codigo string)
}

func (o *resp) crlf() { o.w.WriteString("\r\n") }

func (o *resp) simple(s string) { o.w.WriteByte('+'); o.w.WriteString(s); o.crlf() }

// err escribe un error. s lleva el código delante (ERR, WRONGPASS...); los
// saltos de línea se cambian por espacios, como hace Redis.
func (o *resp) err(s string) {
	s = strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
	if o.errores != nil {
		codigo, _, _ := strings.Cut(s, " ")
		o.errores(codigo)
	}
	o.w.WriteByte('-')
	o.w.WriteString(s)
	o.crlf()
}

func (o *resp) entero(n int64) {
	o.w.WriteByte(':')
	o.w.WriteString(strconv.FormatInt(n, 10))
	o.crlf()
}

func (o *resp) nulo() {
	if o.proto == 3 {
		o.w.WriteString("_\r\n")
	} else {
		o.w.WriteString("$-1\r\n")
	}
}

func (o *resp) nuloArreglo() {
	if o.proto == 3 {
		o.w.WriteString("_\r\n")
	} else {
		o.w.WriteString("*-1\r\n")
	}
}

func (o *resp) bulk(s string) {
	o.w.WriteByte('$')
	o.w.WriteString(strconv.Itoa(len(s)))
	o.crlf()
	o.w.WriteString(s)
	o.crlf()
}

func (o *resp) cabecera(n int) {
	o.w.WriteByte('*')
	o.w.WriteString(strconv.Itoa(n))
	o.crlf()
}

// mapa abre un mapa de n pares: %n en RESP3, un array de 2n en RESP2.
func (o *resp) mapa(n int) {
	if o.proto == 3 {
		o.w.WriteByte('%')
		o.w.WriteString(strconv.Itoa(n))
		o.crlf()
	} else {
		o.cabecera(2 * n)
	}
}

func (o *resp) arreglo(items []string) {
	o.cabecera(len(items))
	for _, it := range items {
		o.bulk(it)
	}
}

// mapaPares escribe pares clave/valor planos (clave, valor, clave, valor...)
// como mapa en RESP3 y como array en RESP2, que es lo que da CONFIG GET.
func (o *resp) mapaPares(kv []string) {
	if o.proto == 3 {
		o.mapa(len(kv) / 2)
		for _, s := range kv {
			o.bulk(s)
		}
		return
	}
	o.arreglo(kv)
}

// verbatim: texto como lo da Redis en INFO o CLIENT LIST: verbatim string en
// RESP3, bulk en RESP2.
func (o *resp) verbatim(s string) {
	if o.proto != 3 {
		o.bulk(s)
		return
	}
	o.w.WriteByte('=')
	o.w.WriteString(strconv.Itoa(len(s) + 4))
	o.w.WriteString("\r\ntxt:")
	o.w.WriteString(s)
	o.crlf()
}

func (o *resp) crudo(b []byte) { o.w.Write(b) }
