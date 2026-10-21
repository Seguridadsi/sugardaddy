//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/consola"
	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/seguidor"
)

// TestPerforadoReal es la prueba de verdad en Linux que lanza
// herramientas/probar-disco.sh, paso a paso (SD_PERFORADO_PASO), en
// contenedores: el registro de la trampa t1 lo escribe otro usuario y el
// sensor corre como en los compose firmados (root, sin más capacidades que
// las que se le den). Sin SD_PERFORADO no hace nada.
func TestPerforadoReal(t *testing.T) {
	datos := os.Getenv("SD_PERFORADO")
	if datos == "" {
		t.Skip("solo dentro de herramientas/probar-disco.sh")
	}
	antes := cuotaRegistros
	cuotaRegistros = 1 << 20
	defer func() { cuotaRegistros = antes }()

	activo := filepath.Join(datos, "registros", "t1", "cowrie.json")
	paso := os.Getenv("SD_PERFORADO_PASO")
	if paso == "sin-perforar" {
		// En un disco que no deja perforar lo escribe la propia prueba.
		_ = os.MkdirAll(filepath.Dir(activo), 0o755)
		if err := os.WriteFile(activo, []byte(strings.Repeat(strings.Repeat("x", 1023)+"\n", 3*1024)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fi, err := os.Stat(activo)
	if err != nil {
		t.Fatal(err)
	}
	var tp plan.TrampaPlan
	tp.ID = "t1"
	tp.Manifiesto.Eventos.Fuente.Ruta = "cowrie.json"
	// El sensor ya lo ha leído entero.
	s := &sensor{
		plan: &plan.Plan{Sensor: os.Getenv("SD_PERFORADO_SENSOR"), Trampas: []plan.TrampaPlan{tp}},
		estado: &estado.Estado{
			Leido: map[string]int64{"t1": fi.Size()}, Huellas: map[string]string{}, Modifs: map[string]int64{},
			Inodos: map[string]uint64{"t1": seguidor.InodoDe(fi)},
		},
	}
	s.opc.Datos = datos
	parada := false
	s.pararTrampa = func(string) error { parada = true; return nil }
	if paso == "sin-permiso" {
		// Con la trampa de verdad, por el socket de Docker, como el sensor.
		d := docker.Nuevo("/var/run/docker.sock")
		s.pararTrampa = func(id string) error {
			ctx, cancelar := context.WithTimeout(context.Background(), time.Minute)
			defer cancelar()
			parada = true
			return despliegue.Parar(ctx, d, s.plan.Sensor, id)
		}
	}

	s.vigilarCuota(time.Now())
	switch paso {
	case "con-permiso":
		fi2, _ := os.Stat(activo)
		if len(s.estado.Paradas) != 0 || parada {
			t.Fatalf("con DAC_OVERRIDE el sensor perfora y la trampa sigue: %v", s.estado.Paradas)
		}
		if ocupado(fi2) >= ocupado(fi)/2 || fi2.Size() != fi.Size() {
			t.Fatalf("lo leído se libera sin cambiar el tamaño: ocupaba %d, ocupa %d", ocupado(fi), ocupado(fi2))
		}
		t.Logf("liberados %d KB del registro de otro usuario, con la trampa en marcha", (ocupado(fi)-ocupado(fi2))>>10)
		return
	case "sin-permiso", "sin-perforar":
		causa := map[string]string{"sin-permiso": causaSinPermiso, "sin-perforar": causaSinPerforar}[paso]
		if !parada || !strings.Contains(s.estado.Paradas["t1"], "cuota superada ("+causa+")") {
			t.Fatalf("la trampa se para con «cuota superada» y su motivo: %v", s.estado.Paradas)
		}
		t.Logf("parada: %s", s.estado.Paradas["t1"])
	default:
		t.Fatalf("paso desconocido: %q", paso)
	}
	// Parada y leída entera: su registro se quita (sin perforar ni permiso
	// sobre el fichero) y vuelve.
	s.vigilarCuota(time.Now())
	if _, err := os.Stat(activo); !os.IsNotExist(err) {
		t.Fatalf("parada y leída entera, su registro se quita: %v", err)
	}
	if len(s.estado.Paradas) != 0 {
		t.Fatalf("y la trampa vuelve: %v", s.estado.Paradas)
	}
}

// TestColaSinDiscoReal lo lanza herramientas/probar-disco.sh en un contenedor
// con un tmpfs pequeño en SD_COLA: con el disco lleno de verdad, la escritura
// de la cola falla a medias. La cola tiene que quedar como estaba (sin media
// línea), la lectura seguir y lo descartado llegar resumido cuando hay disco.
func TestColaSinDiscoReal(t *testing.T) {
	datos := os.Getenv("SD_COLA")
	if datos == "" {
		t.Skip("solo dentro de herramientas/probar-disco.sh")
	}
	registro := filepath.Join(datos, "registros", "t1", "cowrie.json")
	if err := os.MkdirAll(filepath.Dir(registro), 0o755); err != nil {
		t.Fatal(err)
	}
	e, _ := estado.Cargar(datos)
	s := &sensor{
		estado: e, salida: filepath.Join(datos, "salida.jsonl"), ritmo: ritmo{},
		plan: &plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampaDeCola()}},
	}
	s.opc.Datos = datos
	// Lo que ya estaba en la cola antes de quedarse sin disco.
	escribirEventos(t, registro, 0, 5)
	s.leer()
	antes, _ := os.ReadFile(s.salida)

	escribirEventos(t, registro, 5, 1500)
	// Se llena el disco y se deja un hueco de 64 KB: la escritura de la cola
	// (más de 1 MB) empieza y se queda sin sitio a medias.
	relleno := filepath.Join(datos, "relleno")
	f, err := os.Create(relleno)
	if err != nil {
		t.Fatal(err)
	}
	trozo := make([]byte, 64<<10)
	for {
		if _, err := f.Write(trozo); err != nil {
			break
		}
	}
	fi, _ := f.Stat()
	_ = f.Truncate(fi.Size() - 64<<10)
	f.Close()

	s.leer()
	leido, _ := os.Stat(registro)
	if s.estado.Leido["t1"] != leido.Size() {
		t.Fatalf("sin disco la lectura sigue: leído %d de %d", s.estado.Leido["t1"], leido.Size())
	}
	if ahora, _ := os.ReadFile(s.salida); !bytes.Equal(ahora, antes) {
		t.Fatalf("la escritura a medias se deshace: la cola tiene %d bytes, tenía %d", len(ahora), len(antes))
	}
	if s.descartes["t1"] == nil || s.descartes["t1"].Resumen.N != 1500 {
		t.Fatalf("lo de esa vuelta se descarta y se resume: %+v", s.descartes["t1"])
	}

	// Vuelve a haber disco: tras lo que había, el resumen y lo nuevo, en una cadena entera.
	_ = os.Remove(relleno)
	escribirEventos(t, registro, 1505, 3)
	s.leer()
	b, _ := os.ReadFile(s.salida)
	lineas := bytes.Split(bytes.TrimSuffix(b, []byte("\n")), []byte("\n"))
	if i := evento.Verificar(lineas); i >= 0 || len(lineas) != 5+1+3 {
		t.Fatalf("la cola sigue la cadena (rota en %d) con lo que había, el resumen y lo nuevo: %d líneas", i, len(lineas))
	}
	var r evento.Evento
	_ = json.Unmarshal(lineas[5], &r)
	if r.Detalle["codigo"] != "cola.sin-disco" || r.Detalle["descartados"].(float64) != 1500 {
		t.Fatalf("el resumen va tras lo que había y cuenta lo descartado: %v", r.Detalle)
	}
	t.Logf("sin disco: 1500 eventos descartados y resumidos; la cola, intacta")
}

// TestColaPocoDiscoReal lo lanza herramientas/probar-disco.sh en un contenedor
// con un tmpfs de 8 MB en SD_COLA_POCO: con tan poco disco libre, el tope de
// la cola es de 1 MB. Con la consola sana, un goteo de eventos llega entero (la
// cola no se atasca en su tope) y lo que llega de golpe y no cabe se resume
// con cola.poco-disco, no con cola.llena.
func TestColaPocoDiscoReal(t *testing.T) {
	datos := os.Getenv("SD_COLA_POCO")
	if datos == "" {
		t.Skip("solo dentro de herramientas/probar-disco.sh")
	}
	if libre, conocido := libreEn(datos); !conocido || topeCola(libre, 0, true) != colaMin {
		t.Fatalf("con %d bytes libres el tope de la cola tenía que ser de 1 MB", libre)
	}
	registro := filepath.Join(datos, "registros", "t1", "cowrie.json")
	if err := os.MkdirAll(filepath.Dir(registro), 0o755); err != nil {
		t.Fatal(err)
	}
	cf := &consolaFalsa{}
	srv := httptest.NewServer(cf)
	defer srv.Close()
	e, _ := estado.Cargar(datos)
	s := &sensor{
		consola: consola.Nuevo(srv.URL, "token"), estado: e, salida: filepath.Join(datos, "salida.jsonl"), ritmo: ritmo{},
		plan: &plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampaDeCola()}},
	}
	s.opc.Datos = datos

	// Un goteo de unos 2 MB, el doble del tope, de un evento por vuelta.
	const n = 250
	for i := 0; i < n; i++ {
		escribirEventosDe(t, registro, i, 1, 8000)
		s.leer()
		s.entregar(context.Background())
	}
	if len(s.descartes) != 0 || len(cf.eventos(t)) != n {
		t.Fatalf("con la consola sana el goteo llega entero: %d de %d, %d trampas con descartes", len(cf.eventos(t)), n, len(s.descartes))
	}

	// De golpe, más de lo que cabe en la cola.
	escribirEventos(t, registro, n, 2000)
	s.leer()
	if d := s.descartes["t1"]; d == nil || d.Codigo() != "cola.poco-disco" {
		t.Fatalf("lo que no cabe se resume por el poco disco: %+v", d)
	}
	t.Logf("poco disco: el goteo llega entero y lo que no cabe va como cola.poco-disco (%d descartados)", s.descartes["t1"].Resumen.N)
}
