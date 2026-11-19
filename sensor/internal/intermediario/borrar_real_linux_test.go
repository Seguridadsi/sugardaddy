//go:build linux

package intermediario

import (
	"os"
	"path/filepath"
	"testing"
)

// TestBorrarComoSdMotor: como root con solo CHOWN y DAC_OVERRIDE (las capacidades de
// sd-motor), borra lo que una trampa (otro usuario) creó en su carpeta de registros
// (pegajosa y del sensor), aunque lleve carpetas pegajosas suyas dentro. Sin
// SD_BORRAR_REAL no hace nada: lo lanza herramientas/probar-borrar-registros.sh.
func TestBorrarComoSdMotor(t *testing.T) {
	if os.Getenv("SD_BORRAR_REAL") == "" || os.Geteuid() != 0 {
		t.Skip("solo como root, con SD_BORRAR_REAL")
	}
	const sensor, trampa = 65532, 999
	datos := t.TempDir()
	reg := filepath.Join(datos, "registros", "t1")
	if err := os.MkdirAll(reg, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chown(filepath.Join(datos, "registros"), sensor, sensor)
	_ = os.Chown(reg, sensor, sensor)
	_ = os.Chmod(reg, 0o777|os.ModeSticky)
	// Lo que crea la trampa: una carpeta pegajosa suya con otra dentro y ficheros.
	crear := func(base string) {
		for _, d := range []string{base, filepath.Join(base, "honda")} {
			if err := os.Mkdir(d, 0o700); err != nil {
				t.Fatal(err)
			}
			_ = os.Chmod(d, 0o700|os.ModeSticky)
			_ = os.WriteFile(filepath.Join(d, "f"), []byte("x"), 0o600)
			_ = os.Lchown(filepath.Join(d, "f"), trampa, trampa)
			_ = os.Lchown(d, trampa, trampa)
		}
	}
	crear(filepath.Join(reg, "creada"))
	if err := borrarDentro(datos, "registros/t1/creada"); err != nil {
		t.Fatalf("una carpeta de la trampa dentro de sus registros: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(reg, "creada")); !os.IsNotExist(err) {
		t.Fatal("sigue ahí")
	}
	// Y la carpeta entera de una retirada, con ficheros de la trampa arriba.
	crear(filepath.Join(reg, "otra"))
	_ = os.WriteFile(filepath.Join(reg, "registro.json"), []byte("x"), 0o600)
	_ = os.Lchown(filepath.Join(reg, "registro.json"), trampa, trampa)
	if err := borrarDentro(datos, "registros/t1"); err != nil {
		t.Fatalf("la carpeta de una retirada: %v", err)
	}
	if _, err := os.Lstat(reg); !os.IsNotExist(err) {
		t.Fatal("sigue ahí")
	}
}
