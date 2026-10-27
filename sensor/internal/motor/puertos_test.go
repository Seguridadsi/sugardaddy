package motor

import (
	"errors"
	"net"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// Como en un Ubuntu de serie: el resolvedor del sistema en 127.0.0.53:53
// (UDP y TCP), sshd en 0.0.0.0:22 y [::]:22, una conexión establecida (no
// cuenta) y la trampa SSH de este sensor publicada en 0.0.0.0:2222.
const (
	tcp4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   991        0 1 1 0000000000000000 100 0 0 10 5
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 0400000A:0016 0500000A:D431 01 00000000:00000000 02:000A3D70 00000000     0        0 3 4 0000000000000000 20 4 30 10 -1
   3: 00000000:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 100 0 0 10 0
`
	tcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:0277 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 6 1 0000000000000000 100 0 0 10 0
`
	udp4 = `   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  100: 3500007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   991        0 7 2 0000000000000000 0
  101: 0400000A:0044 00000000:0000 07 00000000:00000000 00:00000000 00000000   100        0 8 2 0000000000000000 0
`
)

func escuchasDeUbuntu() []Escucha {
	var r []Escucha
	r = append(r, LeerEscuchas("tcp", strings.NewReader(tcp4))...)
	r = append(r, LeerEscuchas("tcp", strings.NewReader(tcp6))...)
	r = append(r, LeerEscuchas("udp", strings.NewReader(udp4))...)
	return r
}

func TestLeerEscuchasDeProcNet(t *testing.T) {
	var vistas []string
	for _, e := range escuchasDeUbuntu() {
		vistas = append(vistas, e.Proto+" "+e.IP.String()+" "+strconv.Itoa(e.Puerto))
	}
	quiero := []string{
		"tcp 127.0.0.53 53", "tcp 0.0.0.0 22", "tcp 0.0.0.0 2222",
		"tcp :: 22", "tcp ::1 631",
		"udp 127.0.0.53 53", "udp 10.0.0.4 68",
	}
	if !reflect.DeepEqual(vistas, quiero) {
		t.Fatalf("escuchas:\n%v\nquiero:\n%v", vistas, quiero)
	}
}

func TestPublicarEnLaRedSiElPuertoEsLocal(t *testing.T) {
	a := &Anfitrion{Direcciones: []string{"10.0.0.4"}, Escuchas: escuchasDeUbuntu()}
	// El DNS: el resolvedor lo tiene en 127.0.0.53, así que va en la IP de red.
	if got := a.PublicarEn("udp", 53); !reflect.DeepEqual(got, []string{"10.0.0.4"}) {
		t.Fatalf("udp/53: %v", got)
	}
	if got := a.PublicarEn("tcp", 53); !reflect.DeepEqual(got, []string{"10.0.0.4"}) {
		t.Fatalf("tcp/53: %v", got)
	}
	// Libre, u ocupado en la red: como siempre (si choca, choca, y la consola
	// ya lo sabe por puertos.ocupados).
	for _, p := range []struct {
		proto  string
		puerto int
	}{{"udp", 123}, {"tcp", 22}, {"udp", 68}} {
		if got := a.PublicarEn(p.proto, p.puerto); got != nil {
			t.Fatalf("%s/%d: %v", p.proto, p.puerto, got)
		}
	}
	// Sin direcciones de red no hay dónde llevarlo; sin sonda, nada.
	if got := (&Anfitrion{Escuchas: a.Escuchas}).PublicarEn("udp", 53); got != nil {
		t.Fatalf("sin direcciones: %v", got)
	}
	if got := (*Anfitrion)(nil).PublicarEn("udp", 53); got != nil {
		t.Fatalf("sin sonda: %v", got)
	}
}

func TestOcupadosSinLosLocalesNiLosPropios(t *testing.T) {
	a := &Anfitrion{Escuchas: escuchasDeUbuntu()}
	got := a.Ocupados(map[string]bool{"tcp/2222": true})
	// Ni el 53 del resolvedor (local), ni el 631 de ::1, ni la trampa propia.
	if quiero := []string{"tcp/22", "udp/68"}; !reflect.DeepEqual(got, quiero) {
		t.Fatalf("ocupados: %v, quiero %v", got, quiero)
	}
	if got := (&Anfitrion{}).Ocupados(nil); got == nil || len(got) != 0 {
		t.Fatalf("sin nada que escuche, una lista vacía (no «no se sabe»): %v", got)
	}
}

func TestDireccionesDeRedSinLocalesNiDocker(t *testing.T) {
	arriba := net.FlagUp | net.FlagBroadcast
	interfaces := []net.Interface{
		{Name: "lo", Flags: net.FlagUp | net.FlagLoopback},
		{Name: "eth0", Flags: arriba},
		{Name: "docker0", Flags: arriba},
		{Name: "br-0a1b2c", Flags: arriba},
		{Name: "eth1", Flags: net.FlagBroadcast}, // apagada
		{Name: "wlan0", Flags: arriba},
	}
	dirs := map[string][]string{
		"lo":        {"127.0.0.1/8", "::1/128"},
		"eth0":      {"10.0.0.4/24", "fe80::1/64", "169.254.3.3/16"},
		"docker0":   {"172.17.0.1/16"},
		"br-0a1b2c": {"172.18.0.1/16"},
		"eth1":      {"192.168.9.9/24"},
	}
	got := DireccionesDeRed(interfaces, func(i net.Interface) ([]net.Addr, error) {
		if i.Name == "wlan0" {
			return nil, errors.New("sin direcciones")
		}
		var r []net.Addr
		for _, d := range dirs[i.Name] {
			ip, red, _ := net.ParseCIDR(d)
			red.IP = ip
			r = append(r, red)
		}
		return r, nil
	})
	if !reflect.DeepEqual(got, []string{"10.0.0.4"}) {
		t.Fatalf("direcciones: %v", got)
	}
}
