package sd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"time"

	"github.com/mushorg/glutton/connection"
)

// Logger silencioso: los manejadores de glutton registran por su cuenta en
// depuración; la trampa de Sugardaddy solo escribe nuestros eventos JSON. No
// imprime nada por la salida estándar para no contaminar.
type Logger struct{}

func (Logger) Debug(string, ...any) {}
func (Logger) Info(string, ...any)  {}
func (Logger) Warn(string, ...any)  {}
func (Logger) Error(string, ...any) {}

// Mapeador convierte los eventos decodificados de un manejador (el valor
// decoded que pasa ProduceTCP) en nuestras líneas de registro. Cada protocolo
// registra el suyo.
type Mapeador func(cfg Config, base Evento, decoded interface{}) []Evento

var mapeadores = map[string]Mapeador{}

// RegistrarMapeador asocia un protocolo con su mapeador de eventos.
func RegistrarMapeador(proto string, m Mapeador) { mapeadores[proto] = m }

// Honeypot implementa interfaces.Honeypot para los manejadores de glutton,
// pero sin TPROXY ni captura: solo recibe el resultado del manejador y lo
// traduce a nuestro registro. El tiempo de inactividad lo aplica sobre la
// propia conexión.
type Honeypot struct {
	cfg  Config
	reg  *Registro
	idle time.Duration
}

// NuevoHoneypot crea el honeypot con su registro.
func NuevoHoneypot(cfg Config, reg *Registro) *Honeypot {
	return &Honeypot{cfg: cfg, reg: reg, idle: time.Duration(cfg.IdleSegundos) * time.Second}
}

func sesionID(conn net.Conn, inicio time.Time) string {
	h := sha256.New()
	if conn != nil {
		h.Write([]byte(conn.RemoteAddr().String()))
	}
	h.Write([]byte(inicio.Format(time.RFC3339Nano)))
	return hex.EncodeToString(h.Sum(nil)[:8])
}

// ProduceTCP traduce lo que el manejador recogió en una conexión y lo apunta.
func (h *Honeypot) ProduceTCP(protocol string, conn net.Conn, md connection.Metadata, payload []byte, decoded interface{}) error {
	base := Evento{
		Proto:        "tcp",
		DstPort:      int(md.TargetPort),
		MotivoCierre: md.EndReason,
		Session:      sesionID(conn, md.Added),
	}
	if conn != nil {
		if host, port, err := net.SplitHostPort(conn.RemoteAddr().String()); err == nil {
			base.SrcIP = host
			base.SrcPort = atoiSeguro(port)
		}
	}
	m := mapeadores[protocol]
	if m == nil {
		return nil
	}
	for _, e := range m(h.cfg, base, decoded) {
		h.reg.Apunta(e)
	}
	return nil
}

// UpdateConnectionTimeout aplica el tiempo de inactividad a la conexión.
func (h *Honeypot) UpdateConnectionTimeout(_ context.Context, conn net.Conn) error {
	if conn == nil || h.idle <= 0 {
		return nil
	}
	return conn.SetDeadline(time.Now().Add(h.idle))
}

// El resto de la interfaz no se usa en una trampa de un solo puerto TCP sin
// TPROXY: se implementa en vacío.
func (h *Honeypot) ProduceUDP(string, *net.UDPAddr, *net.UDPAddr, connection.Metadata, []byte, interface{}) error {
	return nil
}
func (h *Honeypot) ReplyUDP(*net.UDPAddr, *net.UDPAddr, []byte) error { return nil }
func (h *Honeypot) GuardConn(conn net.Conn) net.Conn                  { return conn }
func (h *Honeypot) ConnectionByFlow([2]uint64) connection.Metadata    { return connection.Metadata{} }
func (h *Honeypot) MetadataByConnection(net.Conn) (connection.Metadata, error) {
	return connection.Metadata{}, nil
}

func atoiSeguro(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}
