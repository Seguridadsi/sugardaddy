package actualizador

import (
	"fmt"
	"testing"
)

func TestSinHerenciaDejaMandarALaImagenNueva(t *testing.T) {
	imagenVieja := map[string]any{
		"Env":        []any{"PATH=/usr/bin", "SUGARDADDY_VERSION=0.4.0"},
		"Labels":     map[string]any{"org.opencontainers.image.version": "0.4.0"},
		"Cmd":        []any{"node", "scripts/arrancar.mjs"},
		"User":       "node",
		"WorkingDir": "/app",
	}
	contenedor := map[string]any{
		"Env":        []any{"PATH=/usr/bin", "SUGARDADDY_VERSION=0.4.0", "DATABASE_URL=postgres://x"},
		"Labels":     map[string]any{"org.opencontainers.image.version": "0.4.0", "sugardaddy.servicio": "consola"},
		"Cmd":        []any{"node", "scripts/arrancar.mjs"},
		"User":       "node",
		"WorkingDir": "/app",
		"Hostname":   "abc",
	}
	r := SinHerencia(contenedor, imagenVieja)

	if fmt.Sprint(r["Env"]) != "[DATABASE_URL=postgres://x]" {
		t.Errorf("solo deben quedar las variables del despliegue: %v", r["Env"])
	}
	if fmt.Sprint(r["Labels"]) != "map[sugardaddy.servicio:consola]" {
		t.Errorf("solo deben quedar las etiquetas del despliegue: %v", r["Labels"])
	}
	for _, c := range []string{"Cmd", "User", "WorkingDir"} {
		if _, hay := r[c]; hay {
			t.Errorf("%s venía de la imagen y debería mandar la nueva", c)
		}
	}
	if r["Hostname"] != "abc" {
		t.Error("lo que no viene de la imagen se conserva")
	}
}

func TestSinHerenciaRespetaLoQuePusoElDespliegue(t *testing.T) {
	r := SinHerencia(
		map[string]any{"Cmd": []any{"-consola=http://consola:3000"}, "Env": []any{"X=1"}},
		map[string]any{"Cmd": nil, "Env": []any{"X=2"}},
	)
	if fmt.Sprint(r["Cmd"]) != "[-consola=http://consola:3000]" || fmt.Sprint(r["Env"]) != "[X=1]" {
		t.Errorf("se ha perdido configuración del despliegue: %v", r)
	}
}
