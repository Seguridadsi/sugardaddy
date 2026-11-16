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

// consolaCertificados firma las CSR que llegan (como /api/sensor/certificado) con una CA de prueba.
func consolaCertificados(t *testing.T, estado *int, vida time.Duration) (*httptest.Server, *int) {
	t.Helper()
	claveCA, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	plantillaCA := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "CA sensores"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign}
	derCA, _ := x509.CreateCertificate(rand.Reader, plantillaCA, plantillaCA, &claveCA.PublicKey, claveCA)
	ca, _ := x509.ParseCertificate(derCA)
	pedidas := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pedidas++
		if r.URL.Path != "/api/sensor/certificado" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if *estado != http.StatusOK {
			w.WriteHeader(*estado)
			return
		}
		var b struct{ Csr string }
		json.NewDecoder(r.Body).Decode(&b)
		bl, _ := pem.Decode([]byte(b.Csr))
		csr, err := x509.ParseCertificateRequest(bl.Bytes)
		if err != nil || csr.CheckSignature() != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		der, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "s1"},
			NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(vida),
			ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}, ca, csr.PublicKey, claveCA)
		json.NewEncoder(w).Encode(map[string]string{"certificado": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))})
	}))
	t.Cleanup(srv.Close)
	return srv, &pedidas
}

func TestCertificadoSensorPideElPrimeroYNoRepite(t *testing.T) {
	estado := http.StatusOK
	srv, pedidas := consolaCertificados(t, &estado, 90*24*time.Hour)
	dir := t.TempDir()
	var dueno []int
	c := &CertificadoSensor{Consola: srv.URL, Token: "tok", HTTP: srv.Client(), Fichero: filepath.Join(dir, FicheroCertificadoSensor),
		Dueno: func(_ string, uid, gid int) error { dueno = []int{uid, gid}; return nil }}
	if err := c.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	cert, err := LeerCertificadoSensor(c.Fichero)
	if err != nil || cert.Subject.CommonName != "s1" {
		t.Fatalf("no dejó el certificado con su clave: %v", err)
	}
	if fi, _ := os.Stat(c.Fichero); fi.Mode().Perm() != 0o640 || len(dueno) != 2 || dueno[0] != UsuarioSensor || dueno[1] != 0 {
		t.Fatalf("permisos o dueño: %v %v", fi.Mode(), dueno)
	}
	if err := c.Vuelta(context.Background()); err != nil || *pedidas != 1 {
		t.Fatalf("con uno vigente no tenía que pedir otro: %d %v", *pedidas, err)
	}
}

func TestCertificadoSensorRenuevaSoloCuandoToca(t *testing.T) {
	estado := http.StatusOK
	srv, pedidas := consolaCertificados(t, &estado, 10*24*time.Hour)
	dir := t.TempDir()
	ahora := time.Now()
	c := &CertificadoSensor{Consola: srv.URL, Token: "tok", HTTP: srv.Client(), Fichero: filepath.Join(dir, FicheroCertificadoSensor),
		Dueno: func(string, int, int) error { return nil }, Ahora: func() time.Time { return ahora }}
	if err := c.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Le quedan 10 días: toca renovar, pero la consola dice que aún no (409). Se espera una hora.
	estado = http.StatusConflict
	if err := c.Vuelta(context.Background()); err != nil || *pedidas != 2 {
		t.Fatalf("tenía que pedir la renovación: %d %v", *pedidas, err)
	}
	if err := c.Vuelta(context.Background()); err != nil || *pedidas != 2 {
		t.Fatalf("tras un 409 tenía que esperar: %d", *pedidas)
	}
	ahora = ahora.Add(61 * time.Minute)
	estado = http.StatusOK
	if err := c.Vuelta(context.Background()); err != nil || *pedidas != 3 {
		t.Fatalf("pasada la hora tenía que renovar: %d %v", *pedidas, err)
	}
}

func TestCertificadoSensorNoAceptaOtraClave(t *testing.T) {
	// Una consola que devuelve siempre el mismo certificado, de otra clave.
	otra, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(3), NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}, &x509.Certificate{SerialNumber: big.NewInt(3)}, &otra.PublicKey, otra)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"certificado": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))})
	}))
	defer srv.Close()
	c := &CertificadoSensor{Consola: srv.URL, Token: "tok", HTTP: srv.Client(), Fichero: filepath.Join(t.TempDir(), FicheroCertificadoSensor),
		Dueno: func(string, int, int) error { return nil }}
	if err := c.Vuelta(context.Background()); err == nil {
		t.Fatal("un certificado de otra clave no se tenía que aceptar")
	}
	if _, err := os.Stat(c.Fichero); err == nil {
		t.Fatal("no tenía que escribir nada")
	}
}
