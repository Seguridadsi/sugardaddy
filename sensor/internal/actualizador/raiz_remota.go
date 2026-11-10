package actualizador

// Las raíces en las que confía un sensor remoto (docs/diseno/ca-nodo.md).
//
// Un sensor en otra máquina habla con la consola por su HTTPS y confía en la
// raíz que le dejó su línea de instalación, en ca-consola.crt. Cuando el nodo
// prepara su CA propia, la consola le da la raíz de ahora y la nueva: así sigue
// conectando antes y después del cambio. Tras el cambio, solo la nueva.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"
)

// RaizRemota mantiene al día ca-consola.crt en la máquina de un sensor remoto.
type RaizRemota struct {
	Consola string // la URL https de la consola
	Token   string
	HTTP    *http.Client
	Fichero string // ca-consola.crt, en la carpeta del sensor montada en el actualizador
	Log     func(string, ...any)
	// Probar comprueba que la consola contesta con un certificado de esas
	// raíces antes de escribirlas: una lista equivocada dejaría al sensor sin
	// consola. Por defecto, una petición de verdad; en las pruebas, un doble.
	Probar func(ctx context.Context, raices []byte) error
}

// raicesValidas: solo certificados de CA, pocos y pequeños.
func raicesValidas(b []byte) error {
	if len(b) > 64<<10 {
		return errors.New("too large")
	}
	n := 0
	for resto := bytes.TrimSpace(b); len(resto) > 0; resto = bytes.TrimSpace(resto) {
		var bloque *pem.Block
		bloque, resto = pem.Decode(resto)
		if bloque == nil || bloque.Type != "CERTIFICATE" {
			return errors.New("not a list of certificates")
		}
		c, err := x509.ParseCertificate(bloque.Bytes)
		if err != nil || !c.IsCA {
			return errors.New("not a CA certificate")
		}
		n++
	}
	if n == 0 || n > 4 {
		return fmt.Errorf("%d certificates", n)
	}
	return nil
}

// Vuelta pregunta por las raíces y, si son otras y la consola contesta con
// ellas, las escribe encima de ca-consola.crt (sin cambiar el fichero, que
// está montado en el sensor y en el actualizador).
func (r *RaizRemota) Vuelta(ctx context.Context) error {
	actual, err := os.ReadFile(r.Fichero)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	h := sha256.Sum256(actual)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, r.Consola+"/api/sensor/ca?tiene="+url.QueryEscape(hex.EncodeToString(h[:])), nil)
	req.Header.Set("Authorization", "Bearer "+r.Token)
	resp, err := r.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil // una consola anterior a esto
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	var p struct {
		Raices *string `json:"raices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil {
		return err
	}
	if p.Raices == nil || *p.Raices == "" || *p.Raices == string(actual) {
		return nil
	}
	nuevas := []byte(*p.Raices)
	if err := raicesValidas(nuevas); err != nil {
		return fmt.Errorf("the console sent CA roots that are not valid: %w", err)
	}
	probar := r.Probar
	if probar == nil {
		probar = r.probar
	}
	if err := probar(ctx, nuevas); err != nil {
		return fmt.Errorf("the console does not answer with the CA roots it sent, so they are not saved: %w", err)
	}
	if _, err := escribirEnSuSitio(r.Fichero, nuevas, 0o644); err != nil {
		return err
	}
	if r.Log != nil {
		r.Log("console CA roots updated")
	}
	return nil
}

// probar abre el HTTPS de la consola confiando solo en esas raíces.
func (r *RaizRemota) probar(ctx context.Context, raices []byte) error {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(raices) {
		return errors.New("no certificates")
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	defer t.CloseIdleConnections()
	c := &http.Client{Timeout: 15 * time.Second, Transport: t}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, r.Consola+"/api/salud", nil)
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
