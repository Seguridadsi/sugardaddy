package main

import (
	crand "crypto/rand"
	"encoding/hex"
	"net"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Topes, ya escapados en JSON, de lo que el atacante decide en cada línea del
// registro. Así una línea nunca pasa de unos pocos KB, mande lo que mande.
const (
	// Credenciales probadas: se guardan ENTERAS (decisión de Kino), pero una
	// credencial de megas (rociada basura, un cuerpo gigante) se recorta al
	// tope de codificación, no a 10 bytes de hash.
	maxCodCredencial = 512
	maxCodRuta       = 256
	maxCodAgente     = 256
)

// prefijo: los primeros n bytes de s, en memoria propia si hay que recortar.
// Un s[:n] comparte el array del argumento entero; strings.Clone evita retener
// un mensaje enorme por quedarnos con su principio.
func prefijo(s string, n int) string {
	if n < 0 || len(s) <= n {
		return s
	}
	return strings.Clone(s[:n])
}

// claveIP es la clave con la que se cuentan los topes de un origen: la IP, o
// su /64 si es IPv6 (quien tiene una IPv6 suele tener el /64 entero y podría
// saltarse los topes cambiando de dirección).
func claveIP(ip string) string {
	p := net.ParseIP(ip)
	if p == nil || p.To4() != nil {
		return ip
	}
	return p.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

func origen(a net.Addr) (string, int) {
	if t, ok := a.(*net.TCPAddr); ok {
		return t.IP.String(), t.Port
	}
	host, port, err := net.SplitHostPort(a.String())
	if err != nil {
		return a.String(), 0
	}
	p, _ := strconv.Atoi(port)
	return host, p
}

// origenCadena: lo mismo para una dirección en texto (la de una petición HTTP,
// que net/http ya resolvió a «ip:puerto»).
func origenCadena(s string) (string, int) {
	host, port, err := net.SplitHostPort(s)
	if err != nil {
		return s, 0
	}
	p, _ := strconv.Atoi(port)
	return host, p
}

// recortarCodificado devuelve el prefijo más largo de s que, escapado en JSON,
// no pasa de max bytes, sin partir un carácter. Cuenta por lo alto lo que
// ocupa cada escape (\u00XX, caracteres de control, el carácter de reemplazo
// por cada byte que no es UTF-8).
func recortarCodificado(s string, max int) string {
	coste := 0
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		c := n
		switch {
		case r == utf8.RuneError && n == 1:
			c = 6
		case r == '"' || r == '\\' || r == '\n' || r == '\r' || r == '\t':
			c = 2
		case r < 0x20:
			c = 6
		case r == '\u2028' || r == '\u2029':
			// encoding/json SIEMPRE los escapa como  /  (6 bytes),
			// aunque SetEscapeHTML esté desactivado.
			c = 6
		}
		if coste+c > max {
			return s[:i]
		}
		coste += c
		i += n
	}
	return s
}

// aleatorioHex: n bytes de crypto/rand en hexadecimal.
func aleatorioHex(n int) string {
	b := make([]byte, n)
	_, _ = crand.Read(b)
	return hex.EncodeToString(b)
}

// nuevaSesion: 64 bits al azar. Con miles de conexiones al día, 32 bits
// chocaban y la consola mezclaba visitas de atacantes distintos.
func nuevaSesion() string { return aleatorioHex(8) }
