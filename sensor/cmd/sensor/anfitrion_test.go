package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func escribirAnfitrion(t *testing.T, contenido string) string {
	t.Helper()
	d := t.TempDir()
	if err := os.MkdirAll(filepath.Join(d, "anfitrion"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(d, "anfitrion", "hechos.json"), []byte(contenido), 0o644); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestHechosDelAnfitrion(t *testing.T) {
	casos := []struct {
		nombre, json string
		quiero       map[string]any
	}{
		{"cifrado y sellado", `{"disco.cifrado":{"valor":true},"disco.tpm":{"valor":true}}`,
			map[string]any{"disco.cifrado": map[string]any{"valor": true}, "disco.tpm": map[string]any{"valor": true}}},
		{"sin TPM, con motivo", `{"disco.cifrado":{"valor":true},"disco.tpm":{"valor":false,"motivo":"tpm.ausente"}}`,
			map[string]any{"disco.cifrado": map[string]any{"valor": true}, "disco.tpm": map[string]any{"valor": false, "motivo": "tpm.ausente"}}},
		{"claves de fuera y valores que no son booleanos, fuera",
			`{"motor.aislamiento":{"valor":true},"disco.cifrado":{"valor":"si"},"disco.tpm":{"valor":false,"motivo":"<b>hola</b>"}}`,
			map[string]any{"disco.tpm": map[string]any{"valor": false}}},
		{"sin valor, fuera", `{"disco.cifrado":{"motivo":"x"}}`, map[string]any{}},
		{"JSON roto", `{"disco.cifrado":`, nil},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			if got := hechosDelAnfitrion(escribirAnfitrion(t, c.json)); !reflect.DeepEqual(got, c.quiero) {
				t.Fatalf("hechosDelAnfitrion = %#v, quiero %#v", got, c.quiero)
			}
		})
	}
}

func TestHechosDelAnfitrionSinFicheroOGrande(t *testing.T) {
	if h := hechosDelAnfitrion(t.TempDir()); h != nil {
		t.Fatalf("sin fichero: %#v", h)
	}
	grande := `{"disco.cifrado":{"valor":true,"motivo":"` + strings.Repeat("a", topeAnfitrion) + `"}}`
	if h := hechosDelAnfitrion(escribirAnfitrion(t, grande)); h != nil {
		t.Fatalf("fichero de más de %d bytes: %#v", topeAnfitrion, h)
	}
}
