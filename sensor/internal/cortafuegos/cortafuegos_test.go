package cortafuegos

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
)

// simulado es un iptables de juguete: cadenas con sus reglas, por orden (iptables-nft,
// ip6tables-nft…). Basta para comprobar qué deja Aplicar, no cómo lo dice iptables.
type simulado struct {
	tablas  map[string]map[string][]string // orden -> cadena -> reglas (sin «-A cadena»)
	ordenes []string
}

func nuevoSimulado() *simulado { return &simulado{tablas: map[string]map[string][]string{}} }

func (s *simulado) tabla(nombre string) map[string][]string {
	if s.tablas[nombre] == nil {
		s.tablas[nombre] = map[string][]string{}
	}
	return s.tablas[nombre]
}

// conDocker monta lo que deja Docker: FORWARD salta a DOCKER-USER.
func (s *simulado) conDocker(orden string, extra ...string) {
	t := s.tabla(orden)
	t["INPUT"] = []string{}
	t["FORWARD"] = []string{"-j DOCKER-USER", "-j DOCKER-FORWARD"}
	t["DOCKER-USER"] = append([]string{}, extra...)
}

func (s *simulado) ejecutar(_ context.Context, entrada, orden string, args ...string) (string, error) {
	s.ordenes = append(s.ordenes, strings.TrimSpace(orden+" "+strings.Join(args, " ")))
	if strings.HasSuffix(orden, "-restore") {
		t, ok := s.tablas[strings.TrimSuffix(orden, "-restore")]
		if !ok {
			return "", errors.New("no such table")
		}
		for _, l := range strings.Split(entrada, "\n") {
			switch {
			case strings.HasPrefix(l, ":"):
				t[strings.Fields(l[1:])[0]] = []string{} // en --noflush, declarar una cadena la vacía
			case strings.HasPrefix(l, "-A "):
				c := strings.Fields(l)[1]
				t[c] = append(t[c], strings.TrimPrefix(l, "-A "+c+" "))
			}
		}
		return "", nil
	}
	t, ok := s.tablas[orden]
	if !ok {
		return "", errors.New("command not found")
	}
	a := args
	for len(a) > 0 && (a[0] == "-w" || a[0] == "-t" || a[0] == "filter") {
		a = a[1:]
	}
	op, cadena := a[0], ""
	if len(a) > 1 {
		cadena = a[1]
	}
	reglas, existe := t[cadena]
	switch op {
	case "-S":
		if !existe {
			return "", errors.New("no chain")
		}
		var b strings.Builder
		b.WriteString("-N " + cadena + "\n")
		for _, r := range reglas {
			b.WriteString("-A " + cadena + " " + r + "\n")
		}
		return b.String(), nil
	case "-C":
		buscada := strings.Join(a[2:], " ")
		for _, r := range reglas {
			if r == buscada {
				return "", nil
			}
		}
		return "", errors.New("no such rule")
	case "-I":
		n, _ := strconv.Atoi(a[2])
		r := strings.Join(a[3:], " ")
		t[cadena] = append(reglas[:n-1:n-1], append([]string{r}, reglas[n-1:]...)...)
		return "", nil
	case "-D":
		n, err := strconv.Atoi(a[2])
		if err != nil || n < 1 || n > len(reglas) {
			return "", errors.New("bad rule number")
		}
		t[cadena] = append(reglas[:n-1:n-1], reglas[n:]...)
		return "", nil
	case "-F":
		t[cadena] = []string{}
		return "", nil
	case "-X":
		delete(t, cadena)
		return "", nil
	}
	return "", errors.New("unknown " + op)
}

func TestValidar(t *testing.T) {
	v4, v6, err := Validar(Pedido{Puerto: 443, Redes: []string{"10.0.5.20", "192.168.10.7/24", "::ffff:10.0.5.20", "2001:db8::1", " 10.0.5.20 "}})
	if err != nil {
		t.Fatal(err)
	}
	if len(v4) != 2 || v4[0].String() != "10.0.5.20/32" || v4[1].String() != "192.168.10.0/24" {
		t.Fatalf("IPv4: %v", v4)
	}
	if len(v6) != 1 || v6[0].String() != "2001:db8::1/128" {
		t.Fatalf("IPv6: %v", v6)
	}
	for _, mal := range []Pedido{
		{Puerto: 443, Redes: []string{"0.0.0.0/0"}},
		{Puerto: 443, Redes: []string{"::/0"}},
		{Puerto: 443, Redes: []string{"10.0.0.300"}},
		{Puerto: 443, Redes: []string{"10.0.0.0/33"}},
		{Puerto: 443, Redes: []string{"10.0.0.1; rm -rf /"}},
		{Puerto: 443},
		{Puerto: 0, Redes: []string{"10.0.0.1"}},
		{Puerto: 443, Redes: []string{"10.0.0.1"}, Escucha: "nada"},
	} {
		if _, _, err := Validar(mal); err == nil {
			t.Errorf("should be rejected: %+v", mal)
		}
	}
	if _, _, err := Validar(Pedido{Puerto: 443, Abierta: true}); err != nil {
		t.Errorf("an open console needs no list: %v", err)
	}
}

func TestPrimeraVez(t *testing.T) {
	s := nuevoSimulado()
	s.conDocker("iptables-nft", "-j RETURN")
	s.conDocker("ip6tables-nft")
	r := Aplicar(context.Background(), Pedido{Puerto: 443, Redes: []string{"10.0.5.20", "192.168.10.0/24", "2001:db8::1"}}, s.ejecutar)
	if r.Estado != Aplicada {
		t.Fatalf("%+v", r)
	}
	v4 := s.tablas["iptables-nft"]
	if got := strings.Join(v4[Cadena], "|"); got != "-s 10.0.5.20/32 -j RETURN|-s 192.168.10.0/24 -j RETURN|-p tcp -j REJECT --reject-with tcp-reset|-j DROP" {
		t.Fatalf("IPv4 chain: %s", got)
	}
	if v4["DOCKER-USER"][0] != "-p tcp -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport 443 -j SD-CONSOLA" || len(v4["DOCKER-USER"]) != 2 {
		t.Fatalf("DOCKER-USER: %v", v4["DOCKER-USER"])
	}
	// Con 0.0.0.0 (lo de compose.yml) Docker no publica por IPv6: nada nuestro ahí.
	if _, hay := s.tablas["ip6tables-nft"][Cadena]; hay {
		t.Fatal("IPv6 chain created although the console does not listen on IPv6")
	}
}

func TestOtraVezNoCambiaNada(t *testing.T) {
	s := nuevoSimulado()
	s.conDocker("iptables-nft")
	p := Pedido{Puerto: 443, Redes: []string{"10.0.5.20"}}
	Aplicar(context.Background(), p, s.ejecutar)
	antes := strings.Join(s.tablas["iptables-nft"]["DOCKER-USER"], "|")
	s.ordenes = nil
	if r := Aplicar(context.Background(), p, s.ejecutar); r.Estado != Aplicada {
		t.Fatalf("%+v", r)
	}
	if got := strings.Join(s.tablas["iptables-nft"]["DOCKER-USER"], "|"); got != antes {
		t.Fatalf("DOCKER-USER changed: %s", got)
	}
	for _, o := range s.ordenes {
		if strings.Contains(o, " -I ") || strings.Contains(o, " -D ") {
			t.Fatalf("touched the jump on a second run: %s", o)
		}
	}
}

func TestCambioDePuertoDejaUnSoloSalto(t *testing.T) {
	s := nuevoSimulado()
	s.conDocker("iptables-legacy", "-s 172.16.0.0/12 -j ACCEPT")
	Aplicar(context.Background(), Pedido{Puerto: 443, Redes: []string{"10.0.5.20"}}, s.ejecutar)
	Aplicar(context.Background(), Pedido{Puerto: 8443, Redes: []string{"10.0.5.20"}, Escucha: "10.0.0.4"}, s.ejecutar)
	du := s.tablas["iptables-legacy"]["DOCKER-USER"]
	if len(du) != 2 || du[0] != "-p tcp -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport 8443 --ctorigdst 10.0.0.4 -j SD-CONSOLA" {
		t.Fatalf("DOCKER-USER: %v", du)
	}
	// La regla del cliente sigue donde estaba, sin tocar.
	if du[1] != "-s 172.16.0.0/12 -j ACCEPT" {
		t.Fatalf("the client rule changed: %v", du)
	}
}

func TestSinDockerUser(t *testing.T) {
	s := nuevoSimulado()
	s.tabla("iptables-nft")["FORWARD"] = []string{"-j ACCEPT"}
	if r := Aplicar(context.Background(), Pedido{Puerto: 443, Redes: []string{"10.0.5.20"}}, s.ejecutar); r.Estado != SinDockerUser {
		t.Fatalf("%+v", r)
	}
	if len(s.tablas["iptables-nft"]) != 1 {
		t.Fatal("touched a firewall without DOCKER-USER")
	}
}

func TestAbrirQuitaLoNuestro(t *testing.T) {
	s := nuevoSimulado()
	s.conDocker("iptables-nft", "-j RETURN")
	s.conDocker("ip6tables-nft")
	Aplicar(context.Background(), Pedido{Puerto: 443, Escucha: "::", Redes: []string{"10.0.5.20", "2001:db8::1"}}, s.ejecutar)
	if len(s.tablas["ip6tables-nft"]["INPUT"]) != 1 || len(s.tablas["ip6tables-nft"]["DOCKER-USER"]) != 1 {
		t.Fatalf("IPv6 with '::': %v", s.tablas["ip6tables-nft"])
	}
	if got := strings.Join(s.tablas["ip6tables-nft"][Cadena], "|"); got != "-i lo -j RETURN|-s 2001:db8::1/128 -j RETURN|-p tcp -j REJECT --reject-with tcp-reset|-j DROP" {
		t.Fatalf("IPv6 chain: %s", got)
	}
	if r := Aplicar(context.Background(), Pedido{Puerto: 443, Abierta: true}, s.ejecutar); r.Estado != Abierta {
		t.Fatalf("%+v", r)
	}
	for orden, cadenas := range s.tablas {
		if _, hay := cadenas[Cadena]; hay {
			t.Errorf("%s still has %s", orden, Cadena)
		}
		for c, reglas := range cadenas {
			for _, r := range reglas {
				if strings.Contains(r, Cadena) {
					t.Errorf("%s %s still jumps: %s", orden, c, r)
				}
			}
		}
	}
	if du := s.tablas["iptables-nft"]["DOCKER-USER"]; len(du) != 1 || du[0] != "-j RETURN" {
		t.Fatalf("Docker's own rule was touched: %v", du)
	}
}

func TestErrorNoDejaMediaRegla(t *testing.T) {
	s := nuevoSimulado()
	s.conDocker("iptables-nft")
	r := Aplicar(context.Background(), Pedido{Puerto: 443, Redes: []string{"0.0.0.0/0"}}, s.ejecutar)
	if r.Estado != ConError || len(s.ordenes) != 0 {
		t.Fatalf("an invalid list ran commands: %+v %v", r, s.ordenes)
	}
}

func TestIPv6SinIp6tablesNoEsAplicada(t *testing.T) {
	s := nuevoSimulado()
	s.conDocker("iptables-nft")
	r := Aplicar(context.Background(), Pedido{Puerto: 443, Escucha: "::", Redes: []string{"10.0.5.20"}}, s.ejecutar)
	if r.Estado != ConError {
		t.Fatalf("listening on IPv6 without ip6tables must not be reported as applied: %+v", r)
	}
}
