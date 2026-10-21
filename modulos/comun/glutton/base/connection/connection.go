// Package connection: versión recortada para la base glutton de Sugardaddy. El
// upstream depende de gopacket y del paquete rules (que importa pcap, con cgo);
// nuestra base no usa TPROXY ni captura de paquetes, así que aquí solo queda lo
// que los manejadores de protocolo necesitan de verdad: el tipo Metadata (con
// el puerto/host de destino y el motivo de cierre), la info de TLS y el mapeo
// de un error de lectura a un motivo de cierre. Sin gopacket, sin rules, sin
// tabla de conexiones ni claves de flujo.
package connection

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"syscall"
	"time"
)

const (
	EndClientClose  = "client_close"
	EndClientReset  = "client_reset"
	EndTimeout      = "timeout"
	EndHandlerClose = "handler_close"
	EndReadError    = "read_error"
	EndWriteError   = "write_error"
	EndMaxFrames    = "max_frames"
	EndEvicted      = "evicted"
)

// EndReasonFromRead mapea un error de lectura/espera a un motivo de cierre.
func EndReasonFromRead(err error) string {
	if err == nil {
		return EndClientClose
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return EndTimeout
	}
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return EndClientClose
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return EndClientReset
	}
	var nerr net.Error
	if errors.As(err, &nerr) && nerr.Timeout() {
		return EndTimeout
	}
	return EndReadError
}

// Metadata describe una conexión en curso. TargetPort/TargetIP son el destino
// (el puerto interno donde escucha la trampa y la IP de la máquina). EndReason
// lo fija el manejador al cerrar.
type Metadata struct {
	Added      time.Time
	TargetPort uint16
	TargetIP   string
	EndReason  string
	// TLS se rellena si el sensor terminara TLS antes del manejador; en la
	// base glutton no se usa (cada manejador que necesite TLS lo termina él).
	TLS *TLSInfo
}

// NewMetadata devuelve metadata para un flujo que empieza ahora.
func NewMetadata(dstPort uint16, dstHost string) Metadata {
	return Metadata{Added: time.Now(), TargetPort: dstPort, TargetIP: dstHost}
}

// TLSInfo describe una sesión TLS terminada antes del manejador de protocolo.
type TLSInfo struct {
	ServerName string
	ALPN       []string
	Version    string
	Cipher     string
	Hello      []byte
	Truncated  bool
	JA3        string
	JA3N       string
	JA4        string
	JA4R       string
}
