package actualizador

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func claveB64(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	return base64.StdEncoding.EncodeToString(der), priv
}

// El vector de paquetes/canal: una versión de Cloud firmada con una clave de legado que no
// se da y, en firmas, con la nueva de Cloud. Un nodo con PUBLICACION_CLAVES y sin legado
// la acepta; si solo confía en claves de otros usos, no.
func TestVectorDeClavesPorUso(t *testing.T) {
	b, err := os.ReadFile("../../../paquetes/canal/src/vectores/confianza.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Claves  string         `json:"claves"`
		Release ReleaseFirmada `json:"release"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	c := LeerConfianza(v.Claves, "")
	if len(c.Claves) != 3 || c.Legado != nil {
		t.Fatalf("la lista del vector se lee mal: %+v", c)
	}
	r, err := Verificar(c, v.Release)
	if err != nil {
		t.Fatalf("la versión del vector debería pasar: %v", err)
	}
	if r.Commit != strings.Repeat("c", 40) || len(r.Catalogo["smb"]) != 1 {
		t.Fatalf("catálogo o commit mal leídos: %+v", r)
	}
	var otras Confianza
	for _, k := range c.Claves {
		if k.Uso != "cloud" {
			otras.Claves = append(otras.Claves, k)
		}
	}
	if _, err := Verificar(otras, v.Release); err == nil {
		t.Fatal("sin clave de Cloud no debería pasar")
	}
}

func TestConfianzaEnLaVersion(t *testing.T) {
	legado, priv := claveB64(t)
	nueva, _ := claveB64(t)
	comm, _ := claveB64(t)
	c := LeerConfianza("", legado)
	img := `ejemplo.azurecr.io/sugardaddy-consola@sha256:` + strings.Repeat("a", 64)
	version := func(extra string) ReleaseFirmada {
		return firmar(t, priv, `{"version":"0.25.0","publicada":"x","notas":"x","servicios":{"consola":"`+img+`"}`+extra+`}`)
	}
	if _, err := Verificar(c, version(`,"confianza":{"claves":"cloud:`+nueva+`"}`)); err != nil {
		t.Fatalf("una confianza con su propia edición debería pasar: %v", err)
	}
	for nombre, extra := range map[string]string{
		"sin clave de su edición": `,"confianza":{"claves":"community:` + comm + `"}`,
		"uso desconocido":         `,"confianza":{"claves":"otra:` + nueva + `"}`,
		"catálogo vacío":          `,"catalogo":{"cowrie":[]}`,
		"catálogo con ruta":       `,"catalogo":{"../x":["` + strings.Repeat("b", 64) + `"]}`,
		"commit raro":             `,"commit":"main"`,
	} {
		if _, err := Verificar(c, version(extra)); err == nil {
			t.Errorf("%s: debería rechazarse", nombre)
		}
	}
}

func TestLeerConfianza(t *testing.T) {
	a, _ := claveB64(t)
	c := LeerConfianza("cloud:"+a+", otra:"+a+",licencias:basura,licencias:"+a, "")
	if len(c.Claves) != 2 || c.Claves[0].Uso != "cloud" || c.Claves[1].Uso != "licencias" || c.Legado != nil {
		t.Fatalf("%+v", c)
	}
	if !c.HayClave("cloud") || c.HayClave("community") || c.HayClave("") {
		t.Fatal("HayClave mal")
	}
	if MotivoClaves("cloud:"+a) != "" || MotivoClaves("otra:"+a) == "" || MotivoClaves("cloud:AAAA") == "" {
		t.Fatal("MotivoClaves mal")
	}
}

// Las claves nuevas del Key Vault son ECDSA P-256 y firman en r||s (vectores/confianza-ec.json,
// generado en TypeScript): el Go acepta lo mismo, también con la nueva sola en firma.
func TestVectorECDSA(t *testing.T) {
	b, err := os.ReadFile("../../../paquetes/canal/src/vectores/confianza-ec.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Claves           string         `json:"claves"`
		Release          ReleaseFirmada `json:"release"`
		ReleaseSinLegado ReleaseFirmada `json:"releaseSinLegado"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	c := LeerConfianza(v.Claves, "")
	if len(c.Claves) != 3 {
		t.Fatalf("claves ECDSA mal leídas: %d", len(c.Claves))
	}
	for nombre, f := range map[string]ReleaseFirmada{"con legado": v.Release, "sin legado": v.ReleaseSinLegado} {
		if _, err := Verificar(c, f); err != nil {
			t.Errorf("%s: %v", nombre, err)
		}
	}
	tocada := v.ReleaseSinLegado
	tocada.Release = strings.Replace(tocada.Release, "vector", "vectoR", 1)
	if _, err := Verificar(c, tocada); err == nil {
		t.Fatal("una versión tocada no debería pasar")
	}
}

// Desde la 0.29.2 la versión de Community lleva la configuración del nodo, como la de
// Cloud: un nodo Community la acepta y uno Cloud no, y lo que no es compose.yml o
// Caddyfile sigue fuera aunque venga firmado.
func TestCommunityConConfiguracion(t *testing.T) {
	comm, priv := claveB64(t)
	c := LeerConfianza("community:"+comm, "")
	img := func(s string) string {
		return `ghcr.io/seguridadsi/sugardaddy-` + s + `:0.29.2@sha256:` + strings.Repeat("a", 64)
	}
	version := func(ficheros string) ReleaseFirmada {
		texto := `{"version":"0.29.2","publicada":"x","notas":"x","servicios":{"consola":"` + img("consola") +
			`","sensor":"` + img("sensor") + `"},"actualizador":"` + img("actualizador") +
			`","nodo":{"ficheros":{` + ficheros + `},"entorno":{"generar":["CLAVE_SECRETOS"]}}}`
		f := firmar(t, priv, texto)
		f.Firmas = []Firma{{Clave: Huella(priv.Public()), Firma: f.Firma}}
		f.Firma = ""
		return f
	}
	buena := version(`"compose.yml":"services: {}","Caddyfile":":443"`)
	r, err := VerificarEnNodo(c, "community", buena)
	if err != nil {
		t.Fatalf("un nodo Community debería aceptarla: %v", err)
	}
	if r.Nodo == nil || r.Nodo.Ficheros["compose.yml"] == "" || r.Actualizador == "" {
		t.Fatalf("la configuración o el actualizador no se leen: %+v", r)
	}
	if _, err := VerificarEnNodo(c, "cloud", buena); err == nil {
		t.Fatal("un nodo Cloud no debería aceptar una versión de Community")
	}
	if _, err := VerificarEnNodo(c, "community", version(`"compose.yml":"x","instalar.sh":"x"`)); err == nil {
		t.Fatal("un fichero que no es compose.yml ni Caddyfile no debería pasar")
	}
}
