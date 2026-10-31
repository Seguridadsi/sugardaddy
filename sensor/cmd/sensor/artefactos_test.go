package main

import (
	"fmt"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

const shaBueno = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func descarga(id, sha, outfile string) evento.Evento {
	return evento.Evento{
		ID: id, Sensor: "s1", Accion: "descarga",
		Trampa:  evento.Trampa{ID: "t1"},
		Detalle: map[string]any{"shasum": sha, "outfile": outfile, "filename": "virus.sh"},
	}
}

func conArtefactos() *sensor {
	return &sensor{plan: &plan.Plan{Sensor: "s1", Admite: []string{"origen.oculta", "artefactos"}}}
}

func TestEncolarArtefactoSoloConOptIn(t *testing.T) {
	// Sin que el plan anuncie "artefactos" no se apunta nada (community, o
	// captura apagada): el sensor no saca binarios del contenedor.
	s := &sensor{plan: &plan.Plan{Sensor: "s1", Admite: []string{"origen.oculta"}}}
	s.encolarArtefacto(descarga("ev-1", shaBueno, "/tmp/"+shaBueno))
	if len(s.artefactos) != 0 {
		t.Fatalf("sin opt-in no debía encolar nada: %d", len(s.artefactos))
	}
}

func TestEncolarArtefactoFiltraYDeduplica(t *testing.T) {
	s := conArtefactos()
	// Una acción que no es descarga/escritura no trae fichero.
	ev := descarga("ev-0", shaBueno, "/tmp/x")
	ev.Accion = "comando"
	s.encolarArtefacto(ev)
	// sha256 inválido o outfile vacío: no se puede sacar, no se apunta.
	s.encolarArtefacto(descarga("ev-1", "no-es-sha", "/tmp/x"))
	s.encolarArtefacto(descarga("ev-2", shaBueno, ""))
	if len(s.artefactos) != 0 {
		t.Fatalf("no debía encolar lo que no se puede subir: %+v", s.artefactos)
	}
	// Uno bueno, y el mismo repetido no se duplica.
	bueno := descarga("ev-3", shaBueno, "/tmp/"+shaBueno)
	s.encolarArtefacto(bueno)
	s.encolarArtefacto(bueno)
	if len(s.artefactos) != 1 {
		t.Fatalf("debía haber una sola copia pendiente: %d", len(s.artefactos))
	}
	p := s.artefactos[0]
	if p.evento != "ev-3" || p.sensor != "s1" || p.trampa != "t1" || p.tipo != "descarga" ||
		p.sha256 != shaBueno || p.nombre != "virus.sh" || p.outfile != "/tmp/"+shaBueno {
		t.Fatalf("metadatos mal copiados: %+v", p)
	}
}

func TestEncolarArtefactoNormalizaSha(t *testing.T) {
	s := conArtefactos()
	s.encolarArtefacto(descarga("ev-1", "  "+strings_ToUpper(shaBueno)+"  ", "/tmp/x"))
	if len(s.artefactos) != 1 || s.artefactos[0].sha256 != shaBueno {
		t.Fatalf("el sha256 debía quedar en minúsculas y sin espacios: %+v", s.artefactos)
	}
}

func TestEncolarArtefactoRespetaElTope(t *testing.T) {
	s := conArtefactos()
	for i := range maxArtefactosPendientes + 5 {
		s.encolarArtefacto(descarga(fmt.Sprintf("ev-%d", i), shaBueno, fmt.Sprintf("/tmp/%d", i)))
	}
	if len(s.artefactos) != maxArtefactosPendientes {
		t.Fatalf("no respetó el tope: %d", len(s.artefactos))
	}
}

func TestReintentarArtefactoEsperaYSeAgota(t *testing.T) {
	s := conArtefactos()
	s.encolarArtefacto(descarga("ev-1", shaBueno, "/tmp/x"))
	// Cada reintento programa el siguiente y crece la espera, hasta agotarse.
	for i := 1; i < artefactoMaxIntentos; i++ {
		if !s.reintentarArtefacto("ev-1", shaBueno) {
			t.Fatalf("aún no debía agotarse en el intento %d", i)
		}
	}
	// El último agota y quita la copia.
	if s.reintentarArtefacto("ev-1", shaBueno) {
		t.Fatal("tenía que agotarse")
	}
	if len(s.artefactos) != 0 {
		t.Fatalf("al agotarse debía quitarse: %+v", s.artefactos)
	}
}

func TestQuitarArtefacto(t *testing.T) {
	s := conArtefactos()
	s.encolarArtefacto(descarga("ev-1", shaBueno, "/tmp/a"))
	s.encolarArtefacto(descarga("ev-2", shaBueno, "/tmp/b"))
	s.quitarArtefacto("ev-1", shaBueno)
	if len(s.artefactos) != 1 || s.artefactos[0].evento != "ev-2" {
		t.Fatalf("quitó mal: %+v", s.artefactos)
	}
}

// strings_ToUpper evita importar strings solo para el test de normalización.
func strings_ToUpper(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] -= 32
		}
	}
	return string(b)
}
