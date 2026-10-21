package main

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/seguidor"
)

func escribir(t *testing.T, contenido string) string {
	t.Helper()
	ruta := filepath.Join(t.TempDir(), "salida.jsonl")
	if err := os.WriteFile(ruta, []byte(contenido), 0o600); err != nil {
		t.Fatal(err)
	}
	return ruta
}

func TestUltimaLinea(t *testing.T) {
	larga := strings.Repeat("x", 200*1024)
	casos := []struct {
		nombre, contenido, ultima string
		completa                  int64
	}{
		{"vacía", "", "", 0},
		{"una", "a\n", "a", 2},
		{"varias", "a\nbb\nccc\n", "ccc", 9},
		{"media línea al final", "a\nbb\ncc", "bb", 5},
		{"solo media línea", "abc", "", 0},
		{"línea más larga que un trozo", "a\n" + larga + "\n", larga, int64(2 + len(larga) + 1)},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			f, err := os.Open(escribir(t, c.contenido))
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			l, completa, err := ultimaLinea(f)
			if err != nil {
				t.Fatal(err)
			}
			if string(l) != c.ultima || completa != c.completa {
				t.Fatalf("ultima=%q (%d), quería %q (%d)", l[:min(len(l), 20)], completa, c.ultima[:min(len(c.ultima), 20)], c.completa)
			}
		})
	}
}

func TestRetomarCadena(t *testing.T) {
	// El sensor se apagó tras escribir dos líneas y media, con el estado guardado tras la primera.
	l1, l2 := `{"n":1}`, `{"n":2}`
	ruta := escribir(t, l1+"\n"+l2+"\n"+`{"n":`)
	s := &sensor{
		salida: ruta,
		estado: &estado.Estado{Leido: map[string]int64{}, UltimoHash: evento.Hash([]byte(l1))},
	}
	s.opc.Datos = filepath.Dir(ruta)
	if err := s.retomarCadena(); err != nil {
		t.Fatal(err)
	}
	if s.estado.UltimoHash != evento.Hash([]byte(l2)) {
		t.Fatal("la cadena tiene que seguir desde la última línea completa escrita")
	}
	b, _ := os.ReadFile(ruta)
	if string(b) != l1+"\n"+l2+"\n" {
		t.Fatalf("la media línea tenía que recortarse: %q", b)
	}
	// Una segunda vez no cambia nada.
	if err := s.retomarCadena(); err != nil {
		t.Fatal(err)
	}
}

func TestLoteDe(t *testing.T) {
	l := func(n int) []byte { return []byte(strings.Repeat("x", n)) }
	cola := [][]byte{l(100), l(100), l(100), l(100)}
	if got := len(loteDe(cola, 500, 1<<20)); got != 4 {
		t.Fatalf("todo cabe: %d", got)
	}
	if got := len(loteDe(cola, 2, 1<<20)); got != 2 {
		t.Fatalf("tope de líneas: %d", got)
	}
	if got := len(loteDe(cola, 500, 250)); got != 2 {
		t.Fatalf("tope de bytes (101+101 <= 250 < 303): %d", got)
	}
	if got := len(loteDe([][]byte{l(1000)}, 500, 10)); got != 1 {
		t.Fatalf("una línea sola siempre sale: %d", got)
	}
}

func TestLaColaEntregadaEnteraSeVacia(t *testing.T) {
	datos := t.TempDir()
	ruta := filepath.Join(datos, "salida.jsonl")
	contenido := strings.Repeat(strings.Repeat("x", 1023)+"\n", 1100)
	_ = os.WriteFile(ruta, []byte(contenido), 0o600)
	s := &sensor{salida: ruta, estado: &estado.Estado{Leido: map[string]int64{}, Entregado: int64(len(contenido)) - 1024}}
	s.opc.Datos = datos
	s.vaciarCola()
	if fi, _ := os.Stat(ruta); fi.Size() != int64(len(contenido)) {
		t.Fatal("con algo sin entregar no se toca")
	}
	s.estado.Entregado = int64(len(contenido))
	s.vaciarCola()
	if fi, _ := os.Stat(ruta); fi.Size() != 0 || s.estado.Entregado != 0 {
		t.Fatalf("entregada entera, se vacía: %d bytes, entregado %d", fi.Size(), s.estado.Entregado)
	}
	if e, _ := estado.Cargar(datos); e.Entregado != 0 {
		t.Fatal("el estado se guarda antes de vaciar")
	}
}

func TestPodarRegistrosViejos(t *testing.T) {
	datos := t.TempDir()
	ahora := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	fichero := func(ruta string, edad time.Duration) {
		_ = os.MkdirAll(filepath.Dir(ruta), 0o755)
		_ = os.WriteFile(ruta, []byte("x\n"), 0o644)
		_ = os.Chtimes(ruta, ahora.Add(-edad), ahora.Add(-edad))
	}
	dia := 24 * time.Hour
	fichero(filepath.Join(datos, "registros", "t1", "cowrie.json"), 0)
	fichero(filepath.Join(datos, "registros", "t1", "cowrie.json.2026_10_01"), 15*dia)
	fichero(filepath.Join(datos, "registros", "t1", "cowrie.json.2026_10_15"), dia)
	fichero(filepath.Join(datos, "registros", "vieja", "cowrie.json"), 40*dia)
	fichero(filepath.Join(datos, "config", "vieja", "0"), 40*dia)
	fichero(filepath.Join(datos, "registros", "reciente", "cowrie.json"), 2*dia)

	var tp plan.TrampaPlan
	tp.ID = "t1"
	tp.Manifiesto.Eventos.Fuente.Ruta = "cowrie.json"
	inodo := func(p ...string) uint64 {
		fi, _ := os.Stat(filepath.Join(append([]string{datos}, p...)...))
		return seguidor.InodoDe(fi)
	}
	s := &sensor{plan: &plan.Plan{Trampas: []plan.TrampaPlan{tp}}, estado: &estado.Estado{
		Leido: map[string]int64{"vieja": 9}, Huellas: map[string]string{},
		// El sensor va por el registro activo: los rotados ya están leídos.
		Inodos: map[string]uint64{"t1": inodo("registros", "t1", "cowrie.json")},
	}}
	s.opc.Datos = datos
	s.podar(ahora)

	existe := func(p ...string) bool {
		_, err := os.Stat(filepath.Join(append([]string{datos}, p...)...))
		return err == nil
	}
	if !existe("registros", "t1", "cowrie.json") {
		t.Fatal("el registro que se está leyendo no se toca nunca")
	}
	if existe("registros", "t1", "cowrie.json.2026_10_01") || !existe("registros", "t1", "cowrie.json.2026_10_15") {
		t.Fatal("los rotados se guardan una semana")
	}
	if existe("registros", "vieja") || existe("config", "vieja") || !existe("registros", "reciente") {
		t.Fatal("las carpetas de trampas retiradas se guardan un mes")
	}
	if _, ok := s.estado.Leido["vieja"]; ok {
		t.Fatal("y su offset se olvida")
	}

	// Si el sensor va por un rotado a medias (estuvo parado), los más nuevos
	// que él aún no se han leído: no se tocan, por viejos que sean.
	fichero(filepath.Join(datos, "registros", "t1", "cowrie.json.2026_09_01"), 45*dia)
	fichero(filepath.Join(datos, "registros", "t1", "cowrie.json.2026_09_02"), 44*dia)
	s.estado.Inodos["t1"] = inodo("registros", "t1", "cowrie.json.2026_09_01")
	s.podar(ahora)
	if !existe("registros", "t1", "cowrie.json.2026_09_01") || !existe("registros", "t1", "cowrie.json.2026_09_02") {
		t.Fatal("no se borra lo que queda por leer")
	}
}

func TestSondaDelAislamiento(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	dir := l.Addr().String()
	l.Close()
	go escuchar(dir, 3*time.Second)
	if sondear(dir) != 0 {
		t.Fatal("con alguien escuchando, llega")
	}
	// Rechazada: el paquete llegó al otro lado, así que tampoco hay aislamiento.
	l2, _ := net.Listen("tcp", "127.0.0.1:0")
	cerrado := l2.Addr().String()
	l2.Close()
	if sondear(cerrado) != 0 {
		t.Fatal("una conexión rechazada cuenta como que llega")
	}
}

func TestCuotaDeRegistrosPorTrampa(t *testing.T) {
	datos := t.TempDir()
	dir := filepath.Join(datos, "registros", "t1")
	_ = os.MkdirAll(dir, 0o755)
	ahora := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	antes := cuotaRegistros
	cuotaRegistros = 1536 << 10
	defer func() { cuotaRegistros = antes }()
	// Con datos de verdad: la cuota cuenta lo que se ocupa en disco.
	grande := func(nombre string, kb int, edad time.Duration) {
		ruta := filepath.Join(dir, nombre)
		_ = os.WriteFile(ruta, []byte(strings.Repeat("x", kb<<10)), 0o644)
		_ = os.Chtimes(ruta, ahora.Add(-edad), ahora.Add(-edad))
	}
	// Tres días de ataque sin parar, ya leídos, que juntos pasan de la cuota.
	grande("cowrie.json.2026_10_13", 1024, 3*24*time.Hour)
	grande("cowrie.json.2026_10_14", 1024, 2*24*time.Hour)
	grande("cowrie.json.2026_10_15", 1024, 24*time.Hour)
	grande("cowrie.json", 100, 0)
	fi, _ := os.Stat(filepath.Join(dir, "cowrie.json"))
	var tp plan.TrampaPlan
	tp.ID = "t1"
	tp.Manifiesto.Eventos.Fuente.Ruta = "cowrie.json"
	s := &sensor{plan: &plan.Plan{Trampas: []plan.TrampaPlan{tp}}, estado: &estado.Estado{
		Leido: map[string]int64{}, Huellas: map[string]string{}, Inodos: map[string]uint64{"t1": seguidor.InodoDe(fi)},
	}}
	s.opc.Datos = datos
	s.podar(ahora)
	var quedan []string
	entradas, _ := os.ReadDir(dir)
	for _, e := range entradas {
		quedan = append(quedan, e.Name())
	}
	if strings.Join(quedan, ",") != "cowrie.json,cowrie.json.2026_10_15" {
		t.Fatalf("por encima de la cuota se borran los rotados leídos más viejos: %v", quedan)
	}
}

func TestLoLeidoDelRegistroActivoSeLiberaSinTocarSuPosicion(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("perforar ficheros solo se hace en Linux")
	}
	antes := cuotaRegistros
	cuotaRegistros = 1 << 20
	defer func() { cuotaRegistros = antes }()
	datos := t.TempDir()
	dir := filepath.Join(datos, "registros", "t1")
	_ = os.MkdirAll(dir, 0o755)
	activo := filepath.Join(dir, "cowrie.json")
	// El honeypot escribe sin O_APPEND (como Cowrie con su registro diario): 3 MB ya leídos.
	f, _ := os.OpenFile(activo, os.O_CREATE|os.O_RDWR, 0o644)
	linea := []byte(strings.Repeat("x", 1023) + "\n")
	for i := 0; i < 3*1024; i++ {
		_, _ = f.Write(linea)
	}
	fi, _ := os.Stat(activo)
	var tp plan.TrampaPlan
	tp.ID = "t1"
	tp.Manifiesto.Eventos.Fuente.Ruta = "cowrie.json"
	s := &sensor{plan: &plan.Plan{Trampas: []plan.TrampaPlan{tp}}, estado: &estado.Estado{
		Leido: map[string]int64{"t1": fi.Size()}, Huellas: map[string]string{"t1": "h"}, Modifs: map[string]int64{},
		Inodos: map[string]uint64{"t1": seguidor.InodoDe(fi)},
	}}
	s.opc.Datos = datos
	s.vigilarCuota(time.Now())
	fi2, _ := os.Stat(activo)
	if ocupado(fi2) >= ocupado(fi)/2 || fi2.Size() != fi.Size() || s.estado.Leido["t1"] != fi.Size() || s.estado.Huellas["t1"] != "h" {
		t.Fatalf("se libera lo leído sin cambiar tamaño ni posición: ocupaba %d, ocupa %d, tamaño %d→%d", ocupado(fi), ocupado(fi2), fi.Size(), fi2.Size())
	}
	// El honeypot sigue escribiendo en su sitio y el sensor lo lee desde donde iba.
	_, _ = f.Write([]byte("{\"nuevo\":1}\n"))
	f.Close()
	lineas, _, _, err := seguidor.Seguir(activo, seguidor.Posicion{Inodo: s.estado.Inodos["t1"], Offset: s.estado.Leido["t1"], Huella: ""})
	if err != nil || len(lineas) != 1 || string(lineas[0]) != `{"nuevo":1}` {
		t.Fatalf("tras liberar, lo nuevo se lee a la primera: %q %v", lineas, err)
	}
}
