package despliegue

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// La configuración y la licencia se escriben sin seguir enlaces: un enlace en lugar
// del fichero o de su carpeta no hace escribir fuera de la carpeta del sensor.
func TestEscribirFicheroNoSigueEnlaces(t *testing.T) {
	dir := t.TempDir()
	fuera := filepath.Join(t.TempDir(), "fuera")
	if err := os.WriteFile(fuera, []byte("intacto"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(fuera, filepath.Join(dir, "licencia.json")); err != nil {
		t.Fatal(err)
	}
	if err := escribirFichero(filepath.Join(dir, "licencia.json"), "x"); err == nil {
		t.Fatal("un enlace en lugar del fichero tiene que dar error")
	}
	if err := os.Symlink(filepath.Dir(fuera), filepath.Join(dir, "config")); err != nil {
		t.Fatal(err)
	}
	if err := escribirFichero(filepath.Join(dir, "config", "fuera"), "x"); err == nil {
		t.Fatal("un enlace en lugar de la carpeta tiene que dar error")
	}
	if b, _ := os.ReadFile(fuera); string(b) != "intacto" {
		t.Fatalf("se escribió fuera: %q", b)
	}
	// Y lo normal: en el sitio, sin cambiar el inodo, legible para el honeypot.
	ruta := filepath.Join(dir, "config", "t1", "f.txt")
	_ = os.Remove(filepath.Join(dir, "config"))
	if err := escribirFichero(ruta, "uno largo"); err != nil {
		t.Fatal(err)
	}
	antes, _ := os.Stat(ruta)
	if err := escribirFichero(ruta, "dos"); err != nil {
		t.Fatal(err)
	}
	despues, _ := os.Stat(ruta)
	if b, _ := os.ReadFile(ruta); string(b) != "dos" || !os.SameFile(antes, despues) || despues.Mode().Perm() != 0o644 {
		t.Fatalf("%q %v %v", b, os.SameFile(antes, despues), despues.Mode())
	}
}

// Un plan con un nombre de sensor que no es un id no toca nada: ese nombre acaba en
// filtros de etiquetas y en nombres de contenedores y volúmenes.
func TestPlanConSensorInvalidoNoTocaNada(t *testing.T) {
	for _, s := range []string{"", "s1,sugardaddy.trampa=x", "../s1", "s 1", strings.Repeat("a", 129)} {
		if SensorValido(s) {
			t.Errorf("%q no debería valer", s)
		}
		// Sin motor: si llegara a hablar con él, daría otro error.
		d := docker.Nuevo(filepath.Join(t.TempDir(), "no.sock"))
		estados, err := Aplicar(context.Background(), d, Opciones{Datos: t.TempDir()},
			plan.Plan{Sensor: s, Trampas: []plan.TrampaPlan{{ID: "t1"}}})
		if err == nil || !strings.Contains(err.Error(), "invalid sensor") || len(estados) != 1 || !strings.Contains(estados[0].Donde, "invalid sensor") {
			t.Errorf("%q: %v %+v", s, err, estados)
		}
	}
	for _, s := range []string{"s1", "nodo", "sensor-oficina.2", "a_b"} {
		if !SensorValido(s) {
			t.Errorf("%q tiene que valer", s)
		}
	}
}
