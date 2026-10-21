//go:build unix

package seguidor

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestUnFIFOEnLugarDelRegistroNoBloquea(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "cowrie.json")
	if err := syscall.Mkfifo(ruta, 0o666); err != nil {
		t.Skip("sin mkfifo:", err)
	}
	hecho := make(chan error, 1)
	go func() { _, _, _, err := Seguir(ruta, Posicion{}); hecho <- err }()
	select {
	case err := <-hecho:
		if err == nil {
			t.Fatal("un FIFO no es un registro: tiene que dar error")
		}
	case <-time.After(time.Second):
		t.Fatal("Seguir se ha quedado bloqueado en un FIFO")
	}
}
