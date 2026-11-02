package confianza

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// caDePrueba genera una CA autofirmada y la escribe como PEM en un fichero
// temporal; devuelve la ruta del PEM, el certificado y su clave, para poder
// firmar luego un leaf y comprobar que la raíz quedó en el pool del cliente.
func caDePrueba(t *testing.T) (string, *x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	clave, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	plantilla := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "CA de prueba Sugardaddy"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, plantilla, plantilla, &clave.PublicKey, clave)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	ruta := filepath.Join(t.TempDir(), "ca.pem")
	bloque := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(ruta, bloque, 0o600); err != nil {
		t.Fatal(err)
	}
	return ruta, cert, clave
}

// Sin CA: cliente por defecto (sin Transport propio) con el tiempo de espera.
func TestClienteSinCA(t *testing.T) {
	c, err := Cliente("", 7*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if c.Transport != nil {
		t.Error("sin CA no debería montar un Transport propio")
	}
	if c.Timeout != 7*time.Second {
		t.Errorf("espera %v, quería 7s", c.Timeout)
	}
}

// Fichero de CA vacío (solo espacios): cae al cliente por defecto, sin error.
// La consola usa entonces un certificado de una CA en la que el sistema confía.
func TestClientePemVacio(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "vacia.pem")
	if err := os.WriteFile(ruta, []byte("  \n\t "), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Cliente(ruta, 5*time.Second)
	if err != nil {
		t.Fatalf("un PEM vacío no debería dar error: %v", err)
	}
	if c.Transport != nil {
		t.Error("un PEM vacío debería caer al cliente por defecto")
	}
	if c.Timeout != 5*time.Second {
		t.Errorf("espera %v, quería 5s", c.Timeout)
	}
}

// Fichero con contenido pero sin ningún certificado válido: error, no se calla.
func TestClientePemSinCertificado(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "basura.pem")
	if err := os.WriteFile(ruta, []byte("esto no es un certificado\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Cliente(ruta, 5*time.Second); err == nil {
		t.Error("un PEM sin certificados debería dar error, no un cliente sin la CA")
	}
}

// Fichero de CA inexistente: error (no se puede leer).
func TestClienteFicheroInexistente(t *testing.T) {
	if _, err := Cliente(filepath.Join(t.TempDir(), "no-existe.pem"), 5*time.Second); err == nil {
		t.Error("un fichero de CA inexistente debería dar error")
	}
}

// CA válida: Transport propio con TLS 1.2 mínimo, verificación activa, y la raíz
// de la CA de prueba dentro del pool (se comprueba firmando un leaf y
// verificándolo contra RootCAs, sin depender de Subjects(), deprecado).
func TestClienteCAValida(t *testing.T) {
	ruta, ca, claveCA := caDePrueba(t)
	c, err := Cliente(ruta, 11*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if c.Timeout != 11*time.Second {
		t.Errorf("espera %v, quería 11s", c.Timeout)
	}
	tr, ok := c.Transport.(*http.Transport)
	if !ok || tr == nil {
		t.Fatalf("con CA debería montar un *http.Transport, es %T", c.Transport)
	}
	if tr.TLSClientConfig == nil {
		t.Fatal("falta TLSClientConfig")
	}
	if tr.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Errorf("MinVersion %x, quería TLS 1.2 (%x)", tr.TLSClientConfig.MinVersion, tls.VersionTLS12)
	}
	if tr.TLSClientConfig.InsecureSkipVerify {
		t.Error("nunca debe desactivarse la verificación del certificado")
	}

	// La raíz está en el pool si un leaf firmado por la CA verifica contra él.
	claveLeaf, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	plantillaLeaf := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "consola.ejemplo"},
		DNSNames:     []string{"consola.ejemplo"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	derLeaf, err := x509.CreateCertificate(rand.Reader, plantillaLeaf, ca, &claveLeaf.PublicKey, claveCA)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(derLeaf)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:   tr.TLSClientConfig.RootCAs,
		DNSName: "consola.ejemplo",
	}); err != nil {
		t.Errorf("la CA de prueba debería estar en el pool de raíces: %v", err)
	}
}
