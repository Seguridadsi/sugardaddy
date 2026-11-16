package actualizador

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func raizPrueba(t *testing.T, ca bool) string {
	t.Helper()
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "CA sensores"}, NotBefore: time.Now(),
		NotAfter: time.Now().Add(time.Hour), IsCA: ca, BasicConstraintsValid: true}
	der, _ := x509.CreateCertificate(rand.Reader, p, p, &k.PublicKey, k)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestRaizSensoresDER(t *testing.T) {
	if _, err := RaizSensoresDER(raizPrueba(t, true)); err != nil {
		t.Fatal(err)
	}
	if _, err := RaizSensoresDER(raizPrueba(t, false)); err == nil {
		t.Fatal("un certificado que no es de CA no vale")
	}
	if _, err := RaizSensoresDER(raizPrueba(t, true) + raizPrueba(t, true)); err == nil {
		t.Fatal("solo una raíz")
	}
}

func TestCASensoresLanzaSoloSiCambia(t *testing.T) {
	raiz := raizPrueba(t, true)
	sinCA := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/actualizador/ca-sensores" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if sinCA {
			json.NewEncoder(w).Encode(map[string]any{"raiz": nil})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"raiz": raiz})
	}))
	defer srv.Close()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".env"), []byte("CONSOLA_DOMINIO=x\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "versiones.env"), []byte("ACTUALIZADOR_IMAGEN=img@sha256:1\n"), 0o600)
	lanzadas := 0
	fallar := false
	c := &CASensores{Consola: srv.URL, Token: "tok", HTTP: srv.Client(), Local: dir,
		Lanzar: func(_ context.Context, imagen, nueva string) ResultadoCA {
			lanzadas++
			if fallar {
				return ResultadoCA{Estado: CAFallida, Detalle: "https no aguanta"}
			}
			fijarEnv(filepath.Join(dir, ".env"), "CA_SENSORES", nueva)
			return ResultadoCA{Estado: CAAplicada}
		}}
	if err := c.Vuelta(context.Background()); err != nil || lanzadas != 1 {
		t.Fatalf("tenía que poner la raíz: %d %v", lanzadas, err)
	}
	if err := c.Vuelta(context.Background()); err != nil || lanzadas != 1 {
		t.Fatalf("con la misma raíz no se relanza: %d", lanzadas)
	}
	sinCA = true
	if err := c.Vuelta(context.Background()); err != nil || lanzadas != 1 {
		t.Fatal("sin CA en la consola no se toca lo que hay")
	}
	sinCA, fallar = false, true
	raiz = raizPrueba(t, true)
	if err := c.Vuelta(context.Background()); err == nil || lanzadas != 2 {
		t.Fatal("un fallo se dice")
	}
	if err := c.Vuelta(context.Background()); err != nil || lanzadas != 2 {
		t.Fatal("tras un fallo se espera antes de reintentar")
	}
}
