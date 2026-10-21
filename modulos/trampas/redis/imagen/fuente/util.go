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
// registro. Así una línea nunca pasa de unos 3 KB, mande lo que mande.
const (
	maxCodComando  = 64
	maxCodArgs     = 1024
	maxCodPassword = 512
	maxCodUsuario  = 128
)

// prefijo: los primeros n bytes de s, en memoria propia si hay que recortar.
// Un s[:n] comparte el array del argumento entero: guardar los 256 bytes de un
// nombre o los 4 KB de un CONFIG SET de 64 KB retenía los 64 KB fuera de toda
// cuenta (139 parámetros así eran 7,7 MB vivos por IP con 494 KB contados).
// Todo lo que sobrevive a la orden (CONFIG, nombres, réplica, valores) se
// recorta con esto, y así lo que ocupa es lo que se cuenta.
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

// recortarCodificado devuelve el prefijo más largo de s que, escapado en JSON,
// no pasa de max bytes, sin partir un carácter. Cuenta por lo alto lo que
// ocupa cada escape (\u00XX, � por cada byte que no es UTF-8).
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
		case r < 0x20 || r == ' ' || r == ' ':
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

// unirArgs junta los argumentos con espacios sin copiar más de max bytes
// (un SET de 64 KB no se copia entero para quedarse con su principio) y lo
// recorta a max bytes escapados.
func unirArgs(args []string, max int) string {
	var sb strings.Builder
	for i, a := range args {
		if i > 0 {
			if sb.Len() >= max {
				break
			}
			sb.WriteByte(' ')
		}
		if falta := max - sb.Len(); len(a) > falta {
			sb.WriteString(a[:falta])
			break
		}
		sb.WriteString(a)
	}
	return recortarCodificado(sb.String(), max)
}

// nombreComando: el nombre de la orden para el registro, en mayúsculas y
// recortado (un nombre de 64 KB no llega entero al disco ni a la memoria).
func nombreComando(s string) string {
	return recortarCodificado(strings.ToUpper(prefijo(s, maxCodComando)), maxCodComando)
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
