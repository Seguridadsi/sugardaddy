package cortafuegos

// SEN-5 (docs/seguridad/2026-11-08/sensor.md; docs/diseno/aislamiento-trampas.md §4b):
// una trampa tomada no puede llegar a los servicios de la máquina (su SSH, la consola,
// lo que escuche en 0.0.0.0) por la pasarela de su puente.
//
// Lo que va de un contenedor a la propia máquina no pasa por FORWARD ni, por tanto,
// por DOCKER-USER: entra por INPUT. Los puentes de las trampas tienen nombre fijo
// (sd-trampas0, sd-trampas1: com.docker.network.bridge.name), así que en INPUT un
// salto «-i sd-trampas+» a la cadena propia SD-TRAMPAS deja pasar solo las
// respuestas (ESTABLISHED,RELATED) y tira el resto. No hace falta nada más: el DNS
// de Docker lo atiende dentro del propio contenedor (127.0.0.11) y no hay DHCP. Los
// puertos publicados de las trampas tampoco pasan por aquí (van por FORWARD).
//
// gateway_mode_ipv4=isolated (Docker ≥ 28) no sirve aquí: Docker solo lo admite en
// redes internas, que no publican puertos (comprobado con Docker 29).

import (
	"context"
	"strings"
)

// CadenaTrampas es la cadena propia de SEN-5, en IPv4 y, si la hay, en IPv6.
const CadenaTrampas = "SD-TRAMPAS"

// PrefijoPuenteTrampas: los puentes de las redes de trampas se llaman así más un número.
const PrefijoPuenteTrampas = "sd-trampas"

// RestoreTrampas rehace SD-TRAMPAS de golpe.
func RestoreTrampas() string {
	return "*filter\n:" + CadenaTrampas + " - [0:0]\n" +
		"-A " + CadenaTrampas + " -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN\n" +
		"-A " + CadenaTrampas + " -j DROP\nCOMMIT\n"
}

// SaltoTrampas es la regla de INPUT: lo que entra por un puente de trampas.
func SaltoTrampas() []string {
	return []string{"-i", PrefijoPuenteTrampas + "+", "-j", CadenaTrampas}
}

// motorEntrada: el motor en el que poner la regla de INPUT. El de Docker si lo usa;
// si no (Docker con su motor nftables propio), el primero que tenga INPUT. Una regla
// DROP en cualquier tabla con el gancho de entrada basta para tirar el paquete.
func motorEntrada(ctx context.Context, ej Ejecutor) (string, bool) {
	if m, ok := motorDocker(ctx, ej); ok {
		return m, true
	}
	for _, m := range []string{"nft", "legacy"} {
		if _, err := ej(ctx, "", "iptables-"+m, "-w", "-t", "filter", "-S", "INPUT"); err == nil {
			return m, true
		}
	}
	return "", false
}

// AplicarTrampas deja la regla de SEN-5. Idempotente: con todo ya puesto, no cambia nada.
func AplicarTrampas(ctx context.Context, ej Ejecutor) Resultado {
	motor, ok := motorEntrada(ctx, ej)
	if !ok {
		return Resultado{ConError, "no iptables on this machine: decoys can reach the machine's services through their bridge gateway"}
	}
	f4, f6 := familias(motor)
	var detalle []string
	for _, f := range []familia{f4, f6} {
		if _, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-S", "INPUT"); err != nil {
			if !f.ipv6 {
				return Resultado{ConError, "IPv4: " + err.Error()}
			}
			continue // sin IPv6 en la máquina, no hay nada que proteger por ahí
		}
		if err := asegurarCadenaTrampas(ctx, ej, f); err != nil {
			if !f.ipv6 {
				return Resultado{ConError, "IPv4: " + err.Error()}
			}
			detalle = append(detalle, "IPv6: "+err.Error())
			continue
		}
		if err := saltoUnicoA(ctx, ej, f, "INPUT", CadenaTrampas, SaltoTrampas()); err != nil {
			if !f.ipv6 {
				return Resultado{ConError, "IPv4: " + err.Error()}
			}
			detalle = append(detalle, "IPv6: "+err.Error())
			continue
		}
		detalle = append(detalle, f.nombre()+" with "+f.tabla)
	}
	return Resultado{Aplicada, strings.Join(detalle, "; ")}
}

// asegurarCadenaTrampas rehace SD-TRAMPAS solo si no es la que toca: así un repaso
// no deja ni un instante la cadena vacía.
func asegurarCadenaTrampas(ctx context.Context, ej Ejecutor, f familia) error {
	if s, err := ej(ctx, "", f.tabla, "-w", "-t", "filter", "-S", CadenaTrampas); err == nil {
		var reglas []string
		for _, l := range strings.Split(s, "\n") {
			if l = strings.TrimSpace(l); strings.HasPrefix(l, "-A ") {
				reglas = append(reglas, l)
			}
		}
		if strings.Join(reglas, "\n") == strings.Join(reglasTrampas(), "\n") {
			return nil
		}
	}
	if _, err := ej(ctx, RestoreTrampas(), f.restore, "-w", "--noflush"); err != nil {
		return err
	}
	return nil
}

func reglasTrampas() []string {
	var r []string
	for _, l := range strings.Split(RestoreTrampas(), "\n") {
		if strings.HasPrefix(l, "-A ") {
			r = append(r, l)
		}
	}
	return r
}
