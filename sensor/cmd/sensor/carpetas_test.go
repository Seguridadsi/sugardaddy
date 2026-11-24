package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
)

// KEBAPS (0.33.1), sensor-2 tras actualizarse: el disco de siete trampas no se veía, la
// máquina pasó a «sin discos» y las trampas se rehicieron sin él. El sensor leía sus
// registros de la carpeta de la máquina con la posición del registro del disco: «the
// previous log is gone: anything unread in it may be missing» (lo que quedaba sin leer
// en el disco, perdido) y, al volver al disco en el arranque siguiente, otra vez lo
// mismo y el registro del disco leído desde el principio (los repetidos).
//
// Cada carpeta tiene ahora su posición y se leen las dos: cambiar de una a otra no
// pierde ni repite nada, aunque no haya ids apuntados (emitidos.go).

// sinIds olvida los ids encolados: así se ve que lo que no se repite es por la posición.
func sinIds(t *testing.T, s *sensor) {
	t.Helper()
	_ = os.Remove(filepath.Join(s.opc.Datos, ficheroEmitidos))
	_ = os.Truncate(s.salida, 0)
	s.estado.Entregado = 0
	s.emitidos = nil
	if err := s.estado.Guardar(s.opc.Datos); err != nil {
		t.Fatal(err)
	}
}

func TestCambiarDeCarpetaEntreDiscoYMaquinaNoPierdeNiRepite(t *testing.T) {
	cf := &consolaFalsa{}
	s, anfitrion := sensorDeCola(t, cf)
	g := &discos.Gestor{Datos: s.opc.Datos}
	s.opc.Discos = g
	disco := filepath.Join(discos.Registros(s.opc.Datos, "t1"), "cowrie.json")
	if err := os.MkdirAll(filepath.Dir(disco), 0o755); err != nil {
		t.Fatal(err)
	}
	// Con su disco: 40 eventos leídos.
	g.Usar("t1", true)
	escribirEventos(t, disco, 0, 40)
	s.leer()
	entregarTodo(t, s)
	// La trampa escribe 10 más en su disco y el sensor deja de verlo antes de leerlos.
	escribirEventos(t, disco, 40, 10)
	oculto := filepath.Dir(disco) + ".oculto"
	if err := os.Rename(filepath.Dir(disco), oculto); err != nil {
		t.Fatal(err)
	}
	// Se rehace sin disco: un registro nuevo en la carpeta de la máquina.
	g.Usar("t1", false)
	escribirEventos(t, anfitrion, 100, 5)
	s.leer()
	entregarTodo(t, s)
	sinIds(t, s)
	// El arranque siguiente ve el disco y la trampa vuelve a él.
	if err := os.Rename(oculto, filepath.Dir(disco)); err != nil {
		t.Fatal(err)
	}
	r := reiniciar(t, s)
	r.opc.Discos = g
	g.Usar("t1", true)
	escribirEventos(t, disco, 50, 3)
	r.leer()
	entregarTodo(t, r)
	sinIds(t, r)
	r.leer()
	entregarTodo(t, r)

	es := cf.eventos(t)
	idsUnicos(t, es)
	if len(es) != 40+5+10+3 {
		t.Fatalf("cada evento de las dos carpetas llega una vez: %d, quería %d", len(es), 58)
	}
}

func TestUnEstadoDeAntesSigueEnElDiscoPorDondeIba(t *testing.T) {
	cf := &consolaFalsa{}
	s, _ := sensorDeCola(t, cf)
	g := &discos.Gestor{Datos: s.opc.Datos}
	s.opc.Discos = g
	disco := filepath.Join(discos.Registros(s.opc.Datos, "t1"), "cowrie.json")
	_ = os.MkdirAll(filepath.Dir(disco), 0o755)
	g.Usar("t1", true)
	escribirEventos(t, disco, 0, 20)
	s.leer()
	entregarTodo(t, s)
	// Un estado de antes de las dos carpetas: la posición del disco, con el id a secas.
	e := s.estado
	clave := claveRegistro("t1", true)
	e.Leido["t1"], e.Inodos["t1"], e.Huellas["t1"], e.Modifs["t1"] = e.Leido[clave], e.Inodos[clave], e.Huellas[clave], e.Modifs[clave]
	delete(e.Leido, clave)
	delete(e.Inodos, clave)
	delete(e.Huellas, clave)
	delete(e.Modifs, clave)
	if err := e.Guardar(s.opc.Datos); err != nil {
		t.Fatal(err)
	}
	sinIds(t, s)
	r := reiniciar(t, s)
	r.opc.Discos = g
	escribirEventos(t, disco, 20, 2)
	r.leer()
	entregarTodo(t, r)
	es := cf.eventos(t)
	idsUnicos(t, es)
	if len(es) != 22 {
		t.Fatalf("sigue por donde iba: %d, quería 22", len(es))
	}
	tras, _ := estado.Cargar(r.opc.Datos)
	if _, ok := tras.Leido["t1"]; ok || tras.Leido[clave] == 0 {
		t.Fatalf("la posición se muda a la del disco: %v", tras.Leido)
	}
}
