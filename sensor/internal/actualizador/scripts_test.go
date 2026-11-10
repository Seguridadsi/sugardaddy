package actualizador

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// Los scripts que lleva la imagen del actualizador tienen que ser los de
// despliegue/nodo, letra por letra: si se cambia uno, se cambia el otro.
func TestScriptsDeCopiasSonLosDelNodo(t *testing.T) {
	for _, n := range ScriptsDeCopias {
		fuente, err := os.ReadFile(filepath.Join("..", "..", "..", "despliegue", "nodo", n))
		if err != nil {
			t.Fatalf("despliegue/nodo/%s: %v", n, err)
		}
		copia, err := scriptsDeCopias.ReadFile("scripts/" + n)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(fuente, copia) {
			t.Fatalf("sensor/internal/actualizador/scripts/%s is not the same as despliegue/nodo/%s: copy it again (cp despliegue/nodo/%s sensor/internal/actualizador/scripts/)", n, n, n)
		}
	}
}

func TestPonerScriptsDeCopias(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "copia.sh"), []byte("#!/bin/sh\n# el de antes\n"), 0o755)
	fuera := filepath.Join(t.TempDir(), "importante")
	_ = os.WriteFile(fuera, []byte("no tocar"), 0o600)
	_ = os.Symlink(fuera, filepath.Join(dir, "restaurar.sh"))
	cambiados, err := PonerScriptsDeCopias(dir)
	if err != nil || len(cambiados) != 2 {
		t.Fatalf("%v %v", cambiados, err)
	}
	for _, n := range ScriptsDeCopias {
		fi, err := os.Lstat(filepath.Join(dir, n))
		if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm() != 0o755 {
			t.Fatalf("%s: %v %v", n, fi, err)
		}
		b, _ := os.ReadFile(filepath.Join(dir, n))
		esperado, _ := scriptsDeCopias.ReadFile("scripts/" + n)
		if !bytes.Equal(b, esperado) {
			t.Fatalf("%s is not the one of this version", n)
		}
	}
	if b, _ := os.ReadFile(fuera); string(b) != "no tocar" {
		t.Fatal("a symlink must be replaced, not written through")
	}
	if cambiados, _ := PonerScriptsDeCopias(dir); len(cambiados) != 0 {
		t.Fatalf("already up to date: %v", cambiados)
	}
}
