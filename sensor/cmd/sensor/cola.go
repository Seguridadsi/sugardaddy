package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"syscall"

	"github.com/kinomakino/sugardaddy/sensor/internal/adaptador"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Tope de la cola de salida (salida.jsonl). Con la consola caída durante una
// avalancha, la cola crecería sin fin y podría llenar el disco del cliente.
// Al llegar a su tope, lo nuevo se descarta y se resume por trampa; lo que ya
// está en la cola no se toca nunca. El resumen entra en la cola en cuanto hay
// sitio (cuando la consola vuelve y la vacía), antes que lo nuevo. La lectura
// de los registros nunca se para: si se parase, sus registros no se podrían
// liberar y las trampas acabarían paradas por su cuota.
const (
	colaMax       = 256 << 20 // tope de la cola con disco de sobra
	colaMin       = 1 << 20   // y con el disco casi lleno
	colaPorciento = 10        // del disco libre, contando lo que ya ocupa la cola
	colaSinDato   = 64 << 20  // si no se sabe cuánto disco libre queda
	// Eventos graves descartados que van de muestra en cada resumen.
	muestraDescarte = 5
)

// espacioLibre dice cuánto disco libre queda donde está dir (variable para las pruebas).
var espacioLibre = libreEn

// topeCola es lo que puede ocupar la cola de salida: el 10 % del disco libre
// contando lo que ya ocupa ella (si no, el tope bajaría según crece), entre
// 1 MB y 256 MB. En una máquina pequeña con 2 GB libres son 200 MB.
func topeCola(libre, cola int64, conocido bool) int64 {
	if !conocido {
		return colaSinDato
	}
	return min(colaMax, max(colaMin, (libre+cola)/100*colaPorciento))
}

// descarte es lo descartado de una trampa con la cola llena, aún sin resumir.
// Guarda su módulo y tipo: la trampa puede haber salido del plan.
type descarte struct {
	Trampa string `json:"trampa"`
	Modulo string `json:"modulo"`
	Tipo   string `json:"tipo"`
	adaptador.Descarte
}

type descartes map[string]*descarte

func (d descartes) copia() descartes {
	c := make(descartes, len(d))
	for id, x := range d {
		y := *x
		y.Descarte = x.Descarte.Copia()
		c[id] = &y
	}
	return c
}

// retomarDescartes recupera al arrancar lo descartado que aún no se había
// resumido. Si no se entiende, se pierde su resumen pero el sensor sigue.
func (s *sensor) retomarDescartes() {
	if len(s.estado.Descartados) == 0 {
		return
	}
	if err := json.Unmarshal(s.estado.Descartados, &s.descartes); err != nil {
		slog.Warn("no se entiende lo descartado pendiente de resumir; se pierde su resumen", "err", err)
		s.descartes = nil
	}
}

// cola es la cola de salida durante una vuelta de lectura: lo que ocupa, su
// tope y los descartes sin resumir (una copia: solo se quedan si la cola se
// escribe).
type cola struct {
	inicio, tam, tope int64
	descartes         descartes
	// porDisco: si algo no cabe, es por el poco disco libre y no por la
	// consola (ver abrirCola).
	porDisco bool
}

func (s *sensor) abrirCola() *cola {
	var tam int64
	if fi, err := os.Stat(s.salida); err == nil {
		tam = fi.Size()
	}
	libre, conocido := espacioLibre(filepath.Dir(s.salida))
	tope := topeCola(libre, tam, conocido)
	// Lo que no cabe es culpa del disco, no de la consola, si el tope está
	// recortado por el poco disco libre y la consola recogía: no quedaba nada
	// por entregarle o la última entrega salió bien. Con más disco, habría
	// cabido.
	porDisco := conocido && tope < colaMax && (s.estado.Entregado >= tam || s.consolaRecoge)
	return &cola{inicio: tam, tam: tam, tope: tope, descartes: s.descartes.copia(), porDisco: porDisco}
}

// cabe dice si una línea de n bytes entra en la cola, y si entra la cuenta.
// Mientras haya descartes sin resumir no entra nada: primero va su resumen
// (si no, lo nuevo, que es pequeño, le quitaría el sitio una y otra vez).
func (c *cola) cabe(n int) bool {
	if len(c.descartes) > 0 || c.tam+int64(n)+1 > c.tope {
		return false
	}
	c.tam += int64(n) + 1
	return true
}

// descartar apunta un evento que no cabe (de n bytes) en el resumen de su
// trampa; sinDisco, si es porque no queda disco para escribir la cola.
func (c *cola) descartar(e evento.Evento, n int, sinDisco bool) {
	d := c.descartes[e.Trampa.ID]
	if d == nil {
		d = &descarte{Trampa: e.Trampa.ID, Modulo: e.Trampa.Modulo, Tipo: e.Trampa.Tipo}
		c.descartes[e.Trampa.ID] = d
	}
	d.Apuntar(e, n+1, muestraDescarte)
	d.Tope = c.tope
	d.SinDisco = d.SinDisco || sinDisco
	d.PocoDisco = d.PocoDisco || (c.porDisco && !sinDisco)
}

// pendientes son las trampas con descartes sin resumir, en orden.
func (c *cola) pendientes() []string {
	ids := make([]string, 0, len(c.descartes))
	for id := range c.descartes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// resumen es el evento que resume lo descartado de una trampa.
func (c *cola) resumen(sensor, id string) evento.Evento {
	d := c.descartes[id]
	var t plan.TrampaPlan
	t.ID, t.Manifiesto.ID, t.Manifiesto.Tipo = d.Trampa, d.Modulo, d.Tipo
	return adaptador.Descartados(sensor, t, d.Descarte)
}

// cabeResumen dice si el resumen (de n bytes) entra ya, y si entra lo quita de
// los pendientes. En una cola vacía entra siempre.
func (c *cola) cabeResumen(id string, n int) bool {
	if c.tam > 0 && c.tam+int64(n)+1 > c.tope {
		return false
	}
	c.tam += int64(n) + 1
	delete(c.descartes, id)
	return true
}

// anadirACola es escribirCola (variable para las pruebas).
var anadirACola = escribirCola

// escribirCola añade las líneas a la cola de salida de una vez. Si falla a
// medias, la deja como estaba (desde bytes): media línea se pegaría a la
// siguiente y la consola recibiría una línea rota. En discos de red el fallo
// por falta de sitio puede llegar al cerrar.
func escribirCola(ruta string, desde int64, lineas [][]byte) error {
	f, err := os.OpenFile(ruta, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(bytes.Join(lineas, []byte("\n")), '\n'))
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		_ = f.Truncate(desde)
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Truncate(ruta, desde)
		return err
	}
	return nil
}

// discoLleno: no se puede escribir la cola porque no queda disco (o cuota de
// disco para el sensor). Lo de esa vuelta se descarta y se resume como si la
// cola estuviera llena: la lectura no se para.
func discoLleno(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT)
}
