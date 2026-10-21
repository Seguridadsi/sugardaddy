// Pruebas de ini_claves.go y del formato por ruta (cambios de SeguridadSI).
// Corren al construir la imagen (Dockerfile): si fallan, no hay imagen.
package encoder

import (
	"strings"
	"testing"
)

func TestIniClavesSueltas(t *testing.T) {
	b, err := NewIniEncoder().Marshal(map[string]any{
		"aws-secret-access-key": "wJalrXUtnFEMI/K7MDENG",
		"categories":            []any{"snippet"},
		"database":              map[string]any{"host": "db01"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if strings.Contains(s, "[aws-secret-access-key]") || strings.Contains(s, "[categories]") || strings.Contains(s, "[DEFAULT]") {
		t.Fatalf("secciones vacías o de más:\n%s", s)
	}
	if !strings.HasPrefix(s, "aws-secret-access-key = wJalrXUtnFEMI/K7MDENG\n") && !strings.HasPrefix(s, "categories") {
		t.Fatalf("los valores sueltos van primero, como clave = valor:\n%s", s)
	}
	if !strings.Contains(s, "aws-secret-access-key = wJalrXUtnFEMI/K7MDENG\n") || !strings.Contains(s, `categories            = ["snippet"]`) && !strings.Contains(s, `categories = ["snippet"]`) {
		t.Fatalf("faltan los valores sueltos:\n%s", s)
	}
	if !strings.Contains(s, "[database]") {
		t.Fatalf("falta la sección:\n%s", s)
	}
}

func TestIniParaEnvYCredenciales(t *testing.T) {
	for _, p := range []string{"/.env", "/.env.production", "/app/.env", "/.git/config", "/.aws/credentials", "/etc/app.conf", "/setup.cfg", "/x.ini", "/.npmrc", "/app.properties"} {
		if _, ok := GetEncoderForPath(p).(*IniEncoder); !ok {
			t.Errorf("%s: %T, quiero INI", p, GetEncoderForPath(p))
		}
	}
	if _, ok := GetEncoderForPath("/config.json").(*JsonEncoder); !ok {
		t.Error("/config.json tiene que seguir siendo JSON")
	}
	if _, ok := GetEncoderForPath("/docker-compose.yml").(*YamlEncoder); !ok {
		t.Error("/docker-compose.yml tiene que seguir siendo YAML")
	}
}
