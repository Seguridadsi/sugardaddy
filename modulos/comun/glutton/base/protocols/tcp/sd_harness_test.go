package tcp

// Arnés de pruebas mínimo para los tests de HandleSMB. El upstream lo define en
// tcp_test.go / proxytcp_test.go, que la base recortada de Sugardaddy no
// incluye (dependen de rules/pcap y viper). Aquí solo está lo que usan las
// pruebas del manejador SMB: un honeypot y un logger de mentira y dos ayudas de
// direcciones. Sin dependencias de terceros.

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/mushorg/glutton/connection"
)

type recordingLogger struct{}

func (l *recordingLogger) Info(string, ...any)  {}
func (l *recordingLogger) Debug(string, ...any) {}
func (l *recordingLogger) Error(string, ...any) {}
func (l *recordingLogger) Warn(string, ...any)  {}

type producedTCP struct {
	protocol  string
	payload   []byte
	decoded   interface{}
	endReason string
	tls       *connection.TLSInfo
}

type fakeHoneypot struct {
	produced chan producedTCP
}

func newFakeHoneypot() *fakeHoneypot {
	return &fakeHoneypot{produced: make(chan producedTCP, 4)}
}

func (h *fakeHoneypot) ProduceTCP(protocol string, conn net.Conn, md connection.Metadata, payload []byte, decoded interface{}) error {
	h.produced <- producedTCP{protocol: protocol, payload: payload, decoded: decoded, endReason: md.EndReason, tls: md.TLS}
	return nil
}

func (h *fakeHoneypot) ProduceUDP(string, *net.UDPAddr, *net.UDPAddr, connection.Metadata, []byte, interface{}) error {
	return nil
}
func (h *fakeHoneypot) ReplyUDP(*net.UDPAddr, *net.UDPAddr, []byte) error    { return nil }
func (h *fakeHoneypot) ConnectionByFlow([2]uint64) connection.Metadata       { return connection.Metadata{} }
func (h *fakeHoneypot) UpdateConnectionTimeout(context.Context, net.Conn) error { return nil }
func (h *fakeHoneypot) GuardConn(conn net.Conn) net.Conn                     { return conn }
func (h *fakeHoneypot) MetadataByConnection(net.Conn) (connection.Metadata, error) {
	return connection.Metadata{}, nil
}

type staticAddr struct{ addr string }

func (a staticAddr) Network() string { return "tcp" }
func (a staticAddr) String() string  { return a.addr }

type connWithRemote struct {
	net.Conn
	remote net.Addr
}

func (c connWithRemote) RemoteAddr() net.Addr { return c.remote }

func waitProduced(t *testing.T, hp *fakeHoneypot) producedTCP {
	t.Helper()
	select {
	case event := <-hp.produced:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for produced TCP event")
	}
	return producedTCP{}
}
