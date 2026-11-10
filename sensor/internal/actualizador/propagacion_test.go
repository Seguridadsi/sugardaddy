package actualizador

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
)

// dockerPropagacion: un Docker que arranca la prueba o, con privada, la rechaza
// como un Docker en una máquina con la raíz privada.
func dockerPropagacion(t *testing.T, privada bool, creado *map[string]any) *docker.Cliente {
	t.Helper()
	base, err := os.MkdirTemp("", "sd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, creado)
			_, _ = w.Write([]byte(`{"Id":"prueba"}`))
		case strings.HasSuffix(r.URL.Path, "/prueba/start") && privada:
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"path /opt/sugardaddy/datos/sensor is mounted on / but it is not a shared or slave mount"}`))
		case strings.HasSuffix(r.URL.Path, "/prueba/wait"):
			_, _ = w.Write([]byte(`{"StatusCode":0}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return docker.Nuevo(sock)
}

func TestLaPropagacionSoloSiLaMaquinaLaAdmite(t *testing.T) {
	for _, privada := range []bool{false, true} {
		dir := t.TempDir()
		_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("DATOS=/opt/sugardaddy/datos\n"), 0o600)
		_ = os.WriteFile(filepath.Join(dir, "versiones.env"), []byte("SENSOR_IMAGEN=r/sensor@sha256:1\n"), 0o644)
		var creado map[string]any
		a := &Aplicacion{Dir: dir, Modo: ModoNodo, Docker: dockerPropagacion(t, privada, &creado), Log: func(string, ...any) {}}
		a.asegurarPropagacion(context.Background())
		env, _ := LeerEnv(filepath.Join(dir, ".env"))
		if (env["SENSOR_PROPAGACION"] == "rslave") == privada {
			t.Fatalf("privada=%v: %v", privada, env)
		}
		m := creado["HostConfig"].(map[string]any)["Mounts"].([]any)[0].(map[string]any)
		if creado["Image"] != "r/sensor@sha256:1" || m["Source"] != "/opt/sugardaddy/datos/sensor" ||
			m["BindOptions"].(map[string]any)["Propagation"] != "rslave" {
			t.Fatalf("la prueba monta la carpeta del sensor como la montará compose: %v", creado)
		}
	}
}

func TestLaPropagacionYaPuestaNoSePruebaOtraVez(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("DATOS=/d\nSENSOR_PROPAGACION=rslave\n"), 0o600)
	var creado map[string]any
	a := &Aplicacion{Dir: dir, Modo: ModoSensorRemoto, Docker: dockerPropagacion(t, false, &creado), Log: func(string, ...any) {}}
	a.asegurarPropagacion(context.Background())
	if creado != nil {
		t.Fatal("ya está: no se prueba")
	}
}
