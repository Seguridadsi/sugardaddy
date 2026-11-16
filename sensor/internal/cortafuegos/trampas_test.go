package cortafuegos

import (
	"context"
	"strings"
	"testing"
)

func TestTrampasPrimeraVezYRepaso(t *testing.T) {
	s := nuevoSimulado()
	s.conDocker("iptables-nft")
	s.conDocker("ip6tables-nft")
	s.tabla("iptables-nft")["INPUT"] = []string{"-j ufw-before-input"}
	r := AplicarTrampas(context.Background(), s.ejecutar)
	if r.Estado != Aplicada {
		t.Fatalf("%+v", r)
	}
	for _, tab := range []string{"iptables-nft", "ip6tables-nft"} {
		in := s.tabla(tab)["INPUT"]
		if len(in) == 0 || in[0] != "-i sd-trampas+ -j SD-TRAMPAS" {
			t.Fatalf("%s INPUT: %v", tab, in)
		}
		c := s.tabla(tab)[CadenaTrampas]
		if len(c) != 2 || !strings.Contains(c[0], "ESTABLISHED,RELATED -j RETURN") || c[1] != "-j DROP" {
			t.Fatalf("%s %v", tab, c)
		}
	}
	if s.tabla("iptables-nft")["INPUT"][1] != "-j ufw-before-input" {
		t.Fatal("the rest of INPUT is untouched")
	}
	// Repaso: nada cambia, ni un restore.
	s.ordenes = nil
	if r := AplicarTrampas(context.Background(), s.ejecutar); r.Estado != Aplicada {
		t.Fatalf("%+v", r)
	}
	for _, o := range s.ordenes {
		if strings.Contains(o, "restore") || strings.Contains(o, " -I ") || strings.Contains(o, " -D ") {
			t.Fatalf("already in place, but: %v", s.ordenes)
		}
	}
	if n := len(s.tabla("iptables-nft")["INPUT"]); n != 2 {
		t.Fatalf("one jump only: %v", s.tabla("iptables-nft")["INPUT"])
	}
}

func TestTrampasSinDockerEnIptablesNiIPv6(t *testing.T) {
	s := nuevoSimulado()
	s.tabla("iptables-legacy")["INPUT"] = []string{}
	r := AplicarTrampas(context.Background(), s.ejecutar)
	if r.Estado != Aplicada || s.tabla("iptables-legacy")["INPUT"][0] != "-i sd-trampas+ -j SD-TRAMPAS" {
		t.Fatalf("%+v %v", r, s.tablas)
	}
	if r := AplicarTrampas(context.Background(), nuevoSimulado().ejecutar); r.Estado != ConError {
		t.Fatalf("no iptables at all is an error: %+v", r)
	}
}
