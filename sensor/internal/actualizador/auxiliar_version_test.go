package actualizador

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// La versión firmada llega entera al auxiliar aunque pase de lo que deja Linux en una
// sola variable (128 KB): la 0.31.1 ya pesaba 159 KB y ningún nodo podía subir.
func TestVersionGrandeEnTrozos(t *testing.T) {
	grande := ReleaseFirmada{Release: strings.Repeat("x", 300*1024), Firma: "f"}
	c := ConfigAuxiliar(Pedido{Imagen: "i", Dir: "/opt/sugardaddy", Proyecto: "p", Firmada: grande})
	env := map[string]string{}
	for _, v := range c["Env"].([]string) {
		k, val, _ := strings.Cut(v, "=")
		if len(v) >= 128*1024 {
			t.Fatalf("%s mide %d bytes: Linux no arrancaría el contenedor", k, len(v))
		}
		env[k] = val
	}
	if _, ok := env["APLICAR_VERSION"]; ok {
		t.Fatal("una versión grande no va en APLICAR_VERSION")
	}
	b64, err := LeerVariablesVersion(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	b, _ := base64.StdEncoding.DecodeString(b64)
	var f ReleaseFirmada
	if err := json.Unmarshal(b, &f); err != nil || f.Release != grande.Release || f.Firma != "f" {
		t.Fatalf("no llega igual: %v", err)
	}
}

// Una pequeña va como siempre: es lo único que lee un auxiliar de antes (volver atrás).
func TestVersionPequenaComoSiempre(t *testing.T) {
	vars := VariablesVersion("abc")
	if len(vars) != 1 || vars[0] != "APLICAR_VERSION=abc" {
		t.Fatalf("%v", vars)
	}
	v, err := LeerVariablesVersion(func(k string) string {
		if k == "APLICAR_VERSION" {
			return "abc"
		}
		return ""
	})
	if err != nil || v != "abc" {
		t.Fatalf("%q %v", v, err)
	}
	if _, err := LeerVariablesVersion(func(string) string { return "" }); err == nil {
		t.Fatal("sin nada tiene que fallar")
	}
	if _, err := LeerVariablesVersion(func(k string) string {
		if k == "APLICAR_VERSION_TROZOS" {
			return "2"
		}
		if k == "APLICAR_VERSION_0" {
			return "a"
		}
		return ""
	}); err == nil {
		t.Fatal("con un trozo que falta tiene que fallar")
	}
}

// Una carpeta firmado/ que dejó un instalar.sh con umask 077 (700, de root) queda legible
// para el sensor, que no es root, en cuanto el actualizador guarda una versión.
func TestFirmadoLegibleParaElSensor(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "firmado"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := GuardarFirmada(dir, ReleaseFirmada{Release: `{"version":"1.0.0"}`, Firma: "f"}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "firmado"))
	if err != nil || st.Mode().Perm() != 0o755 {
		t.Fatalf("firmado/ con %v (%v): el sensor no la puede leer", st.Mode().Perm(), err)
	}
}
