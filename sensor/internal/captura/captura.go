// Package captura es el acompañante de captura de una trampa de enlace
// (docs/diseno/aislamiento-trampas.md §3). Corre con la imagen del sensor, en el
// espacio de red de la trampa, con NET_RAW y nada más: abre el enchufe crudo,
// engancha y candada el BPF que el sensor compila de red.capturar y le pasa las
// tramas a la trampa por un enchufe Unix abstracto (SOCK_SEQPACKET: una trama por
// mensaje), que solo existe en ese espacio de red. Lo que la trampa devuelve solo
// sale al segmento si es suyo: con su MAC de origen, ARP o IPv4, de tamaño de
// trama. Así la trampa no tiene NET_RAW ni es root, y tomada no puede leer más de
// lo que el filtro deja ni inyectar tramas ajenas en la red del cliente.
package captura

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
)

// Enlace es el nombre del enchufe abstracto (despliegue.EnlaceAcompanante).
const Enlace = "@sugardaddy-enlace"

// Tope de instrucciones de un BPF clásico (BPF_MAXINSNS).
const maxInsBPF = 512

// Instruccion es una del BPF clásico (linux/filter.h).
type Instruccion struct {
	Codigo uint16
	Jt, Jf uint8
	K      uint32
}

// DecodificarBPF: el formato de SD_RED_BPF (base64 de instrucciones de 8 bytes).
func DecodificarBPF(v string) ([]Instruccion, error) {
	bruto, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, fmt.Errorf("the BPF is not base64: %w", err)
	}
	if len(bruto) == 0 || len(bruto)%8 != 0 || len(bruto)/8 > maxInsBPF {
		return nil, fmt.Errorf("the BPF is %d bytes long: it must be 1 to %d 8-byte instructions", len(bruto), maxInsBPF)
	}
	ins := make([]Instruccion, len(bruto)/8)
	for i := range ins {
		f := bruto[i*8:]
		ins[i] = Instruccion{binary.LittleEndian.Uint16(f), f[2], f[3], binary.LittleEndian.Uint32(f[4:])}
	}
	return ins, nil
}

// Tipos Ethernet que la trampa puede mandar.
const (
	tipoIPv4 = 0x0800
	tipoARP  = 0x0806
)

// TramaPermitida decide si una trama que manda la trampa sale al segmento: entre
// 42 y 1514 bytes (sin FCS), con la MAC de origen de la interfaz, IPv4 o ARP, y
// si es ARP, con esa misma MAC como emisora (nada de envenenar con otra).
func TramaPermitida(t []byte, mac net.HardwareAddr) error {
	if len(t) < 42 || len(t) > 1514 {
		return errors.New("frame size")
	}
	if len(mac) != 6 || string(t[6:12]) != string(mac) {
		return errors.New("source MAC is not the decoy's")
	}
	switch binary.BigEndian.Uint16(t[12:14]) {
	case tipoIPv4:
		return nil
	case tipoARP:
		// ARP sobre Ethernet/IPv4: emisor en 22:28.
		if binary.BigEndian.Uint16(t[14:16]) != 1 || binary.BigEndian.Uint16(t[16:18]) != tipoIPv4 || string(t[22:28]) != string(mac) {
			return errors.New("ARP sender is not the decoy's")
		}
		return nil
	}
	return errors.New("only IPv4 and ARP")
}

// interfazDeLaTrampa: la primera interfaz levantada que no es loopback, la que
// Docker da a la trampa en su espacio de red.
func interfazDeLaTrampa() (*net.Interface, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback == 0 && i.Flags&net.FlagUp != 0 && len(i.HardwareAddr) == 6 {
			return &i, nil
		}
	}
	return nil, errors.New("the decoy has no network interface")
}
