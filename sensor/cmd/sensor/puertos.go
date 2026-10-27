package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
)

// Cada cuánto se miden los puertos de la máquina: cambian cuando el cliente
// arranca o para un servicio. Si una trampa no ha podido atar su puerto, se
// vuelve a medir antes (cadaAnfitrionAtascado), para publicarla en la IP de
// red en la siguiente vuelta si lo que estorba es local.
const (
	cadaAnfitrion         = 2 * time.Minute
	cadaAnfitrionAtascado = 30 * time.Second
)

// puertosAnfitrion es la orden de la sonda (ver motor.SondaAnfitrion): corre
// en la red del anfitrión, lee lo que escucha de /proc/net y las direcciones
// de sus interfaces, y lo escribe en JSON.
func puertosAnfitrion() int {
	a := motor.Anfitrion{Escuchas: []motor.Escucha{}}
	for _, t := range []struct{ fichero, proto string }{
		{"tcp", "tcp"}, {"tcp6", "tcp"}, {"udp", "udp"}, {"udp6", "udp"},
	} {
		f, err := os.Open("/proc/net/" + t.fichero)
		if err != nil {
			continue // una máquina sin IPv6 no tiene tcp6 ni udp6
		}
		a.Escuchas = append(a.Escuchas, motor.LeerEscuchas(t.proto, f)...)
		f.Close()
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	a.Direcciones = motor.DireccionesDeRed(interfaces, func(i net.Interface) ([]net.Addr, error) { return i.Addrs() })
	if err := json.NewEncoder(os.Stdout).Encode(a); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// sondearAnfitrion mide los puertos y las direcciones de la máquina, con los
// que publican las trampas de este sensor para no contarlos como ocupados.
// Sin la imagen del sensor no hay sonda, y lo que no se mide no se informa.
func (s *sensor) sondearAnfitrion(ctx context.Context, id string, estados []despliegue.Estado) {
	espera := cadaAnfitrion
	if puertoAtascado(estados) {
		espera = cadaAnfitrionAtascado
	}
	if s.opc.ImagenSonda == "" || id == "" || s.motor.Codigo != "" || time.Since(s.anfitrion.intento) < espera {
		return
	}
	s.anfitrion.intento = time.Now()
	a, err := motor.SondaAnfitrion(ctx, s.docker, s.opc.ImagenSonda, id)
	if err != nil {
		slog.Warn("no se pudieron medir los puertos de la máquina", "err", err)
		return
	}
	propios, err := despliegue.PuertosPropios(ctx, s.docker, id)
	if err != nil {
		slog.Warn("no se pudieron leer los puertos de las trampas", "err", err)
		return
	}
	s.anfitrion.a, s.anfitrion.propios = a, propios
}

// puertoAtascado dice si alguna trampa no ha podido atar su puerto en la
// máquina (Docker: «address already in use» o «port is already allocated»).
func puertoAtascado(estados []despliegue.Estado) bool {
	for _, e := range estados {
		if strings.Contains(e.Donde, "address already in use") || strings.Contains(e.Donde, "port is already allocated") {
			return true
		}
	}
	return false
}
