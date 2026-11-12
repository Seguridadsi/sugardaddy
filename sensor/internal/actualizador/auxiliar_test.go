package actualizador

import (
	"reflect"
	"testing"
)

// La resolución fija de la consola que el instalador deja en .env llega al
// auxiliar, que no está en el proyecto de compose; lo que no sea «nombre:IP»
// no llega a Docker.
func TestHostsFijos(t *testing.T) {
	casos := []struct {
		valor string
		want  []string
	}{
		{"gestion.cliente.local:203.0.113.7", []string{"gestion.cliente.local:203.0.113.7"}},
		{"gestion.cliente.local:2001:db8::7", []string{"gestion.cliente.local:2001:db8::7"}},
		{"", nil},
		{"consola-sin-fijar.invalid", nil},
		{"gestion.cliente.local:no-es-ip", nil},
		{":203.0.113.7", nil},
		{"dos nombres:203.0.113.7", nil},
	}
	for _, c := range casos {
		got := HostsFijos(map[string]string{VariableConsolaFija: c.valor})
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("HostsFijos(%q) = %v, se esperaba %v", c.valor, got, c.want)
		}
	}
	if got := HostsFijos(map[string]string{}); got != nil {
		t.Errorf("sin la variable: %v", got)
	}
}
