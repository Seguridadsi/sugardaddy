package estado

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Cargar de un directorio sin estado.json da un estado vacío, no un error.
func TestCargarSinFichero(t *testing.T) {
	e, err := Cargar(t.TempDir())
	if err != nil {
		t.Fatalf("un directorio sin estado no debería dar error: %v", err)
	}
	if e.Leido == nil || e.Inodos == nil || e.Huellas == nil || e.Modifs == nil || e.Paradas == nil {
		t.Errorf("los mapas deberían venir inicializados: %+v", e)
	}
}

// Guardar y Cargar conservan el estado; y no queda el temporal por medio.
func TestGuardarYCargarIdaYVuelta(t *testing.T) {
	dir := t.TempDir()
	e := &Estado{
		Leido:      map[string]int64{"cowrie": 1234},
		Inodos:     map[string]uint64{"cowrie": 99},
		Huellas:    map[string]string{"cowrie": "abc"},
		Modifs:     map[string]int64{"cowrie": 42},
		Paradas:    map[string]string{"smb": "cuota superada"},
		UltimoHash: "deadbeef",
		Entregado:  512,
		OrigenReal: time.Unix(1_700_000_000, 0).UTC(),
	}
	if err := e.Guardar(dir); err != nil {
		t.Fatalf("Guardar: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "estado.json.tmp")); !os.IsNotExist(err) {
		t.Error("el temporal no debería quedar tras el rename")
	}

	leido, err := Cargar(dir)
	if err != nil {
		t.Fatalf("Cargar: %v", err)
	}
	if leido.Leido["cowrie"] != 1234 || leido.UltimoHash != "deadbeef" || leido.Entregado != 512 {
		t.Errorf("no se conservó el estado: %+v", leido)
	}
	if !leido.OrigenReal.Equal(e.OrigenReal) {
		t.Errorf("OrigenReal: %v != %v", leido.OrigenReal, e.OrigenReal)
	}
	if leido.Paradas["smb"] != "cuota superada" {
		t.Errorf("no se conservaron las paradas: %+v", leido.Paradas)
	}
}

// Guardar dos veces deja el último estado (sobrescribe, con el fichero válido).
func TestGuardarSobrescribe(t *testing.T) {
	dir := t.TempDir()
	if err := (&Estado{UltimoHash: "uno", Entregado: 1}).Guardar(dir); err != nil {
		t.Fatal(err)
	}
	if err := (&Estado{UltimoHash: "dos", Entregado: 2}).Guardar(dir); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "estado.json"))
	if err != nil {
		t.Fatal(err)
	}
	var e Estado
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatalf("estado.json no es JSON válido: %v", err)
	}
	if e.UltimoHash != "dos" || e.Entregado != 2 {
		t.Errorf("debería quedar el segundo estado: %+v", e)
	}
}
