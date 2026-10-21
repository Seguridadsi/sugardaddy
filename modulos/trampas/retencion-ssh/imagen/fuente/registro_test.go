package main

import (
	"encoding/json"
	"hash/maphash"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type relojFalso struct{ t time.Time }

func (r *relojFalso) ahora() time.Time { return r.t }

func lineasDe(t *testing.T, ruta string) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("no es JSON: %q", l)
		}
		out = append(out, m)
	}
	return out
}

func TestRegistroRotaAlCambiarDeDia(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "reten.json")
	reloj := &relojFalso{time.Date(2026, 10, 16, 23, 59, 30, 0, time.UTC)}
	r, err := nuevoRegistrador(ruta, 1<<20, reloj.ahora)
	if err != nil {
		t.Fatal(err)
	}
	r.escribir("conexion", campos{"id": "a"}, nil)
	reloj.t = reloj.t.Add(time.Minute)
	r.escribir("conexion", campos{"id": "b"}, nil)
	r.cerrar()
	ayer := lineasDe(t, ruta+".2026_10_16")
	hoy := lineasDe(t, ruta)
	if len(ayer) != 1 || ayer[0]["id"] != "a" || len(hoy) != 1 || hoy[0]["id"] != "b" {
		t.Fatalf("ayer=%v hoy=%v", ayer, hoy)
	}
	if hoy[0]["ts"] != "2026-10-17T00:00:30Z" || hoy[0]["evento"] != "conexion" {
		t.Fatalf("línea: %v", hoy[0])
	}
}

// Lleno el día: una línea de aviso y, desde entonces, un resumen por periodo
// de lo que no se apunta, no silencio hasta medianoche. Y nunca más del tope.
func TestRegistroTopeDiario(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "reten.json")
	reloj := &relojFalso{time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	r, err := nuevoRegistradorCon(ruta, 300+3000, 3000, 1<<20, reloj.ahora)
	if err != nil {
		t.Fatal(err)
	}
	for range 10 {
		r.escribir("conexion", campos{"id": "0123456789abcdef", "src_ip": "192.0.2.10", "src_port": 51234}, nil)
	}
	l := lineasDe(t, ruta)
	conexiones, topes := 0, 0
	for _, e := range l {
		switch e["evento"] {
		case "conexion":
			conexiones++
		case "tope":
			topes++
			if e["tope_bytes"] != float64(3300) || e["ts"] == nil {
				t.Fatalf("línea de tope: %v", e)
			}
		}
	}
	if conexiones < 1 || conexiones > 3 || topes != 1 {
		t.Fatalf("conexiones %d, topes %d: %v", conexiones, topes, l)
	}
	r.resumirCallados("ssh", time.Minute)
	res := deEvento(lineasDe(t, ruta), "callados")
	if len(res) != 1 || res[0]["sin_apuntar"] != float64(10-conexiones) || res[0]["por_tope_dia"] != float64(10-conexiones) ||
		res[0]["src_ip"] != "192.0.2.10" || res[0]["periodo_s"] != float64(60) || res[0]["modo"] != "ssh" {
		t.Fatalf("resumen: %v", res)
	}
	// Siguen llegando y siguen saliendo resúmenes, sin pasar del tope.
	for range 100 {
		for range 10 {
			r.escribir("conexion", campos{"id": "0123456789abcdef", "src_ip": "192.0.2.10", "src_port": 51234}, nil)
		}
		reloj.t = reloj.t.Add(time.Minute)
		r.resumirCallados("ssh", time.Minute)
		if fi, _ := os.Stat(ruta); fi.Size() > 3300 {
			t.Fatalf("el registro pasa del tope: %d bytes", fi.Size())
		}
	}
	if n := len(deEvento(lineasDe(t, ruta), "callados")); n < 5 {
		t.Fatalf("tras llenarse el día tienen que seguir los resúmenes: %d", n)
	}
	if n := len(deEvento(lineasDe(t, ruta), "tope")); n != 1 {
		t.Fatalf("una sola línea de tope por día: %d", n)
	}
	// Al día siguiente se rota y se vuelve a apuntar.
	reloj.t = time.Date(2026, 10, 17, 0, 0, 1, 0, time.UTC)
	r.escribir("conexion", campos{"id": "nuevo"}, nil)
	r.cerrar()
	if hoy := lineasDe(t, ruta); len(hoy) != 1 || hoy[0]["id"] != "nuevo" {
		t.Fatalf("tras rotar: %v", hoy)
	}
}

// Un solo atacante ya no deja la trampa ciega: gasta su parte del día y lo de
// los demás se sigue apuntando.
func TestRegistroRepartoPorIP(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "reten.json")
	reloj := &relojFalso{time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	r, err := nuevoRegistrador(ruta, 1<<20, reloj.ahora) // 62 KiB por IP
	if err != nil {
		t.Fatal(err)
	}
	atacante, otra := "192.0.2.66", "198.51.100.7"
	for r.cubeta(atacante) == r.cubeta(otra) {
		r.clave = maphash.MakeSeed()
	}
	for i := range 3000 {
		r.escribir("conexion", campos{"id": nuevoID(), "modo": "ssh", "src_ip": atacante, "src_port": 40000 + i}, nil)
	}
	for i := range 10 {
		r.escribir("conexion", campos{"id": nuevoID(), "modo": "ssh", "src_ip": otra, "src_port": 50000 + i}, nil)
	}
	deAtacante, deOtra := 0, 0
	for _, e := range deEvento(lineasDe(t, ruta), "conexion") {
		switch e["src_ip"] {
		case atacante:
			deAtacante++
		case otra:
			deOtra++
		}
	}
	if deOtra != 10 {
		t.Fatalf("las de otra IP tienen que apuntarse todas: %d de 10", deOtra)
	}
	if deAtacante == 0 || deAtacante == 3000 {
		t.Fatalf("del atacante: %d de 3000", deAtacante)
	}
	if fi, _ := os.Stat(ruta); fi.Size() > r.cupoIP+2000 {
		t.Fatalf("el atacante pasa de su parte: %d bytes (cupo %d)", fi.Size(), r.cupoIP)
	}
	r.resumirCallados("ssh", time.Minute)
	res := deEvento(lineasDe(t, ruta), "callados")
	if len(res) != 1 || res[0]["src_ip"] != atacante || res[0]["sin_apuntar"] != float64(3000-deAtacante) ||
		res[0]["por_cupo_ip"] != float64(3000-deAtacante) || res[0]["ips_distintas"] != float64(1) {
		t.Fatalf("resumen: %v", res)
	}
	// Sin nada callado, no hay resumen.
	n := len(lineasDe(t, ruta))
	r.resumirCallados("ssh", time.Minute)
	if len(lineasDe(t, ruta)) != n {
		t.Fatal("sin nada callado no hay resumen")
	}
}

func deEvento(l []map[string]any, evento string) []map[string]any {
	var out []map[string]any
	for _, e := range l {
		if e["evento"] == evento {
			out = append(out, e)
		}
	}
	return out
}

func TestRegistroTrasReinicio(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "reten.json")
	os.WriteFile(ruta, []byte(`{"evento":"conexion","id":"ayer"}`+"\n"), 0o644)
	ayer := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	os.Chtimes(ruta, ayer, ayer)
	os.WriteFile(ruta+".2026_10_15", []byte(`{"evento":"conexion","id":"antes"}`+"\n"), 0o644)

	reloj := &relojFalso{time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)}
	r, err := nuevoRegistrador(ruta, 1<<20, reloj.ahora)
	if err != nil {
		t.Fatal(err)
	}
	r.escribir("conexion", campos{"id": "hoy"}, nil)
	r.cerrar()
	if l := lineasDe(t, ruta+".2026_10_15.1"); len(l) != 1 || l[0]["id"] != "ayer" {
		t.Fatalf("rotado: %v", l)
	}
	if l := lineasDe(t, ruta+".2026_10_15"); len(l) != 1 || l[0]["id"] != "antes" {
		t.Fatalf("se ha pisado el rotado de antes: %v", l)
	}
	if l := lineasDe(t, ruta); len(l) != 1 || l[0]["id"] != "hoy" {
		t.Fatalf("activo: %v", l)
	}
}

func TestRegistroMismoDiaSigueContando(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "reten.json")
	os.WriteFile(ruta, []byte(strings.Repeat("x", 250)+"\n"), 0o644)
	hoy := time.Now()
	r, err := nuevoRegistradorCon(ruta, 300+1000, 1000, 1<<20, func() time.Time { return hoy })
	if err != nil {
		t.Fatal(err)
	}
	r.escribir("conexion", campos{"id": "0123456789abcdef0123456789abcdef"}, nil)
	r.cerrar()
	b, _ := os.ReadFile(ruta)
	if !strings.Contains(string(b), `"evento":"tope"`) || strings.Contains(string(b), "0123456789abcdef") {
		t.Fatalf("los bytes de antes del reinicio cuentan para el tope de hoy: %s", b)
	}
}

func TestRegistroRepartoConElTopeDelManifiesto(t *testing.T) {
	r, err := nuevoRegistrador(filepath.Join(t.TempDir(), "reten.json"), 60<<20, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer r.cerrar()
	if r.reserva != 60<<20/32 || r.cupoIP != (60<<20-60<<20/32)/16 {
		t.Fatalf("reserva %d, cupo por IP %d", r.reserva, r.cupoIP)
	}
}

func TestSemillaDeLaTrampa(t *testing.T) {
	dir := t.TempDir()
	a := semillaDeLaTrampa(filepath.Join(dir, "reten.json"))
	if len(a) != 32 {
		t.Fatalf("semilla: %q", a)
	}
	if b := semillaDeLaTrampa(filepath.Join(dir, "reten.json")); b != a {
		t.Fatalf("la misma tras un reinicio: %q %q", a, b)
	}
	if b := semillaDeLaTrampa(filepath.Join(t.TempDir(), "reten.json")); b == a {
		t.Fatal("dos trampas, dos semillas")
	}
	h, _ := os.Hostname()
	if b := semillaDeLaTrampa("/no/existe/reten.json"); b != h {
		t.Fatalf("sin carpeta, el nombre del contenedor: %q", b)
	}
}
