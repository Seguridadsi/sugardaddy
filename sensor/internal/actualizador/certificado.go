package actualizador

// El certificado de cliente de un sensor remoto (docs/diseno/mtls-sensores.md).
//
// El instalador deja en tls/cliente.pem el certificado que firmó la CA de
// sensores de la consola, con su clave. El actualizador lo renueva antes de
// que caduque: crea una clave nueva, manda la CSR a la consola (con el
// certificado de ahora, que ya presenta su cliente HTTP) y deja el nuevo con
// un rename, del usuario del sensor (65532) y del grupo 0, para que lo lean
// los dos y nadie más. Un sensor instalado antes, sin fichero, pide así su
// primero, si la consola lo deja.

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// FicheroCertificadoSensor: dentro de la carpeta del sensor.
	FicheroCertificadoSensor = "tls/cliente.pem"
	// RenovarCertificadoAntes: lo que le queda de vida cuando se pide el siguiente.
	RenovarCertificadoAntes = 30 * 24 * time.Hour
	// UsuarioSensor: el usuario con el que corre el contenedor del sensor.
	UsuarioSensor     = 65532
	esperaCertificado = time.Hour
)

// CertificadoSensor renueva tls/cliente.pem en la máquina de un sensor remoto.
type CertificadoSensor struct {
	Consola string // la URL https de la consola
	Token   string
	HTTP    *http.Client
	Fichero string
	Log     func(string, ...any)
	Ahora   func() time.Time
	// Dueno cambia el dueño del fichero nuevo; por defecto os.Chown (en las pruebas, un doble).
	Dueno func(ruta string, uid, gid int) error

	siguiente time.Time
}

func (c *CertificadoSensor) ahora() time.Time {
	if c.Ahora != nil {
		return c.Ahora()
	}
	return time.Now()
}

func (c *CertificadoSensor) log(m string, args ...any) {
	if c.Log != nil {
		c.Log(m, args...)
	}
}

// LeerCertificadoSensor devuelve el certificado del PEM si trae también su clave.
func LeerCertificadoSensor(ruta string) (*x509.Certificate, error) {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return nil, err
	}
	par, err := tls.X509KeyPair(b, b)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(par.Certificate[0])
}

// Vuelta mira si toca renovar y, si toca, renueva. Tras un intento fallido (o
// si la consola dice que aún no toca), espera una hora.
func (c *CertificadoSensor) Vuelta(ctx context.Context) error {
	ahora := c.ahora()
	if ahora.Before(c.siguiente) {
		return nil
	}
	if actual, err := LeerCertificadoSensor(c.Fichero); err == nil && actual.NotAfter.Sub(ahora) > RenovarCertificadoAntes {
		return nil
	}
	c.siguiente = ahora.Add(esperaCertificado)
	nuevo, err := c.pedir(ctx)
	if err != nil || nuevo == nil {
		return err
	}
	if err := c.escribir(nuevo); err != nil {
		return err
	}
	c.siguiente = time.Time{}
	c.log("client certificate renewed")
	return nil
}

// pedir manda la CSR; nil sin error si la consola no lo da ahora (409, o una consola de antes).
func (c *CertificadoSensor) pedir(ctx context.Context) ([]byte, error) {
	clave, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "sugardaddy-sensor"},
	}, clave)
	if err != nil {
		return nil, err
	}
	cuerpo, _ := json.Marshal(map[string]string{"csr": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.Consola, "/")+"/api/sensor/certificado", bytes.NewReader(cuerpo))
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound, http.StatusConflict:
		return nil, nil
	default:
		m, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return nil, fmt.Errorf("consola: %s %s", resp.Status, strings.TrimSpace(string(m)))
	}
	var r struct {
		Certificado string `json:"certificado"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, topeRespuestaConsola)).Decode(&r); err != nil {
		return nil, err
	}
	bloque, _ := pem.Decode([]byte(r.Certificado))
	if bloque == nil || bloque.Type != "CERTIFICATE" {
		return nil, errors.New("the console did not return a certificate")
	}
	cert, err := x509.ParseCertificate(bloque.Bytes)
	if err != nil {
		return nil, err
	}
	if pub, ok := cert.PublicKey.(*ecdsa.PublicKey); !ok || !pub.Equal(&clave.PublicKey) {
		return nil, errors.New("the certificate from the console is not for the key it was asked for")
	}
	cliente := false
	for _, u := range cert.ExtKeyUsage {
		cliente = cliente || u == x509.ExtKeyUsageClientAuth
	}
	if !cliente || c.ahora().After(cert.NotAfter) {
		return nil, errors.New("the certificate from the console is not a valid client certificate")
	}
	k, err := x509.MarshalPKCS8PrivateKey(clave)
	if err != nil {
		return nil, err
	}
	return append(pem.EncodeToMemory(bloque), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: k})...), nil
}

// escribir deja el PEM nuevo de una vez: el sensor nunca lee uno a medias.
func (c *CertificadoSensor) escribir(b []byte) error {
	dir := filepath.Dir(c.Fichero)
	if err := os.MkdirAll(dir, 0o711); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".cliente-*.pem")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	dueno := c.Dueno
	if dueno == nil {
		dueno = os.Chown
	}
	if err := dueno(tmp, UsuarioSensor, 0); err != nil {
		return fmt.Errorf("the sensor could not read the new certificate: %w", err)
	}
	if err := os.Chmod(tmp, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, c.Fichero)
}
