// Package motor describe el motor de contenedores de la máquina del sensor
// (qué es, cómo corre y qué permite) para que la consola lo vea, y decide si
// la IP que ve una trampa es la del atacante o la del propio motor.
//
// Nada de esto supone una máquina concreta: se lee lo que el motor dice de sí
// mismo (GET /version y GET /info) y de sus redes, y lo que va llegando a las
// trampas.
package motor

import (
	"context"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Modos en que corre el motor. Lo que no se reconoce cuenta como rootful.
const (
	ModoRootful  = "rootful"
	ModoRootless = "rootless"
	// Docker Desktop: el motor está en una máquina virtual y reenvía los
	// puertos con su propia dirección.
	ModoDesktop = "desktop"
	// Docker instalado dentro de WSL2.
	ModoWSL = "wsl"
)

// Descripcion es lo que el sensor cuenta a la consola de su motor.
type Descripcion struct {
	Tipo    string `json:"tipo,omitempty"` // docker, podman u otro
	Modo    string `json:"modo,omitempty"`
	Version string `json:"version,omitempty"`
	// API: la versión con la que habla el sensor; APIMotor y APIMinima, el
	// tramo que admite el motor.
	API         string `json:"api,omitempty"`
	APIMotor    string `json:"apiMotor,omitempty"`
	APIMinima   string `json:"apiMinima,omitempty"`
	SinGarantia bool   `json:"sinGarantia,omitempty"`
	// SO y Arquitectura los dice el motor (p. ej. linux y arm64), no uname.
	SO             string   `json:"so,omitempty"`
	Arquitectura   string   `json:"arquitectura,omitempty"`
	Kernel         string   `json:"kernel,omitempty"`
	Sistema        string   `json:"sistema,omitempty"`
	Cgroups        string   `json:"cgroups,omitempty"`
	CgroupDriver   string   `json:"cgroupDriver,omitempty"`
	Seguridad      []string `json:"seguridad,omitempty"`
	Memoria        int64    `json:"memoria,omitempty"`
	CPUs           int      `json:"cpus,omitempty"`
	Almacenamiento string   `json:"almacenamiento,omitempty"`
	// Pasarelas: las direcciones del motor en las redes de trampas.
	Pasarelas []string `json:"pasarelas,omitempty"`
	// PuertaEnlace: con WSL2, la puerta de enlace de su máquina virtual,
	// medida con una sonda en la red del anfitrión. Con la red en NAT (lo
	// normal) es el propio Windows, que reenvía con esa dirección todo lo
	// que llega de fuera. Vacía mientras no se ha medido.
	PuertaEnlace string `json:"puertaEnlace,omitempty"`
	// Fallo general del motor: código estable (motor.*) y texto para el cliente.
	Codigo string `json:"codigo,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Fallo describe un motor con el que no se puede trabajar.
func Fallo(e *docker.ErrMotor) Descripcion {
	return Descripcion{Codigo: e.Codigo, Error: e.Texto}
}

// Describir pregunta al motor qué es y cómo corre. Si no contesta, la
// descripción lleva el fallo con su código.
func Describir(ctx context.Context, d *docker.Cliente, redes []string) Descripcion {
	n, err := d.Negociar(ctx)
	if err != nil {
		return Fallo(d.Clasificar(err))
	}
	m := n.Motor
	r := Descripcion{
		Tipo: tipoDe(m), Version: m.Version,
		API: n.API, APIMotor: m.APIVersion, APIMinima: m.MinAPIVersion, SinGarantia: n.SinGarantia,
		SO: m.Os, Arquitectura: m.Arch, Kernel: m.KernelVersion,
	}
	// Sin /info se sigue con lo que dijo /version: no es un fallo del motor.
	info, _ := d.Info(ctx)
	r.Modo = modoDe(m, info)
	r.Sistema, r.Cgroups, r.CgroupDriver = info.OperatingSystem, info.CgroupVersion, info.CgroupDriver
	r.Seguridad, r.Memoria, r.CPUs, r.Almacenamiento = info.SecurityOptions, info.MemTotal, info.NCPU, info.Driver
	if r.Kernel == "" {
		r.Kernel = info.KernelVersion
	}
	r.Pasarelas = Pasarelas(ctx, d, redes)
	return r
}

// Pasarelas son las direcciones del motor en esas redes (las que no existen
// todavía no cuentan).
func Pasarelas(ctx context.Context, d *docker.Cliente, redes []string) []string {
	var p []string
	for _, nombre := range redes {
		if r, err := d.InspeccionarRed(ctx, nombre); err == nil {
			p = append(p, r.Pasarelas()...)
		}
	}
	return p
}

func tipoDe(m docker.Motor) string {
	if m.Podman() {
		return "podman"
	}
	if strings.Contains(strings.ToLower(m.Platform.Name), "docker") {
		return "docker"
	}
	for _, c := range m.Components {
		if c.Name == "Engine" {
			return "docker"
		}
	}
	return "otro"
}

func modoDe(m docker.Motor, i docker.Info) string {
	switch {
	case strings.Contains(i.OperatingSystem, "Docker Desktop") || strings.Contains(m.Platform.Name, "Docker Desktop") ||
		slices.ContainsFunc(i.Labels, func(l string) bool { return strings.HasPrefix(l, "com.docker.desktop.") }):
		return ModoDesktop
	case strings.Contains(strings.ToLower(m.KernelVersion+" "+i.KernelVersion), "microsoft"):
		return ModoWSL
	case slices.ContainsFunc(i.SecurityOptions, func(o string) bool { return strings.Contains(o, "name=rootless") }):
		return ModoRootless
	}
	return ModoRootful
}

// Oculta dice si la IP que ha visto una trampa es la del propio motor y no
// la de quien la ha tocado: una pasarela de las redes de trampas (el motor
// reenvía el puerto con su proxy: sin iptables, reglas borradas, rootless o
// una conexión desde la propia máquina), una dirección local, cualquiera
// con Docker Desktop, que nunca deja ver el origen, y con WSL2 la de su
// puerta de enlace (Windows, si la red está en NAT) o, mientras no se ha
// medido, cualquiera.
func (d Descripcion) Oculta(ip string) bool {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	a = a.Unmap()
	if d.Modo == ModoDesktop || (d.Modo == ModoWSL && d.PuertaEnlace == "") || a.IsLoopback() || a.IsUnspecified() {
		return true
	}
	direcciones := d.Pasarelas
	if d.Modo == ModoWSL {
		direcciones = append(slices.Clip(direcciones), d.PuertaEnlace)
	}
	for _, p := range direcciones {
		if b, err := netip.ParseAddr(p); err == nil && b.Unmap() == a {
			return true
		}
	}
	return false
}

// Motivos (códigos estables) del hecho red.ipOrigenReal.
const (
	// Ha llegado a las trampas una IP que no es del motor.
	OrigenReal = "origen.real"
	// Llegan la IP de la pasarela o una local, y ninguna real en la ventana.
	OrigenPasarela = "origen.pasarela"
	// Docker Desktop reenvía los puertos con su propia dirección.
	OrigenDesktop = "origen.desktop"
	// En WSL2 con la red en NAT (lo normal), las trampas ven la IP de Windows,
	// y aún no ha llegado nada que diga lo contrario (con la red en modo
	// espejo llegan las IPs reales).
	OrigenWSL = "origen.wsl"
	// Docker o Podman sin root: su reenvío de puertos más habitual no deja
	// ver el origen, y aún no ha llegado nada que diga lo contrario.
	OrigenRootless = "origen.rootless"
)

// VentanaOrigen: una IP real cuenta para red.ipOrigenReal hasta que llega una
// del motor más de este tiempo después. Así, una conexión desde la propia
// máquina (una prueba, un chequeo de puertos) o por IPv6, que también llega
// con la IP del motor, no apaga el hecho en un sensor que sí ve el origen; y
// unas reglas del cortafuegos borradas se notan en cuanto pasa la ventana
// sin ninguna IP real. Es larga porque una trampa interna puede pasar días
// sin que la toque nadie de fuera; mientras tanto, cada evento con la IP del
// motor ya va marcado uno a uno.
const VentanaOrigen = 7 * 24 * time.Hour

// Hecho es algo que el sensor sabe de su máquina (red.ipOrigenReal,
// motor.clone3…), con el código estable (fase.causa) de por qué lo sabe.
type Hecho struct {
	Valor  bool   `json:"valor"`
	Motivo string `json:"motivo"`
}

// HechoOrigen decide red.ipOrigenReal (si las trampas ven la IP real de
// quien las toca) con el modo del motor y, si el modo no lo dice todo, con
// lo que ha llegado a las trampas: es verdadero si la última IP real llegó
// como mucho VentanaOrigen antes que la última del motor (o después), y
// falso si llegan IPs del motor y ninguna real en esa ventana. Solo cuentan
// las horas de los eventos, no el reloj del sensor: que pase el tiempo sin
// que llegue nada no cambia el hecho. nil: aún no se sabe.
//
// Con WSL2 se decide igual (con la red en modo espejo las trampas sí ven el
// origen), pero mientras no se ha medido su puerta de enlace toda IP cuenta
// como del motor, igual que en Oculta: el hecho y la marca de cada evento
// siguen la misma regla.
func HechoOrigen(d Descripcion, ultimoReal, ultimoOculto time.Time) *Hecho {
	switch {
	case d.Modo == ModoDesktop:
		return &Hecho{false, OrigenDesktop}
	case d.Modo == ModoWSL && d.PuertaEnlace == "":
		return &Hecho{false, OrigenWSL}
	}
	switch {
	case !ultimoReal.IsZero() && (ultimoOculto.IsZero() || !ultimoReal.Before(ultimoOculto.Add(-VentanaOrigen))):
		return &Hecho{true, OrigenReal}
	case d.Modo == ModoWSL:
		return &Hecho{false, OrigenWSL}
	case !ultimoOculto.IsZero():
		return &Hecho{false, OrigenPasarela}
	case d.Modo == ModoRootless:
		return &Hecho{false, OrigenRootless}
	}
	return nil
}
