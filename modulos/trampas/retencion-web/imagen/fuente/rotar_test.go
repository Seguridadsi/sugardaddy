// Pruebas de rotar.go (código propio de SeguridadSI). Corren al construir la
// imagen (Dockerfile): si fallan, no hay imagen.
package logging

import (
	"encoding/json"
	"fmt"
	"hash/maphash"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
)

type relojFalso struct{ t time.Time }

func (r *relojFalso) ahora() time.Time { return r.t }

func lineas(t *testing.T, ruta string) []string {
	t.Helper()
	b, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.TrimSuffix(string(b), "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func objetos(t *testing.T, ruta string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, l := range lineas(t, ruta) {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("línea que no es JSON: %q", l)
		}
		out = append(out, m)
	}
	return out
}

func conPhase(objs []map[string]any, phase string) []map[string]any {
	var out []map[string]any
	for _, o := range objs {
		if o["phase"] == phase {
			out = append(out, o)
		}
	}
	return out
}

func peticion(ip string, n int) []byte {
	return []byte(fmt.Sprintf(`{"level":"info","ts":"2026-10-16T10:00:00Z","msg":"","phase":"start","src_ip":%q,"path":"/.env","n":%d}`+"\n", ip, n))
}

func tamano(t *testing.T, ruta string) int64 {
	t.Helper()
	fi, err := os.Stat(ruta)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}

func TestRotadorRotaAlCambiarDeDia(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	reloj := &relojFalso{time.Date(2026, 10, 16, 23, 59, 0, 0, time.UTC)}
	r, err := nuevoRotador(ruta, 1<<20, reloj.ahora)
	if err != nil {
		t.Fatal(err)
	}
	r.Write([]byte(`{"n":1}` + "\n"))
	reloj.t = reloj.t.Add(2 * time.Minute)
	r.Write([]byte(`{"n":2}` + "\n"))
	r.Close()

	if l := lineas(t, ruta+".2026_10_16"); len(l) != 1 || l[0] != `{"n":1}` {
		t.Fatalf("rotado: %q", l)
	}
	if l := lineas(t, ruta); len(l) != 1 || l[0] != `{"n":2}` {
		t.Fatalf("activo: %q", l)
	}
}

// Lleno el día: una línea de aviso y, desde entonces, un resumen por periodo
// de lo que se calla, no silencio hasta medianoche. Y nunca más del tope.
func TestRotadorTopeDiarioConAvisoYResumenes(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	reloj := &relojFalso{time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	linea := peticion("192.0.2.10", 1) // ~120 bytes
	tope := int64(2*len(linea)) + 3000
	r, err := nuevoRotadorCon(ruta, tope, 3000, 1<<20, reloj.ahora)
	if err != nil {
		t.Fatal(err)
	}
	for range 6 {
		if n, err := r.Write(linea); err != nil || n != len(linea) {
			t.Fatalf("Write: %d %v", n, err)
		}
	}
	objs := objetos(t, ruta)
	if len(conPhase(objs, "start")) != 2 {
		t.Fatalf("esperaba 2 peticiones: %v", objs)
	}
	topes := conPhase(objs, "tope")
	if len(topes) != 1 || topes[0]["tope_bytes"] != float64(tope) {
		t.Fatalf("aviso de tope: %v", objs)
	}
	if ts, ok := topes[0]["ts"].(string); !ok || ts != "2026-10-16T10:00:00Z" {
		t.Fatalf("ts del aviso: %v", topes[0]["ts"])
	}
	r.resumir(time.Minute)
	res := conPhase(objetos(t, ruta), "callados")
	if len(res) != 1 || res[0]["sin_apuntar"] != float64(4) || res[0]["por_tope_dia"] != float64(4) ||
		res[0]["src_ip"] != "192.0.2.10" || res[0]["de_su_ip"] != float64(4) || res[0]["periodo_s"] != float64(60) {
		t.Fatalf("resumen: %v", res)
	}
	// Siguen llegando y siguen saliendo resúmenes, sin pasar del tope.
	for range 100 {
		for range 10 {
			r.Write(linea)
		}
		reloj.t = reloj.t.Add(time.Minute)
		r.resumir(time.Minute)
		if s := tamano(t, ruta); s > tope {
			t.Fatalf("el registro pasa del tope: %d > %d", s, tope)
		}
	}
	if n := len(conPhase(objetos(t, ruta), "callados")); n < 5 {
		t.Fatalf("tras llenarse el día tienen que seguir los resúmenes: %d", n)
	}
	if n := len(conPhase(objetos(t, ruta), "tope")); n != 1 {
		t.Fatalf("una sola línea de tope por día: %d", n)
	}

	// Al día siguiente se rota y se vuelve a escribir.
	reloj.t = time.Date(2026, 10, 17, 0, 0, 1, 0, time.UTC)
	r.Write(linea)
	r.Close()
	if l := lineas(t, ruta); len(l) != 1 {
		t.Fatalf("tras rotar: %q", l)
	}
	if len(conPhase(objetos(t, ruta+".2026_10_16"), "start")) != 2 {
		t.Fatal("el rotado tiene que conservar lo de ayer")
	}
}

// Un solo atacante ya no deja la trampa ciega: gasta su parte y lo demás se
// sigue apuntando.
func TestRotadorRepartoPorIP(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	reloj := &relojFalso{time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	r, err := nuevoRotador(ruta, 1<<20, reloj.ahora) // 32 KiB de reserva y 62 KiB por IP
	if err != nil {
		t.Fatal(err)
	}
	atacante, otra := "192.0.2.66", "198.51.100.7"
	for r.cubeta(atacante) == r.cubeta(otra) {
		r.clave = maphash.MakeSeed()
	}
	for i := range 5000 {
		r.Write(peticion(atacante, i))
	}
	for i := range 10 {
		r.Write(peticion(otra, i))
	}
	objs := objetos(t, ruta)
	var deAtacante, deOtra int
	for _, o := range conPhase(objs, "start") {
		switch o["src_ip"] {
		case atacante:
			deAtacante++
		case otra:
			deOtra++
		}
	}
	if deOtra != 10 {
		t.Fatalf("las líneas de otra IP tienen que apuntarse todas: %d de 10", deOtra)
	}
	if b := tamano(t, ruta); b > r.cupoIP+int64(10*len(peticion(otra, 0))) {
		t.Fatalf("el atacante ha pasado de su parte: %d bytes (cupo %d)", b, r.cupoIP)
	}
	if len(conPhase(objs, "tope")) != 0 {
		t.Fatal("una sola IP no tiene que llenar el día")
	}
	r.resumir(time.Minute)
	res := conPhase(objetos(t, ruta), "callados")
	if len(res) != 1 || res[0]["src_ip"] != atacante || res[0]["sin_apuntar"] != float64(5000-deAtacante) ||
		res[0]["por_cupo_ip"] != float64(5000-deAtacante) || res[0]["ips_distintas"] != float64(1) {
		t.Fatalf("resumen: %v (apuntadas del atacante: %d)", res, deAtacante)
	}
	// Un periodo sin nada callado no escribe nada.
	n := len(lineas(t, ruta))
	r.resumir(time.Minute)
	if len(lineas(t, ruta)) != n {
		t.Fatal("sin nada callado no hay resumen")
	}
}

func TestRotadorResumenAcotaLasIPs(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	reloj := &relojFalso{time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)}
	r, err := nuevoRotadorCon(ruta, 1<<20, 32<<10, 0, reloj.ahora) // todo se calla
	if err != nil {
		t.Fatal(err)
	}
	for i := range maxIPsResumen + 500 {
		r.Write(peticion(fmt.Sprintf("10.0.%d.%d", i>>8, i&255), i))
	}
	r.resumir(time.Minute)
	res := conPhase(objetos(t, ruta), "callados")
	if len(res) != 1 || res[0]["ips_distintas"] != float64(maxIPsResumen) || res[0]["ips_sin_contar"] != float64(500) ||
		res[0]["sin_apuntar"] != float64(maxIPsResumen+500) {
		t.Fatalf("resumen: %v", res)
	}
}

func TestRotadorTrasReinicioOtroDia(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	if err := os.WriteFile(ruta, []byte(`{"n":"ayer"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ayer := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(ruta, ayer, ayer); err != nil {
		t.Fatal(err)
	}
	// Ya hay un rotado con ese nombre: no se pisa.
	if err := os.WriteFile(ruta+".2026_10_15", []byte(`{"n":"antes"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reloj := &relojFalso{time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	r, err := nuevoRotador(ruta, 1<<20, reloj.ahora)
	if err != nil {
		t.Fatal(err)
	}
	r.Write([]byte(`{"n":"hoy"}` + "\n"))
	r.Close()
	if l := lineas(t, ruta+".2026_10_15.1"); len(l) != 1 || l[0] != `{"n":"ayer"}` {
		t.Fatalf("rotado: %q", l)
	}
	if l := lineas(t, ruta+".2026_10_15"); len(l) != 1 || l[0] != `{"n":"antes"}` {
		t.Fatalf("el rotado de antes se ha tocado: %q", l)
	}
	if l := lineas(t, ruta); len(l) != 1 || l[0] != `{"n":"hoy"}` {
		t.Fatalf("activo: %q", l)
	}
}

func TestRotadorMismoDiaSigueContando(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	hoy := time.Now().UTC()
	if err := os.WriteFile(ruta, []byte(strings.Repeat("x", 90)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := nuevoRotadorCon(ruta, 100+1000, 1000, 1<<20, func() time.Time { return hoy })
	if err != nil {
		t.Fatal(err)
	}
	r.Write([]byte(`{"n":1}` + "\n")) // 91 + 8 = 99: cabe
	r.Write([]byte(`{"n":2}` + "\n")) // ya no: aviso
	r.Close()
	l := lineas(t, ruta)
	if len(l) != 3 || l[1] != `{"n":1}` || !strings.Contains(l[2], `"phase":"tope"`) {
		t.Fatalf("activo: %q", l)
	}
}

func TestTopeDe(t *testing.T) {
	casos := map[string]int64{"": topePorDefecto, "x": topePorDefecto, "0": topePorDefecto, "2000": topePorDefecto, "1": 1 << 20, "60": 60 << 20}
	for s, quiere := range casos {
		if got := topeDe(s); got != quiere {
			t.Errorf("topeDe(%q) = %d, quiero %d", s, got, quiere)
		}
	}
	// El reparto con el tope del manifiesto.
	r, err := nuevoRotador(filepath.Join(t.TempDir(), "go-pot.json"), topeDe("60"), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if r.reserva != 60<<20/32 || r.cupoIP != (60<<20-60<<20/32)/16 {
		t.Fatalf("reserva %d, cupo por IP %d", r.reserva, r.cupoIP)
	}
}

// Como lo usa go-pot: un logger de producción de zap con OutputPaths rotar://.
func TestRotadorDesdeZap(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "go-pot.json")
	cfg := zap.NewProductionConfig()
	cfg.Sampling = nil
	cfg.EncoderConfig.EncodeTime = horaRFC3339
	cfg.OutputPaths = []string{"rotar://" + ruta + "?tope_mb=1"}
	logger, err := cfg.Build()
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		logger.Info("", zap.String("phase", "start"), zap.String("path", "/.env"))
	}
	logger.Sync()
	l := lineas(t, ruta)
	if len(l) != 3 {
		t.Fatalf("esperaba 3 líneas: %q", l)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(l[0]), &m); err != nil || m["path"] != "/.env" {
		t.Fatalf("línea: %q (%v)", l[0], err)
	}
	if ts, ok := m["ts"].(string); !ok || !strings.HasSuffix(ts, "Z") {
		t.Fatalf("ts: %q", l[0])
	}
	if rotadorActivo.Load() == nil {
		t.Fatal("el limitador no tendría dónde escribir sus resúmenes")
	}
}
