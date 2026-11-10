package main

import (
	"context"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
)

// TestElHechoDeLosDiscos: la consola sabe si cada trampa tiene su disco y, si no,
// por qué (disco.trampas), en cuanto el sensor lo ha averiguado; antes, nada.
func TestElHechoDeLosDiscos(t *testing.T) {
	s := &sensor{estado: &estado.Estado{}}
	if _, ya := s.hechos()["disco.trampas"]; ya {
		t.Fatal("sin gestor de discos, nada")
	}
	s.opc.Discos = &discos.Gestor{Datos: t.TempDir(), Imagen: "r/actualizador@sha256:1", Propagacion: func() bool { return false }}
	if _, ya := s.hechos()["disco.trampas"]; ya {
		t.Fatal("sin saberlo aún, nada")
	}
	s.opc.Discos.Maquina(context.Background(), "s1", true)
	h, _ := s.hechos()["disco.trampas"].(*motor.Hecho)
	if h == nil || h.Valor || h.Motivo != discos.CodigoSinPropagacion {
		t.Fatalf("%+v", h)
	}
}
