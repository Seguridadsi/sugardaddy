package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/consola"
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
)

// consolaQueFalla es como la de verdad hasta que una entrega trae la línea
// envenenada: entonces responde 500 y no guarda nada del lote (C01).
type consolaQueFalla struct {
	mu       sync.Mutex
	veneno   []byte
	codigo   int
	lineas   [][]byte
	entregas int
}

func (c *consolaQueFalla) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entregas++
	b, _ := io.ReadAll(r.Body)
	if bytes.Contains(b, c.veneno) {
		http.Error(w, "invalid byte sequence", c.codigo)
		return
	}
	ls := bytes.Split(bytes.TrimSuffix(b, []byte("\n")), []byte("\n"))
	for _, l := range ls {
		c.lineas = append(c.lineas, append([]byte(nil), l...))
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "aceptadas": len(ls)})
}

// colaConVeneno deja en la cola de salida n líneas encadenadas; la k lleva el veneno.
func colaConVeneno(t *testing.T, cf *consolaQueFalla, n, k int) (*sensor, [][]byte) {
	t.Helper()
	datos := t.TempDir()
	srv := httptest.NewServer(cf)
	t.Cleanup(srv.Close)
	e, _ := estado.Cargar(datos)
	s := &sensor{consola: consola.Nuevo(srv.URL, "token"), estado: e, salida: filepath.Join(datos, "salida.jsonl")}
	s.opc.Datos = datos
	cadena := evento.NuevaCadena(evento.Genesis)
	var lineas [][]byte
	var cola bytes.Buffer
	for i := 0; i < n; i++ {
		ev := evento.Evento{Version: 2, ID: fmt.Sprintf("e%04d", i), Sensor: "s1", Accion: "baliza", Severidad: "media",
			Detalle: map[string]any{"token": fmt.Sprintf("t%d", i)}}
		if i == k {
			ev.Detalle["token"] = string(cf.veneno)
		}
		l, err := cadena.Emitir(ev)
		if err != nil {
			t.Fatal(err)
		}
		lineas = append(lineas, l)
		cola.Write(l)
		cola.WriteByte('\n')
	}
	if err := os.WriteFile(s.salida, cola.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return s, lineas
}

func TestUnaLineaQueLaConsolaNoProcesaSeApartaYLoDemasLlega(t *testing.T) {
	cf := &consolaQueFalla{veneno: []byte("VENENO"), codigo: http.StatusInternalServerError}
	const n, k = 40, 23
	s, lineas := colaConVeneno(t, cf, n, k)
	// La consola atiende lo demás: ha dado un plan hace nada (y lo sigue dando).
	for i := 0; i < 200 && s.estado.Entregado < tamCola(s); i++ {
		s.pausa = time.Time{}
		s.ultimoPlan.Store(time.Now().Unix() + 1 + int64(i))
		s.entregar(context.Background())
	}
	if s.estado.Entregado != tamCola(s) {
		t.Fatalf("la entrega se queda atascada: %d de %d bytes", s.estado.Entregado, tamCola(s))
	}
	if len(cf.lineas) != n-1 {
		t.Fatalf("a la consola tenían que llegar %d líneas y han llegado %d", n-1, len(cf.lineas))
	}
	for _, l := range cf.lineas {
		if bytes.Contains(l, cf.veneno) {
			t.Fatal("la línea envenenada no se ha apartado")
		}
	}
	if !bytes.Equal(cf.lineas[k], lineas[k+1]) {
		t.Fatal("tras la apartada sigue la siguiente, en orden")
	}
	b, err := os.ReadFile(filepath.Join(s.opc.Datos, "apartadas.jsonl"))
	if err != nil || !bytes.Equal(b, append(lineas[k], '\n')) {
		t.Fatalf("la apartada se guarda en apartadas.jsonl: %q %v", b, err)
	}
	if s.estado.Apartadas != 1 || s.hechos()["entrega.apartadas"] == nil {
		t.Fatal("tiene que quedar el hecho entrega.apartadas")
	}
	// Se aísla partiendo el lote, no probando línea a línea desde el principio.
	if cf.entregas > 40 {
		t.Fatalf("demasiadas entregas para aislar la línea: %d", cf.entregas)
	}
	// Y el lote vuelve a su tamaño.
	if s.lote != porEntrega {
		t.Fatalf("el lote se queda en %d", s.lote)
	}
}

func TestSinPlanDeLaConsolaNoSeApartaNada(t *testing.T) {
	// Una consola que falla con todo y no da planes está caída: no se aparta nada.
	cf := &consolaQueFalla{veneno: []byte("e0"), codigo: http.StatusInternalServerError}
	s, _ := colaConVeneno(t, cf, 5, 0)
	for i := 0; i < 50; i++ {
		s.pausa = time.Time{}
		s.entregar(context.Background())
	}
	if s.estado.Entregado != 0 || s.estado.Apartadas != 0 {
		t.Fatalf("con la consola sin planes no se aparta nada: entregado %d, apartadas %d", s.estado.Entregado, s.estado.Apartadas)
	}
}

func TestUn503NoParteNiApartaElLote(t *testing.T) {
	cf := &consolaQueFalla{veneno: []byte("e0"), codigo: http.StatusServiceUnavailable}
	s, _ := colaConVeneno(t, cf, 5, 2)
	for i := 0; i < 20; i++ {
		s.pausa = time.Time{}
		s.ultimoPlan.Store(time.Now().Unix() + 1 + int64(i))
		s.entregar(context.Background())
	}
	if s.estado.Entregado != 0 || s.estado.Apartadas != 0 || s.atasco.activo {
		t.Fatal("un 503 es la consola que no está: se reintenta igual, sin partir ni apartar")
	}
}
