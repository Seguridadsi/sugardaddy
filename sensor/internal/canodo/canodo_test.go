package canodo

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// hoja firma con la intermedia de la CA un certificado con esos nombres e IPs
// y el uso que se diga, como haría quien se hiciera con la clave del nodo.
func hoja(t *testing.T, c *CA, dns []string, ips []net.IP, usos []x509.ExtKeyUsage) *x509.Certificate {
	t.Helper()
	clave, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	s, _ := serie()
	tpl := &x509.Certificate{
		SerialNumber: s,
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  usos,
		DNSNames:     dns,
		IPAddresses:  ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.Intermedia, &clave.PublicKey, c.clave)
	if err != nil {
		t.Fatal(err)
	}
	h, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

var servidor = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}

func TestUnaConsolaPorNombre(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ca-nodo")
	c, err := Generar(dir, "gestion.aldanza.local", "nodo-mad01", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := Verificar(c.Raiz, c.Intermedia, hoja(t, c, []string{"gestion.aldanza.local"}, nil, servidor), "gestion.aldanza.local"); err != nil {
		t.Fatalf("the console certificate must validate: %v", err)
	}
	// Lo que el atacante querría: otros nombres, IPs, o mezclar la consola con otro.
	malos := []struct {
		que     string
		dns     []string
		ips     []net.IP
		destino string
	}{
		{"otro dominio", []string{"www.microsoft.com"}, nil, "www.microsoft.com"},
		{"el ERP interno", []string{"erp.aldanza.local"}, nil, "erp.aldanza.local"},
		{"el dominio padre", []string{"aldanza.local"}, nil, "aldanza.local"},
		{"la consola y otro", []string{"gestion.aldanza.local", "erp.aldanza.local"}, nil, "gestion.aldanza.local"},
		{"una IP", nil, []net.IP{net.ParseIP("10.0.0.5")}, "10.0.0.5"},
		{"una IPv6", nil, []net.IP{net.ParseIP("fe80::1")}, "fe80::1"},
	}
	for _, m := range malos {
		if err := Verificar(c.Raiz, c.Intermedia, hoja(t, c, m.dns, m.ips, servidor), m.destino); err == nil {
			t.Errorf("%s: a certificate for %v %v must NOT validate", m.que, m.dns, m.ips)
		}
	}
	if !c.Cubre("gestion.aldanza.local") || c.Cubre("otra.aldanza.local") || c.Cubre("10.0.0.5") {
		t.Fatal("Cubre must say yes only for the console address")
	}
	if !strings.Contains(c.Raiz.Subject.String(), "nodo-mad01") || c.Raiz.Subject.String() == c.Intermedia.Subject.String() {
		t.Fatalf("subjects: %q / %q", c.Raiz.Subject, c.Intermedia.Subject)
	}
}

func TestUnaConsolaPorIP(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ca-nodo")
	c, err := Generar(dir, "10.70.0.10", "nodo-x", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := Verificar(c.Raiz, c.Intermedia, hoja(t, c, nil, []net.IP{net.ParseIP("10.70.0.10")}, servidor), "10.70.0.10"); err != nil {
		t.Fatalf("the console certificate must validate: %v", err)
	}
	for _, m := range []struct {
		dns     []string
		ips     []net.IP
		destino string
	}{
		{nil, []net.IP{net.ParseIP("10.70.0.11")}, "10.70.0.11"},
		{nil, []net.IP{net.ParseIP("::ffff:10.70.0.11")}, "10.70.0.11"},
		{[]string{"www.microsoft.com"}, nil, "www.microsoft.com"},
		{[]string{"intranet"}, nil, "intranet"},
	} {
		if err := Verificar(c.Raiz, c.Intermedia, hoja(t, c, m.dns, m.ips, servidor), m.destino); err == nil {
			t.Errorf("a certificate for %v %v must NOT validate", m.dns, m.ips)
		}
	}
	if !c.Cubre("10.70.0.10") || c.Cubre("10.70.0.11") || c.Cubre("gestion.aldanza.local") {
		t.Fatal("Cubre must say yes only for the console IP")
	}
}

func TestSoloServidoresTLS(t *testing.T) {
	c, err := Generar(filepath.Join(t.TempDir(), "ca"), "gestion.aldanza.local", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// Un certificado sin nombres para firmar código: los nameConstraints no lo
	// frenan, el uso de clave de la cadena sí.
	codigo := hoja(t, c, nil, nil, []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning})
	raices := x509.NewCertPool()
	raices.AddCert(c.Raiz)
	inters := x509.NewCertPool()
	inters.AddCert(c.Intermedia)
	if _, err := codigo.Verify(x509.VerifyOptions{Roots: raices, Intermediates: inters, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning}}); err == nil {
		t.Fatal("a code signing certificate must not validate")
	}
	if c.Raiz.MaxPathLen != 1 || !c.Intermedia.MaxPathLenZero {
		t.Fatalf("path lengths: root %d, intermediate zero %v", c.Raiz.MaxPathLen, c.Intermedia.MaxPathLenZero)
	}
}

func TestLaClaveDeLaRaizNoSeEscribe(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ca-nodo")
	if _, err := Generar(dir, "consola.local", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	entradas, _ := os.ReadDir(dir)
	var nombres []string
	for _, e := range entradas {
		nombres = append(nombres, e.Name())
	}
	if strings.Join(nombres, ",") != "intermedia.crt,intermedia.key,raiz.crt" {
		t.Fatalf("files: %v", nombres)
	}
	fi, _ := os.Stat(filepath.Join(dir, FicheroClave))
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("intermedia.key mode %v", fi.Mode().Perm())
	}
	fd, _ := os.Stat(dir)
	if fd.Mode().Perm() != 0o700 {
		t.Fatalf("folder mode %v", fd.Mode().Perm())
	}
}

func TestLeerRechazaUnaCAAMedias(t *testing.T) {
	a := filepath.Join(t.TempDir(), "a")
	b := filepath.Join(t.TempDir(), "b")
	if _, err := Generar(a, "consola.local", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := Generar(b, "consola.local", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := Leer(a); err != nil {
		t.Fatal(err)
	}
	// La intermedia de otra CA: no la firma esta raíz.
	otra, _ := os.ReadFile(filepath.Join(b, FicheroIntermedia))
	_ = os.WriteFile(filepath.Join(a, FicheroIntermedia), otra, 0o644)
	if _, err := Leer(a); err == nil {
		t.Fatal("an intermediate from another CA must be rejected")
	}
	// La intermedia buena con la clave de otra.
	_, _ = Generar(a, "consola.local", "", time.Now())
	claveOtra, _ := os.ReadFile(filepath.Join(b, FicheroClave))
	_ = os.WriteFile(filepath.Join(a, FicheroClave), claveOtra, 0o600)
	if _, err := Leer(a); err == nil {
		t.Fatal("a key that does not match must be rejected")
	}
	// Un enlace en lugar de la raíz.
	_, _ = Generar(a, "consola.local", "", time.Now())
	_ = os.Remove(filepath.Join(a, FicheroRaiz))
	_ = os.Symlink(filepath.Join(b, FicheroRaiz), filepath.Join(a, FicheroRaiz))
	if _, err := Leer(a); err == nil {
		t.Fatal("a symlink must be rejected")
	}
	if _, err := Leer(filepath.Join(t.TempDir(), "nada")); err == nil {
		t.Fatal("a missing CA must be an error")
	}
}

func TestDireccionesNoValidas(t *testing.T) {
	for _, d := range []string{"", "*.aldanza.local", "con espacio", "a..b", "-x.local"} {
		if _, err := Generar(filepath.Join(t.TempDir(), "ca"), d, "", time.Now()); err == nil {
			t.Errorf("%q must be rejected", d)
		}
	}
}

func TestHuellaComoOpenSSL(t *testing.T) {
	c, err := Generar(filepath.Join(t.TempDir(), "ca"), "consola.local", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	h := c.Huella()
	if len(h) != 95 || strings.ToUpper(h) != h || strings.Count(h, ":") != 31 {
		t.Fatalf("fingerprint %q", h)
	}
}
