package main

import (
	"context"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Toques: «Prueba mi detección». La consola pide en el plan una conexión de
// prueba a una trampa; la hace el sensor, que está junto a ella aunque la
// consola no llegue, y marca él mismo los eventos que provoca con el código
// de la prueba (detalle.toque). Así la consola sabe qué es de la prueba sin
// fiarse de la IP, y el toque, que suele llegar con la IP del motor, no
// cuenta para decidir si las trampas ven la IP de quien se conecta.
//
// Un evento es del toque si es de esa trampa, dentro de su vida, y viene del
// puerto desde el que se conectó el sensor o de una IP de la propia máquina:
// una trampa publicada con NAT o con el proxy de Docker no siempre conserva
// el puerto. La consola no pide toques a un motor que oculta la IP de origen,
// donde las IP de la máquina serían también las de cualquier atacante.

const (
	// Hasta cuándo se le da a conectar.
	plazoToque = 5 * time.Second
	// Lo que se aguanta abierta: una trampa que habla primero ya ha visto la
	// conexión. Es lo que tardaría un «nc -vz».
	abiertoToque = 300 * time.Millisecond
	// Hasta cuándo cuentan los eventos. Una sesión cerrada también da evento
	// y algunas trampas lo escriben con retraso. La prueba de la consola dura
	// más, pero un evento que llegara después ya no sería de este toque.
	vidaToque = time.Minute
	// A cuántas trampas a la vez: «todas» pueden ser decenas.
	toquesALaVez = 8
	// El campo del evento donde va el código.
	campoToque = "toque"
)

type toqueActivo struct {
	codigo string
	puerto int
	ips    map[netip.Addr]bool
	hasta  time.Time
}

// toques son los toques en curso, por trampa. Los apunta el goroutine de cada
// toque y los consulta la lectura de los registros.
type toques struct {
	mu      sync.Mutex
	activos map[string][]*toqueActivo
}

func direccion(ip string) (netip.Addr, bool) {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap().WithZone(""), true
}

func (t *toques) apuntar(o plan.Toque, ahora time.Time) *toqueActivo {
	a := &toqueActivo{codigo: o.Codigo, ips: map[netip.Addr]bool{}, hasta: ahora.Add(vidaToque)}
	for _, ip := range o.IPs {
		if x, ok := direccion(ip); ok {
			a.ips[x] = true
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.activos == nil {
		t.activos = map[string][]*toqueActivo{}
	}
	t.activos[o.Trampa] = append(t.activos[o.Trampa], a)
	return a
}

func (t *toques) conPuerto(a *toqueActivo, puerto int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	a.puerto = puerto
}

// marcar pone el código en el evento si es de un toque y dice si lo era. Lo
// que traiga un evento en ese campo por su cuenta se quita: lo escribe quien
// se conecta a la trampa, y solo el sensor puede decir que algo es una prueba.
func (t *toques) marcar(e *evento.Evento, ahora time.Time) bool {
	delete(e.Detalle, campoToque)
	t.mu.Lock()
	defer t.mu.Unlock()
	activos := t.activos[e.Trampa.ID]
	if len(activos) == 0 {
		return false
	}
	vivos := activos[:0]
	for _, a := range activos {
		if ahora.Before(a.hasta) {
			vivos = append(vivos, a)
		}
	}
	if len(vivos) == 0 {
		delete(t.activos, e.Trampa.ID)
		return false
	}
	t.activos[e.Trampa.ID] = vivos
	ip, conIP := direccion(e.Origen.IP)
	for _, a := range vivos {
		if (a.puerto != 0 && e.Origen.Puerto == a.puerto) || (conIP && a.ips[ip]) {
			if e.Detalle == nil {
				e.Detalle = map[string]any{}
			}
			e.Detalle[campoToque] = a.codigo
			return true
		}
	}
	return false
}

// valido descarta una orden mal formada: la consola es de confianza, pero un
// puerto fuera de rango no se le pide a la red.
func valido(o plan.Toque) bool {
	return o.ID != "" && o.Trampa != "" && o.Direccion != "" && o.Codigo != "" && o.Puerto > 0 && o.Puerto <= 65535
}

// tocar hace los toques pedidos sin parar el bucle del sensor y cuenta a la
// consola cómo ha ido cada uno. Se apunta antes de conectar: el evento puede
// escribirse antes de que vuelva el Dial.
func (t *toques) tocar(ctx context.Context, ordenes []plan.Toque, informar func(context.Context, string, bool, string) error) *sync.WaitGroup {
	var todos sync.WaitGroup
	turno := make(chan struct{}, toquesALaVez)
	for _, o := range ordenes {
		if !valido(o) {
			slog.Warn("malformed touch", "id", o.ID, "trampa", o.Trampa)
			continue
		}
		todos.Add(1)
		go func() {
			defer todos.Done()
			turno <- struct{}{}
			defer func() { <-turno }()
			a := t.apuntar(o, time.Now())
			d := net.Dialer{Timeout: plazoToque}
			c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(o.Direccion, strconv.Itoa(o.Puerto)))
			detalle := ""
			if err != nil {
				detalle = err.Error()
			} else {
				if l, ok := c.LocalAddr().(*net.TCPAddr); ok {
					t.conPuerto(a, l.Port)
				}
				time.Sleep(abiertoToque)
				c.Close()
			}
			if err := informar(ctx, o.ID, err == nil, detalle); err != nil {
				slog.Warn("could not count how a touch went", "id", o.ID, "err", err)
			}
		}()
	}
	return &todos
}
