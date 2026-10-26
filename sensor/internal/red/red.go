// Package red es la sección red del sensor (docs/diseno/red.md): el modo
// «IP propia», que pone a una trampa con su propia dirección en el segmento
// del cliente en vez de en el puente aislado con NAT.
//
// Aquí vive lo que el sensor aporta y una trampa nunca decide por sí misma:
//
//   - CompilarBPF: el filtro BPF clásico que acota lo que una trampa con
//     NET_RAW puede leer del enlace, compilado de los rangos de su bloque
//     red (solo el ARP y el tráfico IPv4 dirigido a esos rangos pasa);
//   - Capa2: el hecho red.capa2 (si la máquina puede dar IP propia: por
//     cable o VLAN; el Wi-Fi y la nube informan false con su motivo);
//   - sondeo ARP previo (RFC 5227) para no pisar a nadie con la IP propia, y
//     el vigilante que la suelta si otro equipo la reclama.
//
// El sensor concede NET_RAW SOLO cuando hay rangos que capturar y el BPF
// está enganchado; NUNCA concede NET_ADMIN a una trampa (docs/diseno/red.md,
// por qué es seguro).
//
// Sin dependencias: el BPF clásico se ensambla a mano (las constantes de
// linux/filter.h), y se prueba con la máquina virtual de red_test.go.
package red

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/netip"
	"strings"
)

// Instrucción del BPF clásico, tal cual la espera el kernel y tal cual se
// serializa en SD_RED_BPF: código (clase+tamaño+modo), los dos saltos y la
// palabra K (linux/filter.h).
type instruccion struct {
	Codigo uint16
	Jt     uint8
	Jf     uint8
	K      uint32
}

// Clases y modos del BPF clásico que aquí se usan (linux/filter.h).
const (
	cargarMitad = 0x28 // BPF_LD  | BPF_H | BPF_ABS: cargar 2 bytes del paquete
	cargarPal   = 0x20 // BPF_LD  | BPF_W | BPF_ABS: cargar 4 bytes del paquete
	saltoIgual  = 0x15 // BPF_JMP | BPF_JEQ | BPF_K: saltar si A == K
	yLogico     = 0x54 // BPF_ALU | BPF_AND | BPF_K: A = A & K
	devolver    = 0x06 // BPF_RET | BPF_K: devolver K (cuántos bytes pasan)
)

// Desplazamientos dentro de la trama Ethernet DIX (RFC 894) que el filtro
// mira. Sin etiquetas 802.1Q: el modo «IP propia» es para el segmento de
// acceso del cliente (el puerto de acceso del conmutador, sin etiquetar).
const (
	desplazTipo    = 12 // ethertype (2 bytes)
	desplazDestino = 30 // dirección IPv4 de destino (14 de cabecera + 16)
)

// ethertype ARP e IPv4 (RFC 894).
const (
	tipoARP  = 0x0806
	tipoIPv4 = 0x0800
)

// Tope de rangos que un filtro puede traer: cada uno cuesta 2 instrucciones
// y el kernel no admite más de 512 en total; 32 sobran de sobra para un
// rango de IP propias y sus rangos oscuros.
const maxRangosBPF = 32

// Rangos analiza la lista de CIDR IPv4 separados por comas (el red.capturar
// del manifiesto, ya sustituido con los parámetros de la instalación): los
// ordena y rechaza lo que no sean CIDR IPv4 decentes. Un rango mayor que
// /8 no se acepta: capturar casi todo Internet no es acotar nada.
func Rangos(lista string) ([]netip.Prefix, error) {
	if strings.TrimSpace(lista) == "" {
		return nil, fmt.Errorf("capturar viene vacío: sin rangos que capturar no hay NET_RAW")
	}
	var rangos []netip.Prefix
	for _, trozo := range strings.Split(lista, ",") {
		trozo = strings.TrimSpace(trozo)
		if trozo == "" {
			return nil, fmt.Errorf("capturar trae una coma de más: cada hueco entre comas es un CIDR IPv4")
		}
		p, err := netip.ParsePrefix(trozo)
		if err != nil || !p.Addr().Is4() {
			return nil, fmt.Errorf("capturar trae %q: tiene que ser CIDR IPv4 (p. ej. 10.20.0.0/24, separados por comas)", trozo)
		}
		if p.Addr().IsUnspecified() || p.Bits() == 0 {
			return nil, fmt.Errorf("capturar trae %s: capturar todas las direcciones no es acotar; pon solo el rango de la trampa", p.String())
		}
		if p.Bits() < 8 {
			return nil, fmt.Errorf("capturar trae %s: un rango mayor que un /8 no es acotar; pon solo el rango de la trampa", p.String())
		}
		rangos = append(rangos, p.Masked())
	}
	if len(rangos) == 0 {
		return nil, fmt.Errorf("capturar viene vacío: sin rangos que capturar no hay NET_RAW")
	}
	if len(rangos) > maxRangosBPF {
		return nil, fmt.Errorf("capturar trae %d rangos: el tope es %d", len(rangos), maxRangosBPF)
	}
	return rangos, nil
}

// CompilarBPF ensambla el filtro clásico que deja pasar SOLO el ARP y el
// tráfico IPv4 cuya dirección de destino está en los rangos, y lo devuelve
// serializado en base64 tal como lo espera SD_RED_BPF (instrucciones de 8
// bytes en little endian: código, jt, jf, k; lo decodifica la trampa, ver
// modulos/trampas/darknet/imagen/fuente/enlace.go).
//
// El filtro lo compila el SENSOR desde el manifiesto, no la trampa: la
// trampa no decide qué oye. Que venga en el entorno (y no dentro de la
// imagen) hace que cambiar los rangos rehaga la trampa con su huella.
//
//	[0] cargar el ethertype
//	[1] si es ARP, ACCEPT (la charla ARP del segmento hacia los rangos)
//	[2] si no es IPv4, REJECT (IPv6 y demás, fuera)
//	[3] cargar la dirección de destino
//	[4…] por cada rango: A&=máscara; si A==red, ACCEPT; si no, el siguiente
//	[·] ACCEPT: devolver 0xFFFFFFFF (la trama entera)
//	[·] REJECT: devolver 0 (nada: el kernel la tira antes del enchufe)
func CompilarBPF(lista string) (string, error) {
	rangos, err := Rangos(lista)
	if err != nil {
		return "", err
	}
	n := len(rangos)
	aceptar, rechazar := 4+2*n, 5+2*n
	ins := make([]instruccion, 0, 6+2*n)
	ins = append(ins,
		instruccion{Codigo: cargarMitad, K: desplazTipo},
		// ARP pasa entero: hace falta para que la trampa responda como un
		// equipo vivo a las preguntas por las IP de sus rangos.
		instruccion{Codigo: saltoIgual, Jt: uint8(aceptar - 2), K: tipoARP},
		instruccion{Codigo: saltoIgual, Jt: 0, Jf: uint8(rechazar - 3), K: tipoIPv4},
		instruccion{Codigo: cargarPal, K: desplazDestino},
	)
	for i, p := range rangos {
		// La dirección viaja en orden de red: se compara como palabra, no
		// byte a byte, y la máscara recorta la parte de red.
		mascara := uint32(0xFFFFFFFF) << (32 - p.Bits())
		ins = append(ins,
			instruccion{Codigo: yLogico, K: mascara},
			// el último rango que no coincide cae en REJECT, no en el vecino.
			instruccion{Codigo: saltoIgual, Jt: uint8(aceptar - 6 - 2*i), Jf: saltoSiguiente(i, n), K: binaria(p.Addr())},
		)
	}
	ins = append(ins,
		instruccion{Codigo: devolver, K: 0xFFFFFFFF},
		instruccion{Codigo: devolver, K: 0},
	)
	if len(ins) > 512 {
		return "", fmt.Errorf("el filtro trae %d instrucciones: el tope del kernel es 512", len(ins))
	}
	bruto := make([]byte, 8*len(ins))
	for i, in := range ins {
		b := bruto[i*8:]
		binary.LittleEndian.PutUint16(b, in.Codigo)
		b[2], b[3] = in.Jt, in.Jf
		binary.LittleEndian.PutUint32(b[4:], in.K)
	}
	return base64.StdEncoding.EncodeToString(bruto), nil
}

// saltoSiguiente: el salto del «no es de este rango» — al siguiente rango, o
// a REJECT si este era el último.
func saltoSiguiente(i, n int) uint8 {
	if i == n-1 {
		return 1 // cae en la instrucción siguiente: REJECT
	}
	return 0 // cae en la instrucción siguiente: el siguiente rango
}

// binaria: la palabra de 4 bytes de una IPv4 en orden de red, tal como la
// carga el BPF del paquete.
func binaria(ip netip.Addr) uint32 {
	b := ip.As4()
	return binary.BigEndian.Uint32(b[:])
}
