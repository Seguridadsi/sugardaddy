package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// Hechos que la máquina dice de sí misma y que el sensor, en su contenedor, no
// puede medir: hoy, el disco de datos del appliance (docs/diseno/disco-cifrado.md).
// Los deja el script «disco» del appliance, como root, en
// <datos>/anfitrion/hechos.json, en cada arranque y tras el alta. Solo se aceptan
// estas claves, con un valor booleano y un motivo corto: el fichero no puede
// colar otros hechos ni textos en la consola. Sin fichero (un nodo instalado a
// mano, Docker Desktop), no se informa nada.
var clavesAnfitrion = map[string]bool{
	"disco.cifrado": true, // el disco de datos está cifrado (LUKS2)
	"disco.tpm":     true, // su clave está sellada al TPM 2.0
}

var motivoAnfitrion = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,63}$`)

const topeAnfitrion = 4096

func hechosDelAnfitrion(datos string) map[string]any {
	f, err := os.Open(filepath.Join(datos, "anfitrion", "hechos.json"))
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
