package actualizador

import (
	"testing"
	"time"
)

func TestLeerVentanas(t *testing.T) {
	v, err := LeerVentanas("1-5 02:00-05:00 Europe/Madrid; 6,7 00:00-00:00")
	if err != nil || len(v) != 2 {
		t.Fatalf("%v %+v", err, v)
	}
	if len(v[0].Dias) != 5 || v[0].Zona != "Europe/Madrid" || v[1].Zona != "" || len(v[1].Dias) != 2 {
		t.Fatalf("%+v", v)
	}
	if got := TextoVentanas(v); got != "1,2,3,4,5 02:00-05:00 Europe/Madrid; 6,7 00:00-00:00" {
		t.Fatalf("%q", got)
	}
	if v, err := LeerVentanas("  "); err != nil || v != nil {
		t.Fatalf("vacía: %v %v", v, err)
	}
	for _, malo := range []string{"1-5", "0 02:00-03:00", "1-8 02:00-03:00", "5-1 02:00-03:00", "1 2:00-03:00",
		"1 24:00-03:00", "1 02:00-03:00 Marte/Olimpo", "1 02:00-03:00 ../../etc/passwd", "1 02:00 03:00 x y"} {
		if _, err := LeerVentanas(malo); err == nil {
			t.Errorf("%q debería rechazarse", malo)
		}
	}
}

func TestVentanaAbierta(t *testing.T) {
	madrid, _ := time.LoadLocation("Europe/Madrid")
	// Miércoles 18 de noviembre de 2026.
	en := func(d, h, m int) time.Time { return time.Date(2026, 11, d, h, m, 0, 0, madrid) }
	laborables := Ventana{Dias: []int{1, 2, 3, 4, 5}, Desde: "02:00", Hasta: "05:00", Zona: "Europe/Madrid"}
	casos := []struct {
		v    Ventana
		t    time.Time
		bien bool
	}{
		{laborables, en(18, 2, 0), true},
		{laborables, en(18, 4, 59), true},
		{laborables, en(18, 5, 0), false},
		{laborables, en(18, 1, 59), false},
		{laborables, en(21, 3, 0), false}, // sábado
		// La zona cuenta: las 3 en Madrid son las 2 en UTC (noviembre, UTC+1).
		{Ventana{Dias: []int{3}, Desde: "02:00", Hasta: "03:00"}, en(18, 3, 30), true},
		// Cruza la medianoche: la noche del viernes al sábado.
		{Ventana{Dias: []int{5}, Desde: "22:00", Hasta: "02:00", Zona: "Europe/Madrid"}, en(20, 23, 0), true},
		{Ventana{Dias: []int{5}, Desde: "22:00", Hasta: "02:00", Zona: "Europe/Madrid"}, en(21, 1, 30), true},
		{Ventana{Dias: []int{5}, Desde: "22:00", Hasta: "02:00", Zona: "Europe/Madrid"}, en(20, 1, 30), false},
		// Desde igual a hasta: 24 horas.
		{Ventana{Dias: []int{7}, Desde: "00:00", Hasta: "00:00", Zona: "Europe/Madrid"}, en(22, 23, 59), true},
		{Ventana{Dias: []int{7}, Desde: "00:00", Hasta: "00:00", Zona: "Europe/Madrid"}, en(23, 0, 0), false},
		// Inválida: nunca.
		{Ventana{}, en(18, 3, 0), false},
	}
	for i, c := range casos {
		if got := c.v.Abierta(c.t); got != c.bien {
			t.Errorf("caso %d (%+v a las %s): %v", i, c.v, c.t, got)
		}
	}
}

func TestSiguienteApertura(t *testing.T) {
	ahora := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC) // miércoles
	g := [][]Ventana{{{Dias: []int{1, 2, 3, 4, 5}, Desde: "02:00", Hasta: "05:00"}}}
	if got := siguienteApertura(g, ahora); !got.Equal(time.Date(2026, 11, 19, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("%s", got)
	}
	// Dos ventanas que no se cruzan nunca: cero.
	g = append(g, []Ventana{{Dias: []int{6}, Desde: "02:00", Hasta: "05:00"}})
	if got := siguienteApertura(g, ahora); !got.IsZero() {
		t.Fatalf("%s", got)
	}
}
