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
	"net"
	"net/http"
	"net/http/httptest"
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
	r, ok := c.Transport.(*Recargable)
	if !ok || r == nil {
		t.Fatalf("con CA debería montar un *Recargable, es %T", c.Transport)
	}
	tr := r.Transporte()
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

// servidorDe arranca un HTTPS con un certificado de esa CA para 127.0.0.1.
func servidorDe(t *testing.T, ca *x509.Certificate, claveCA *ecdsa.PrivateKey) *httptest.Server {
	t.Helper()
	clave, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}, ca, &clave.PublicKey, claveCA)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: clave}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// La consola pasa a otra raíz: el actualizador deja en el fichero la vieja y la
// nueva, y el mismo cliente, sin rehacerlo, ya confía en la nueva.
func TestRecargaLasRaicesAlCambiarElFichero(t *testing.T) {
	rutaVieja, vieja, claveVieja := caDePrueba(t)
	_, nueva, claveNueva := caDePrueba(t)
	srvViejo := servidorDe(t, vieja, claveVieja)
	srvNuevo := servidorDe(t, nueva, claveNueva)
	c, err := Cliente(rutaVieja, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	pide := func(url string) error {
		resp, err := c.Get(url)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	if err := pide(srvViejo.URL); err != nil {
		t.Fatalf("old root: %v", err)
	}
	if err := pide(srvNuevo.URL); err == nil {
		t.Fatal("the new root is not trusted yet")
	}
	pemVieja, _ := os.ReadFile(rutaVieja)
	pemNueva := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: nueva.Raw})
	f, _ := os.OpenFile(rutaVieja, os.O_WRONLY|os.O_TRUNC, 0)
	_, _ = f.Write(append(append([]byte{}, pemVieja...), pemNueva...))
	f.Close()
	if err := pide(srvNuevo.URL); err != nil {
		t.Fatalf("after the change both roots must be trusted: %v", err)
	}
	if err := pide(srvViejo.URL); err != nil {
		t.Fatalf("the old one too, until the switch: %v", err)
	}
	// Después solo la nueva.
	_ = os.WriteFile(rutaVieja, pemNueva, 0o600)
	if err := pide(srvViejo.URL); err == nil {
		t.Fatal("the old root must no longer be trusted")
	}
	// Un fichero roto no deja al sensor sin conexión: sigue con lo que tenía.
	_ = os.WriteFile(rutaVieja, []byte("basura que no es un certificado, más larga\n"), 0o600)
	if err := pide(srvNuevo.URL); err != nil {
		t.Fatalf("a broken file must keep the previous roots: %v", err)
	}
}

// certificadoCliente firma con la CA un certificado de cliente y lo deja, con su
// clave, en un solo PEM (como lo deja el instalador del sensor remoto).
func certificadoCliente(t *testing.T, ca *x509.Certificate, claveCA *ecdsa.PrivateKey, ruta, cn string) {
	t.Helper()
	clave, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	plantilla := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, plantilla, ca, &clave.PublicKey, claveCA)
	if err != nil {
		t.Fatal(err)
	}
	k, _ := x509.MarshalPKCS8PrivateKey(clave)
	b := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: k})...)
	tmp := ruta + ".nuevo"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, ruta); err != nil {
		t.Fatal(err)
	}
}

// Con certificado propio: lo presenta cuando el servidor lo pide (verify_if_given,
// como Caddy), sin él no presenta nada, y si cambia el fichero usa el nuevo.
func TestClienteConCertificado(t *testing.T) {
	raiz, ca, claveCA := caDePrueba(t)
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.TLS.PeerCertificates) == 0 {
			w.Write([]byte("-"))
			return
		}
		w.Write([]byte(r.TLS.PeerCertificates[0].Subject.CommonName))
	}))
	srv.TLS = &tls.Config{ClientAuth: tls.VerifyClientCertIfGiven, ClientCAs: pool}
	srv.StartTLS()
	defer srv.Close()
	// La raíz del servidor de prueba, junto a la de la CA.
	servidor := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	b, _ := os.ReadFile(raiz)
	os.WriteFile(raiz, append(b, servidor...), 0o600)

	cert := filepath.Join(t.TempDir(), "cliente.pem")
	c, err := ClienteConCertificado(raiz, cert, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	pedir := func() string {
		r, err := c.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var buf [64]byte
		n, _ := r.Body.Read(buf[:])
		return string(buf[:n])
	}
	if got := pedir(); got != "-" {
		t.Fatalf("sin fichero no debía presentar certificado: %q", got)
	}
	certificadoCliente(t, ca, claveCA, cert, "sensor-1")
	time.Sleep(10 * time.Millisecond)
	if got := pedir(); got != "sensor-1" {
		t.Fatalf("con el fichero nuevo debía cerrar la conexión vieja y presentarlo: %q", got)
	}
	certificadoCliente(t, ca, claveCA, cert, "sensor-1-renovado")
	// Otra fecha de modificación aunque el sistema de ficheros redondee.
	futuro := time.Now().Add(2 * time.Second)
	os.Chtimes(cert, futuro, futuro)
	if got := pedir(); got != "sensor-1-renovado" {
		t.Fatalf("tras renovar debía presentar el nuevo: %q", got)
	}
}

// Sin raíz propia pero con certificado: las raíces del sistema y el certificado.
func TestClienteSoloCertificado(t *testing.T) {
	c, err := ClienteConCertificado("", filepath.Join(t.TempDir(), "no-existe.pem"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if c.Transport == nil {
		t.Fatal("con certificado propio hace falta un transporte propio")
	}
}
