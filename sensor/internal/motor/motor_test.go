package motor

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
)

// motorCon levanta un motor falso que contesta /info con info y tiene la red
// de trampas «trampas» con la pasarela 172.19.0.1.
func motorCon(t *testing.T, m motorfalso.Motor, info map[string]any) *docker.Cliente {
	t.Helper()
	base, err := os.MkdirTemp("", "mt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: motorfalso.Envolver(m, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/info":
			_ = json.NewEncoder(w).Encode(info)
		case "/networks/trampas":
			_, _ = w.Write([]byte(`{"Options":{},"Containers":{},"IPAM":{"Config":[{"Subnet":"172.19.0.0/16","Gateway":"172.19.0.1"}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"no existe"}`))
		}
	}))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return docker.Nuevo(sock)
}

func TestDescribeElMotor(t *testing.T) {
	d := motorCon(t, motorfalso.Docker27, map[string]any{
		"OperatingSystem": "Ubuntu 24.04.1 LTS", "CgroupVersion": "2", "CgroupDriver": "systemd",
		"SecurityOptions": []string{"name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"},
		"MemTotal":        8 << 30, "NCPU": 4, "Driver": "overlay2",
	})
	r := Describir(context.Background(), d, []string{"trampas", "no-existe"})
	if r.Tipo != "docker" || r.Modo != ModoRootful || r.Version != "27.5.1" || r.API != "1.47" || r.APIMinima != "1.24" ||
		r.Sistema != "Ubuntu 24.04.1 LTS" || r.Cgroups != "2" || r.CPUs != 4 || r.Memoria != 8<<30 || r.Almacenamiento != "overlay2" ||
		r.Arquitectura != "amd64" || len(r.Seguridad) != 3 || r.Codigo != "" {
		t.Fatalf("descripción: %+v", r)
	}
	if strings.Join(r.Pasarelas, ",") != "172.19.0.1" {
		t.Fatalf("pasarelas: %v", r.Pasarelas)
	}
}

func TestReconoceElModo(t *testing.T) {
	for _, c := range []struct {
		nombre string
		motor  motorfalso.Motor
		info   map[string]any
		tipo   string
		modo   string
	}{
		{"Docker sin root", motorfalso.Docker27, map[string]any{"SecurityOptions": []string{"name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"}}, "docker", ModoRootless},
		{"Docker Desktop", motorfalso.Docker29_3, map[string]any{"OperatingSystem": "Docker Desktop", "Labels": []string{"com.docker.desktop.address=unix:///Users/x/Library/Containers/com.docker.docker/Data/docker-cli.sock"}}, "docker", ModoDesktop},
		{"Docker en WSL2", motorfalso.Docker27, map[string]any{"OperatingSystem": "Ubuntu 22.04.3 LTS", "KernelVersion": "5.15.153.1-microsoft-standard-WSL2"}, "docker", ModoWSL},
		{"Podman sin root", motorfalso.Podman4, map[string]any{"OperatingSystem": "fedora", "SecurityOptions": []string{"name=seccomp,profile=/usr/share/containers/seccomp.json", "name=rootless"}}, "podman", ModoRootless},
		{"Podman con root", motorfalso.Podman4, map[string]any{"OperatingSystem": "rhel", "SecurityOptions": []string{"name=selinux"}}, "podman", ModoRootful},
	} {
		t.Run(c.nombre, func(t *testing.T) {
			r := Describir(context.Background(), motorCon(t, c.motor, c.info), nil)
			if r.Tipo != c.tipo || r.Modo != c.modo {
				t.Fatalf("tipo %q y modo %q; se esperaba %q y %q", r.Tipo, r.Modo, c.tipo, c.modo)
			}
		})
	}
}

func TestUnMotorQueNoSirveSeDescribeConSuFallo(t *testing.T) {
	r := Describir(context.Background(), motorCon(t, motorfalso.Docker19, nil), nil)
	if r.Codigo != docker.MotorAntiguo || !strings.Contains(r.Error, "Docker 20.10 o posterior") || r.Tipo != "" {
		t.Fatalf("descripción: %+v", r)
	}
}

// Un Docker 20.10 anterior a la 20.10.10 ya no se rechaza por su número:
// muchas distribuciones traen el parche de clone3 sin cambiarlo.
func TestUnDocker20_10DeDistribucionSeDescribe(t *testing.T) {
	r := Describir(context.Background(), motorCon(t, motorfalso.Docker20_10_7Ubuntu, map[string]any{"OperatingSystem": "Ubuntu 20.04.6 LTS"}), nil)
	if r.Codigo != "" || r.Tipo != "docker" || r.Version != "20.10.7" || r.API != "1.41" {
		t.Fatalf("descripción: %+v", r)
	}
}

// motorConSondas: un Docker 27 en el que cada sonda sale con codigo.
func motorConSondas(t *testing.T, codigo int) (*docker.Cliente, *motorfalso.Sondas) {
	t.Helper()
	sondas := &motorfalso.Sondas{Salida: func([]string) (int, string) { return codigo, "clone3: lo que sea\n" }}
	return motorConSondasDe(t, sondas), sondas
}

// motorConSondasDe: un Docker 27 cuyas sondas atiende sondas.
func motorConSondasDe(t *testing.T, sondas *motorfalso.Sondas) *docker.Cliente {
	t.Helper()
	base, err := os.MkdirTemp("", "mt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !sondas.Atender(w, r) {
			w.WriteHeader(http.StatusNotFound)
		}
	}))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return docker.Nuevo(sock)
}

func TestClone3SeMideConUnaSonda(t *testing.T) {
	for _, c := range []struct {
		nombre string
		codigo int
		hecho  *Hecho
	}{
		{"el núcleo contesta (EINVAL) o el motor dice ENOSYS", SalidaClone3Disponible, &Hecho{true, Clone3Disponible}},
		{"el perfil seccomp contesta EPERM (Docker 20.10.9 sin parche)", SalidaClone3Bloqueado, &Hecho{false, Clone3Bloqueado}},
		{"el perfil mata el proceso (SIGSYS)", 159, &Hecho{false, Clone3Bloqueado}},
		{"la imagen no sabe hacer la sonda", 2, nil},
	} {
		t.Run(c.nombre, func(t *testing.T) {
			d, sondas := motorConSondas(t, c.codigo)
			h, err := Clone3(context.Background(), d, "r/sensor@sha256:1", "s1")
			if (c.hecho == nil) != (err != nil) || (c.hecho != nil && (h == nil || *h != *c.hecho)) {
				t.Fatalf("hecho %+v, error %v", h, err)
			}
			if len(sondas.Creadas) != 1 {
				t.Fatalf("sondas creadas: %d", len(sondas.Creadas))
			}
			sonda := sondas.Creadas[0]
			hc, _ := sonda["HostConfig"].(map[string]any)
			etiquetas, _ := sonda["Labels"].(map[string]any)
			if hc["NetworkMode"] != "none" || etiquetas["sugardaddy.sonda"] != "s1" || hc["SecurityOpt"] == nil {
				t.Fatalf("sonda: %v", sonda)
			}
		})
	}
}

func TestOculta(t *testing.T) {
	d := Descripcion{Modo: ModoRootful, Pasarelas: []string{"172.19.0.1", "fd00:dead:beef::1"}}
	for ip, oculta := range map[string]bool{
		"172.19.0.1":          true, // el proxy del motor (sin iptables, rootless, conexión local)
		"::ffff:172.19.0.1":   true,
		"fd00:dead:beef::1":   true,
		"127.0.0.1":           true,
		"::1":                 true,
		"203.0.113.7":         false,
		"10.20.0.15":          false, // una IP de la red del cliente: es la de verdad
		"172.19.0.2":          false,
		"":                    false,
		"no es una dirección": false,
	} {
		if d.Oculta(ip) != oculta {
			t.Errorf("%q: oculta tenía que ser %v", ip, oculta)
		}
	}
	if !(Descripcion{Modo: ModoDesktop}).Oculta("192.168.65.1") {
		t.Error("con Docker Desktop ninguna IP es la del atacante")
	}
}

// Con WSL2 la marca de cada evento sigue la misma regla que el hecho: sin
// medir la puerta de enlace, toda IP es del motor; medida, solo ella (el
// Windows que reenvía con netsh portproxy), las pasarelas y las locales.
func TestOcultaConWSL(t *testing.T) {
	sinMedir := Descripcion{Modo: ModoWSL, Pasarelas: []string{"172.18.0.1"}}
	for _, ip := range []string{"172.29.128.1", "203.0.113.7", "172.18.0.1"} {
		if !sinMedir.Oculta(ip) {
			t.Errorf("WSL sin medir: %s tenía que contar como del motor", ip)
		}
	}
	medida := Descripcion{Modo: ModoWSL, Pasarelas: []string{"172.18.0.1"}, PuertaEnlace: "172.29.128.1"}
	for ip, oculta := range map[string]bool{
		"172.29.128.1": true, // Windows, en la red de WSL
		"172.18.0.1":   true,
		"127.0.0.1":    true,
		"203.0.113.7":  false, // con la red en modo espejo llega la IP real
		"192.168.1.40": false,
	} {
		if medida.Oculta(ip) != oculta {
			t.Errorf("WSL medida: %s, oculta tenía que ser %v", ip, oculta)
		}
	}
	if len(medida.Pasarelas) != 1 {
		t.Fatalf("Oculta no puede tocar las pasarelas: %v", medida.Pasarelas)
	}
	// En Linux, la puerta de enlace no cuenta: lo que llega de ella es real.
	if (Descripcion{Modo: ModoRootful, PuertaEnlace: "192.168.1.1"}).Oculta("192.168.1.1") {
		t.Error("fuera de WSL, la puerta de enlace es una IP de verdad")
	}
}

func TestHechoOrigen(t *testing.T) {
	antes, despues := time.Unix(1000, 0), time.Unix(2000, 0)
	// Más de una ventana después de «despues».
	mucho := despues.Add(VentanaOrigen + time.Second)
	var nunca time.Time
	for _, c := range []struct {
		nombre       string
		modo         string
		real, oculto time.Time
		sabe, valor  bool
		motivo       string
	}{
		{"sin nada llegado no se sabe", ModoRootful, nunca, nunca, false, false, ""},
		{"llega una IP real", ModoRootful, despues, nunca, true, true, OrigenReal},
		{"llega la pasarela", ModoRootful, nunca, despues, true, false, OrigenPasarela},
		{"una local poco después de una real (una prueba desde la propia máquina)", ModoRootful, antes, despues, true, true, OrigenReal},
		{"una real tras la pasarela", ModoRootful, despues, antes, true, true, OrigenReal},
		{"llegan a la vez", ModoRootful, despues, despues, true, true, OrigenReal},
		{"solo la pasarela durante más de una ventana (reglas borradas)", ModoRootful, despues, mucho, true, false, OrigenPasarela},
		{"justo al borde de la ventana", ModoRootful, despues, despues.Add(VentanaOrigen), true, true, OrigenReal},
		{"rootless con la pasarela", ModoRootless, nunca, despues, true, false, OrigenPasarela},
		{"rootless sin nada llegado", ModoRootless, nunca, nunca, true, false, OrigenRootless},
		{"rootless con una IP real", ModoRootless, despues, nunca, true, true, OrigenReal},
		{"Docker Desktop manda siempre", ModoDesktop, despues, nunca, true, false, OrigenDesktop},
		{"WSL2 sin medir su puerta de enlace", ModoWSL, despues, nunca, true, false, OrigenWSL},
	} {
		h := HechoOrigen(Descripcion{Modo: c.modo}, c.real, c.oculto)
		if (h != nil) != c.sabe || (h != nil && (h.Valor != c.valor || h.Motivo != c.motivo)) {
			t.Errorf("%s: %+v", c.nombre, h)
		}
	}
	// Con WSL2 y su puerta de enlace medida se decide por lo que llega.
	wsl := Descripcion{Modo: ModoWSL, PuertaEnlace: "172.29.128.1"}
	for _, c := range []struct {
		nombre       string
		real, oculto time.Time
		valor        bool
		motivo       string
	}{
		{"sin nada llegado", nunca, nunca, false, OrigenWSL},
		{"solo llega Windows (NAT)", nunca, despues, false, OrigenWSL},
		{"llega una IP real (modo espejo)", despues, antes, true, OrigenReal},
		{"una real hace más de una ventana", despues, mucho, false, OrigenWSL},
	} {
		h := HechoOrigen(wsl, c.real, c.oculto)
		if h == nil || h.Valor != c.valor || h.Motivo != c.motivo {
			t.Errorf("WSL medida, %s: %+v", c.nombre, h)
		}
	}
}

func TestLeerPuertaEnlace(t *testing.T) {
	cabecera := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
	for _, c := range []struct {
		nombre, tabla, puerta string
	}{
		{"WSL2 en NAT", "eth0\t00000000\t0180A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
			"eth0\t0080A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n" +
			"docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n", "192.168.128.1"},
		{"dos rutas por defecto: la de menor métrica", "wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n" +
			"eth0\t00000000\t01801DAC\t0003\t0\t0\t100\t00000000\t0\t0\t0\n", "172.29.128.1"},
		{"sin ruta por defecto", "eth0\t0080A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n", ""},
		{"ruta por defecto sin puerta de enlace (punto a punto)", "tun0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0\n", ""},
		{"ruta caída", "eth0\t00000000\t0180A8C0\t0002\t0\t0\t0\t00000000\t0\t0\t0\n", ""},
	} {
		if p := LeerPuertaEnlace(strings.NewReader(cabecera + c.tabla)); p != c.puerta {
			t.Errorf("%s: %q, se esperaba %q", c.nombre, p, c.puerta)
		}
	}
}

func TestPuertaEnlaceSeMideConUnaSonda(t *testing.T) {
	for _, c := range []struct {
		nombre, salida string
		codigo         int
		puerta         string
		falla          bool
	}{
		{"WSL2 en NAT", "172.29.128.1\n", 0, "172.29.128.1", false},
		{"sin ruta por defecto", "\n", 0, "", false},
		{"la sonda falla", "open /proc/net/route: permission denied\n", 1, "", true},
		{"lo que dice no es una dirección", "hola\n", 0, "", true},
	} {
		t.Run(c.nombre, func(t *testing.T) {
			sondas := &motorfalso.Sondas{Salida: func([]string) (int, string) { return c.codigo, c.salida }}
			d := motorConSondasDe(t, sondas)
			p, err := PuertaEnlace(context.Background(), d, "r/sensor@sha256:1", "s1")
			if p != c.puerta || (err != nil) != c.falla {
				t.Fatalf("puerta %q, error %v", p, err)
			}
			hc, _ := sondas.Creadas[0]["HostConfig"].(map[string]any)
			if hc["NetworkMode"] != "host" || fmt.Sprint(sondas.Creadas[0]["Cmd"]) != "[puerta-enlace]" {
				t.Fatalf("la sonda tiene que correr en la red del anfitrión: %v", sondas.Creadas[0])
			}
		})
	}
}
