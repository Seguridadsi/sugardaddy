// catalogo calcula las huellas del catálogo firmado (SEN-3, docs/diseno/claves-y-catalogo.md)
// con el mismo código que usa el sensor para comprobarlas. Lee de la entrada estándar
// {"<módulo>": [<manifiesto>, …]}, los manifiestos tal como los proyecta la consola para el
// sensor (uno por cada imagen posible), y escribe {"<módulo>": ["<huella>", …]}.
//
//	go run ./cmd/catalogo < manifiestos.json > catalogo.json
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"

	"github.com/kinomakino/sugardaddy/sensor/internal/catalogo"
)

func main() {
	var entrada map[string][]json.RawMessage
	if err := json.NewDecoder(os.Stdin).Decode(&entrada); err != nil {
		fmt.Fprintln(os.Stderr, "catalogo: la entrada no es {módulo: [manifiesto, …]}:", err)
		os.Exit(1)
	}
	salida := make(map[string][]string, len(entrada))
	for modulo, ms := range entrada {
		var hs []string
		for _, m := range ms {
			h, err := catalogo.HuellaDeTexto(m)
			if err != nil {
				fmt.Fprintf(os.Stderr, "catalogo: %s: %v\n", modulo, err)
				os.Exit(1)
			}
			var id struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(m, &id)
			if id.ID != modulo {
				fmt.Fprintf(os.Stderr, "catalogo: el manifiesto de %s dice ser %q\n", modulo, id.ID)
				os.Exit(1)
			}
			if !slices.Contains(hs, h) {
				hs = append(hs, h)
			}
		}
		salida[modulo] = hs
	}
	if err := json.NewEncoder(os.Stdout).Encode(salida); err != nil {
		os.Exit(1)
	}
}
