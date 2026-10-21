package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

func TestTopeCola(t *testing.T) {
	const mb = 1 << 20
	casos := []struct {
		nombre      string
		libre, cola int64
		conocido    bool
		tope        int64
	}{
		{"disco de sobra", 500 << 30, 0, true, 256 * mb},
		{"máquina pequeña con 2 GB libres", 2000 * mb, 0, true, 200 * mb},
		{"lo que ocupa la cola cuenta como suyo", 1500 * mb, 500 * mb, true, 200 * mb},
		{"disco casi lleno", 3 * mb, 0, true, mb},
		{"sin saber cuánto queda", 0, 0, false, 64 * mb},
	}
	for _, c := range casos {
		if got := topeCola(c.libre, c.cola, c.conocido); got != c.tope {
			t.Errorf("%s: %d MB, quería %d MB", c.nombre, got/mb, c.tope/mb)
		}
	}
}

// consolaFalsa recibe entregas como la de verdad: comprueba la cadena y las
// guarda. Caída, responde 503.
type consolaFalsa struct {
	mu       sync.Mutex
	caida    bool
	lineas   [][]byte
	anterior string
}

func (c *consolaFalsa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.caida || r.URL.Path != "/api/sensor/eventos" {
		http.Error(w, "caída", http.StatusServiceUnavailable)
		return
	}
	b, _ := io.ReadAll(r.Body)
	n := 0
	for _, l := range bytes.Split(bytes.TrimSuffix(b, []byte("\n")), []byte("\n")) {
		c.lineas = append(c.lineas, append([]byte(nil), l...))
		n++
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "aceptadas": n})
}

func (c *consolaFalsa) eventos(t *testing.T) []evento.Evento {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if i := evento.Verificar(c.lineas); i >= 0 {
		t.Fatalf("la cadena que recibe la consola se rompe en la línea %d", i)
	}
	var es []evento.Evento
	for _, l := range c.lineas {
		var e evento.Evento
		if err := json.Unmarshal(l, &e); err != nil {
			t.Fatal(err)
		}
		es = append(es, e)
	}
	return es
}

// trampaDeCola es una trampa cuyo registro da un evento por línea, cada uno de
// un minuto distinto (los topes por minuto no omiten ninguno).
func trampaDeCola() plan.TrampaPlan {
	var tp plan.TrampaPlan
	tp.ID, tp.Manifiesto.ID, tp.Manifiesto.Tipo = "t1", "cowrie", "contenedor"
	ev := &tp.Manifiesto.Eventos
	ev.Fuente.Ruta = "cowrie.json"
	ev.Campos.Cuando, ev.Campos.IP = "timestamp", "src_ip"
	ev.Accion.Campo, ev.Accion.PorDefecto = "eventid", "otra"
	ev.Accion.Valores = map[string]string{"login": "autenticacion"}
	ev.Severidad.PorDefecto = "baja"
	ev.Severidad.PorValor = map[string]string{"login": "alta"}
	return tp
}

// escribirEventos añade n líneas al registro de la trampa, desde el evento k.
func escribirEventos(t *testing.T, ruta string, k, n int) {
	t.Helper()
	escribirEventosDe(t, ruta, k, n, 300)
}

// escribirEventosDe es escribirEventos con líneas de un relleno dado.
func escribirEventosDe(t *testing.T, ruta string, k, n, relleno int) {
	t.Helper()
	f, err := os.OpenFile(ruta, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	inicio := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for i := k; i < k+n; i++ {
		id := "conexion"
		if i%10 == 0 {
			id = "login"
		}
		fmt.Fprintf(w, `{"eventid":%q,"timestamp":%q,"src_ip":"10.0.%d.%d","relleno":"%0*d"}`+"\n",
			id, inicio.Add(time.Duration(i)*time.Minute).Format(time.RFC3339), i/250%250, i%250, relleno, i)
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
}

func sensorDeCola(t *testing.T, cf *consolaFalsa) (*sensor, string) {
	t.Helper()
	datos := t.TempDir()
	dir := filepath.Join(datos, "registros", "t1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(cf)
	t.Cleanup(srv.Close)
	e, _ := estado.Cargar(datos)
	s := &sensor{
		consola: consola.Nuevo(srv.URL, "token"),
		estado:  e,
		salida:  filepath.Join(datos, "salida.jsonl"),
		plan:    &plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampaDeCola()}},
		ritmo:   ritmo{},
	}
	s.opc.Datos = datos
	return s, filepath.Join(dir, "cowrie.json")
}

// conDiscoLibre fija el disco libre que ve el sensor (tope de la cola: 1 MB).
func conDiscoLibre(t *testing.T, libre int64) {
	t.Helper()
	antes := espacioLibre
	espacioLibre = func(string) (int64, bool) { return libre, true }
	t.Cleanup(func() { espacioLibre = antes })
}

func tamCola(s *sensor) int64 {
	fi, err := os.Stat(s.salida)
	if err != nil {
		return 0
	}
	return fi.Size()
}

// entregarTodo entrega la cola hasta el final (y la vacía, si toca).
func entregarTodo(t *testing.T, s *sensor) {
	t.Helper()
	for i := 0; i < 1000 && (tamCola(s) == 0 || s.estado.Entregado < tamCola(s)); i++ {
		if tamCola(s) == 0 {
			return
		}
		s.pausa = time.Time{}
		s.entregar(context.Background())
	}
}

func TestConLaConsolaCaidaLaColaNoPasaDeSuTopeYDejaSuResumen(t *testing.T) {
	conDiscoLibre(t, 0)
	cf := &consolaFalsa{caida: true}
	s, registro := sensorDeCola(t, cf)

	// La consola cae con unos eventos en la cola, que caben...
	escribirEventos(t, registro, 0, 500)
	s.leer()
	s.entregar(context.Background())
	if len(s.descartes) != 0 {
		t.Fatal("lo primero cabe en la cola")
	}
	// ...y llega una avalancha: unos 3 MB de eventos para una cola de 1 MB.
	escribirEventos(t, registro, 500, 5500)
	for i := 0; i < 5; i++ {
		s.leer()
		s.entregar(context.Background())
	}
	fi, _ := os.Stat(registro)
	if s.estado.Leido["t1"] != fi.Size() {
		t.Fatalf("la lectura no se para con la cola llena: leído %d de %d", s.estado.Leido["t1"], fi.Size())
	}
	if tamCola(s) > colaMin {
		t.Fatalf("la cola pasa de su tope: %d bytes", tamCola(s))
	}
	d := s.descartes["t1"]
	if d == nil || d.Resumen.N == 0 {
		t.Fatal("lo que no cabe se apunta para su resumen")
	}
	// Lo descartado se guarda en el estado: un reinicio no lo pierde.
	tras := &sensor{}
	tras.estado, _ = estado.Cargar(s.opc.Datos)
	tras.retomarDescartes()
	if r := tras.descartes["t1"]; r == nil || r.Resumen.N != d.Resumen.N || r.Modulo != "cowrie" || len(r.Resumen.Muestra) == 0 {
		t.Fatalf("tras un reinicio, lo descartado sigue pendiente de resumir: %+v", r)
	}
	b, _ := os.ReadFile(s.salida)
	enCola := bytes.Count(b, []byte("\n"))
	if i := evento.Verificar(bytes.Split(bytes.TrimSuffix(b, []byte("\n")), []byte("\n"))); i >= 0 {
		t.Fatalf("lo descartado no entra en la cadena: se rompe en la línea %d", i)
	}

	// La avalancha sigue: la cola no crece y lo ya aceptado no se toca.
	escribirEventos(t, registro, 6000, 1000)
	s.leer()
	if b2, _ := os.ReadFile(s.salida); !bytes.Equal(b, b2) {
		t.Fatal("con la cola llena no entra nada nuevo ni se pierde nada de lo que había")
	}

	// Vuelve la consola: recibe la cola entera, la cola se vacía y el resumen va primero.
	cf.mu.Lock()
	cf.caida = false
	cf.mu.Unlock()
	entregarTodo(t, s)
	if tamCola(s) != 0 {
		t.Fatalf("entregada entera y con descartes, la cola se vacía aunque sea pequeña: %d bytes", tamCola(s))
	}
	escribirEventos(t, registro, 7000, 5)
	s.leer()
	entregarTodo(t, s)

	es := cf.eventos(t)
	if len(es) != enCola+1+5 {
		t.Fatalf("la consola recibe lo que había en la cola, el resumen y lo nuevo: %d, quería %d", len(es), enCola+6)
	}
	r := es[enCola]
	if r.Detalle["codigo"] != "cola.llena" || r.Trampa.ID != "t1" || r.Accion != "otra" {
		t.Fatalf("tras lo que había, el resumen de lo descartado: %+v", r)
	}
	if aviso, _ := r.Detalle["aviso"].(string); !strings.Contains(aviso, "consola") {
		t.Fatalf("con la consola caída, el aviso habla de la consola: %q", aviso)
	}
	descartados := int(r.Detalle["descartados"].(float64))
	if enCola+descartados != 7000 {
		t.Fatalf("el resumen cuenta exactamente lo descartado: %d en la cola + %d descartados, quería 7000", enCola, descartados)
	}
	if r.Severidad != "alta" || r.Detalle["muestra"] == nil {
		t.Fatalf("con logins descartados, el resumen es alto y lleva muestra: %s %v", r.Severidad, r.Detalle["muestra"])
	}
	if r.Detalle["desde"] == "" || r.Detalle["hasta"] == r.Detalle["desde"] {
		t.Fatalf("el resumen dice de cuándo es lo descartado: %v → %v", r.Detalle["desde"], r.Detalle["hasta"])
	}
	if len(s.descartes) != 0 || len(s.estado.Descartados) != 0 {
		t.Fatal("ya resumido, se olvida")
	}
}

func TestSinDiscoParaLaColaLaLecturaSigue(t *testing.T) {
	conDiscoLibre(t, 0)
	cf := &consolaFalsa{}
	s, registro := sensorDeCola(t, cf)
	antes := anadirACola
	anadirACola = func(string, int64, [][]byte) error {
		return &os.PathError{Op: "write", Path: "salida.jsonl", Err: syscall.ENOSPC}
	}
	defer func() { anadirACola = antes }()

	// Más de lo que cabe en la cola (1 MB): unos caben y otros no, y no hay disco para ninguno.
	escribirEventos(t, registro, 0, 2000)
	s.leer()
	fi, _ := os.Stat(registro)
	if s.estado.Leido["t1"] != fi.Size() || tamCola(s) != 0 {
		t.Fatalf("sin disco la lectura sigue: leído %d de %d", s.estado.Leido["t1"], fi.Size())
	}
	if s.descartes["t1"] == nil || s.descartes["t1"].Resumen.N != 2000 || s.estado.UltimoHash != evento.Genesis {
		t.Fatalf("lo de esa vuelta se descarta, sin avanzar la cadena: %+v %q", s.descartes["t1"], s.estado.UltimoHash)
	}

	// Vuelve a haber disco: primero el resumen, después lo nuevo.
	anadirACola = antes
	escribirEventos(t, registro, 2000, 3)
	s.leer()
	entregarTodo(t, s)
	es := cf.eventos(t)
	if len(es) != 4 || es[0].Detalle["codigo"] != "cola.sin-disco" || es[0].Detalle["descartados"].(float64) != 2000 {
		t.Fatalf("el resumen, que dice que faltaba disco, va antes que lo nuevo: %d eventos", len(es))
	}
	if aviso, _ := es[0].Detalle["aviso"].(string); !strings.Contains(aviso, "disco") {
		t.Fatalf("el aviso dice que faltaba disco, no que la consola no recogía: %q", aviso)
	}
}

func TestLaColaConDescartesSeVaciaAunqueSeaPequena(t *testing.T) {
	datos := t.TempDir()
	ruta := filepath.Join(datos, "salida.jsonl")
	_ = os.WriteFile(ruta, []byte("{}\n{}\n"), 0o600)
	s := &sensor{salida: ruta, estado: &estado.Estado{Leido: map[string]int64{}, Entregado: 6}}
	s.opc.Datos = datos
	s.vaciarCola()
	if tamCola(s) != 6 {
		t.Fatal("sin descartes, una cola pequeña entregada no se vacía")
	}
	s.descartes = descartes{"t1": &descarte{Trampa: "t1"}}
	s.vaciarCola()
	if tamCola(s) != 0 || s.estado.Entregado != 0 {
		t.Fatal("con descartes se vacía para que entre su resumen")
	}
}

// Con el disco casi lleno (tope de 1 MB) y la consola sana, un goteo de un
// evento por vuelta no deja la cola atascada en su tope: la consola los
// recibe todos y no se descarta ninguno.
func TestConPocoDiscoYLaConsolaSanaElGoteoLlegaEntero(t *testing.T) {
	conDiscoLibre(t, 0)
	cf := &consolaFalsa{}
	s, registro := sensorDeCola(t, cf)
	const n = 250 // de unos 8 KB cada uno: el doble del tope
	for i := 0; i < n; i++ {
		escribirEventosDe(t, registro, i, 1, 8000)
		s.leer()
		s.entregar(context.Background())
	}
	if len(s.descartes) != 0 {
		t.Fatalf("con la consola sana no se descarta nada: %d trampas con descartes", len(s.descartes))
	}
	if es := cf.eventos(t); len(es) != n {
		t.Fatalf("la consola recibe todos los eventos: %d de %d", len(es), n)
	}
}

// Si la cola se queda entregada entera, sin vaciar y con descartes pendientes
// (llegó a su tope después de la última entrega), se vacía aunque no haya nada
// nuevo que entregar, también tras un reinicio: si no, no volvería a entrar
// nada, ni el resumen, aunque la consola esté bien.
func TestLaColaEntregadaConDescartesSeVaciaSinNadaNuevoQueEntregar(t *testing.T) {
	conDiscoLibre(t, 0)
	cf := &consolaFalsa{caida: true}
	s, registro := sensorDeCola(t, cf)
	escribirEventos(t, registro, 0, 3000)
	s.leer()
	if len(s.descartes) == 0 {
		t.Fatal("la cola tenía que llegar a su tope")
	}
	// La consola ya tiene toda la cola, pero la cola sigue ahí.
	b, _ := os.ReadFile(s.salida)
	enCola := bytes.Count(b, []byte("\n"))
	cf.mu.Lock()
	cf.caida = false
	for _, l := range bytes.Split(bytes.TrimSuffix(b, []byte("\n")), []byte("\n")) {
		cf.lineas = append(cf.lineas, append([]byte(nil), l...))
	}
	cf.mu.Unlock()
	s.estado.Entregado = int64(len(b))
	s.guardar()

	// Se reinicia el sensor.
	tras := &sensor{consola: s.consola, salida: s.salida, plan: s.plan, ritmo: ritmo{}, opc: s.opc}
	tras.estado, _ = estado.Cargar(s.opc.Datos)
	tras.retomarDescartes()
	if err := tras.retomarCadena(); err != nil {
		t.Fatal(err)
	}
	// Goteo de un evento por vuelta: el primero no cabe (la cola sigue llena),
	// pero la cola, entregada entera, se vacía para que entre el resumen.
	escribirEventos(t, registro, 3000, 1)
	tras.leer()
	tras.entregar(context.Background())
	if tamCola(tras) != 0 {
		t.Fatalf("entregada entera y con descartes, se vacía sin esperar a otra entrega: %d bytes", tamCola(tras))
	}
	for i := 1; i < 5; i++ {
		escribirEventos(t, registro, 3000+i, 1)
		tras.leer()
		tras.entregar(context.Background())
	}
	es := cf.eventos(t)
	if len(es) != enCola+1+4 {
		t.Fatalf("la consola recibe lo que había, el resumen y lo nuevo: %d, quería %d", len(es), enCola+5)
	}
	r := es[enCola]
	codigo, _ := r.Detalle["codigo"].(string)
	if !strings.HasPrefix(codigo, "cola.") || enCola+int(r.Detalle["descartados"].(float64)) != 3001 {
		t.Fatalf("tras lo que había, el resumen de todo lo descartado: %v", r.Detalle)
	}
	if len(tras.descartes) != 0 {
		t.Fatal("ya resumido, se olvida")
	}
}

// Con poco disco libre (tope de 1 MB) y la consola sana, lo que llega de golpe
// y no cabe se resume con cola.poco-disco: el aviso pide liberar disco y no
// culpa a la consola.
func TestConPocoDiscoYLaConsolaSanaLoQueNoCabeEsCulpaDelDisco(t *testing.T) {
	conDiscoLibre(t, 5<<20)
	cf := &consolaFalsa{}
	s, registro := sensorDeCola(t, cf)
	// La consola va recogiendo, pero aún le queda algo por recoger...
	escribirEventos(t, registro, 0, 600)
	s.leer()
	s.entregar(context.Background())
	if s.estado.Entregado == 0 || s.estado.Entregado >= tamCola(s) {
		t.Fatalf("una entrega se lleva solo una parte: %d de %d", s.estado.Entregado, tamCola(s))
	}
	// ...cuando llega de golpe, en una vuelta, más de lo que cabe (1,4 MB).
	escribirEventos(t, registro, 600, 2000)
	s.leer()
	if d := s.descartes["t1"]; d == nil || d.Codigo() != "cola.poco-disco" {
		t.Fatalf("lo que no cabe se descarta, por el poco disco: %+v", d)
	}
	entregarTodo(t, s)
	escribirEventos(t, registro, 2600, 3)
	s.leer()
	entregarTodo(t, s)

	var r *evento.Evento
	es := cf.eventos(t)
	for i := range es {
		if c, _ := es[i].Detalle["codigo"].(string); strings.HasPrefix(c, "cola.") {
			r = &es[i]
		}
	}
	if r == nil {
		t.Fatal("la consola recibe el resumen de lo descartado")
	}
	aviso, _ := r.Detalle["aviso"].(string)
	if r.Detalle["codigo"] != "cola.poco-disco" || !strings.Contains(aviso, "liberar espacio") || strings.Contains(aviso, "no recogió") {
		t.Fatalf("el resumen dice que faltaba disco, no que la consola no recogía: %v %q", r.Detalle["codigo"], aviso)
	}
	if len(es) != 2600-int(r.Detalle["descartados"].(float64))+1+3 {
		t.Fatalf("la consola recibe lo que cupo, el resumen y lo nuevo: %d", len(es))
	}

	// Si la consola no recoge y le queda algo por recoger, la culpa es suya.
	cf.mu.Lock()
	cf.caida = true
	cf.mu.Unlock()
	escribirEventos(t, registro, 2603, 500)
	s.leer()
	s.entregar(context.Background())
	escribirEventos(t, registro, 3103, 2000)
	s.leer()
	if d := s.descartes["t1"]; d == nil || d.Codigo() != "cola.llena" {
		t.Fatalf("con la consola caída y eventos sin entregar, cola.llena: %+v", d)
	}
}
