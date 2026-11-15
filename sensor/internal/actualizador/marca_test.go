package actualizador

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type vectorMarca struct {
	Marcas    string       `json:"marcas"`
	Legado    string       `json:"legado"`
	Ahora     string       `json:"ahora"`
	ConMarcas MarcaFirmada `json:"conMarcas"`
	ConLegado MarcaFirmada `json:"conLegado"`
}

func leerVectorMarca(t *testing.T) (vectorMarca, time.Time) {
	t.Helper()
	b, err := os.ReadFile("../../../paquetes/canal/src/vectores/marca.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorMarca
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	ahora, _ := time.Parse(time.RFC3339, v.Ahora)
	return v, ahora
}

// El vector lo genera TypeScript (paquetes/canal/src/vectores/marca.json).
func TestMarcaVectorComun(t *testing.T) {
	v, ahora := leerVectorMarca(t)
	m, err := VerificarMarca(Confianza{}, []string{v.Marcas}, "cloud", v.ConMarcas, ahora)
	if err != nil || m.Caducada || m.Marca.Ultimas["cloud"].Version != "0.30.0" {
		t.Fatalf("la marca del vector no vale: %v", err)
	}
	if _, err := VerificarMarca(LeerConfianza("", v.Legado), nil, "cloud", v.ConLegado, ahora); err != nil {
		t.Fatalf("con la de legado debería valer: %v", err)
	}
	if _, err := VerificarMarca(Confianza{}, []string{v.Marcas}, "cloud", v.ConLegado, ahora); err != nil {
		t.Fatalf("con la de marcas en firmas debería valer: %v", err)
	}
	if _, err := VerificarMarca(Confianza{}, nil, "cloud", v.ConMarcas, ahora); err == nil {
		t.Fatal("sin claves no vale")
	}
	tocada := v.ConMarcas
	tocada.Marca = strings.Replace(tocada.Marca, "0.30.0", "0.30.1", 1)
	if _, err := VerificarMarca(Confianza{}, []string{v.Marcas}, "cloud", tocada, ahora); err == nil {
		t.Fatal("tocada no vale")
	}
	tarde, err := VerificarMarca(Confianza{}, []string{v.Marcas}, "cloud", v.ConMarcas, ahora.Add(10*24*time.Hour))
	if err != nil || !tarde.Caducada {
		t.Fatal("pasada su fecha, se devuelve caducada")
	}
	if _, err := VerificarMarca(Confianza{}, []string{v.Marcas}, "cloud", v.ConMarcas, ahora.Add(-3*24*time.Hour)); err == nil {
		t.Fatal("una marca del futuro no vale")
	}
}

func TestEvaluarMarca(t *testing.T) {
	v, ahora := leerVectorMarca(t)
	m, _ := VerificarMarca(Confianza{}, []string{v.Marcas}, "cloud", v.ConMarcas, ahora)
	if e := EvaluarMarca(nil, "cloud", "0.29.0", ahora); e.Estado != "sin-marca" {
		t.Fatalf("sin marca: %+v", e)
	}
	// 0.30.0 de Cloud se publicó el 1 y el plazo es de una semana: el 15, retenida.
	if e := EvaluarMarca(&m, "cloud", "0.29.5", ahora); e.Estado != "retenida" || e.Ultima != "0.30.0" {
		t.Fatalf("debería estar retenida: %+v", e)
	}
	if e := EvaluarMarca(&m, "cloud", "0.30.0", ahora); e.Estado != "al-dia" {
		t.Fatalf("al día: %+v", e)
	}
	// La de Community se publicó el 10: aún dentro del plazo.
	if e := EvaluarMarca(&m, "community", "0.29.0", ahora); e.Estado != "al-dia" {
		t.Fatalf("dentro del plazo: %+v", e)
	}
	c := m
	c.Caducada = true
	if e := EvaluarMarca(&c, "cloud", "0.30.0", ahora); e.Estado != "caducada" {
		t.Fatalf("caducada: %+v", e)
	}
	// Sin edición (desarrollo) nunca se dice retenida.
	if e := EvaluarMarca(&m, "", "0.1.0", ahora); e.Estado != "al-dia" {
		t.Fatalf("sin edición: %+v", e)
	}
}

// El vigía junta la copia estática y la del panel, guarda la más nueva y lo dice a la consola.
func TestVigia(t *testing.T) {
	v, ahora := leerVectorMarca(t)
	var mu sync.Mutex
	var informado EstadoMarca
	panelDa := (*MarcaFirmada)(nil)
	consola := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tk" {
			w.WriteHeader(401)
			return
		}
		if r.Method == http.MethodPost {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			_ = json.Unmarshal(b, &informado)
			mu.Unlock()
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"marca": panelDa})
	}))
	defer consola.Close()
	estatica := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transparencia/marca.json" {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(v.ConMarcas)
	}))
	defer estatica.Close()

	dir := t.TempDir()
	versiones := filepath.Join(dir, "versiones.env")
	_ = os.WriteFile(versiones, []byte("SUGARDADDY_VERSION=0.30.0\n"), 0o644)
	vg := &Vigia{Estatica: estatica.URL + "/transparencia", Consola: consola.URL, Token: "tk",
		HTTP: consola.Client(), Fuera: estatica.Client(), Dir: dir, Marcas: []string{v.Marcas},
		Edicion: "cloud", Versiones: versiones}
	e, err := vg.Vuelta(context.Background(), ahora)
	if err != nil || e.Estado != "al-dia" || e.Origen != "estatica" {
		t.Fatalf("primera vuelta: %+v %v", e, err)
	}
	mu.Lock()
	if informado.Estado != "al-dia" {
		t.Fatalf("no se informó a la consola: %+v", informado)
	}
	mu.Unlock()
	if _, err := os.Stat(filepath.Join(dir, FicheroMarca)); err != nil {
		t.Fatal("la marca no se guardó")
	}

	// Sin red ni panel y días después: la guardada caduca y se avisa.
	vg2 := &Vigia{Consola: consola.URL, Token: "tk", HTTP: consola.Client(), Dir: dir,
		Marcas: []string{v.Marcas}, Edicion: "cloud", Versiones: versiones}
	e, _ = vg2.Vuelta(context.Background(), ahora.Add(10*24*time.Hour))
	if e.Estado != "caducada" {
		t.Fatalf("debería avisar de la marca caducada: %+v", e)
	}
}
