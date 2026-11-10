// Package canodo crea y lee la CA propia del nodo (docs/diseno/ca-nodo.md).
//
// La raíz que se instala en los equipos del cliente solo vale para la
// dirección de la consola: lleva nameConstraints críticos con ese nombre o esa
// IP, y el uso de clave limitado a servidores TLS. Caddy firma con una
// intermedia; la clave de la raíz solo vive en memoria mientras se firma la
// intermedia y no se escribe nunca. Así, quien se haga con el nodo (que está
// expuesto a atacantes a propósito) solo puede suplantar a la propia consola.
package canodo

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Ficheros de la carpeta de la CA (ca-nodo/ en la carpeta del nodo). Caddy los
// monta en solo lectura; la consola nunca: la raíz pública le llega aparte, en
// ca-raiz.crt.
const (
	FicheroRaiz       = "raiz.crt"
	FicheroIntermedia = "intermedia.crt"
	FicheroClave      = "intermedia.key"
)

// Vigencia de la raíz y de la intermedia. Caddy no renueva una intermedia que
// se le da hecha, y sin la clave de la raíz nadie podría: las dos duran lo
// mismo. Al acabar hay que repartir otra raíz, como con la de Caddy.
const Vigencia = 10 * 365 * 24 * time.Hour

// dnsNinguno: con la consola en una IP, el único nombre permitido es uno que
// no existe (RFC 6761). Un dNSName permitido cierra todos los demás nombres en
// cualquier verificador; un excluido vacío no lo entienden todos igual.
const dnsNinguno = "invalid"

// CA es la CA del nodo ya leída y comprobada.
type CA struct {
	Raiz       *x509.Certificate
	Intermedia *x509.Certificate
	clave      crypto.Signer
}

var nombreValido = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)

// direccion separa la dirección de la consola en IP o nombre, con el mismo
// criterio que instalar.sh (minúsculas, dígitos, puntos y guiones).
func direccion(d string) (net.IP, string, error) {
	d = strings.TrimSpace(d)
	if ip := net.ParseIP(d); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			ip = v4
		}
		return ip, "", nil
	}
	d = strings.TrimSuffix(strings.ToLower(d), ".")
	if len(d) == 0 || len(d) > 253 || !nombreValido.MatchString(d) {
		return nil, "", fmt.Errorf("%q is not a name or an IP address", d)
	}
	return nil, d, nil
}

// restricciones pone en la plantilla los nombres que podrá firmar la CA: solo
// la dirección de la consola. Un nombre DNS permite también sus subdominios
// (RFC 5280, no hay forma de evitarlo); una IP, solo esa IP.
func restricciones(t *x509.Certificate, d string) error {
	ip, nombre, err := direccion(d)
	if err != nil {
		return err
	}
	t.PermittedDNSDomainsCritical = true
	if ip != nil {
		bits := 8 * len(ip)
		t.PermittedIPRanges = []*net.IPNet{{IP: ip, Mask: net.CIDRMask(bits, bits)}}
		t.PermittedDNSDomains = []string{dnsNinguno}
		return nil
	}
	t.PermittedDNSDomains = []string{nombre}
	// Ninguna IP, ni v4 ni v6: sin esto, las IP no tendrían límite.
	t.ExcludedIPRanges = []*net.IPNet{
		{IP: net.IPv4zero.To4(), Mask: net.CIDRMask(0, 32)},
		{IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)},
	}
	return nil
}

func serie() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

// Generar crea en dir una CA nueva para la dirección de la consola y devuelve
// la CA. Sustituye la que hubiera. La clave de la raíz no sale de esta función.
func Generar(dir, direccionConsola, nodo string, ahora time.Time) (*CA, error) {
	claveRaiz, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	claveInter, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	desde, hasta := ahora.Add(-time.Hour).UTC(), ahora.Add(Vigencia).UTC()
	fecha := ahora.UTC().Format("2006-01-02")
	sujeto := func(cn string) pkix.Name {
		n := pkix.Name{CommonName: cn, Organization: []string{"Sugardaddy"}}
		if nodo != "" {
			n.OrganizationalUnit = []string{nodo}
		}
		return n
	}
	sr, err := serie()
	if err != nil {
		return nil, err
	}
	raiz := &x509.Certificate{
		SerialNumber:          sr,
		Subject:               sujeto("Sugardaddy console root " + fecha),
		NotBefore:             desde,
		NotAfter:              hasta,
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLen:            1,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		// Solo servidores TLS: ni firma de código, ni correo, ni clientes. Los
		// nameConstraints no limitan un certificado sin nombres (el de firmar
		// código), esto sí (Windows, macOS, Chrome y Go lo aplican en la cadena).
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if err := restricciones(raiz, direccionConsola); err != nil {
		return nil, err
	}
	derRaiz, err := x509.CreateCertificate(rand.Reader, raiz, raiz, &claveRaiz.PublicKey, claveRaiz)
	if err != nil {
		return nil, fmt.Errorf("root: %w", err)
	}
	certRaiz, err := x509.ParseCertificate(derRaiz)
	if err != nil {
		return nil, err
	}
	si, err := serie()
	if err != nil {
		return nil, err
	}
	inter := &x509.Certificate{
		SerialNumber:          si,
		Subject:               sujeto("Sugardaddy console intermediate " + fecha),
		NotBefore:             desde,
		NotAfter:              hasta,
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	// Las mismas restricciones también en la intermedia, por si alguien la
	// instalara en lugar de la raíz.
	if err := restricciones(inter, direccionConsola); err != nil {
		return nil, err
	}
	derInter, err := x509.CreateCertificate(rand.Reader, inter, certRaiz, &claveInter.PublicKey, claveRaiz)
	if err != nil {
		return nil, fmt.Errorf("intermediate: %w", err)
	}
	claveDER, err := x509.MarshalECPrivateKey(claveInter)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	// Primero la clave y la intermedia, la raíz la última: si algo se corta a
	// medias, Leer ve que no casan y se vuelve a generar.
	escribir := []struct {
		nombre string
		tipo   string
		der    []byte
		modo   os.FileMode
	}{
		{FicheroClave, "EC PRIVATE KEY", claveDER, 0o600},
		{FicheroIntermedia, "CERTIFICATE", derInter, 0o644},
		{FicheroRaiz, "CERTIFICATE", derRaiz, 0o644},
	}
	for _, f := range escribir {
		if err := escribirAtomico(filepath.Join(dir, f.nombre), pem.EncodeToMemory(&pem.Block{Type: f.tipo, Bytes: f.der}), f.modo); err != nil {
			return nil, err
		}
	}
	return Leer(dir)
}

// Leer carga la CA de dir y comprueba que está entera: la intermedia firmada
// por la raíz, la clave de la intermedia que corresponde a su certificado, y
// la raíz con sus restricciones de nombre.
func Leer(dir string) (*CA, error) {
	raiz, err := leerCert(filepath.Join(dir, FicheroRaiz))
	if err != nil {
		return nil, err
	}
	inter, err := leerCert(filepath.Join(dir, FicheroIntermedia))
	if err != nil {
		return nil, err
	}
	if !raiz.IsCA || !inter.IsCA {
		return nil, errors.New("the node CA certificates are not CA certificates")
	}
	if !raiz.PermittedDNSDomainsCritical || (len(raiz.PermittedDNSDomains) == 0 && len(raiz.PermittedIPRanges) == 0) {
		return nil, errors.New("the node CA root has no name constraints")
	}
	if err := inter.CheckSignatureFrom(raiz); err != nil {
		return nil, fmt.Errorf("the intermediate is not signed by the root: %w", err)
	}
	b, err := leerPequeno(filepath.Join(dir, FicheroClave))
	if err != nil {
		return nil, err
	}
	bloque, _ := pem.Decode(b)
	if bloque == nil {
		return nil, errors.New("intermedia.key is not a PEM key")
	}
	var clave crypto.Signer
	if k, err := x509.ParseECPrivateKey(bloque.Bytes); err == nil {
		clave = k
	} else if k, err := x509.ParsePKCS8PrivateKey(bloque.Bytes); err == nil {
		s, ok := k.(crypto.Signer)
		if !ok {
			return nil, errors.New("intermedia.key cannot sign")
		}
		clave = s
	} else {
		return nil, errors.New("intermedia.key is not a valid key")
	}
	pub, ok := clave.Public().(interface{ Equal(crypto.PublicKey) bool })
	if !ok || !pub.Equal(inter.PublicKey) {
		return nil, errors.New("intermedia.key does not match intermedia.crt")
	}
	return &CA{Raiz: raiz, Intermedia: inter, clave: clave}, nil
}

// RaizPEM es la raíz, la que se instala en los equipos.
func (c *CA) RaizPEM() []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raiz.Raw})
}

// Huella de la raíz, como la enseñan openssl (-fingerprint -sha256), Windows y
// la consola: SHA-256 del certificado en hexadecimal, en mayúsculas y con dos puntos.
func (c *CA) Huella() string { return Huella(c.Raiz) }

func Huella(cert *x509.Certificate) string {
	h := sha256.Sum256(cert.Raw)
	partes := make([]string, len(h))
	for i, b := range h {
		partes[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(partes, ":")
}

// Cubre dice si un certificado de servidor para esa dirección, firmado por la
// intermedia, valida con la raíz: la prueba de verdad de las restricciones y
// de que la clave firma.
func (c *CA) Cubre(direccionConsola string) bool {
	ip, nombre, err := direccion(direccionConsola)
	if err != nil {
		return false
	}
	if c.Intermedia.NotAfter.Before(time.Now().Add(24 * time.Hour)) {
		return false
	}
	return c.firmarYVerificar(ip, nombre) == nil
}

// firmarYVerificar firma un certificado de servidor de un minuto para ese
// nombre o esa IP y lo verifica con la raíz como lo haría un navegador.
func (c *CA) firmarYVerificar(ip net.IP, nombre string) error {
	clave, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	s, err := serie()
	if err != nil {
		return err
	}
	ahora := time.Now()
	h := &x509.Certificate{
		SerialNumber: s,
		NotBefore:    ahora.Add(-time.Minute),
		NotAfter:     ahora.Add(time.Minute),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	destino := nombre
	if ip != nil {
		h.IPAddresses = []net.IP{ip}
		destino = ip.String()
	} else {
		h.DNSNames = []string{nombre}
	}
	der, err := x509.CreateCertificate(rand.Reader, h, c.Intermedia, &clave.PublicKey, c.clave)
	if err != nil {
		return err
	}
	hoja, err := x509.ParseCertificate(der)
	if err != nil {
		return err
	}
	return Verificar(c.Raiz, c.Intermedia, hoja, destino)
}

// Verificar comprueba una cadena hoja → intermedia → raíz para un nombre o una
// IP, con la raíz como única de confianza.
func Verificar(raiz, inter, hoja *x509.Certificate, destino string) error {
	raices := x509.NewCertPool()
	raices.AddCert(raiz)
	inters := x509.NewCertPool()
	if inter != nil {
		inters.AddCert(inter)
	}
	_, err := hoja.Verify(x509.VerifyOptions{
		DNSName:       destino,
		Roots:         raices,
		Intermediates: inters,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	return err
}

// leerPequeno lee un fichero normal (nunca un enlace) de tamaño razonable.
func leerPequeno(ruta string) ([]byte, error) {
	fi, err := os.Lstat(ruta)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > 64<<10 {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(ruta))
	}
	return os.ReadFile(ruta)
}

func leerCert(ruta string) (*x509.Certificate, error) {
	b, err := leerPequeno(ruta)
	if err != nil {
		return nil, err
	}
	bloque, resto := pem.Decode(b)
	if bloque == nil || bloque.Type != "CERTIFICATE" || len(bytes.TrimSpace(resto)) > 0 {
		return nil, fmt.Errorf("%s is not a single certificate", filepath.Base(ruta))
	}
	return x509.ParseCertificate(bloque.Bytes)
}

func escribirAtomico(ruta string, b []byte, modo os.FileMode) error {
	tmp := ruta + ".tmp"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, modo)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if e := f.Sync(); err == nil {
		err = e
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = os.Chmod(tmp, modo)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, ruta)
}
