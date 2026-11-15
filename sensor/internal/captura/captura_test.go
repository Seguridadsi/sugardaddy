package captura

import (
	"encoding/base64"
	"net"
	"testing"
)

func trama(src net.HardwareAddr, tipo uint16, arpEmisor net.HardwareAddr) []byte {
	t := make([]byte, 60)
	copy(t[0:6], []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	copy(t[6:12], src)
	t[12], t[13] = byte(tipo>>8), byte(tipo)
	if tipo == tipoARP {
		t[14], t[15], t[16], t[17] = 0, 1, 0x08, 0x00
		copy(t[22:28], arpEmisor)
	}
	return t
}

func TestTramaPermitida(t *testing.T) {
	mia := net.HardwareAddr{2, 0x42, 0xac, 0x1f, 0xc9, 7}
	otra := net.HardwareAddr{2, 0x42, 0xac, 0x1f, 0xc9, 8}
	casos := []struct {
		nombre string
		t      []byte
		vale   bool
	}{
		{"IPv4 suya", trama(mia, tipoIPv4, nil), true},
		{"ARP suyo", trama(mia, tipoARP, mia), true},
		{"MAC de otro (suplantar)", trama(otra, tipoIPv4, nil), false},
		{"ARP envenenando con otra MAC", trama(mia, tipoARP, otra), false},
		{"IPv6 no", trama(mia, 0x86dd, nil), false},
		{"corta", trama(mia, tipoIPv4, nil)[:20], false},
		{"gigante", append(trama(mia, tipoIPv4, nil), make([]byte, 2000)...), false},
	}
	for _, c := range casos {
		if err := TramaPermitida(c.t, mia); (err == nil) != c.vale {
			t.Errorf("%s: err=%v, quería vale=%v", c.nombre, err, c.vale)
		}
	}
}

func TestDecodificarBPF(t *testing.T) {
	if _, err := DecodificarBPF(base64.StdEncoding.EncodeToString(make([]byte, 16))); err != nil {
		t.Fatal(err)
	}
	for _, malo := range []string{"", "no-base64!", base64.StdEncoding.EncodeToString(make([]byte, 7)), base64.StdEncoding.EncodeToString(make([]byte, 8*513))} {
		if _, err := DecodificarBPF(malo); err == nil {
			t.Errorf("%q: quería error", malo)
		}
	}
}
