package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/consola"
	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

func eventoDe(ip, cuando string) evento.Evento {
	return evento.Evento{Cuando: cuando, Origen: evento.Origen{IP: ip}}
}

func TestMarcaElOrigenOcultoSiLaConsolaLoAdmite(t *testing.T) {
	s := &sensor{
		estado:   &estado.Estado{},
		plan:     &plan.Plan{Admite: []string{plan.OrigenOculta}},
		conocido: motor.Descripcion{Modo: motor.ModoRootful, Pasarelas: []string{"172.19.0.1"}},
	}
	real, delMotor := eventoDe("203.0.113.7", "2026-10-17T10:00:00Z"), eventoDe("172.19.0.1", "2026-10-17T10:05:00Z")
	s.origen(&real)
	s.origen(&delMotor)
	if real.Origen.Oculta || !delMotor.Origen.Oculta {
		t.Fatalf("solo la IP de la pasarela es del motor: %+v %+v", real.Origen, delMotor.Origen)
	}
	// Una conexión desde la propia máquina (redis-cli -h 127.0.0.1) después
	// de una IP real no apaga el hecho: el sensor sí ve el origen.
	h, _ := s.hechos()["red.ipOrigenReal"].(*motor.Hecho)
	if h == nil || !h.Valor || h.Motivo != motor.OrigenReal {
		t.Fatalf("hecho: %+v", h)
	}
	// Ocho días llegando solo la IP de la pasarela (reglas del cortafuegos
	// borradas): ya no ve el origen.
	tarde := eventoDe("172.19.0.1", "2026-10-25T10:05:00Z")
	s.origen(&tarde)
	if h, _ := s.hechos()["red.ipOrigenReal"].(*motor.Hecho); h == nil || h.Valor || h.Motivo != motor.OrigenPasarela {
		t.Fatalf("hecho: %+v", h)
	}
	// Y una IP real después lo vuelve verdadero.
	otro := eventoDe("198.51.100.4", "2026-10-25T10:06:00Z")
	s.origen(&otro)
	if h, _ := s.hechos()["red.ipOrigenReal"].(*motor.Hecho); h == nil || !h.Valor {
		t.Fatalf("hecho: %+v", h)
	}
}

// Una consola anterior a la 0.13.1 apartaría el evento con un campo que no
// conoce: sin «admite», no se marca (pero el hecho sí se apunta).
func TestSinAdmiteNoSeMarcaElEvento(t *testing.T) {
	s := &sensor{
		estado:   &estado.Estado{},
		plan:     &plan.Plan{},
		conocido: motor.Descripcion{Pasarelas: []string{"172.19.0.1"}},
	}
	e := eventoDe("172.19.0.1", "2026-10-17T10:00:00Z")
	s.origen(&e)
	if e.Origen.Oculta {
		t.Fatal("la consola no lo admite: no se marca")
	}
	linea, _ := evento.NuevaCadena("").Emitir(e)
	if strings.Contains(string(linea), "oculta") {
		t.Fatalf("el campo no puede viajar: %s", linea)
	}
	if s.estado.OrigenOculto.IsZero() {
		t.Fatal("el hecho se apunta igual")
	}
}

// consolaDePrueba da un plan con una trampa y apunta lo que el sensor informa.
type consolaDePrueba struct {
	mu       sync.Mutex
	informes []map[string]json.RawMessage
}

func (c *consolaDePrueba) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/sensor/plan":
		_, _ = w.Write([]byte(`{"sensor":"s1","ultimoHash":"","admite":["origen.oculta"],"trampas":[{"id":"t1","manifiesto":{"id":"m","tipo":"contenedor","contenedor":{"imagen":"r/x@sha256:1","registros":"/log"},"aislamiento":{"cpu":0.5,"memoriaMb":64}}}]}`))
	case "/api/sensor/estado":
		var b map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&b)
		c.mu.Lock()
		c.informes = append(c.informes, b)
		c.mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	default:
		http.NotFound(w, r)
	}
}

func (c *consolaDePrueba) ultimo(t *testing.T) (trampas []despliegue.Estado, m motor.Descripcion, hechos map[string]motor.Hecho) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.informes) == 0 {
		t.Fatal("el sensor no ha informado")
	}
	b := c.informes[len(c.informes)-1]
	var crudos map[string]json.RawMessage
	if json.Unmarshal(b["trampas"], &trampas) != nil || json.Unmarshal(b["motor"], &m) != nil || json.Unmarshal(b["hechos"], &crudos) != nil {
		t.Fatalf("informe ilegible: %v", b)
	}
	// Los de sí o no; los de lista (puertos.ocupados…), con listaDe.
	hechos = map[string]motor.Hecho{}
	for k, v := range crudos {
		var h motor.Hecho
		if json.Unmarshal(v, &h) == nil {
			hechos[k] = h
		}
	}
	return
}

// listaDe da el valor de un hecho de lista del último informe; nil si no está.
func (c *consolaDePrueba) listaDe(t *testing.T, clave string) []string {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	var hechos map[string]json.RawMessage
	if err := json.Unmarshal(c.informes[len(c.informes)-1]["hechos"], &hechos); err != nil {
		t.Fatalf("hechos ilegibles: %v", err)
	}
	crudo, ok := hechos[clave]
	if !ok {
		return nil
	}
	var h struct {
		Valor []string `json:"valor"`
	}
	if err := json.Unmarshal(crudo, &h); err != nil {
		t.Fatalf("%s no es una lista: %v", clave, err)
	}
	return h.Valor
}

// creadasCon cuenta las sondas creadas con esta orden.
func creadasCon(s *motorfalso.Sondas, orden string) int {
	n := 0
	for _, c := range s.Creadas {
		if fmt.Sprint(c["Cmd"]) == fmt.Sprint([]any{orden}) {
			n++
		}
	}
	return n
}

// motorDePrueba: un Docker 27 vacío que deja crear redes y contenedores.
func motorDePrueba(t *testing.T) string {
	t.Helper()
	return motorDePruebaCon(t, nil, "")
}

// motorDePruebaCon es motorDePrueba, con las sondas del sensor atendidas
// por sondas y lo que contesta a /info (vacío: un Debian 12 con root).
func motorDePruebaCon(t *testing.T, sondas *motorfalso.Sondas, info string) string {
	t.Helper()
	if info == "" {
		info = `{"OperatingSystem":"Debian GNU/Linux 12 (bookworm)","SecurityOptions":["name=apparmor","name=seccomp,profile=builtin"],"NCPU":2,"MemTotal":4294967296}`
	}
	base, err := os.MkdirTemp("", "sm")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	redes := map[string]bool{}
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sondas != nil && strings.Contains(r.URL.Path+r.URL.RawQuery, "sonda") && sondas.Atender(w, r) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		p := r.URL.Path
		switch {
		case p == "/info":
			_, _ = w.Write([]byte(info))
		case r.Method == http.MethodPost && p == "/networks/create":
			var c struct{ Name string }
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &c)
			redes[c.Name] = true
			_, _ = w.Write([]byte(`{"Id":"red"}`))
		case strings.HasPrefix(p, "/networks/"):
			if !redes[strings.TrimPrefix(p, "/networks/")] {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"no existe"}`))
				return
			}
			_, _ = w.Write([]byte(`{"Options":{"com.docker.network.bridge.enable_ip_masquerade":"false","com.docker.network.bridge.enable_icc":"false"},"Containers":{},"IPAM":{"Config":[{"Subnet":"172.19.0.0/16","Gateway":"172.19.0.1"}]}}`))
		case p == "/containers/json":
			_, _ = w.Write([]byte(`[]`))
		case p == "/volumes":
			_, _ = w.Write([]byte(`{"Volumes":[]}`))
		case p == "/containers/create":
			_, _ = w.Write([]byte(`{"Id":"c1"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sock
}

func sensorDePrueba(t *testing.T, sock string) (*sensor, *consolaDePrueba) {
	t.Helper()
	c := &consolaDePrueba{}
	srv := httptest.NewServer(c)
	t.Cleanup(srv.Close)
	return &sensor{
		consola: consola.Nuevo(srv.URL, "token"),
		docker:  docker.Nuevo(sock),
		opc:     despliegue.Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"},
		estado:  &estado.Estado{},
	}, c
}

func salud(s *sensor) int {
	w := httptest.NewRecorder()
	s.salud(w, httptest.NewRequest(http.MethodGet, "/salud", nil))
	return w.Code
}

// Sin motor, cada trampa del plan llega a la consola con el fallo y su
// código, el bloque motor lo dice y el sensor no está sano. Cuando el motor
// vuelve, la consola recibe su descripción y la salud vuelve.
func TestUnFalloDelMotorLlegaALaConsolaYQuitaLaSalud(t *testing.T) {
	base, err := os.MkdirTemp("", "sm")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	s, c := sensorDePrueba(t, filepath.Join(base, "parado.sock"))
	s.actualizarPlan(context.Background())
	trampas, m, _ := c.ultimo(t)
	if len(trampas) != 1 || trampas[0].Codigo != docker.MotorInalcanzable || !strings.HasPrefix(trampas[0].Donde, "error: motor.inalcanzable: ") {
		t.Fatalf("estado de la trampa: %+v", trampas)
	}
	if m.Codigo != docker.MotorInalcanzable || m.Error == "" {
		t.Fatalf("bloque motor: %+v", m)
	}
	if salud(s) != http.StatusServiceUnavailable {
		t.Fatal("sin motor, el sensor no está sano")
	}

	s.docker = docker.Nuevo(motorDePrueba(t))
	s.actualizarPlan(context.Background())
	trampas, m, _ = c.ultimo(t)
	if len(trampas) != 1 || trampas[0].Codigo != "" {
		t.Fatalf("estado de la trampa: %+v", trampas)
	}
	if m.Codigo != "" || m.Tipo != "docker" || m.Version != "27.5.1" || m.API != "1.47" || m.Modo != motor.ModoRootful ||
		m.Sistema != "Debian GNU/Linux 12 (bookworm)" || strings.Join(m.Pasarelas, ",") != "172.19.0.1" {
		t.Fatalf("bloque motor: %+v", m)
	}
	if salud(s) != http.StatusOK {
		t.Fatal("con motor y consola, el sensor está sano")
	}
	if !s.plan.Acepta(plan.OrigenOculta) {
		t.Fatal("el plan de la consola admite origen.oculta")
	}
}

func TestSalidaDeLaSondaDeClone3(t *testing.T) {
	for e, salida := range map[syscall.Errno]int{
		syscall.EINVAL: motor.SalidaClone3Disponible, // el núcleo la conoce y el motor la deja pasar
		syscall.EFAULT: motor.SalidaClone3Disponible,
		syscall.ENOSYS: motor.SalidaClone3Disponible, // núcleo sin clone3 o perfil que dice ENOSYS: glibc vuelve a clone
		syscall.EPERM:  motor.SalidaClone3Bloqueado,  // el perfil seccomp de Docker anterior a la 20.10.10
	} {
		if salidaClone3(e) != salida {
			t.Errorf("%v: tenía que salir con %d", e, salida)
		}
	}
}

// Con la imagen del sensor, una sonda mide clone3 y la consola recibe el
// hecho motor.clone3; no se vuelve a medir en cada plan.
func TestInformaDeClone3(t *testing.T) {
	var veces int
	sondas := &motorfalso.Sondas{Salida: func(orden []string) (int, string) {
		switch strings.Join(orden, " ") {
		case "probar-clone3":
			veces++
			return motor.SalidaClone3Bloqueado, "clone3: operation not permitted\n"
		case "puertos-anfitrion":
			return 0, `{"direcciones":[],"escuchas":[]}`
		}
		t.Errorf("orden de la sonda: %v", orden)
		return 1, ""
	}}
	s, c := sensorDePrueba(t, motorDePruebaCon(t, sondas, ""))
	s.opc.ImagenSonda = "r/sensor@sha256:1"
	s.actualizarPlan(context.Background())
	_, _, hechos := c.ultimo(t)
	if h := hechos["motor.clone3"]; h.Valor || h.Motivo != motor.Clone3Bloqueado {
		t.Fatalf("hechos: %+v", hechos)
	}
	s.actualizarPlan(context.Background())
	if _, _, hechos := c.ultimo(t); hechos["motor.clone3"].Motivo != motor.Clone3Bloqueado {
		t.Fatalf("el hecho se sigue informando: %+v", hechos)
	}
	// Cada sonda contesta dos veces (al esperarla y al leer su salida): una sola.
	if creadasCon(sondas, "probar-clone3") != 1 || veces != 2 {
		t.Fatalf("sondas: %d creadas, %d llamadas", creadasCon(sondas, "probar-clone3"), veces)
	}
}

// Una sonda en la red del anfitrión mide sus puertos y direcciones: la
// consola recibe puertos.ocupados (sin lo que solo está en una dirección
// local, como el resolvedor de Ubuntu en 127.0.0.53:53) y red.direcciones, y
// el 53 se publicará en la IP de red de la máquina.
func TestInformaDePuertosYDirecciones(t *testing.T) {
	sondas := &motorfalso.Sondas{Salida: func(orden []string) (int, string) {
		if strings.Join(orden, " ") == "puertos-anfitrion" {
			return 0, `{"direcciones":["10.0.0.4"],"escuchas":[` +
				`{"proto":"udp","puerto":53,"ip":"127.0.0.53"},{"proto":"tcp","puerto":53,"ip":"127.0.0.53"},` +
				`{"proto":"tcp","puerto":22,"ip":"0.0.0.0"},{"proto":"tcp","puerto":22,"ip":"::"}]}`
		}
		return motor.SalidaClone3Disponible, ""
	}}
	s, c := sensorDePrueba(t, motorDePruebaCon(t, sondas, ""))
	s.opc.ImagenSonda = "r/sensor@sha256:1"
	s.actualizarPlan(context.Background())
	if got := c.listaDe(t, "puertos.ocupados"); strings.Join(got, ",") != "tcp/22" {
		t.Fatalf("puertos.ocupados: %v", got)
	}
	if got := c.listaDe(t, "red.direcciones"); strings.Join(got, ",") != "10.0.0.4" {
		t.Fatalf("red.direcciones: %v", got)
	}
	if got := s.anfitrion.a.PublicarEn("udp", 53); strings.Join(got, ",") != "10.0.0.4" {
		t.Fatalf("el 53 va a la IP de red: %v", got)
	}
	// No se vuelve a medir en cada plan.
	s.actualizarPlan(context.Background())
	if n := creadasCon(sondas, "puertos-anfitrion"); n != 1 {
		t.Fatalf("sondas de puertos: %d", n)
	}
}

// Docker Engine dentro de WSL2 con la red en NAT: una sonda en la red del
// anfitrión mide su puerta de enlace (Windows), lo que llega con ella se
// marca como del motor y el hecho lo dice; una IP real (modo espejo) no se
// marca y el hecho pasa a verdadero.
func TestWSLMarcaLaIPDeWindows(t *testing.T) {
	sondas := &motorfalso.Sondas{Salida: func(orden []string) (int, string) {
		if strings.Join(orden, " ") == "puerta-enlace" {
			return 0, "172.29.128.1\n"
		}
		return motor.SalidaClone3Disponible, "clone3: function not implemented\n"
	}}
	s, c := sensorDePrueba(t, motorDePruebaCon(t, sondas, `{"OperatingSystem":"Ubuntu 22.04.3 LTS","KernelVersion":"5.15.153.1-microsoft-standard-WSL2"}`))
	s.opc.ImagenSonda = "r/sensor@sha256:1"
	s.actualizarPlan(context.Background())
	_, m, hechos := c.ultimo(t)
	if m.Modo != motor.ModoWSL || m.PuertaEnlace != "172.29.128.1" {
		t.Fatalf("bloque motor: %+v", m)
	}
	if h := hechos["red.ipOrigenReal"]; h.Valor || h.Motivo != motor.OrigenWSL {
		t.Fatalf("hecho: %+v", hechos)
	}
	windows := eventoDe("172.29.128.1", "2026-10-17T10:00:00Z")
	s.origen(&windows)
	if !windows.Origen.Oculta {
		t.Fatal("lo que reenvía Windows llega con su IP: es del motor, no del atacante")
	}
	if h, _ := s.hechos()["red.ipOrigenReal"].(*motor.Hecho); h == nil || h.Valor || h.Motivo != motor.OrigenWSL {
		t.Fatalf("hecho: %+v", h)
	}
	real := eventoDe("203.0.113.7", "2026-10-17T10:01:00Z")
	s.origen(&real)
	if real.Origen.Oculta {
		t.Fatal("con la red en modo espejo llega la IP real")
	}
	if h, _ := s.hechos()["red.ipOrigenReal"].(*motor.Hecho); h == nil || !h.Valor {
		t.Fatalf("hecho: %+v", h)
	}
	// La puerta de enlace sigue ahí cuando el motor se vuelve a describir.
	s.motorCuando = time.Time{}
	s.actualizarPlan(context.Background())
	sondasMotor := creadasCon(sondas, "probar-clone3") + creadasCon(sondas, "puerta-enlace")
	if _, m, _ := c.ultimo(t); m.PuertaEnlace != "172.29.128.1" || sondasMotor != 2 {
		t.Fatalf("bloque motor %+v, %d sondas", m, sondasMotor)
	}
}

// Sin la imagen del sensor no hay sonda: con WSL2, toda IP cuenta como del
// motor, igual que dice el hecho.
func TestWSLSinSondaTodoEsDelMotor(t *testing.T) {
	s, c := sensorDePrueba(t, motorDePruebaCon(t, nil, `{"KernelVersion":"5.15.153.1-microsoft-standard-WSL2"}`))
	s.plan = &plan.Plan{Admite: []string{plan.OrigenOculta}}
	s.actualizarPlan(context.Background())
	_, _, hechos := c.ultimo(t)
	if h := hechos["red.ipOrigenReal"]; h.Valor || h.Motivo != motor.OrigenWSL {
		t.Fatalf("hecho: %+v", hechos)
	}
	e := eventoDe("172.29.128.1", "2026-10-17T10:00:00Z")
	s.origen(&e)
	if !e.Origen.Oculta {
		t.Fatal("el hecho dice que no se ve el origen: el evento tiene que ir marcado")
	}
}
