// Package confianza arma el cliente HTTPS con el que el sensor y el
// actualizador hablan con la consola. Un sensor en otra máquina llega a la
// consola por su HTTPS, que suele llevar la CA propia del nodo: esa raíz se
// añade a las del sistema, nunca se desactiva la verificación.
package confianza

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
	"time"
)

func Cliente(ca string, espera time.Duration) (*http.Client, error) {
	if ca == "" {
		return &http.Client{Timeout: espera}, nil
	}
	pem, err := os.ReadFile(ca)
	if err != nil {
		return nil, err
	}
	// Vacío: la consola usa un certificado de una CA en la que el sistema ya
	// confía. El fichero existe igual porque se monta siempre.
	if len(bytes.TrimSpace(pem)) == 0 {
		return &http.Client{Timeout: espera}, nil
	}
	raices, err := x509.SystemCertPool()
	if err != nil || raices == nil {
		raices = x509.NewCertPool()
	}
	if !raices.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("%s no tiene ningún certificado", ca)
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.TLSClientConfig = &tls.Config{RootCAs: raices, MinVersion: tls.VersionTLS12}
	return &http.Client{Timeout: espera, Transport: t}, nil
}
