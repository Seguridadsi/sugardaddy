// Package confianza arma el cliente HTTPS con el que el sensor y el
// actualizador hablan con la consola. Un sensor en otra máquina llega a la
// consola por su HTTPS, que suele llevar la CA propia del nodo: esa raíz se
// añade a las del sistema, nunca se desactiva la verificación.
//
// Cuando la consola pasa a otra raíz (docs/diseno/ca-nodo.md), el actualizador
// deja en el mismo fichero la vieja y la nueva: el cliente las vuelve a leer en
// cuanto cambia el fichero, sin reiniciar nada.
//
// Un sensor remoto, además, presenta su certificado de cliente
// (docs/diseno/mtls-sensores.md): el PEM con certificado y clave que deja su
// instalador y renueva su actualizador. Se lee en cada saludo TLS que lo pide
// y, si cambia, se cierran las conexiones abiertas con el anterior.
package confianza

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

func Cliente(ca string, espera time.Duration) (*http.Client, error) {
	return ClienteConCertificado(ca, "", espera)
}

// ClienteConCertificado es Cliente con el certificado de cliente del fichero
// cert (certificado y clave en un PEM). Vacío, o mientras el fichero no
// existe, no se presenta ninguno: la consola decide si eso vale.
func ClienteConCertificado(ca, cert string, espera time.Duration) (*http.Client, error) {
	if ca == "" && cert == "" {
		return &http.Client{Timeout: espera}, nil
	}
	var propio *Propio
	if cert != "" {
		propio = &Propio{ruta: cert}
	}
	t, err := transporte(ca, propio)
	if err != nil {
		return nil, err
	}
	// Vacío: la consola usa un certificado de una CA en la que el sistema ya
	// confía. El fichero existe igual porque se monta siempre.
	if t == nil {
		return &http.Client{Timeout: espera}, nil
	}
	r := &Recargable{ruta: ca, actual: t, propio: propio}
	if ca != "" {
		r.firma, _ = firmaDe(ca)
	}
	return &http.Client{Timeout: espera, Transport: r}, nil
}

// transporte lee las raíces del fichero (ninguno: las del sistema); nil si
// está vacío y no hay certificado propio.
func transporte(ca string, propio *Propio) (*http.Transport, error) {
	var raices *x509.CertPool
	if ca != "" {
		pem, err := os.ReadFile(ca)
		if err != nil {
			return nil, err
		}
		if len(bytes.TrimSpace(pem)) > 0 {
			raices, err = x509.SystemCertPool()
			if err != nil || raices == nil {
				raices = x509.NewCertPool()
			}
			if !raices.AppendCertsFromPEM(pem) {
				return nil, fmt.Errorf("%s has no certificate", ca)
			}
		}
	}
	if raices == nil && propio == nil {
		return nil, nil
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.TLSClientConfig = &tls.Config{RootCAs: raices, MinVersion: tls.VersionTLS12}
	if propio != nil {
		t.TLSClientConfig.GetClientCertificate = propio.Certificado
	}
	return t, nil
}

// Propio es el certificado de cliente del fichero, leído de nuevo cuando cambia.
type Propio struct {
	ruta  string
	mu    sync.Mutex
	firma firma
	cert  *tls.Certificate
	vista *firma // la que vio Cambiado la última vez
}

// Certificado es el GetClientCertificate del cliente TLS: el del fichero, o
// ninguno si no existe o no se puede leer (Go manda entonces un certificado vacío).
func (p *Propio) Certificado(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.leer()
	if p.cert == nil {
		return &tls.Certificate{}, nil
	}
	return p.cert, nil
}

// leer rehace el certificado si el fichero cambió; dice si cambió.
func (p *Propio) leer() bool {
	f, err := firmaDe(p.ruta)
	if err != nil {
		cambia := p.cert != nil
		p.cert, p.firma = nil, firma{}
		return cambia
	}
	if f == p.firma && p.cert != nil {
		return false
	}
	p.firma = f
	b, err := os.ReadFile(p.ruta)
	if err != nil {
		return false
	}
	c, err := tls.X509KeyPair(b, b)
	if err != nil {
		// A medio escribir o roto: se sigue con el que había.
		return false
	}
	p.cert = &c
	return true
}

// Cambiado dice si el fichero trae otro certificado desde la última vez.
func (p *Propio) Cambiado() bool {
	if p == nil {
		return false
	}
	f, _ := firmaDe(p.ruta)
	p.mu.Lock()
	defer p.mu.Unlock()
	cambia := p.vista != nil && *p.vista != f
	p.vista = &f
	return cambia
}

type firma struct {
	tamano int64
	fecha  time.Time
}

func firmaDe(ruta string) (firma, error) {
	fi, err := os.Stat(ruta)
	if err != nil {
		return firma{}, err
	}
	return firma{fi.Size(), fi.ModTime()}, nil
}

// Recargable es el transporte con las raíces del fichero de ahora: si el
// fichero cambia y trae certificados, se rehace; si no se puede leer o ya no
// trae ninguno, sigue con las que tenía.
type Recargable struct {
	ruta   string
	mu     sync.Mutex
	firma  firma
	actual *http.Transport
	propio *Propio
}

func (r *Recargable) RoundTrip(req *http.Request) (*http.Response, error) {
	return r.Transporte().RoundTrip(req)
}

// Transporte devuelve el transporte de ahora.
func (r *Recargable) Transporte() *http.Transport {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Con otro certificado propio, las conexiones abiertas llevan el de antes: fuera.
	if r.propio.Cambiado() {
		r.actual.CloseIdleConnections()
	}
	if r.ruta == "" {
		return r.actual
	}
	f, err := firmaDe(r.ruta)
	if err != nil || f == r.firma {
		return r.actual
	}
	r.firma = f
	if t, err := transporte(r.ruta, r.propio); err == nil && t != nil {
		r.actual.CloseIdleConnections()
		r.actual = t
	}
	return r.actual
}

// CloseIdleConnections, para que http.Client.CloseIdleConnections llegue al transporte.
func (r *Recargable) CloseIdleConnections() { r.Transporte().CloseIdleConnections() }
