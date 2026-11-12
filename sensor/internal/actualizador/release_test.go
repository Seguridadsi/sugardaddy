package actualizador

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

func firmar(t *testing.T, priv ed25519.PrivateKey, texto string) ReleaseFirmada {
	t.Helper()
	return ReleaseFirmada{Release: texto, Firma: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(texto)))}
}

func TestVerificar(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, otra, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	clave, err := ClavePublica(base64.StdEncoding.EncodeToString(der))
	if err != nil {
		t.Fatal(err)
	}
	buena := `{"version":"0.3.0","publicada":"2026-10-13T00:00:00Z","notas":"x","servicios":{"consola":"ghcr.io/seguridadsi/consola@sha256:` + strings.Repeat("a", 64) + `"}}`

	if _, err := Verificar(Confianza{Legado: clave}, firmar(t, priv, buena)); err != nil {
		t.Fatalf("una versión bien firmada debería pasar: %v", err)
	}
	if _, err := Verificar(Confianza{Legado: clave}, firmar(t, otra, buena)); err == nil {
		t.Fatal("firmada con otra clave no debería pasar")
	}
	tocada := firmar(t, priv, buena)
	tocada.Release = strings.Replace(tocada.Release, "aaaa", "bbbb", 1)
	if _, err := Verificar(Confianza{Legado: clave}, tocada); err == nil {
		t.Fatal("una versión cambiada tras firmar no debería pasar")
	}
	// Lo que este actualizador no conoce se ignora: una versión que trae el instalador
	// (docs/diseno/instalador-verificado.md) la aceptan también los actualizadores de antes.
	conInstalador := strings.TrimSuffix(buena, "}") + `,"instalador":{"huellas":"v1;instalar.sh=` + strings.Repeat("0", 64) + `","ficheros":{"instalar.sh":"#!/bin/sh\n"},"etapa1":{"texto":"#!/usr/bin/env bash\n","firmas":[]}}}`
	if _, err := Verificar(Confianza{Legado: clave}, firmar(t, priv, conInstalador)); err != nil {
		t.Fatalf("una versión con instalador debería pasar: %v", err)
	}
	sinDigest := strings.Replace(buena, "@sha256:"+strings.Repeat("a", 64), ":latest", 1)
	if _, err := Verificar(Confianza{Legado: clave}, firmar(t, priv, sinDigest)); err == nil {
		t.Fatal("una imagen por etiqueta no debería pasar aunque esté firmada")
	}
}

func TestEscribirVersiones(t *testing.T) {
	ruta := t.TempDir() + "/versiones.env"
	err := EscribirVersiones(ruta, Release{Version: "0.4.1", Servicios: map[string]string{"sensor": "s@sha256:1", "consola": "c@sha256:2"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(ruta)
	if !strings.Contains(string(b), "SUGARDADDY_VERSION=0.4.1\nCONSOLA_IMAGEN=c@sha256:2\nSENSOR_IMAGEN=s@sha256:1\n") {
		t.Fatalf("contenido inesperado:\n%s", b)
	}
	if ConfiguracionAplicada(ruta) != "" {
		t.Fatal("sin configuración no se apunta ninguna")
	}
	_ = EscribirVersiones(ruta, Release{Version: "0.12.0", Servicios: map[string]string{"sensor": "s@sha256:1"}, Actualizador: "a@sha256:3"}, true)
	b, _ = os.ReadFile(ruta)
	if !strings.Contains(string(b), "ACTUALIZADOR_IMAGEN=a@sha256:3\n") || ConfiguracionAplicada(ruta) != "0.12.0" {
		t.Fatalf("falta el actualizador o la configuración:\n%s", b)
	}
}
