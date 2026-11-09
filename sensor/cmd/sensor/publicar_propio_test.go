package main

import (
	"context"
	"encoding/json"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

func TestPublicarEn(t *testing.T) {
	ignora := plan.Plan{IgnorarPropio: true}
	casos := []struct {
		nombre string
		p      plan.Plan
		cambia func(s *sensor)
		quiere []string
	}{
		{"sin registrar lo de la máquina: en sus direcciones de red", ignora, nil, []string{"10.0.0.5"}},
		{"registrándolo: en 0.0.0.0, como siempre", plan.Plan{}, nil, nil},
		{"sin medir la máquina", ignora, func(s *sensor) { s.anfitrion.a = nil }, nil},
		{"sin direcciones de red", ignora, func(s *sensor) { s.anfitrion.a.Direcciones = nil }, nil},
		{"medida hace demasiado", ignora, func(s *sensor) { s.anfitrion.medido = time.Now().Add(-vidaDirecciones - time.Minute) }, nil},
		{"sin saber aún cómo es el motor", ignora, func(s *sensor) { s.conocido = motor.Descripcion{} }, nil},
		{"Docker Desktop", ignora, func(s *sensor) { s.conocido = motor.Descripcion{Modo: motor.ModoDesktop} }, nil},
		{"sin root", ignora, func(s *sensor) { s.conocido = motor.Descripcion{Modo: motor.ModoRootless} }, nil},
		{"WSL", ignora, func(s *sensor) { s.conocido = motor.Descripcion{Modo: motor.ModoWSL} }, nil},
	}
	for _, c := range casos {
		s := sensorPropio(false)
		if c.cambia != nil {
			c.cambia(s)
		}
		if got := s.publicarEn(c.p)("tcp", 2222); !slices.Equal(got, c.quiere) {
			t.Errorf("%s: %v, quería %v", c.nombre, got, c.quiere)
		}
	}

	// Lo que ya tiene algo local en 127.x se sigue publicando en la IP de red.
	s := sensorPropio(false)
	s.anfitrion.a.Escuchas = []motor.Escucha{{Proto: "udp", Puerto: 53, IP: netip.MustParseAddr("127.0.0.53")}}
	if got := s.publicarEn(plan.Plan{})("udp", 53); !slices.Equal(got, []string{"10.0.0.5"}) {
		t.Errorf("el 53 del resolvedor de Ubuntu: %v", got)
	}

	// Lo que da es de este despliegue: una medida nueva no lo cambia a medias.
	s = sensorPropio(false)
	donde := s.publicarEn(ignora)
	s.anfitrion.a.Direcciones[0] = "10.0.0.99"
	if got := donde("tcp", 2222); !slices.Equal(got, []string{"10.0.0.5"}) {
		t.Errorf("tras medir otra vez: %v", got)
	}
}

// Sin registrar lo de su máquina, una trampa no escucha en 127.0.0.1: «curl localhost»
// no llega a ella. Ya en el primer despliegue, porque la máquina se mide antes: si no,
// las trampas se harían en 0.0.0.0 y se rehacerían en el plan siguiente.
func TestSinRegistrarLoPropioLaTrampaNoEscuchaEnLocal(t *testing.T) {
	sondas := &motorfalso.Sondas{Salida: func(orden []string) (int, string) {
		switch strings.Join(orden, " ") {
		case "probar-clone3":
			return motor.SalidaClone3Disponible, ""
		case "puertos-anfitrion":
			return 0, `{"direcciones":["10.0.0.5","192.168.1.9"],"escuchas":[]}`
		}
		t.Errorf("orden de la sonda: %v", orden)
		return 1, ""
	}}
	var mu sync.Mutex
	var enlaces [][]string
	sock := motorDePruebaApuntando(t, sondas, "", func(cuerpo []byte) {
		var c struct {
			HostConfig struct {
				PortBindings map[string][]struct{ HostIp, HostPort string }
			}
		}
		if err := json.Unmarshal(cuerpo, &c); err != nil {
			t.Errorf("cuerpo de la trampa: %v", err)
		}
		var donde []string
		for _, bs := range c.HostConfig.PortBindings {
			for _, b := range bs {
				donde = append(donde, b.HostIp+":"+b.HostPort)
			}
		}
		slices.Sort(donde)
		mu.Lock()
		enlaces = append(enlaces, donde)
		mu.Unlock()
	})
	conPuerto := func(ignorar bool) string {
		return `{"sensor":"s1","ultimoHash":"","admite":["origen.oculta"],"ignorarPropio":` + map[bool]string{true: "true", false: "false"}[ignorar] +
			`,"trampas":[{"id":"t1","manifiesto":{"id":"m","tipo":"contenedor","contenedor":{"imagen":"r/x@sha256:1","registros":"/log","puertos":[{"interno":22,"expuesto":2222,"protocolo":"tcp"}]},"aislamiento":{"cpu":0.5,"memoriaMb":64}}}]}`
	}
	ultimo := func() []string {
		mu.Lock()
		defer mu.Unlock()
		if len(enlaces) == 0 {
			t.Fatal("no se ha creado la trampa")
		}
		return enlaces[len(enlaces)-1]
	}

	s, c := sensorDePrueba(t, sock)
	s.opc.ImagenSonda = "r/sensor@sha256:1"
	c.plan = conPuerto(true)
	s.actualizarPlan(context.Background())
	if got := ultimo(); !slices.Equal(got, []string{"10.0.0.5:2222", "192.168.1.9:2222"}) {
		t.Fatalf("en el primer despliegue: %v", got)
	}
	if creadasCon(sondas, "puertos-anfitrion") != 1 {
		t.Fatalf("la máquina se mide una vez: %d", creadasCon(sondas, "puertos-anfitrion"))
	}

	// Con la casilla marcada, otra vez en 0.0.0.0.
	c.mu.Lock()
	c.plan = conPuerto(false)
	c.mu.Unlock()
	s.actualizarPlan(context.Background())
	if got := ultimo(); !slices.Equal(got, []string{"0.0.0.0:2222"}) {
		t.Fatalf("registrándolo: %v", got)
	}
}

// Una trampa publicada en una IP que la máquina ya no tiene (una VPN que se cae) no
// arranca: la máquina se vuelve a medir pronto, como con un puerto ocupado.
func TestUnaIPQueYaNoEsDeLaMaquinaSeMideAntes(t *testing.T) {
	sinIP := []despliegue.Estado{{ID: "t1", Donde: "error: Error starting userland proxy: listen tcp4 10.8.0.2:2222: bind: cannot assign requested address"}}
	if !puertoAtascado(sinIP) {
		t.Fatal("con una IP que ya no es de la máquina, se mide antes")
	}
	if puertoAtascado([]despliegue.Estado{{ID: "t1", Donde: "10.0.0.5:2222"}}) {
		t.Fatal("una trampa en marcha no lo pide")
	}
}
