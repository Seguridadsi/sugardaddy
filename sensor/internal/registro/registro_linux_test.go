//go:build linux

package registro

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestPerforarElAbierto: AbrirEn + PerforarLeido perforan el registro de dentro
// (ceros desde el segundo bloque, mismo tamaño) y no tocan el de fuera aunque la
// carpeta se haya cambiado por un enlace a él.
func TestPerforarElAbierto(t *testing.T) {
	datos, fuera := t.TempDir(), t.TempDir()
	dir := filepath.Join(datos, "registros", "abc")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lleno := bytes.Repeat([]byte("A"), 64<<10)
	for _, d := range []string{dir, fuera} {
		if err := os.WriteFile(filepath.Join(d, "log.txt"), lleno, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raiz, err := os.OpenRoot(datos)
	if err != nil {
		t.Fatal(err)
	}
	defer raiz.Close()
	f, err := AbrirEn(raiz, "registros/abc/log.txt")
	if err != nil {
		t.Fatal(err)
	}
	err = PerforarLeido(f, 64<<10)
	f.Close()
	if err != nil {
		t.Skipf("este sistema de ficheros no perfora: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "log.txt"))
	if len(b) != 64<<10 || b[0] != 'A' || b[4096] != 0 || b[61439] != 0 || b[61440] != 'A' {
		t.Fatalf("perforado mal: tamaño %d", len(b))
	}
	// La carpeta pasa a ser un enlace al de fuera: no se abre.
	if err := os.Rename(dir, dir+".real"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(fuera, dir); err != nil {
		t.Fatal(err)
	}
	if f, err := AbrirEn(raiz, "registros/abc/log.txt"); err == nil {
		f.Close()
		t.Fatal("se abrió por el enlace")
	}
	if b, _ := os.ReadFile(filepath.Join(fuera, "log.txt")); !bytes.Equal(b, lleno) {
		t.Fatal("el de fuera ha cambiado")
	}
}
