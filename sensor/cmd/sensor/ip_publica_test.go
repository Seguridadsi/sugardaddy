package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestLeerIPPublica(t *testing.T) {
	for cuerpo, quiere := range map[string]string{
		"20.50.60.70\n":      "20.50.60.70",
		"::ffff:20.50.60.70": "20.50.60.70",
		"2a01:111::5":        "2a01:111::5",
		"10.0.0.4":           "",
		"192.168.1.1":        "",
		"100.64.3.2":         "",
		"127.0.0.1":          "",
		"169.254.1.1":        "",
		"<html>hola</html>":  "",
		"":                   "",
	} {
		if got := leerIPPublica(cuerpo); got != quiere {
			t.Errorf("%q: %q, se esperaba %q", cuerpo, got, quiere)
		}
	}
}

func esperarIP(t *testing.T, p *ipPublica, quiere string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		p.mu.Lock()
		libre := !p.enCurso
		p.mu.Unlock()
		if libre && p.actual() == quiere {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("la IP pública es %q, se esperaba %q", p.actual(), quiere)
}

func TestIPPublicaPregunta(t *testing.T) {
	veces := 0
	p := &ipPublica{pedir: func(_ context.Context, url string) (string, error) {
		veces++
		if url != "https://panel.example/api/nodo/ip" {
			t.Errorf("preguntó en %q", url)
		}
		return "20.50.60.70", nil
	}}
	ctx := context.Background()
	// Sin dirección, o sin https, no pregunta.
	p.preguntar(ctx, "")
	p.preguntar(ctx, "http://panel.example/api/nodo/ip")
	esperarIP(t, p, "")
	if veces != 0 {
		t.Fatalf("preguntó %d veces sin deber", veces)
	}
	p.preguntar(ctx, "https://panel.example/api/nodo/ip")
	esperarIP(t, p, "20.50.60.70")
	// Antes de la hora no vuelve a preguntar.
	p.preguntar(ctx, "https://panel.example/api/nodo/ip")
	esperarIP(t, p, "20.50.60.70")
	if veces != 1 {
		t.Fatalf("preguntó %d veces, se esperaba 1", veces)
	}
	// Lo sabido caduca.
	p.mu.Lock()
	p.sabida = time.Now().Add(-ipPublicaVida - time.Minute)
	p.mu.Unlock()
	if got := p.actual(); got != "" {
		t.Fatalf("una IP caducada sigue valiendo: %q", got)
	}
	// La consola deja de pedirlo: se olvida.
	p.mu.Lock()
	p.sabida = time.Now()
	p.mu.Unlock()
	p.preguntar(ctx, "")
	if got := p.actual(); got != "" {
		t.Fatalf("sin dirección sigue informando %q", got)
	}
}

func TestIPPublicaFallo(t *testing.T) {
	p := &ipPublica{pedir: func(context.Context, string) (string, error) {
		return "", errors.New("sin salida")
	}}
	p.preguntar(context.Background(), "https://panel.example/api/nodo/ip")
	esperarIP(t, p, "")
	p.mu.Lock()
	defer p.mu.Unlock()
	if d := time.Until(p.proximo); d < ipPublicaReintento-time.Minute || d > ipPublicaReintento {
		t.Fatalf("reintento en %v", d)
	}
}
