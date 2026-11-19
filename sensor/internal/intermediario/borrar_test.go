package intermediario

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCarpetaDeRegistros(t *testing.T) {
	r := reglasPrueba()
	for _, bien := range []string{datosPrueba + "/registros/cache-1", datosPrueba + "/registros/cache-1/sub",
		datosPrueba + "/discos/cache-1/registros/sub"} {
		if _, err := r.CarpetaDeRegistros(bien); err != nil {
			t.Errorf("%s: %v", bien, err)
		}
	}
	for _, mal := range []string{"/etc", datosPrueba, datosPrueba + "/registros", datosPrueba + "/estado.json",
		datosPrueba + "/registros/cache-1/a/b", datosPrueba + "/registros/../config", datosPrueba + "/discos/cache-1",
		datosPrueba + "/discos/cache-1/escribible-0/x", datosPrueba + "/discos/cache-1/registros", datosPrueba + "/config/cache-1",
		datosPrueba + "/registros/x y/a", "relativa/registros/a", datosPrueba + "/registros/../../etc"} {
		if _, err := r.CarpetaDeRegistros(mal); err == nil {
			t.Errorf("%s: tenía que rechazarse", mal)
		}
	}
}

// Borra lo que la trampa ha creado (con lo de dentro), sin salir de la carpeta del
// sensor aunque haya enlaces por medio.
func TestBorrarDentroNoSigueEnlaces(t *testing.T) {
	datos, fuera := t.TempDir(), t.TempDir()
	_ = os.WriteFile(filepath.Join(fuera, "importante"), []byte("x"), 0o600)
	sub := filepath.Join(datos, "registros", "t1", "creada")
	_ = os.MkdirAll(filepath.Join(sub, "honda"), 0o755)
	_ = os.WriteFile(filepath.Join(sub, "honda", "f"), []byte("y"), 0o600)
	_ = os.Symlink(fuera, filepath.Join(datos, "registros", "t1", "enlace"))
	if err := borrarDentro(datos, "registros/t1/creada"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(sub); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("la carpeta creada por la trampa se borra entera")
	}
	if err := borrarDentro(datos, "registros/t1/enlace"); err != nil {
		t.Fatal(err)
	}
	// Una carpeta de registros que es un enlace: no se entra por ella.
	_ = os.Symlink(fuera, filepath.Join(datos, "registros", "t2"))
	if err := borrarDentro(datos, "registros/t2/importante"); err == nil {
		t.Fatal("tiene que negarse")
	}
	if err := borrarDentro(datos, "registros/t2"); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(fuera, "importante")); err != nil || string(b) != "x" {
		t.Fatal("lo de fuera no se toca")
	}
	if err := borrarDentro(datos, "registros/no-existe/x"); err != nil {
		t.Fatal("lo que no existe ya está borrado")
	}
}
