package main

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

func eventoTocado(trampa, ip string, puerto int) *evento.Evento {
	e := &evento.Evento{}
	e.Trampa.ID = trampa
	e.Origen.IP = ip
	e.Origen.Puerto = puerto
	return e
}

func TestMarcarPorPuertoOPorIPPropia(t *testing.T) {
	ahora := time.Now()
	var ts toques
	a := ts.apuntar(plan.Toque{Trampa: "ftp", Codigo: "abc12345", IPs: []string{"172.20.0.1", "::ffff:10.0.0.11"}}, ahora)
	ts.conPuerto(a, 40000)

	casos := []struct {
		nombre string
		e      *evento.Evento
		marca  bool
	}{
		{"por el puerto, aunque sea otra IP", eventoTocado("ftp", "203.0.113.9", 40000), true},
		{"por la IP del motor, con otro puerto", eventoTocado("ftp", "172.20.0.1", 51000), true},
		{"por la IP de la máquina, escrita en IPv4", eventoTocado("ftp", "10.0.0.11", 51000), true},
		{"otra IP y otro puerto: es de verdad", eventoTocado("ftp", "203.0.113.9", 51000), false},
		{"sin IP ni puerto", eventoTocado("ftp", "", 0), false},
		{"otra trampa", eventoTocado("ssh", "172.20.0.1", 40000), false},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			if got := ts.marcar(c.e, ahora); got != c.marca {
				t.Fatalf("marcar = %v, quería %v", got, c.marca)
			}
			if c.marca && c.e.Detalle[campoToque] != "abc12345" {
				t.Fatalf("sin el código: %v", c.e.Detalle)
			}
			if !c.marca && c.e.Detalle[campoToque] != nil {
				t.Fatalf("marcado de más: %v", c.e.Detalle)
			}
		})
	}
}

func TestMarcarSinPuertoAunNoCasaConPuertoCero(t *testing.T) {
	ahora := time.Now()
	var ts toques
	ts.apuntar(plan.Toque{Trampa: "ftp", Codigo: "abc12345"}, ahora)
	if ts.marcar(eventoTocado("ftp", "203.0.113.9", 0), ahora) {
		t.Fatal("un evento sin puerto no puede casar con un toque que aún no tiene")
	}
}

func TestMarcarCaduca(t *testing.T) {
	ahora := time.Now()
	var ts toques
	ts.apuntar(plan.Toque{Trampa: "ftp", Codigo: "abc12345", IPs: []string{"172.20.0.1"}}, ahora)
	if ts.marcar(eventoTocado("ftp", "172.20.0.1", 1), ahora.Add(vidaToque)) {
		t.Fatal("pasada su vida ya no es del toque")
	}
	if len(ts.activos) != 0 {
		t.Fatalf("se queda apuntado: %v", ts.activos)
	}
}

func TestMarcarQuitaLoQueTraeElEvento(t *testing.T) {
	var ts toques
	e := eventoTocado("ftp", "203.0.113.9", 1)
	e.Detalle = map[string]any{campoToque: "abc12345", "otro": 1}
	if ts.marcar(e, time.Now()) {
		t.Fatal("sin toques no se marca")
	}
	if _, hay := e.Detalle[campoToque]; hay {
		t.Fatal("un atacante podría hacer pasar su evento por una prueba")
	}
	if e.Detalle["otro"] != 1 {
		t.Fatal("se ha llevado lo demás")
	}
}

type informe struct {
	id, detalle string
	ok          bool
}

func recogerInformes() (func(context.Context, string, bool, string) error, func() []informe) {
	var mu sync.Mutex
	var todos []informe
	return func(_ context.Context, id string, ok bool, detalle string) error {
			mu.Lock()
			defer mu.Unlock()
			todos = append(todos, informe{id, detalle, ok})
			return nil
		}, func() []informe {
			mu.Lock()
			defer mu.Unlock()
			return append([]informe(nil), todos...)
		}
}

func TestTocarConectaApuntaElPuertoEInforma(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	vista := make(chan int, 1)
	go func() {
		c, err := l.Accept()
		if err == nil {
			vista <- c.RemoteAddr().(*net.TCPAddr).Port
			c.Close()
		}
	}()
	puerto := l.Addr().(*net.TCPAddr).Port

	var ts toques
	informar, informes := recogerInformes()
	ts.tocar(context.Background(), []plan.Toque{{ID: "t1", Trampa: "ftp", Direccion: "127.0.0.1", Puerto: puerto, Codigo: "abc12345"}}, informar).Wait()

	got := informes()
	if len(got) != 1 || !got[0].ok || got[0].id != "t1" {
		t.Fatalf("informes = %+v", got)
	}
	// La trampa ve el puerto desde el que se conectó el sensor: su evento casa.
	if !ts.marcar(eventoTocado("ftp", "203.0.113.9", <-vista), time.Now()) {
		t.Fatal("el evento del toque no se ha marcado")
	}
}

func TestTocarUnPuertoCerradoLoCuenta(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	puerto := l.Addr().(*net.TCPAddr).Port
	l.Close()

	var ts toques
	informar, informes := recogerInformes()
	ts.tocar(context.Background(), []plan.Toque{{ID: "t1", Trampa: "ftp", Direccion: "127.0.0.1", Puerto: puerto, Codigo: "abc12345"}}, informar).Wait()
	got := informes()
	if len(got) != 1 || got[0].ok || got[0].detalle == "" {
		t.Fatalf("informes = %+v", got)
	}
}

func TestTocarDescartaOrdenesMalFormadas(t *testing.T) {
	var ts toques
	informar, informes := recogerInformes()
	ts.tocar(context.Background(), []plan.Toque{
		{ID: "t1", Trampa: "ftp", Direccion: "127.0.0.1", Puerto: 0, Codigo: "x"},
		{ID: "t2", Trampa: "ftp", Direccion: "127.0.0.1", Puerto: 70000, Codigo: "x"},
		{ID: "t3", Trampa: "ftp", Direccion: "", Puerto: 21, Codigo: "x"},
		{ID: "t4", Trampa: "ftp", Direccion: "127.0.0.1", Puerto: 21, Codigo: ""},
	}, informar).Wait()
	if got := informes(); len(got) != 0 {
		t.Fatalf("informes = %+v", got)
	}
}
