package despliegue

import "testing"

func TestTextoDeParametro(t *testing.T) {
	for v, quiere := range map[any]string{
		nil:          "",
		float64(1e6): "1000000",
		float64(22):  "22",
		0.5:          "0.5",
		"hola":       "hola",
		true:         "true",
	} {
		if got := textoDeParametro(v); got != quiere {
			t.Errorf("textoDeParametro(%#v) = %q, quiere %q", v, got, quiere)
		}
	}
}
