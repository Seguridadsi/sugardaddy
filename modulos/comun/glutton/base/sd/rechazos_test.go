package sd

import (
	"path/filepath"
	"testing"
)

func TestRechazosResumen(t *testing.T) {
	dir := t.TempDir()
	r, err := NuevoRegistro(cfgPrueba(dir))
	if err != nil {
		t.Fatal(err)
	}
	x := NuevosRechazos(r, "smb", 100)
	x.Global("203.0.113.1")
	x.Global("203.0.113.1")
	x.PorIP("203.0.113.2")
	x.PorIP("203.0.113.2")
	x.PorIP("203.0.113.3")
	x.Volcar()
	r.Cierra()

	evs := leerLineas(t, filepath.Join(dir, "smb.json"))
	var rech *Evento
	for i := range evs {
		if evs[i].EventID == "smb.session.rechazos" {
			rech = &evs[i]
		}
	}
	if rech == nil {
		t.Fatal("no se emitió smb.session.rechazos")
	}
	if rech.PorTipo["por_tope_global"] != 2 || rech.PorTipo["por_tope_ip"] != 3 {
		t.Errorf("conteo por tope mal: %+v", rech.PorTipo)
	}
	if rech.IPsDistintas != 3 {
		t.Errorf("esperaba 3 IP distintas, dio %d", rech.IPsDistintas)
	}
}

func TestRechazosVacioNoEscribe(t *testing.T) {
	dir := t.TempDir()
	r, err := NuevoRegistro(cfgPrueba(dir))
	if err != nil {
		t.Fatal(err)
	}
	x := NuevosRechazos(r, "smb", 100)
	x.Volcar() // nada que contar
	r.Cierra()
	evs := leerLineas(t, filepath.Join(dir, "smb.json"))
	for _, e := range evs {
		if e.EventID == "smb.session.rechazos" {
			t.Fatal("no debería escribir resumen sin rechazos")
		}
	}
}
