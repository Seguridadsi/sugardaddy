package actualizador

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// El vector lo genera TypeScript (paquetes/canal/src/vectores/raiz.json): una llave Ed25519 y
// otra ECDSA P-256, umbral 2.
func TestRaizVectorComun(t *testing.T) {
	b, err := os.ReadFile("../../../paquetes/canal/src/vectores/raiz.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Confianza string      `json:"confianza"`
		Ahora     string      `json:"ahora"`
		Claves    string      `json:"claves"`
		Firmada   RaizFirmada `json:"firmada"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	c, err := LeerRaizDeConfianza(v.Confianza, 0)
	if err != nil {
		t.Fatal(err)
	}
	ahora, _ := time.Parse(time.RFC3339, v.Ahora)
	r, nueva, err := VerificarRaiz(c, v.Firmada, ahora)
	if err != nil || r.Claves != v.Claves || nueva.Version != 1 {
		t.Fatalf("la raíz del vector no vale: %v", err)
	}
	if _, _, err := VerificarRaiz(c, v.Firmada, ahora.AddDate(5, 0, 0)); err == nil {
		t.Fatal("una raíz caducada no vale")
	}
	if _, _, err := VerificarRaiz(RaizDeConfianza{Claves: c.Claves, Umbral: 2, Version: 2}, v.Firmada, ahora); err == nil {
		t.Fatal("una raíz más vieja que la conocida no vale")
	}
	// Con una sola de las dos firmas, no.
	una := v.Firmada
	una.Firmas = una.Firmas[:1]
	if _, _, err := VerificarRaiz(c, una, ahora); err == nil {
		t.Fatal("con una sola llave no vale")
	}
	// La misma firma dos veces no cuenta como dos.
	dos := v.Firmada
	dos.Firmas = []Firma{v.Firmada.Firmas[0], v.Firmada.Firmas[0]}
	if _, _, err := VerificarRaiz(c, dos, ahora); err == nil {
		t.Fatal("la misma llave dos veces no vale")
	}
	tocada := v.Firmada
	tocada.Raiz = strings.Replace(tocada.Raiz, "cloud:", "licencias:", 1)
	if _, _, err := VerificarRaiz(c, tocada, ahora); err == nil {
		t.Fatal("una raíz tocada no vale")
	}
	if _, err := LeerRaizDeConfianza("3:"+strings.SplitN(v.Confianza, ":", 2)[1], 0); err == nil {
		t.Fatal("un umbral mayor que las llaves no se lee")
	}
}
