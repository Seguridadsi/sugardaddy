package evento

import (
	"bytes"
	"os"
	"testing"
)

// El mismo vector lo verifica el contrato en TypeScript: si Go y TS dejan de
// coincidir en cómo se encadena, falla uno de los dos lados.
func TestVectorCompartido(t *testing.T) {
	datos, err := os.ReadFile("../../../paquetes/contrato/vectores/cadena.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	lineas := bytes.Split(bytes.TrimRight(datos, "\n"), []byte("\n"))
	if i := Verificar(lineas); i != -1 {
		t.Fatalf("la cadena se rompe en la línea %d", i)
	}
}

func TestEmitirEncadena(t *testing.T) {
	c := NuevaCadena("")
	var lineas [][]byte
	for _, cmd := range []string{"uname -a", "echo <&>", "id"} {
		l, err := c.Emitir(Evento{Version: 1, Accion: "comando", Detalle: map[string]any{"input": cmd}})
		if err != nil {
			t.Fatal(err)
		}
		lineas = append(lineas, l)
	}
	if i := Verificar(lineas); i != -1 {
		t.Fatalf("la cadena se rompe en la línea %d", i)
	}
	if !bytes.Contains(lineas[1], []byte("<&>")) {
		t.Fatalf("se ha escapado el HTML: %s", lineas[1])
	}

	lineas = append(lineas[:1], lineas[2:]...)
	if i := Verificar(lineas); i != 1 {
		t.Fatalf("un evento borrado debería romper la cadena en 1, y la rompe en %d", i)
	}
}
