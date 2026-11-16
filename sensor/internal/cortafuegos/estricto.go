package cortafuegos

// Cortafuegos estricto de la máquina (plan de fortificación §1.3,
// docs/diseno/cortafuegos-anfitrion.md): una tabla nftables propia, «inet
// sugardaddy», que deniega por defecto y deja pasar solo lo que dice el estado
// del nodo:
//
//   - de entrada, el puerto de la consola para su lista de IP (SEN-1), los
//     puertos publicados de las trampas y de los servicios del nodo, el SSH de la
//     máquina solo desde los rangos de administración (si se dan) y lo mínimo para
//     que la red funcione (respuestas, ICMP de control, DHCP);
//   - lo que entra por un puente de trampas hacia la propia máquina, nunca (SEN-5,
//     la misma regla que la cadena SD-TRAMPAS de trampas.go);
//   - lo que Docker reenvía a un puerto publicado (DNAT) que no es del nodo, nunca;
//   - de salida, si se pide, solo a la lista de destinos (panel, registro, proxy y
//     los del cliente), más DNS y NTP.
//
// Es otra tabla, no toca las de nadie: ni las de Docker, ni SD-CONSOLA ni
// SD-TRAMPAS (que siguen como segunda barrera), ni las del cliente. Con UFW o
// firewalld activos no se aplica (Conflictos): dos cortafuegos que deniegan por
// defecto en la misma máquina dejan fuera lo que cada uno cree permitido.
//
// Se aplica en una sola transacción de nft (nunca hay un instante sin reglas ni con
// media tabla) y con interruptor de hombre muerto: si nadie confirma en el plazo
// que el nodo sigue hablando con su consola, vuelve a la tabla de antes
// (AplicarEstricto).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// TablaEstricta es la tabla propia, de la familia inet (IPv4 e IPv6 a la vez).
const TablaEstricta = "sugardaddy"

// Estricto es lo que tiene que quedar en la tabla. Lo calcula el actualizador con
// lo que dice la consola y lo que Docker tiene publicado.
type Estricto struct {
	Consola    ConsolaEstricta `json:"consola"`
	Publicados []Publicado     `json:"publicados"`
	SSH        SSHEstricto     `json:"ssh"`
	Salida     SalidaEstricta  `json:"salida"`
}

// ConsolaEstricta: el puerto de la consola y quién llega a él.
type ConsolaEstricta struct {
	Puerto  int      `json:"puerto"`
	Abierta bool     `json:"abierta"` // pendiente, abierta a propósito o emergencia
	Redes   []string `json:"redes"`
}

// Publicado es un puerto que Docker publica en la máquina para un contenedor del nodo.
type Publicado struct {
	Proto  string `json:"proto"` // tcp o udp
	Puerto int    `json:"puerto"`
}

// SSHEstricto: el SSH de la propia máquina. Sin redes, cerrado.
type SSHEstricto struct {
	Puerto int      `json:"puerto"`
	Redes  []string `json:"redes"`
}

// SalidaEstricta: sin Restringida, la salida no se toca.
type SalidaEstricta struct {
	Restringida bool      `json:"restringida"`
	Destinos    []Destino `json:"destinos"`
}

// Destino es una IP (ya resuelta) y un puerto TCP al que el nodo puede salir.
type Destino struct {
	IP     string `json:"ip"`
	Puerto int    `json:"puerto"`
}

// Topes: el estado sale de la consola y de Docker; uno desmedido es un error, no
// una tabla gigante.
const (
	maxRedes     = 256
	maxPublicado = 1024
	maxDestinos  = 512
)

// Estados del cortafuegos estricto.
const (
	EstrictoAplicado   = "aplicada"
	EstrictoQuitado    = "quitada"    // apagado: la tabla no está
	EstrictoRevertido  = "revertida"  // nadie confirmó a tiempo: se volvió a la de antes
	EstrictoConflicto  = "conflicto"  // UFW o firewalld activos: no se aplica
	EstrictoSinNft     = "sin-nft"    // la máquina no tiene nftables
	EstrictoSuspendido = "suspendida" // fichero de emergencia: quitada durante su plazo
)

// estricto validado y en forma canónica.
type estrictoCanonico struct {
	consola    int
	abierta    bool
	consola4   []netip.Prefix
	consola6   []netip.Prefix
	publicados []Publicado
	ssh        int
	ssh4       []netip.Prefix
	ssh6       []netip.Prefix
	salida     bool
	destinos4  []Destino
	destinos6  []Destino
}

func separar(redes []string, que string) (v4, v6 []netip.Prefix, err error) {
	if len(redes) > maxRedes {
		return nil, nil, fmt.Errorf("too many %s networks (%d, at most %d)", que, len(redes), maxRedes)
	}
	vistas := map[netip.Prefix]bool{}
	for _, r := range redes {
		pr, err := prefijo(r)
		if err != nil {
			return nil, nil, err
		}
		if pr.Bits() == 0 {
			return nil, nil, fmt.Errorf("%s lets everyone in: not a %s list", r, que)
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
	return quitarCubiertas(v4), quitarCubiertas(v6), nil
}

// quitarCubiertas ordena y deja fuera las redes que ya cubre otra de la lista: un
// conjunto de intervalos de nft no admite dos que se solapan.
func quitarCubiertas(l []netip.Prefix) []netip.Prefix {
	sort.Slice(l, func(i, j int) bool {
		if l[i].Bits() != l[j].Bits() {
			return l[i].Bits() < l[j].Bits()
		}
		return l[i].Addr().Less(l[j].Addr())
	})
	var r []netip.Prefix
	for _, p := range l {
		cubierta := false
		for _, q := range r {
			if q.Bits() <= p.Bits() && q.Contains(p.Addr()) {
				cubierta = true
				break
			}
		}
		if !cubierta {
			r = append(r, p)
		}
	}
	sort.Slice(r, func(i, j int) bool { return r[i].Addr().Less(r[j].Addr()) })
	return r
}

func puertoValido(p int) bool { return p >= 1 && p <= 65535 }

// canonico valida e y lo deja ordenado y sin repetidos: la misma entrada da siempre
// el mismo texto (y la misma huella).
func canonico(e Estricto) (estrictoCanonico, error) {
	var c estrictoCanonico
	if !puertoValido(e.Consola.Puerto) {
		return c, fmt.Errorf("invalid console port %d", e.Consola.Puerto)
	}
	c.consola, c.abierta = e.Consola.Puerto, e.Consola.Abierta
	if !c.abierta {
		v4, v6, err := separar(e.Consola.Redes, "console")
		if err != nil {
			return c, err
		}
		if len(v4)+len(v6) == 0 {
			return c, errors.New("an empty console list would leave nobody able to reach the console")
		}
		c.consola4, c.consola6 = v4, v6
	}
	if len(e.Publicados) > maxPublicado {
		return c, fmt.Errorf("too many published ports (%d)", len(e.Publicados))
	}
	vistos := map[Publicado]bool{}
	for _, p := range e.Publicados {
		if (p.Proto != "tcp" && p.Proto != "udp") || !puertoValido(p.Puerto) {
			return c, fmt.Errorf("invalid published port %s/%d", p.Proto, p.Puerto)
		}
		// El de la consola va aparte, con su lista.
		if p.Proto == "tcp" && p.Puerto == c.consola {
			continue
		}
		if !vistos[p] {
			vistos[p] = true
			c.publicados = append(c.publicados, p)
		}
	}
	sort.Slice(c.publicados, func(i, j int) bool {
		if c.publicados[i].Proto != c.publicados[j].Proto {
			return c.publicados[i].Proto < c.publicados[j].Proto
		}
		return c.publicados[i].Puerto < c.publicados[j].Puerto
	})
	if len(e.SSH.Redes) > 0 {
		if !puertoValido(e.SSH.Puerto) {
			return c, fmt.Errorf("invalid SSH port %d", e.SSH.Puerto)
		}
		if e.SSH.Puerto == c.consola {
			return c, errors.New("the SSH port is the console port")
		}
		if vistos[Publicado{"tcp", e.SSH.Puerto}] {
			return c, fmt.Errorf("a decoy is published on port %d, the machine's SSH port: SSH would be open to everyone", e.SSH.Puerto)
		}
		v4, v6, err := separar(e.SSH.Redes, "SSH")
		if err != nil {
			return c, err
		}
		c.ssh, c.ssh4, c.ssh6 = e.SSH.Puerto, v4, v6
	}
	if e.Salida.Restringida {
		c.salida = true
		if len(e.Salida.Destinos) > maxDestinos {
			return c, fmt.Errorf("too many outbound destinations (%d, at most %d)", len(e.Salida.Destinos), maxDestinos)
		}
		vistos := map[Destino]bool{}
		for _, d := range e.Salida.Destinos {
			a, err := netip.ParseAddr(strings.TrimSpace(d.IP))
			if err != nil || !puertoValido(d.Puerto) {
				return c, fmt.Errorf("invalid outbound destination %s:%d", d.IP, d.Puerto)
			}
			a = a.Unmap()
			if a.IsUnspecified() {
				return c, fmt.Errorf("invalid outbound destination %s", d.IP)
			}
			n := Destino{a.String(), d.Puerto}
			if vistos[n] {
				continue
			}
			vistos[n] = true
			if a.Is4() {
				c.destinos4 = append(c.destinos4, n)
			} else {
				c.destinos6 = append(c.destinos6, n)
			}
		}
		ordenar := func(l []Destino) {
			sort.Slice(l, func(i, j int) bool {
				ai, aj := netip.MustParseAddr(l[i].IP), netip.MustParseAddr(l[j].IP)
				if ai != aj {
					return ai.Less(aj)
				}
				return l[i].Puerto < l[j].Puerto
			})
		}
		ordenar(c.destinos4)
		ordenar(c.destinos6)
	}
	return c, nil
}

// ValidarEstricto dice si e se puede aplicar.
func ValidarEstricto(e Estricto) error {
	_, err := canonico(e)
	return err
}

// HuellaEstricto identifica las reglas que salen de e: dos estados que dan la misma
// tabla tienen la misma huella.
func HuellaEstricto(e Estricto) (string, error) {
	t, err := ReglasEstricto(e)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:]), nil
}

func conjunto(b *strings.Builder, nombre, tipo string, intervalo bool, elementos []string) {
	b.WriteString("\tset " + nombre + " {\n\t\ttype " + tipo + "\n")
	if intervalo {
		b.WriteString("\t\tflags interval\n")
	}
	if len(elementos) > 0 {
		b.WriteString("\t\telements = { " + strings.Join(elementos, ", ") + " }\n")
	}
	b.WriteString("\t}\n")
}

func textos(l []netip.Prefix) []string {
	r := make([]string, len(l))
	for i, p := range l {
		if p.Bits() == p.Addr().BitLen() {
			r[i] = p.Addr().String()
		} else {
			r[i] = p.String()
		}
	}
	return r
}

// Las interfaces de Docker para los servicios del nodo (red por defecto y redes de
// usuario). Las de las trampas se llaman sd-trampas*: nunca son de confianza.
var puentesNodo = []string{"docker0", "br-*"}

// ReglasEstricto es el guion de nft que deja la tabla como pide e, en una sola
// transacción: crea la tabla si no está (para poder borrarla), la borra y la vuelve
// a crear entera.
func ReglasEstricto(e Estricto) (string, error) {
	c, err := canonico(e)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	t := "inet " + TablaEstricta
	b.WriteString("# Sugardaddy: strict host firewall (docs/diseno/cortafuegos-anfitrion.md). Generated: do not edit.\n")
	b.WriteString("table " + t + "\ndelete table " + t + "\ntable " + t + " {\n")

	conjunto(&b, "consola4", "ipv4_addr", true, textos(c.consola4))
	conjunto(&b, "consola6", "ipv6_addr", true, textos(c.consola6))
	conjunto(&b, "ssh4", "ipv4_addr", true, textos(c.ssh4))
	conjunto(&b, "ssh6", "ipv6_addr", true, textos(c.ssh6))
	var pub []string
	for _, p := range c.publicados {
		pub = append(pub, p.Proto+" . "+strconv.Itoa(p.Puerto))
	}
	conjunto(&b, "publicados", "inet_proto . inet_service", false, pub)
	if c.salida {
		var d4, d6 []string
		for _, d := range c.destinos4 {
			d4 = append(d4, d.IP+" . "+strconv.Itoa(d.Puerto))
		}
		for _, d := range c.destinos6 {
			d6 = append(d6, d.IP+" . "+strconv.Itoa(d.Puerto))
		}
		conjunto(&b, "salida4", "ipv4_addr . inet_service", false, d4)
		conjunto(&b, "salida6", "ipv6_addr . inet_service", false, d6)
	}
	puerto := strconv.Itoa(c.consola)

	// Entrada: lo que va a la propia máquina.
	b.WriteString("\n\tchain entrada {\n\t\ttype filter hook input priority filter; policy drop;\n")
	b.WriteString("\t\tiif \"lo\" accept\n")
	b.WriteString("\t\tct state established,related accept\n")
	b.WriteString("\t\tct state invalid drop\n")
	b.WriteString("\t\t# SEN-5: a taken decoy cannot reach the machine through its bridge gateway.\n")
	b.WriteString("\t\tiifname \"" + PrefijoPuenteTrampas + "*\" drop\n")
	b.WriteString("\t\tmeta l4proto icmp icmp type { destination-unreachable, time-exceeded, parameter-problem } accept\n")
	b.WriteString("\t\tmeta l4proto icmp icmp type echo-request limit rate 10/second accept\n")
	b.WriteString("\t\tmeta l4proto ipv6-icmp icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept\n")
	b.WriteString("\t\tmeta l4proto ipv6-icmp icmpv6 type echo-request limit rate 10/second accept\n")
	b.WriteString("\t\tudp sport 67 udp dport 68 accept\n")
	b.WriteString("\t\tudp sport 547 udp dport 546 accept\n")
	b.WriteString("\t\t# The node's own containers reach its published ports (Docker's proxy, same bridge).\n")
	for _, p := range puentesNodo {
		b.WriteString("\t\tiifname \"" + p + "\" tcp dport " + puerto + " accept\n")
		b.WriteString("\t\tiifname \"" + p + "\" meta l4proto . th dport @publicados accept\n")
	}
	if c.abierta {
		b.WriteString("\t\ttcp dport " + puerto + " accept\n")
	} else {
		b.WriteString("\t\ttcp dport " + puerto + " ip saddr @consola4 accept\n")
		b.WriteString("\t\ttcp dport " + puerto + " ip6 saddr @consola6 accept\n")
	}
	b.WriteString("\t\tmeta l4proto . th dport @publicados accept\n")
	if c.ssh != 0 {
		s := strconv.Itoa(c.ssh)
		b.WriteString("\t\ttcp dport " + s + " ip saddr @ssh4 accept\n")
		b.WriteString("\t\ttcp dport " + s + " ip6 saddr @ssh6 accept\n")
	}
	b.WriteString("\t\t# The rest, as a closed port of any machine: a silent (filtered) port draws attention.\n")
	b.WriteString("\t\tmeta l4proto tcp reject with tcp reset\n")
	b.WriteString("\t\tmeta l4proto udp reject\n")
	b.WriteString("\t}\n")

	// Reenvío: lo que Docker lleva a sus contenedores (puertos publicados) y lo que sale de ellos.
	b.WriteString("\n\tchain adelante {\n\t\ttype filter hook forward priority filter; policy accept;\n")
	b.WriteString("\t\tct state established,related accept\n")
	b.WriteString("\t\tct state invalid drop\n")
	dnatConsola := "ct status dnat meta l4proto tcp ct original proto-dst " + puerto
	if c.abierta {
		b.WriteString("\t\t" + dnatConsola + " accept\n")
	} else {
		for _, p := range puentesNodo {
			b.WriteString("\t\tiifname \"" + p + "\" " + dnatConsola + " accept\n")
		}
		b.WriteString("\t\t" + dnatConsola + " ip saddr @consola4 accept\n")
		b.WriteString("\t\t" + dnatConsola + " ip6 saddr @consola6 accept\n")
		b.WriteString("\t\t" + dnatConsola + " reject with tcp reset\n")
	}
	b.WriteString("\t\tct status dnat meta l4proto . ct original proto-dst @publicados accept\n")
	b.WriteString("\t\t# A published port that is not the node's: nobody reaches it.\n")
	b.WriteString("\t\tct state new ct status dnat meta l4proto tcp reject with tcp reset\n")
	b.WriteString("\t\tct state new ct status dnat drop\n")
	if c.salida {
		b.WriteString("\t\t# Restricted outbound: only to the list (plus DNS and NTP).\n")
		escribirSalida(&b, "oifname")
	}
	b.WriteString("\t}\n")

	if c.salida {
		b.WriteString("\n\tchain salida {\n\t\ttype filter hook output priority filter; policy accept;\n")
		b.WriteString("\t\toif \"lo\" accept\n")
		b.WriteString("\t\tct state established,related accept\n")
		b.WriteString("\t\tmeta l4proto { icmp, ipv6-icmp } accept\n")
		b.WriteString("\t\tudp dport { 67, 547 } accept\n")
		escribirSalida(&b, "oifname")
		b.WriteString("\t}\n")
	}
	b.WriteString("}\n")
	return b.String(), nil
}

func escribirSalida(b *strings.Builder, oif string) {
	for _, p := range append(append([]string{}, puentesNodo...), PrefijoPuenteTrampas+"*") {
		b.WriteString("\t\tct state new " + oif + " \"" + p + "\" accept\n")
	}
	b.WriteString("\t\tct state new meta l4proto { tcp, udp } th dport 53 accept\n")
	b.WriteString("\t\tct state new udp dport 123 accept\n")
	b.WriteString("\t\tct state new ip daddr . tcp dport @salida4 accept\n")
	b.WriteString("\t\tct state new ip6 daddr . tcp dport @salida6 accept\n")
	b.WriteString("\t\tct state new meta l4proto tcp reject with tcp reset\n")
	b.WriteString("\t\tct state new reject with icmpx type admin-prohibited\n")
}

// QuitarReglas es el guion que deja la máquina sin la tabla (exista o no).
func QuitarReglas() string {
	t := "inet " + TablaEstricta
	return "table " + t + "\ndelete table " + t + "\n"
}

// Conflictos dice qué otro cortafuegos que deniega por defecto está activo en la
// máquina: UFW (sus saltos desde INPUT, con iptables-nft o legacy) o firewalld (su
// tabla de nftables o sus cadenas de iptables).
func Conflictos(ctx context.Context, ej Ejecutor) []string {
	var r []string
	if s, err := ej(ctx, "", "nft", "list", "tables"); err == nil {
		for _, l := range strings.Split(s, "\n") {
			if strings.TrimSpace(l) == "table inet firewalld" {
				r = append(r, "firewalld")
				break
			}
		}
	}
	ufw := false
	fwd := false
	for _, m := range []string{"nft", "legacy"} {
		s, err := ej(ctx, "", "iptables-"+m, "-w", "-t", "filter", "-S", "INPUT")
		if err != nil {
			continue
		}
		if strings.Contains(s, "-j ufw-") {
			ufw = true
		}
		if strings.Contains(s, "-j INPUT_direct") || strings.Contains(s, "-j IN_public") {
			fwd = true
		}
	}
	if ufw {
		r = append(r, "UFW")
	}
	if fwd && !contiene(r, "firewalld") {
		r = append(r, "firewalld")
	}
	return r
}

func contiene(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// ResultadoEstricto es lo que dice el auxiliar.
type ResultadoEstricto struct {
	Estado  string `json:"estado"`
	Detalle string `json:"detalle"`
	Huella  string `json:"huella,omitempty"`
}

// Confirmador dice si alguien ha confirmado la huella aplicada. El auxiliar lo
// pregunta cada segundo durante el plazo.
type Confirmador func(huella string) bool

// tablaActual devuelve la tabla propia tal cual está («» si no está).
func tablaActual(ctx context.Context, ej Ejecutor) (string, bool) {
	s, err := ej(ctx, "", "nft", "list", "table", "inet", TablaEstricta)
	if err != nil {
		return "", false
	}
	return s, true
}

var lineaHuella = regexp.MustCompile(`comment "sd:([0-9a-f]{64})"`)

// AplicarEstricto deja la tabla como pide e. Si la tabla en marcha ya es la de esa
// huella, no hace nada. Si no, la cambia de golpe y espera hasta plazo a que
// confirmar diga que sí; si no lo dice, vuelve a la tabla de antes (o a ninguna).
func AplicarEstricto(ctx context.Context, e Estricto, ej Ejecutor, confirmar Confirmador, plazo time.Duration) ResultadoEstricto {
	guion, err := ReglasEstricto(e)
	if err != nil {
		return ResultadoEstricto{ConError, err.Error(), ""}
	}
	h := sha256.Sum256([]byte(guion))
	huella := hex.EncodeToString(h[:])
	if _, err := ej(ctx, "", "nft", "--version"); err != nil {
		return ResultadoEstricto{EstrictoSinNft, "nftables is not available on this machine: " + err.Error(), huella}
	}
	if cs := Conflictos(ctx, ej); len(cs) > 0 {
		return ResultadoEstricto{EstrictoConflicto, strings.Join(cs, " and ") + " active on this machine: the strict host firewall is not applied (turn it off there, or keep using it and leave this setting off)", huella}
	}
	antes, habia := tablaActual(ctx, ej)
	if habia {
		if m := lineaHuella.FindStringSubmatch(antes); m != nil && m[1] == huella {
			return ResultadoEstricto{EstrictoAplicado, "already in place", huella}
		}
	}
	// La huella va como comentario de la primera regla: así se sabe qué hay puesto
	// sin comparar textos (nft list no devuelve el guion tal cual). En una regla y no
	// en la tabla: los comentarios de tabla piden un núcleo 5.10 o posterior.
	conHuella := strings.Replace(guion, "\t\tiif \"lo\" accept\n", "\t\tiif \"lo\" accept comment \"sd:"+huella+"\"\n", 1)
	if _, err := ej(ctx, conHuella, "nft", "-f", "-"); err != nil {
		return ResultadoEstricto{ConError, "nft: " + err.Error(), huella}
	}
	if confirmar != nil {
		hasta := time.Now().Add(plazo)
		for !confirmar(huella) {
			if time.Now().After(hasta) || ctx.Err() != nil {
				return volver(context.WithoutCancel(ctx), ej, antes, habia, huella, plazo)
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
		}
	}
	return ResultadoEstricto{EstrictoAplicado, fmt.Sprintf("%d published ports, console %s", len(e.Publicados), describirConsola(e)), huella}
}

func describirConsola(e Estricto) string {
	if e.Consola.Abierta {
		return "open to everyone"
	}
	return fmt.Sprintf("limited to %d networks", len(e.Consola.Redes))
}

// volver deja la tabla de antes (o ninguna). Lo de antes se vuelve a cargar tal
// cual lo listó nft, que es un guion válido.
func volver(ctx context.Context, ej Ejecutor, antes string, habia bool, huella string, plazo time.Duration) ResultadoEstricto {
	guion := QuitarReglas()
	if habia {
		guion += antes
	}
	if _, err := ej(ctx, guion, "nft", "-f", "-"); err != nil {
		// Último recurso: sin tabla, la máquina queda como sin el modo estricto.
		_, _ = ej(ctx, QuitarReglas(), "nft", "-f", "-")
		return ResultadoEstricto{EstrictoRevertido, fmt.Sprintf("not confirmed within %s; the previous rules could not be restored (%v), so the strict firewall was removed", plazo, err), huella}
	}
	return ResultadoEstricto{EstrictoRevertido, fmt.Sprintf("the node did not confirm it could still reach its console within %s: back to the previous rules", plazo), huella}
}

// QuitarEstricto deja la máquina sin la tabla.
func QuitarEstricto(ctx context.Context, ej Ejecutor) ResultadoEstricto {
	if _, err := ej(ctx, "", "nft", "--version"); err != nil {
		return ResultadoEstricto{EstrictoQuitado, "nftables is not available: nothing to remove", ""}
	}
	if _, habia := tablaActual(ctx, ej); !habia {
		return ResultadoEstricto{EstrictoQuitado, "not in place", ""}
	}
	if _, err := ej(ctx, QuitarReglas(), "nft", "-f", "-"); err != nil {
		return ResultadoEstricto{ConError, "nft: " + err.Error(), ""}
	}
	return ResultadoEstricto{EstrictoQuitado, "removed", ""}
}

// LeerEstricto saca el estado del JSON que recibe el auxiliar.
func LeerEstricto(texto string) (Estricto, error) {
	var e Estricto
	d := json.NewDecoder(strings.NewReader(texto))
	d.DisallowUnknownFields()
	if err := d.Decode(&e); err != nil {
		return e, fmt.Errorf("malformed strict firewall state: %w", err)
	}
	return e, ValidarEstricto(e)
}
