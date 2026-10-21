package main

import (
	crand "crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Topes, ya escapados en JSON, de lo que el atacante decide en cada línea del
// registro: así una línea nunca crece sin medida, mande lo que mande (nombres
// de fichero larguísimos de PRET, cabeceras HTTP enormes, rutas con miles de
// "../").
const (
	maxCodComando = 64
	maxCodArgs    = 1024
	maxCodRuta    = 512
	maxCodTexto   = 512
	maxCodUsuario = 256
	maxCodClave   = 512
	maxCodValor   = 512
)

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

// prefijo: los primeros n bytes de s, en memoria propia si hay que recortar.
// Un s[:n] comparte el array de origen y retendría la cadena entera (una ruta
// de 64 KB de PRET) fuera de toda cuenta; strings.Clone copia solo el trozo.
func prefijo(s string, n int) string {
	if n < 0 || len(s) <= n {
		return s
	}
	return strings.Clone(s[:n])
}

// recortarCodificado devuelve el prefijo más largo de s que, escapado en JSON,
// no pasa de max bytes, sin partir un carácter. Cuenta por lo alto lo que
// ocupa cada escape (\u00XX, el carácter de reemplazo por cada byte que no es
// UTF-8).
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
		case r == 0x2028 || r == 0x2029:
			// encoding/json SIEMPRE escapa el separador de línea (U+2028) y el
			// de párrafo (U+2029) como  /  (6 bytes), aunque se use
			// SetEscapeHTML(false), pese a que en UTF-8 ocupan 3. Si no se
			// cuenta así, un campo lleno de ellos doblaría el tope anunciado.
			c = 6
		}
		if coste+c > max {
			return strings.Clone(s[:i])
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

func env(k, def string) string {
	if v := envTrim(k); v != "" {
		return v
	}
	return def
}

func envTrim(k string) string { return strings.TrimSpace(os.Getenv(k)) }

func envN(k string, def int) int {
	if v := envTrim(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	switch strings.ToLower(envTrim(k)) {
	case "on", "yes", "true", "1":
		return true
	case "off", "no", "false", "0":
		return false
	}
	return def
}
