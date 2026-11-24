package registro

import (
	"os"
	"path/filepath"
	"testing"
)

// TestAbrirEnNoSigueEnlaces: lo que se abre para perforar es el fichero normal de
// rel, sin pasar por ningún enlace: ni una carpeta que lleva fuera (el caso de la
// auditoría), ni una que lleva a otra parte de dentro, ni la propia hoja.
func TestAbrirEnNoSigueEnlaces(t *testing.T) {
	datos, fuera := t.TempDir(), t.TempDir()
	escribir := func(ruta string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(ruta), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(ruta, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	escribir(filepath.Join(datos, "registros", "abc", "log.txt"))
	escribir(filepath.Join(datos, "discos", "abc", "escribible-0", "log.txt"))
	escribir(filepath.Join(fuera, "log.txt"))
	enlace := func(destino, ruta string) {
		t.Helper()
		if err := os.Symlink(destino, filepath.Join(datos, ruta)); err != nil {
			t.Fatal(err)
		}
	}
	enlace(fuera, "registros/fuera")
	enlace("../discos/abc/escribible-0", "registros/dentro")
	enlace("log.txt", "registros/abc/hoja")

	raiz, err := os.OpenRoot(datos)
	if err != nil {
		t.Fatal(err)
	}
	defer raiz.Close()
	f, err := AbrirEn(raiz, "registros/abc/log.txt")
	if err != nil {
		t.Fatalf("el registro de verdad: %v", err)
	}
	f.Close()
	for _, mal := range []string{"registros/fuera/log.txt", "registros/dentro/log.txt", "registros/abc/hoja", "registros/abc"} {
		if f, err := AbrirEn(raiz, mal); err == nil {
			f.Close()
			t.Errorf("%s: tenía que rechazarse", mal)
		}
	}
}
