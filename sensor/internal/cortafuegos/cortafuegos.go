// Package cortafuegos deja el puerto de la consola del nodo abierto solo para
// las IP que diga el cliente (docs/diseno/acceso-consola.md).
//
// Docker publica el puerto con sus propias reglas, por delante de ufw, así que
// la regla va en la cadena que Docker reserva para esto, DOCKER-USER. Desde ahí
// se salta a una cadena propia, SD-CONSOLA, que deja pasar las IP de la lista y
// tira el resto. No toca nada más del cortafuegos de la máquina.
//
// Lo ejecuta un auxiliar de un solo uso con --network host y NET_ADMIN (orden
// «cortafuegos» del actualizador).
package cortafuegos

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"
)

// Cadena es la cadena propia, en el filtro de IPv4 y en el de IPv6.
const Cadena = "SD-CONSOLA"

// Pedido es lo que tiene que quedar en el cortafuegos.
type Pedido struct {
	Abierta bool     // sin reglas: el puerto contesta a todos
	Redes   []string // IP o redes CIDR, IPv4 o IPv6, que pasan
	Puerto  int      // puerto publicado de la consola en la máquina
	Escucha string   // IP en la que escucha la consola; vacía o 0.0.0.0, todas
}

// Resultado de aplicar un pedido.
type Resultado struct {
	Estado  string `json:"estado"` // aplicada, abierta, sin-docker-user o error
	Detalle string `json:"detalle"`
}

// Estados que puede dar Aplicar.
const (
	Aplicada      = "aplicada"
	Abierta       = "abierta"
	SinDockerUser = "sin-docker-user"
	ConError      = "error"
)

// Ejecutor corre una orden con su entrada estándar y devuelve lo que escribe.
// En el auxiliar es exec; en las pruebas, un doble.
type Ejecutor func(ctx context.Context, entrada string, orden string, args ...string) (string, error)

// Validar comprueba el pedido y devuelve las redes en forma canónica, separadas por familia.
func Validar(p Pedido) (v4, v6 []netip.Prefix, err error) {
	if p.Puerto < 1 || p.Puerto > 65535 {
		return nil, nil, fmt.Errorf("invalid port %d", p.Puerto)
	}
	if p.Escucha != "" {
		if _, err := netip.ParseAddr(p.Escucha); err != nil {
			return nil, nil, fmt.Errorf("invalid listen address %q", p.Escucha)
		}
	}
	vistas := map[netip.Prefix]bool{}
	for _, r := range p.Redes {
		pr, err := prefijo(r)
		if err != nil {
			return nil, nil, err
		}
		if pr.Bits() == 0 {
			return nil, nil, fmt.Errorf("%s lets everyone in: that is an open console, not a list", r)
		}
		if vistas[pr] {
			continue
		}
		vistas[pr] = true
		if pr.Addr().Is4() {
			v4 = append(v4, pr)
		} else {
			v6 = append(v6, pr)
		}
	}
	if !p.Abierta && len(v4)+len(v6) == 0 {
		return nil, nil, errors.New("an empty list would leave nobody able to reach the console")
	}
	orden := func(l []netip.Prefix) {
		sort.Slice(l, func(i, j int) bool { return l[i].String() < l[j].String() })
	}
	orden(v4)
	orden(v6)
	return v4, v6, nil
}

func prefijo(r string) (netip.Prefix, error) {
	r = strings.TrimSpace(r)
	if strings.Contains(r, "/") {
		pr, err := netip.ParsePrefix(r)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("invalid network %q", r)
		}
		return normal(pr), nil
	}
	a, err := netip.ParseAddr(r)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("invalid address %q", r)
	}
	a = a.Unmap()
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// normal: IPv4 dentro de IPv6 como IPv4 y la base alineada a la máscara.
func normal(pr netip.Prefix) netip.Prefix {
	a := pr.Addr()
	if a.Is4In6() && pr.Bits() >= 96 {
		pr = netip.PrefixFrom(a.Unmap(), pr.Bits()-96)
	}
	return pr.Masked()
}

// Restore es el texto para «iptables-restore --noflush»: rehace la cadena
// propia de golpe, sin un instante en que quede vacía. En IPv6 la interfaz de
// loopback va siempre dentro: lo que sale de la propia máquina pasa. Al resto
// se le contesta con un RST, como un puerto cerrado de cualquier máquina: un
// puerto que no contesta («filtrado») llama la atención si los demás sí.
func Restore(redes []netip.Prefix, ipv6 bool) string {
	var b strings.Builder
	b.WriteString("*filter\n:" + Cadena + " - [0:0]\n")
	if ipv6 {
		b.WriteString("-A " + Cadena + " -i lo -j RETURN\n")
	}
	for _, r := range redes {
		b.WriteString("-A " + Cadena + " -s " + r.String() + " -j RETURN\n")
	}
	b.WriteString("-A " + Cadena + " -p tcp -j REJECT --reject-with tcp-reset\n-A " + Cadena + " -j DROP\nCOMMIT\n")
	return b.String()
}

// SaltoDNAT es la regla de DOCKER-USER: solo las conexiones nuevas que entran
// por un puerto publicado (DNAT) a ese puerto. Sin --ctstate DNAT también
// cogería lo que los contenedores abren hacia fuera a un 443 (el panel, Entra,
// el registro de imágenes) y lo cortaría.
func SaltoDNAT(puerto int, escucha netip.Addr) []string {
	r := []string{"-p", "tcp", "-m", "conntrack", "--ctstate", "DNAT", "--ctdir", "ORIGINAL", "--ctorigdstport", strconv.Itoa(puerto)}
	if escucha.IsValid() && !escucha.IsUnspecified() {
		r = append(r, "--ctorigdst", escucha.String())
	}
	return append(r, "-j", Cadena)
}

// SaltoEntrada es la regla de INPUT en IPv6: Docker suele atender el puerto
// por IPv6 con su proxy, en la propia máquina, y eso no pasa por DOCKER-USER.
func SaltoEntrada(puerto int, escucha netip.Addr) []string {
	r := []string{"-p", "tcp", "--dport", strconv.Itoa(puerto)}
	if escucha.IsValid() && !escucha.IsUnspecified() {
		r = append(r, "-d", escucha.String())
	}
	return append(r, "-j", Cadena)
}

// familia son las órdenes de una familia (IPv4 o IPv6) con un mismo motor (nft o legacy).
type familia struct {
	tabla, restore string
	ipv6           bool
}

func (f familia) nombre() string {
	if f.ipv6 {
		return "IPv6"
	}
	return "IPv4"
}

// motorDocker busca el motor (nft o legacy) en el que Docker tiene DOCKER-USER
// enganchada a FORWARD. Si no está en ninguno, Docker no usa iptables aquí.
func motorDocker(ctx context.Context, ej Ejecutor) (string, bool) {
	for _, m := range []string{"nft", "legacy"} {
		s, err := ej(ctx, "", "iptables-"+m, "-w", "-t", "filter", "-S", "FORWARD")
		if err == nil && strings.Contains(s, "-j DOCKER-USER") {
			return m, true
		}
	}
	return "", false
}

func familias(motor string) (v4, v6 familia) {
	return familia{"iptables-" + motor, "iptables-" + motor + "-restore", false},
		familia{"ip6tables-" + motor, "ip6tables-" + motor + "-restore", true}
}

// Aplicar deja el cortafuegos como pide p. Nunca toca reglas que no sean suyas.
func Aplicar(ctx context.Context, p Pedido, ej Ejecutor) Resultado {
	v4, v6, err := Validar(p)
	if err != nil {
		return Resultado{ConError, err.Error()}
	}
	var escucha netip.Addr
	if p.Escucha != "" {
		escucha, _ = netip.ParseAddr(p.Escucha)
		escucha = escucha.Unmap()
	}
	motor, ok := motorDocker(ctx, ej)
	if !ok {
		if p.Abierta {
			return Resultado{Abierta, "Docker does not use iptables here: there was nothing to remove"}
		}
		return Resultado{SinDockerUser, "Docker does not use iptables on this machine (no DOCKER-USER chain): the console port is still open to everyone"}
	}
	f4, f6 := familias(motor)
	if p.Abierta {
		var notas []string
		for _, f := range []familia{f4, f6} {
			if err := quitar(ctx, ej, f); err != nil {
				notas = append(notas, f.nombre()+": "+err.Error())
			}
		}
		if len(notas) > 0 {
			return Resultado{ConError, strings.Join(notas, "; ")}
		}
		return Resultado{Abierta, "rules removed (iptables-" + motor + ")"}
	}
	// Por qué familias escucha la consola. compose.yml publica en
	// ${CONSOLA_ESCUCHA:-0.0.0.0}: con una IPv4 (también 0.0.0.0), Docker solo
	// abre el puerto por IPv4; con «::», por las dos; con una IPv6, solo por esa.
	// Una familia por la que no escucha se deja sin nada nuestro: un salto ahí
	// sin --ctorigdst podría coger una trampa publicada en ese mismo puerto.
	if !escucha.IsValid() {
		escucha = netip.IPv4Unspecified()
	}
	usa4 := escucha.Is4() || escucha == netip.IPv6Unspecified()
	usa6 := escucha.Is6()
	var esc4, esc6 netip.Addr
	if escucha.Is4() {
		esc4 = escucha
	} else {
		esc6 = escucha
	}
	var detalle []string
	if usa4 {
		if err := cadena(ctx, ej, f4, v4); err != nil {
			return Resultado{ConError, "IPv4: " + err.Error()}
		}
		if err := saltoUnico(ctx, ej, f4, "DOCKER-USER", SaltoDNAT(p.Puerto, esc4)); err != nil {
			return Resultado{ConError, "IPv4: " + err.Error()}
		}
		detalle = append(detalle, fmt.Sprintf("IPv4 with iptables-%s, %d allowed", motor, len(v4)))
	} else if err := quitar(ctx, ej, f4); err != nil {
		return Resultado{ConError, "IPv4: " + err.Error()}
	}
	if !usa6 {
		if err := quitar(ctx, ej, f6); err != nil {
			return Resultado{ConError, strings.Join(append(detalle, "IPv6: "+err.Error()), "; ")}
		}
		return Resultado{Aplicada, strings.Join(append(detalle, "the console does not listen on IPv6"), "; ")}
	}
	if _, err := ej(ctx, "", f6.tabla, "-w", "-t", "filter", "-S", "INPUT"); err != nil {
		// La consola escucha por IPv6 y no se puede proteger por ahí: no es «aplicada».
		return Resultado{ConError, strings.Join(append(detalle, "the console listens on IPv6 but ip6tables is not available: "+err.Error()), "; ")}
	}
	if err := cadena(ctx, ej, f6, v6); err != nil {
		return Resultado{ConError, strings.Join(append(detalle, "IPv6: "+err.Error()), "; ")}
	}
	// Docker suele atender el puerto por IPv6 con su proxy, en la propia máquina (INPUT).
	if err := saltoUnico(ctx, ej, f6, "INPUT", SaltoEntrada(p.Puerto, esc6)); err != nil {
		return Resultado{ConError, strings.Join(append(detalle, "IPv6: "+err.Error()), "; ")}
	}
	// Y con IPv6 en sus redes, por DNAT, como en IPv4.
	if s, err := ej(ctx, "", f6.tabla, "-w", "-t", "filter", "-S", "FORWARD"); err == nil && strings.Contains(s, "-j DOCKER-USER") {
		if err := saltoUnico(ctx, ej, f6, "DOCKER-USER", SaltoDNAT(p.Puerto, esc6)); err != nil {
			return Resultado{ConError, strings.Join(append(detalle, "IPv6: "+err.Error()), "; ")}
		}
	}
	return Resultado{Aplicada, strings.Join(append(detalle, fmt.Sprintf("IPv6 with ip6tables-%s, %d allowed", motor, len(v6))), "; ")}
}

// cadena rehace SD-CONSOLA de golpe con la lista de su familia.
func cadena(ctx context.Context, ej Ejecutor, f familia, redes []netip.Prefix) error {
	if _, err := ej(ctx, Restore(redes, f.ipv6), f.restore, "-w", "--noflush"); err != nil {
		return fmt.Errorf("%s: %w", f.restore, err)
	}
	return nil
}

// saltoUnico deja en la cadena padre exactamente un salto a SD-CONSOLA, el
// pedido, el primero. Pone el nuevo antes de quitar los viejos: nunca hay un
// instante sin salto.
func saltoUnico(ctx context.Context, ej Ejecutor, f familia, padre string, regla []string) error {
	saltos, err := listarSaltos(ctx, ej, f, padre)
	if err != nil {
		return err
	}
	_, existe := ej(ctx, "", f.tabla, append([]string{"-w", "-t", "filter", "-C", padre}, regla...)...)
	if existe == nil && len(saltos) == 1 && saltos[0] == 1 {
		return nil
	}
	if _, err := ej(ctx, "", f.tabla, append([]string{"-w", "-t", "filter", "-I", padre, "1"}, regla...)...); err != nil {
		return fmt.Errorf("%s -I %s: %w", f.tabla, padre, err)
	}
	// Los que había bajan un puesto. De abajo arriba, para que los números no se muevan.
	for i := len(saltos) - 1; i >= 0; i-- {
		if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-D", padre, strconv.Itoa(saltos[i]+1)); err != nil {
			return fmt.Errorf("%s -D %s: %w", f.tabla, padre, err)
		}
	}
	return nil
}

// listarSaltos da los números de regla (desde 1) de la cadena padre que saltan a SD-CONSOLA.
func listarSaltos(ctx context.Context, ej Ejecutor, f familia, padre string) ([]int, error) {
	s, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-S", padre)
	if err != nil {
		return nil, fmt.Errorf("%s -S %s: %w", f.tabla, padre, err)
	}
	var r []int
	n := 0
	for _, l := range strings.Split(s, "\n") {
		if !strings.HasPrefix(l, "-A ") {
			continue
		}
		n++
		if strings.HasSuffix(strings.TrimSpace(l), "-j "+Cadena) {
			r = append(r, n)
		}
	}
	return r, nil
}

func quitarSaltos(ctx context.Context, ej Ejecutor, f familia, padre string) error {
	saltos, err := listarSaltos(ctx, ej, f, padre)
	if err != nil {
		return err
	}
	for i := len(saltos) - 1; i >= 0; i-- {
		if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-D", padre, strconv.Itoa(saltos[i])); err != nil {
			return fmt.Errorf("%s -D %s: %w", f.tabla, padre, err)
		}
	}
	return nil
}

// quitar deja la familia sin nada nuestro. Si la familia no existe (sin IPv6),
// no hay nada que quitar.
func quitar(ctx context.Context, ej Ejecutor, f familia) error {
	if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-S", "INPUT"); err != nil {
		return nil
	}
	for _, padre := range []string{"DOCKER-USER", "INPUT"} {
		if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-S", padre); err != nil {
			continue // sin esa cadena, sin saltos que quitar
		}
		if err := quitarSaltos(ctx, ej, f, padre); err != nil {
			return err
		}
	}
	if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-S", Cadena); err != nil {
		return nil
	}
	if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-F", Cadena); err != nil {
		return fmt.Errorf("%s -F: %w", f.tabla, err)
	}
	if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-X", Cadena); err != nil {
		return fmt.Errorf("%s -X: %w", f.tabla, err)
	}
	return nil
}
