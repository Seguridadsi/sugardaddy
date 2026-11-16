package actualizador

import (
	"testing"
	"time"
)

func entorno(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestPoliticaDelEntorno(t *testing.T) {
	casos := []struct {
		env  map[string]string
		modo string
		h    int
	}{
		{map[string]string{}, PoliticaAutomatica, 0},
		{map[string]string{"ACTUALIZACION_POLITICA": "automatica"}, PoliticaAutomatica, 0},
		{map[string]string{"ACTUALIZACION_POLITICA": "manual", "ACTUALIZACION_RETARDO_HORAS": "72"}, PoliticaManual, 72},
		// Mal escrito: lo más estricto, nunca automático.
		{map[string]string{"ACTUALIZACION_POLITICA": "manul"}, PoliticaManual, 0},
		{map[string]string{"ACTUALIZACION_RETARDO_HORAS": "x"}, PoliticaAutomatica, RetardoMaximoHoras},
		{map[string]string{"ACTUALIZACION_RETARDO_HORAS": "99999"}, PoliticaAutomatica, RetardoMaximoHoras},
		{map[string]string{"ACTUALIZACION_RETARDO_HORAS": "-5"}, PoliticaAutomatica, 0},
	}
	for _, c := range casos {
		p := PoliticaDelEntorno(entorno(c.env))
		if p.Modo != c.modo || p.RetardoHoras != c.h {
			t.Errorf("%v: %+v, quería %s/%d", c.env, p, c.modo, c.h)
		}
	}
}

func TestMasEstricta(t *testing.T) {
	p := MasEstricta(Politica{Modo: PoliticaManual}, Politica{Modo: PoliticaAutomatica, RetardoHoras: 24})
	if p.Modo != PoliticaManual || p.RetardoHoras != 24 {
		t.Fatalf("%+v", p)
	}
	// La consola no puede bajar el suelo local.
	p = MasEstricta(Politica{Modo: PoliticaManual, RetardoHoras: 72}, Politica{Modo: PoliticaAutomatica, RetardoHoras: -1})
	if p.Modo != PoliticaManual || p.RetardoHoras != 72 {
		t.Fatalf("%+v", p)
	}
	if p := MasEstricta(Politica{RetardoHoras: 5000}, Politica{}); p.RetardoHoras != RetardoMaximoHoras {
		t.Fatalf("%+v", p)
	}
}

func TestComprobarPolitica(t *testing.T) {
	pub := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	r := Release{Version: "0.30.0", Publicada: pub.Format(time.RFC3339)}
	manual := Politica{Modo: PoliticaManual}
	banca := Politica{Modo: PoliticaManual, RetardoHoras: 72}
	aprobada := &Aprobacion{Version: "0.30.0", Quien: "ana@banco.es", Cuando: "2026-11-10T13:00:00Z"}

	if e := ComprobarPolitica(r, Politica{Modo: PoliticaAutomatica}, nil, true, pub); e.Motivo != "" {
		t.Fatalf("automática sin retardo debería instalar: %v", e)
	}
	if e := ComprobarPolitica(r, manual, nil, true, pub); e.Motivo != "aprobacion" {
		t.Fatalf("manual sin aprobación: %v", e)
	}
	// Una aprobación de otra versión no vale para esta.
	otra := &Aprobacion{Version: "0.29.9", Quien: "ana@banco.es"}
	if e := ComprobarPolitica(r, manual, otra, true, pub); e.Motivo != "aprobacion" {
		t.Fatalf("aprobación de otra versión: %v", e)
	}
	if e := ComprobarPolitica(r, manual, &Aprobacion{Version: "0.30.0"}, true, pub); e.Motivo != "aprobacion" {
		t.Fatalf("aprobación sin persona: %v", e)
	}
	if e := ComprobarPolitica(r, manual, aprobada, true, pub); e.Motivo != "" {
		t.Fatalf("manual aprobada: %v", e)
	}
	// Banca: aprobada pero dentro de las 72 h.
	e := ComprobarPolitica(r, banca, aprobada, true, pub.Add(71*time.Hour))
	if e.Motivo != "retardo" || !e.Hasta.Equal(pub.Add(72*time.Hour)) {
		t.Fatalf("retardo: %+v", e)
	}
	if e := ComprobarPolitica(r, banca, aprobada, true, pub.Add(72*time.Hour)); e.Motivo != "" {
		t.Fatalf("pasado el retardo: %v", e)
	}
	// Urgente: se salta el retardo, no la aprobación.
	u := r
	u.Urgente = true
	if e := ComprobarPolitica(u, banca, aprobada, true, pub); e.Motivo != "" {
		t.Fatalf("urgente aprobada: %v", e)
	}
	if e := ComprobarPolitica(u, banca, nil, true, pub); e.Motivo != "aprobacion" {
		t.Fatalf("urgente sin aprobar: %v", e)
	}
	// Sensor remoto: no se le pide aprobación, sí el retardo.
	if e := ComprobarPolitica(r, banca, nil, false, pub.Add(time.Hour)); e.Motivo != "retardo" {
		t.Fatalf("sensor remoto: %v", e)
	}
	// Sin fecha firmada legible no se cuenta el retardo: no se instala.
	if e := ComprobarPolitica(Release{Version: "0.30.0", Publicada: "ayer"}, banca, aprobada, true, pub); e.Motivo != "retardo" {
		t.Fatalf("sin fecha: %v", e)
	}
}
