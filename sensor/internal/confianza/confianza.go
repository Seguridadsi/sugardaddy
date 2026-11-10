// Package confianza arma el cliente HTTPS con el que el sensor y el
// actualizador hablan con la consola. Un sensor en otra máquina llega a la
// consola por su HTTPS, que suele llevar la CA propia del nodo: esa raíz se
// añade a las del sistema, nunca se desactiva la verificación.
//
// Cuando la consola pasa a otra raíz (docs/diseno/ca-nodo.md), el actualizador
// deja en el mismo fichero la vieja y la nueva: el cliente las vuelve a leer en
// cuanto cambia el fichero, sin reiniciar nada.
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
	if ca == "" {
		return &http.Client{Timeout: espera}, nil
	}
	t, err := transporte(ca)
	if err != nil {
		return nil, err
	}
	// Vacío: la consola usa un certificado de una CA en la que el sistema ya
	// confía. El fichero existe igual porque se monta siempre.
	if t == nil {
		return &http.Client{Timeout: espera}, nil
	}
	r := &Recargable{ruta: ca, actual: t}
	r.firma, _ = firmaDe(ca)
	return &http.Client{Timeout: espera, Transport: r}, nil
}

// transporte lee las raíces del fichero; nil si está vacío.
func transporte(ca string) (*http.Transport, error) {
	pem, err := os.ReadFile(ca)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(pem)) == 0 {
		return nil, nil
	}
	raices, err := x509.SystemCertPool()
	if err != nil || raices == nil {
		raices = x509.NewCertPool()
	}
	if !raices.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("%s has no certificate", ca)
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.TLSClientConfig = &tls.Config{RootCAs: raices, MinVersion: tls.VersionTLS12}
	return t, nil
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
}

func (r *Recargable) RoundTrip(req *http.Request) (*http.Response, error) {
	return r.Transporte().RoundTrip(req)
}

// Transporte devuelve el transporte de ahora.
func (r *Recargable) Transporte() *http.Transport {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, err := firmaDe(r.ruta)
	if err != nil || f == r.firma {
		return r.actual
	}
	r.firma = f
	if t, err := transporte(r.ruta); err == nil && t != nil {
		r.actual.CloseIdleConnections()
		r.actual = t
	}
	return r.actual
}

// CloseIdleConnections, para que http.Client.CloseIdleConnections llegue al transporte.
func (r *Recargable) CloseIdleConnections() { r.Transporte().CloseIdleConnections() }
