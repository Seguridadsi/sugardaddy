package actualizador

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// motorDeIntegridad hace de Docker: cada servicio con su contenedor, la imagen que pide y la que corre.
type motorDeIntegridad struct {
	pide    map[string]string // servicio → Config.Image
	corre   map[string]string // servicio → Image (id)
	imagens map[string]string // ref → Id
}

func (m motorDeIntegridad) ListarConEtiqueta(_ context.Context, etiqueta string) ([]docker.Contenedor, error) {
	s := strings.TrimPrefix(etiqueta, EtiquetaServicio+"=")
	if _, ok := m.pide[s]; !ok {
		return nil, nil
	}
	return []docker.Contenedor{{ID: s, State: "running"}}, nil
}

func (m motorDeIntegridad) Inspeccionar(_ context.Context, id string) (map[string]any, error) {
	return map[string]any{"Config": map[string]any{"Image": m.pide[id]}, "Image": m.corre[id]}, nil
}

func (m motorDeIntegridad) InspeccionarImagen(_ context.Context, ref string) (map[string]any, error) {
	if id, ok := m.imagens[ref]; ok {
		return map[string]any{"Id": id}, nil
	}
	return nil, &docker.ErrAPI{Codigo: 404, Mensaje: "no such image"}
}

type nodoIntegridad struct {
	dir string
	i   *Integridad
	m   *motorDeIntegridad
}

// Un nodo recién aplicado con la 0.30.0: todo casa con lo firmado.
func nodoSano(t *testing.T) nodoIntegridad {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	clave, _ := ClavePublica(base64.StdEncoding.EncodeToString(der))
	consola := "r/consola@sha256:" + strings.Repeat("a", 64)
	r := Release{
		Version: "0.30.0", Publicada: "2026-11-14T00:00:00Z", Servicios: map[string]string{"consola": consola},
		Actualizador: "r/actualizador@sha256:" + strings.Repeat("b", 64),
		Nodo:         &Configuracion{Ficheros: map[string]string{"compose.yml": "services: {}\n", "Caddyfile": "caddy\n"}},
	}
	b, _ := json.Marshal(r)
	f := ReleaseFirmada{Release: string(b), Firma: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, b))}
	dir := t.TempDir()
	if err := GuardarFirmada(dir, f); err != nil {
		t.Fatal(err)
	}
	escribir := func(n, s string) {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	escribir("compose.yml", "services: {}\n")
	escribir("Caddyfile", "caddy\n")
	escribir(".env", "POSTGRES_PASSWORD=x\nNODO_NOMBRE=y\n")
	if err := EscribirVersiones(filepath.Join(dir, "versiones.env"), r, true); err != nil {
		t.Fatal(err)
	}
	m := &motorDeIntegridad{
		pide:    map[string]string{"consola": consola},
		corre:   map[string]string{"consola": "sha256:buena"},
		imagens: map[string]string{consola: "sha256:buena"},
	}
	return nodoIntegridad{dir: dir, m: m, i: &Integridad{Docker: m, Local: dir, Confianza: Confianza{Legado: clave}}}
}

func (n nodoIntegridad) desviaciones(t *testing.T) []Desviacion {
	t.Helper()
	v, ds, ok := n.i.Comprobar(context.Background())
	if !ok || v != "0.30.0" {
		t.Fatalf("debería poder comparar con la 0.30.0: %q %v", v, ok)
	}
	return ds
}

func tieneTipo(ds []Desviacion, tipo, texto string) bool {
	for _, d := range ds {
		if d.Tipo == tipo && strings.Contains(d.Detalle, texto) {
			return true
		}
	}
	return false
}

func TestUnNodoComoSuVersionFirmadaNoTieneDesviaciones(t *testing.T) {
	n := nodoSano(t)
	if ds := n.desviaciones(t); len(ds) != 0 {
		t.Fatalf("no debería haber desviaciones: %v", ds)
	}
	// Y la segunda vez, ya con la referencia del .env guardada, tampoco.
	if ds := n.desviaciones(t); len(ds) != 0 {
		t.Fatalf("no debería haber desviaciones: %v", ds)
	}
}

func TestUnComposeTocadoEsUnaDesviacion(t *testing.T) {
	n := nodoSano(t)
	_ = os.WriteFile(filepath.Join(n.dir, "compose.yml"), []byte("services: {malo: {privileged: true}}\n"), 0o644)
	if ds := n.desviaciones(t); !tieneTipo(ds, "fichero", "compose.yml differs") {
		t.Fatalf("debería ver el compose cambiado: %v", ds)
	}
}

func TestUnaVariableNuevaEnElEnvEsUnaDesviacionYSinSuValor(t *testing.T) {
	n := nodoSano(t)
	n.desviaciones(t) // la referencia
	f, _ := os.OpenFile(filepath.Join(n.dir, ".env"), os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString("PANEL_HTTP_PERMITIDO=secreto-que-no-sale\nCA_NODO=nodo\n")
	f.Close()
	ds := n.desviaciones(t)
	if !tieneTipo(ds, "env", "PANEL_HTTP_PERMITIDO") {
		t.Fatalf("debería ver la variable nueva: %v", ds)
	}
	for _, d := range ds {
		if strings.Contains(d.Detalle, "secreto-que-no-sale") || strings.Contains(d.Detalle, "CA_NODO") {
			t.Fatalf("ni el valor ni lo que pone el propio actualizador: %v", d)
		}
	}
}

func TestUnaVariableQuitadaDelEnvEsUnaDesviacion(t *testing.T) {
	n := nodoSano(t)
	n.desviaciones(t) // la referencia
	_ = os.WriteFile(filepath.Join(n.dir, ".env"), []byte("POSTGRES_PASSWORD=x\n"), 0o600)
	if ds := n.desviaciones(t); !tieneTipo(ds, "env", "removed from .env since the last version: NODO_NOMBRE") {
		t.Fatalf("debería ver la variable quitada: %v", ds)
	}
}

func TestUnaImagenCambiadaEnMarchaEsUnaDesviacion(t *testing.T) {
	n := nodoSano(t)
	n.m.corre["consola"] = "sha256:otra"
	if ds := n.desviaciones(t); !tieneTipo(ds, "imagen", "content is not the one") {
		t.Fatalf("debería ver la imagen cambiada por debajo: %v", ds)
	}
	n = nodoSano(t)
	n.m.pide["consola"] = "r/consola:latest"
	if ds := n.desviaciones(t); !tieneTipo(ds, "imagen", "not the one of the signed version") {
		t.Fatalf("debería ver otra imagen: %v", ds)
	}
}

func TestVersionesEnvTocadoEsUnaDesviacion(t *testing.T) {
	n := nodoSano(t)
	ruta := filepath.Join(n.dir, "versiones.env")
	b, _ := os.ReadFile(ruta)
	_ = os.WriteFile(ruta, []byte(strings.Replace(string(b), strings.Repeat("a", 64), strings.Repeat("c", 64), 1)), 0o644)
	if ds := n.desviaciones(t); !tieneTipo(ds, "versiones", "CONSOLA_IMAGEN") {
		t.Fatalf("debería ver versiones.env cambiado: %v", ds)
	}
}

func TestUnaVersionFirmadaFalsaEsUnaDesviacion(t *testing.T) {
	n := nodoSano(t)
	ruta := filepath.Join(n.dir, FicheroFirmada)
	b, _ := os.ReadFile(ruta)
	_ = os.WriteFile(ruta, []byte(strings.Replace(string(b), "0.30.0", "0.30.1", 1)), 0o644)
	_, ds, ok := n.i.Comprobar(context.Background())
	if !ok || !tieneTipo(ds, "firma", "does not verify") {
		t.Fatalf("debería ver la versión firmada falsa: %v %v", ds, ok)
	}
}

func TestSinVersionFirmadaNoHayConQueComparar(t *testing.T) {
	n := nodoSano(t)
	_ = os.Remove(filepath.Join(n.dir, FicheroFirmada))
	if _, _, ok := n.i.Comprobar(context.Background()); ok {
		t.Fatal("sin versión firmada no debería decir nada")
	}
}
