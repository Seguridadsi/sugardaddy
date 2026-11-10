package catalogo

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

func manifiesto(imagen string) plan.Manifiesto {
	return plan.Manifiesto{ID: "smb", Tipo: "smb", Contenedor: &plan.Contenedor{Imagen: imagen, Registros: "/log"},
		Aislamiento: &plan.Aislamiento{SoloLectura: true, CPU: 0.5, MemoriaMb: 64}}
}

func firmada(t *testing.T, priv ed25519.PrivateKey, catalogo map[string][]string) []byte {
	t.Helper()
	r := map[string]any{"version": "0.25.0", "publicada": "x", "notas": "x",
		"servicios": map[string]string{"sensor": "ejemplo.azurecr.io/s@sha256:" + strings.Repeat("a", 64)}}
	if catalogo != nil {
		r["catalogo"] = catalogo
	}
	texto, _ := json.Marshal(r)
	b, _ := json.Marshal(actualizador.ReleaseFirmada{Release: string(texto), Firma: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, texto))})
	return b
}

func TestHuellaEsLaMismaDesdeTextoYDesdeEstructura(t *testing.T) {
	m := manifiesto("r/smb@sha256:1")
	b, _ := json.Marshal(m)
	// Con un campo que el sensor no entiende y otro orden: la misma huella.
	var x map[string]any
	_ = json.Unmarshal(b, &x)
	x["algoNuevo"] = "que el sensor ignora"
	b2, _ := json.Marshal(x)
	h, err := HuellaDeTexto(b2)
	if err != nil || h != Huella(m) || len(h) != 64 {
		t.Fatalf("%s %s %v", h, Huella(m), err)
	}
	otra := manifiesto("r/smb@sha256:1")
	otra.Aislamiento.SoloLectura = false
	if Huella(otra) == Huella(m) {
		t.Fatal("un cambio en el aislamiento tiene que cambiar la huella")
	}
}

func TestLectorConFirmaCatalogoYManipulacion(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	conf := actualizador.LeerConfianza("", base64.StdEncoding.EncodeToString(der))
	ruta := filepath.Join(t.TempDir(), "version.json")
	l := &Lector{Ruta: ruta, Confianza: conf}

	if c, err := l.Leer(); c != nil || err != nil {
		t.Fatalf("sin fichero: sin catálogo y sin error (%v %v)", c, err)
	}
	if err := os.WriteFile(ruta, firmada(t, priv, nil), 0o644); err != nil {
		t.Fatal(err)
	}
	if c, err := l.Leer(); c != nil || err != nil {
		t.Fatalf("una versión sin catálogo no limita nada (%v %v)", c, err)
	}
	buena := manifiesto("r/smb@sha256:1")
	_ = os.WriteFile(ruta, firmada(t, priv, map[string][]string{"smb": {Huella(buena)}}), 0o644)
	_ = os.Chtimes(ruta, time.Now().Add(time.Minute), time.Now().Add(time.Minute))
	c, err := l.Leer()
	if err != nil || c == nil {
		t.Fatalf("con catálogo: %v", err)
	}
	if m := c.Motivo(plan.TrampaPlan{ID: "t1", Manifiesto: buena}); m != "" {
		t.Fatalf("la del catálogo vale: %s", m)
	}
	if m := c.Motivo(plan.TrampaPlan{ID: "t1", Manifiesto: manifiesto("atacante.io/x@sha256:2")}); !strings.Contains(m, "differs from the one signed") {
		t.Fatalf("otra imagen: %q", m)
	}
	otro := buena
	otro.ID = "cowrie"
	if m := c.Motivo(plan.TrampaPlan{ID: "t2", Manifiesto: otro}); !strings.Contains(m, "does not include module") {
		t.Fatalf("otro módulo: %q", m)
	}
	// Alguien toca el fichero en la máquina: la firma no vale y no se arranca nada nuevo.
	b, _ := os.ReadFile(ruta)
	_ = os.WriteFile(ruta, []byte(strings.Replace(string(b), "0.25.0", "0.25.1", 1)), 0o644)
	_ = os.Chtimes(ruta, time.Now().Add(2*time.Minute), time.Now().Add(2*time.Minute))
	if c, err := l.Leer(); c != nil || err == nil {
		t.Fatalf("manipulada: tiene que dar error (%v %v)", c, err)
	}
}

// Con la marca, el catálogo es obligatorio: sin fichero o con una versión sin catálogo no se
// arranca nada nuevo. Y una versión de la otra edición no vale aunque la firma sea buena.
func TestCatalogoExigidoYEdicion(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	conf := actualizador.LeerConfianza("", base64.StdEncoding.EncodeToString(der))
	dir := t.TempDir()
	ruta := filepath.Join(dir, "version.json")
	marca := filepath.Join(dir, "exigir")
	l := &Lector{Ruta: ruta, Confianza: conf, Marca: marca, Edicion: "cloud"}
	if c, err := l.Leer(); c != nil || err != nil {
		t.Fatalf("sin marca y sin fichero, como antes: %v %v", c, err)
	}
	_ = os.WriteFile(marca, []byte("1\n"), 0o644)
	if _, err := l.Leer(); err == nil {
		t.Fatal("con la marca y sin fichero tiene que dar error")
	}
	_ = os.WriteFile(ruta, firmada(t, priv, nil), 0o644)
	if _, err := l.Leer(); err == nil {
		t.Fatal("con la marca y una versión sin catálogo tiene que dar error")
	}
	_ = os.WriteFile(ruta, firmada(t, priv, map[string][]string{"smb": {Huella(manifiesto("r/x@sha256:1"))}}), 0o644)
	_ = os.Chtimes(ruta, time.Now().Add(time.Minute), time.Now().Add(time.Minute))
	if c, err := l.Leer(); err != nil || c == nil {
		t.Fatalf("con catálogo de su edición vale: %v", err)
	}
	l2 := &Lector{Ruta: ruta, Confianza: conf, Marca: marca, Edicion: "community"}
	if _, err := l2.Leer(); err == nil {
		t.Fatal("una versión de Cloud no vale en un nodo Community")
	}
}
