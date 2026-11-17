package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Hechos que la máquina dice de sí misma y que el sensor, en su contenedor, no
// puede medir: el disco de datos del appliance (docs/diseno/disco-cifrado.md) y
// la comprobación de integridad de sus ficheros con AIDE
// (docs/seguridad/appliance-cis.md). Los dejan los scripts del appliance, como
// root, en <datos>/anfitrion/*.json: «disco» en hechos.json, «integridad» en
// aide.json; cada uno el suyo, para no pisarse. Solo se aceptan estas claves,
// con un valor booleano y un motivo corto: los ficheros no pueden colar otros
// hechos ni textos en la consola. Sin ficheros (un nodo instalado a mano, Docker
// Desktop), no se informa nada.
var clavesAnfitrion = map[string]bool{
	"disco.cifrado":   true, // el disco de datos está cifrado (LUKS2)
	"disco.tpm":       true, // su clave está sellada al TPM 2.0
	"integridad.aide": true, // la última comprobación de AIDE no encontró cambios
}

var motivoAnfitrion = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,63}$`)

const (
	topeAnfitrion     = 4096
	ficherosAnfitrion = 8
)

func hechosDelAnfitrion(datos string) map[string]any {
	dir := filepath.Join(datos, "anfitrion")
	entradas, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var nombres []string
	for _, e := range entradas {
		if e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".json") {
			nombres = append(nombres, e.Name())
		}
	}
	sort.Strings(nombres)
	if len(nombres) > ficherosAnfitrion {
		nombres = nombres[:ficherosAnfitrion]
	}
	var h map[string]any
	for _, n := range nombres {
		uno := hechosDeFichero(filepath.Join(dir, n))
		if uno == nil {
			continue
		}
		if h == nil {
			h = map[string]any{}
		}
		for k, v := range uno {
			if _, ya := h[k]; !ya {
				h[k] = v
			}
		}
	}
	return h
}

func hechosDeFichero(ruta string) map[string]any {
	f, err := os.Open(ruta)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, topeAnfitrion+1))
	if err != nil || len(b) > topeAnfitrion {
		return nil
	}
	var crudo map[string]json.RawMessage
	if json.Unmarshal(b, &crudo) != nil {
		return nil
	}
	h := map[string]any{}
	for k, raw := range crudo {
		var v struct {
			Valor  *bool  `json:"valor"`
			Motivo string `json:"motivo"`
		}
		if !clavesAnfitrion[k] || json.Unmarshal(raw, &v) != nil || v.Valor == nil {
			continue
		}
		hecho := map[string]any{"valor": *v.Valor}
		if !*v.Valor && motivoAnfitrion.MatchString(v.Motivo) {
			hecho["motivo"] = v.Motivo
		}
		h[k] = hecho
	}
	return h
}
