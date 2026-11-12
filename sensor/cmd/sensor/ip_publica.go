package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// La IP pública del sensor: por dónde sale a internet. Detrás de un NAT no está en
// ninguna interfaz de su máquina, así que se la pregunta a quien la consola le diga
// en el plan (el panel, que contesta con la dirección desde la que le llega la
// petición). No manda nada suyo: ni identificador, ni token, ni versión.
//
// Sin salida a internet no se sabe, y no pasa nada: el hecho no se informa. Se
// pregunta fuera del bucle, que no espera por ello.
const (
	ipPublicaCada      = time.Hour
	ipPublicaReintento = 10 * time.Minute
	// Pasado esto sin poder preguntar, lo sabido ya no se da por bueno.
	ipPublicaVida = 3 * ipPublicaCada
)

type ipPublica struct {
	mu      sync.Mutex
	valor   string
	sabida  time.Time
	proximo time.Time
	en      string
	enCurso bool
	// pedir hace la petición; las pruebas ponen la suya.
	pedir func(ctx context.Context, url string) (string, error)
}

// preguntar lanza la pregunta si toca. en vacío (una consola anterior, o una que
// no quiere que se pregunte): no se pregunta y se olvida lo sabido.
func (p *ipPublica) preguntar(ctx context.Context, en string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if en != p.en {
		p.en, p.proximo = en, time.Time{}
		if en == "" {
			p.valor = ""
		}
	}
	if en == "" || !strings.HasPrefix(en, "https://") || p.enCurso || time.Now().Before(p.proximo) {
		return
	}
	p.enCurso = true
	pedir := p.pedir
	if pedir == nil {
		pedir = pedirIPPublica
	}
	go func() {
		ip, err := pedir(ctx, en)
		p.mu.Lock()
		defer p.mu.Unlock()
		p.enCurso = false
		if err != nil || ip == "" {
			slog.Debug("could not learn the public address", "err", err)
			p.proximo = time.Now().Add(ipPublicaReintento)
			return
		}
		p.valor, p.sabida = ip, time.Now()
		p.proximo = p.sabida.Add(ipPublicaCada)
	}()
}

// actual es la última sabida, si aún vale.
func (p *ipPublica) actual() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.valor == "" || time.Since(p.sabida) > ipPublicaVida {
		return ""
	}
	return p.valor
}

var clienteIPPublica = &http.Client{
	Timeout: 10 * time.Second,
	// La respuesta es de quien se pregunta: sin seguir a nadie más.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func pedirIPPublica(ctx context.Context, url string) (string, error) {
	ctx, cancelar := context.WithTimeout(ctx, 10*time.Second)
	defer cancelar()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "sugardaddy-sensor")
	r, err := clienteIPPublica.Do(req)
	if err != nil {
		return "", err
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return "", nil
	}
	cuerpo, err := io.ReadAll(io.LimitReader(r.Body, 64))
	if err != nil {
		return "", err
	}
	return leerIPPublica(string(cuerpo)), nil
}

// leerIPPublica da la dirección de la respuesta si es una de internet; si no, "".
func leerIPPublica(cuerpo string) string {
	a, err := netip.ParseAddr(strings.TrimSpace(cuerpo))
	if err != nil {
		return ""
	}
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return ""
	}
	// El NAT del operador (100.64.0.0/10) tampoco es de internet.
	if netip.MustParsePrefix("100.64.0.0/10").Contains(a) {
		return ""
	}
	return a.String()
}
