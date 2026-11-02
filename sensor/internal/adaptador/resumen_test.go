package adaptador

import (
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
)

// evMuestra arma el evento mínimo que mira Resumen.Apuntar: la severidad, la
// acción y la línea nativa (el «tipo» de la muestra es acción|nativa) y la IP.
func evMuestra(sev, accion, nativa, ip string) evento.Evento {
	return evento.Evento{
		Severidad: sev,
		Accion:    accion,
		Nativa:    nativa,
		Origen:    evento.Origen{IP: ip},
		Cuando:    "2026-11-01T10:00:00Z",
	}
}

// Dos eventos del mismo tipo (acción|nativa) dejan UNA sola muestra: lo
// repetido no tapa otra descarga ni otra escritura. Pero los contadores los
// cuentan a los dos.
func TestResumenMuestraDedupPorTipo(t *testing.T) {
	var r Resumen
	r.Apuntar(evMuestra("alta", "comando", "cowrie.command.input", "10.0.0.1"), 5)
	r.Apuntar(evMuestra("alta", "comando", "cowrie.command.input", "10.0.0.2"), 5)
	if len(r.Muestra) != 1 {
		t.Errorf("lo repetido no debería dar más de una muestra: %d", len(r.Muestra))
	}
	if r.N != 2 || r.PorSeveridad["alta"] != 2 || r.PorAccion["comando"] != 2 {
		t.Errorf("los contadores sí cuentan los dos: %+v", r)
	}
	if r.PorIP["10.0.0.1"] != 1 || r.PorIP["10.0.0.2"] != 1 {
		t.Errorf("las dos IP deberían contarse: %+v", r.PorIP)
	}
}

// Las severidades no graves cuentan en los totales pero no entran en la muestra.
func TestResumenBajaMediaCuentanNoMuestran(t *testing.T) {
	var r Resumen
	r.Apuntar(evMuestra("baja", "conexion", "cowrie.session.connect", "10.0.0.1"), 5)
	r.Apuntar(evMuestra("media", "version", "cowrie.client.version", "10.0.0.1"), 5)
	if len(r.Muestra) != 0 {
		t.Errorf("baja/media no deberían dar muestra: %d", len(r.Muestra))
	}
	if r.N != 2 || r.PorSeveridad["baja"] != 1 || r.PorSeveridad["media"] != 1 {
		t.Errorf("baja/media deberían contar igual en los totales: %+v", r)
	}
	if r.PorAccion["conexion"] != 1 || r.PorIP["10.0.0.1"] != 2 {
		t.Errorf("acción/IP mal contadas: %+v", r)
	}
}

// Con la muestra llena, una crítica desplaza a una alta (de otro tipo): el
// resumen de un ataque no debe esconder lo crítico detrás de altas repetidas.
func TestResumenCriticaDesplazaAlta(t *testing.T) {
	var r Resumen
	r.Apuntar(evMuestra("alta", "comando", "cowrie.command.input", "10.0.0.1"), 1)
	r.Apuntar(evMuestra("critica", "descarga", "cowrie.session.file_download", "10.0.0.2"), 1)
	if len(r.Muestra) != 1 {
		t.Fatalf("la muestra debería seguir con un elemento (tope 1): %d", len(r.Muestra))
	}
	if r.Muestra[0]["severidad"] != "critica" || r.Muestra[0]["accion"] != "descarga" {
		t.Errorf("la crítica debería haber desplazado a la alta: %+v", r.Muestra[0])
	}
}

// Con la muestra llena de crítica, una alta NO desplaza nada.
func TestResumenAltaNoDesplazaCritica(t *testing.T) {
	var r Resumen
	r.Apuntar(evMuestra("critica", "descarga", "cowrie.session.file_download", "10.0.0.1"), 1)
	r.Apuntar(evMuestra("alta", "comando", "cowrie.command.input", "10.0.0.2"), 1)
	if len(r.Muestra) != 1 || r.Muestra[0]["severidad"] != "critica" {
		t.Errorf("una alta no debería desplazar a una crítica: %+v", r.Muestra)
	}
}

// El tope de la muestra se respeta aunque lleguen más tipos graves.
func TestResumenTopeMuestra(t *testing.T) {
	var r Resumen
	for _, nat := range []string{"a", "b", "c", "d"} {
		r.Apuntar(evMuestra("alta", "comando", "cowrie.command."+nat, "10.0.0.1"), 2)
	}
	if len(r.Muestra) != 2 {
		t.Errorf("la muestra no debería pasar del tope 2: %d", len(r.Muestra))
	}
	if r.N != 4 {
		t.Errorf("los cuatro eventos deberían contar en N: %d", r.N)
	}
}
