package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Los sensores de internet de KEBAPS (0.33.1) mandaban otra vez, tras cada
// actualización, eventos que la consola ya tenía: el mismo id y el mismo contenido,
// pero encadenados en otro punto (otro hashAnterior). La consola los apartaba a la
// cuarentena («repeats an event already received») y el sensor salía degradado.

// reiniciar arranca otro sensor sobre la misma carpeta, como tras una actualización.
func reiniciar(t *testing.T, antes *sensor) *sensor {
	t.Helper()
	e, err := estado.Cargar(antes.opc.Datos)
	if err != nil {
		t.Fatal(err)
	}
	s := &sensor{
		consola: antes.consola,
		estado:  e,
		salida:  antes.salida,
		plan:    &plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampaDeCola()}},
		ritmo:   ritmo{},
	}
	s.opc.Datos = antes.opc.Datos
	if err := s.retomarCadena(); err != nil {
		t.Fatal(err)
	}
	s.losEmitidos()
	return s
}

func lineasCola(t *testing.T, s *sensor) [][]byte {
	t.Helper()
	b, err := os.ReadFile(s.salida)
	if err != nil || len(b) == 0 {
		return nil
	}
	return bytes.Split(bytes.TrimSuffix(b, []byte("\n")), []byte("\n"))
}

// idsUnicos falla si la consola ha recibido dos veces un mismo evento.
func idsUnicos(t *testing.T, es []evento.Evento) {
	t.Helper()
	vistos := map[string]bool{}
	for _, e := range es {
		if vistos[e.ID] {
			t.Fatalf("la consola recibe dos veces el evento %s", e.ID)
		}
		vistos[e.ID] = true
	}
}

func TestTrasUnReinicioConElEstadoPorDetrasDeLaColaNoSeRepiteNada(t *testing.T) {
	for _, sinFichero := range []bool{false, true} {
		cf := &consolaFalsa{}
		s, registro := sensorDeCola(t, cf)
		escribirEventos(t, registro, 0, 50)
		s.leer()
		entregarTodo(t, s)
		// El estado se queda en el de esta vuelta...
		viejo, err := os.ReadFile(filepath.Join(s.opc.Datos, "estado.json"))
		if err != nil {
			t.Fatal(err)
		}
		escribirEventos(t, registro, 50, 30)
		s.leer()
		// ...porque el sensor se corta tras escribir la cola y antes de guardarlo (o
		// el estado no se pudo guardar): la cola tiene 80 eventos y el estado dice 50.
		if err := os.WriteFile(filepath.Join(s.opc.Datos, "estado.json"), viejo, 0o600); err != nil {
			t.Fatal(err)
		}
		if sinFichero {
			// Y sin los ids apuntados: cuentan los de la cola.
			_ = os.Remove(filepath.Join(s.opc.Datos, ficheroEmitidos))
		}
		r := reiniciar(t, s)
		antes := len(lineasCola(t, r))
		r.leer()
		if despues := len(lineasCola(t, r)); despues != antes {
			t.Fatalf("lo vuelto a leer ya estaba en la cola: %d líneas nuevas (sin fichero de ids: %v)", despues-antes, sinFichero)
		}
		escribirEventos(t, registro, 80, 5)
		r.leer()
		entregarTodo(t, r)
		es := cf.eventos(t)
		idsUnicos(t, es)
		if len(es) != 85 {
			t.Fatalf("la consola recibe cada evento una vez: %d, quería 85", len(es))
		}
	}
}

func TestTrasUnReinicioSinEstadoYConLaColaVaciadaNoSeRepiteNada(t *testing.T) {
	cf := &consolaFalsa{}
	s, registro := sensorDeCola(t, cf)
	// Más de vaciarDesde: entregada entera, la cola se vacía.
	escribirEventos(t, registro, 0, 2000)
	for i := 0; i < 10; i++ {
		s.leer()
		entregarTodo(t, s)
	}
	if tamCola(s) != 0 {
		t.Fatalf("entregada entera, la cola se vacía: %d bytes", tamCola(s))
	}
	recibidos := len(cf.eventos(t))
	// Se pierde el estado: las posiciones de lectura vuelven a cero y la cadena
	// sigue desde lo último que aceptó la consola (actualizarPlan).
	if err := os.Remove(filepath.Join(s.opc.Datos, "estado.json")); err != nil {
		t.Fatal(err)
	}
	r := reiniciar(t, s)
	cf.mu.Lock()
	r.estado.UltimoHash = evento.Hash(cf.lineas[len(cf.lineas)-1])
	cf.mu.Unlock()
	for i := 0; i < 10; i++ {
		r.leer()
	}
	if n := len(lineasCola(t, r)); n != 0 {
		t.Fatalf("el registro leído otra vez desde el principio no vuelve a la cola: %d líneas", n)
	}
	escribirEventos(t, registro, 2000, 3)
	r.leer()
	entregarTodo(t, r)
	es := cf.eventos(t)
	idsUnicos(t, es)
	if len(es) != recibidos+3 {
		t.Fatalf("solo llega lo nuevo: %d, quería %d", len(es)-recibidos, 3)
	}
}

func TestLaMismaLineaDosVecesEnUnaVueltaVaUnaSola(t *testing.T) {
	cf := &consolaFalsa{}
	s, registro := sensorDeCola(t, cf)
	escribirEventos(t, registro, 0, 3)
	escribirEventos(t, registro, 0, 3)
	s.leer()
	if n := len(lineasCola(t, s)); n != 3 {
		t.Fatalf("la misma línea es el mismo evento: %d en la cola, quería 3", n)
	}
}

func TestLosIdsEmitidosTienenTopeYSobrevivenAlReinicio(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, ficheroEmitidos)
	x := nuevosEmitidos(ruta, 4)
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"} {
		if err := x.apuntar([]string{id}); err != nil {
			t.Fatal(err)
		}
	}
	if x.visto("f") || !x.visto("g") || !x.visto("j") || len(x.vistos) != 4 {
		t.Fatalf("se quedan los últimos 4: %d", len(x.vistos))
	}
	fi, err := os.Stat(ruta)
	if err != nil || fi.Size() > 2*4*16 {
		t.Fatalf("el fichero se reescribe al doblar su tope: %v %d bytes", err, fi.Size())
	}
	// Al arrancar: lo del fichero (los últimos del tope) y lo de la cola de salida.
	salida := filepath.Join(dir, "salida.jsonl")
	if err := os.WriteFile(salida, []byte(`{"id":"k","hashAnterior":"x"}`+"\n"+`{"id":"l"`), 0o600); err != nil {
		t.Fatal(err)
	}
	y := cargarEmitidos(dir, salida)
	for _, id := range []string{"g", "h", "i", "j", "k"} {
		if !y.visto(id) {
			t.Fatalf("tras un reinicio, %s cuenta como encolado", id)
		}
	}
	if y.visto("c") || y.visto("l") {
		t.Fatal("lo que salió por el tope o una línea a medias no cuentan")
	}
	// Un registro a medias al final del fichero (un corte) se ignora.
	f, _ := os.OpenFile(ruta, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.Write([]byte{1, 2, 3})
	f.Close()
	if z := cargarEmitidos(dir, filepath.Join(dir, "no-existe")); !z.visto("j") {
		t.Fatal("un final a medias no estropea lo demás")
	}
}
