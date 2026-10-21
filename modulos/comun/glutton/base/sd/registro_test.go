package sd

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func leerLineas(t *testing.T, ruta string) []Evento {
	t.Helper()
	f, err := os.Open(ruta)
	if err != nil {
		return nil
	}
	defer f.Close()
	var evs []Evento
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		linea := sc.Bytes()
		if len(linea) == 0 {
			continue
		}
		var e Evento
		if err := json.Unmarshal(linea, &e); err != nil {
			t.Fatalf("línea no es JSON válido: %s", linea)
		}
		evs = append(evs, e)
	}
	return evs
}

func cfgPrueba(dir string) Config {
	return Config{
		Modulo:        "smb",
		LogDir:        dir,
		MaxLogBytes:   100000,
		LibresPorTipo: 2,
		ResumenSeg:    1,
		MaxIPs:        100,
	}
}

func TestRegistroEscribeYLee(t *testing.T) {
	dir := t.TempDir()
	r, err := NuevoRegistro(cfgPrueba(dir))
	if err != nil {
		t.Fatal(err)
	}
	r.Apunta(Evento{EventID: "smb.session.connect", SrcIP: "198.51.100.1"})
	r.Apunta(Evento{EventID: "smb.session.auth", SrcIP: "198.51.100.1", Usuario: "jdoe"})
	if err := r.Cierra(); err != nil {
		t.Fatal(err)
	}
	evs := leerLineas(t, filepath.Join(dir, "smb.json"))
	if len(evs) != 2 {
		t.Fatalf("esperaba 2 líneas, hay %d", len(evs))
	}
	if evs[0].Cuando == "" {
		t.Error("no se rellenó 'cuando'")
	}
	if _, err := time.Parse(time.RFC3339Nano, evs[0].Cuando); err != nil {
		t.Errorf("'cuando' no es RFC3339Nano: %v", err)
	}
}

func TestRegistroTopeYOmitidos(t *testing.T) {
	dir := t.TempDir()
	c := cfgPrueba(dir)
	c.MaxLogBytes = 1 // casi nada: solo entran los del pase libre
	c.LibresPorTipo = 3
	r, err := NuevoRegistro(c)
	if err != nil {
		t.Fatal(err)
	}
	reloj := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	r.reloj = func() time.Time { return reloj }
	r.ultResumen = reloj

	// 10 del mismo tipo desde la misma IP: pasan 3 (pase libre), se callan 7.
	for i := 0; i < 10; i++ {
		r.Apunta(Evento{EventID: "smb.session.auth", SrcIP: "203.0.113.5"})
	}
	// El tiempo avanza para disparar el resumen en el siguiente apunte.
	reloj = reloj.Add(2 * time.Second)
	r.Apunta(Evento{EventID: "smb.session.auth", SrcIP: "203.0.113.5"})
	r.Cierra()

	evs := leerLineas(t, filepath.Join(dir, "smb.json"))
	var auth, omit int
	var totalOmit int64
	for _, e := range evs {
		switch e.EventID {
		case "smb.session.auth":
			auth++
		case "smb.log.omitidos":
			omit++
			totalOmit = e.Omitidos
		}
	}
	if auth != 3 {
		t.Errorf("el pase libre debía dejar 3 auth, dejó %d", auth)
	}
	if omit == 0 {
		t.Fatal("no se emitió ningún resumen de omitidos")
	}
	if totalOmit == 0 {
		t.Error("el resumen no cuenta los omitidos")
	}
}

func TestRegistroRotacionDiaria(t *testing.T) {
	dir := t.TempDir()
	r, err := NuevoRegistro(cfgPrueba(dir))
	if err != nil {
		t.Fatal(err)
	}
	dia := time.Date(2026, 3, 10, 23, 59, 0, 0, time.UTC)
	r.reloj = func() time.Time { return dia }
	r.dia = dia.UTC().Format("2006-01-02")
	r.Apunta(Evento{EventID: "smb.session.connect", SrcIP: "198.51.100.9"})
	// Día siguiente: el próximo apunte rota.
	dia = dia.Add(2 * time.Minute) // cruza medianoche
	r.Apunta(Evento{EventID: "smb.session.connect", SrcIP: "198.51.100.9"})
	r.Cierra()

	rotados, _ := filepath.Glob(filepath.Join(dir, "smb.json.*"))
	if len(rotados) != 1 {
		t.Fatalf("esperaba 1 fichero rotado, hay %d", len(rotados))
	}
	if !strings.HasSuffix(rotados[0], "2026-03-10") {
		t.Errorf("el rotado no lleva la fecha esperada: %s", rotados[0])
	}
	// El del día nuevo tiene la última línea.
	hoy := leerLineas(t, filepath.Join(dir, "smb.json"))
	if len(hoy) != 1 {
		t.Errorf("el registro del día nuevo debía tener 1 línea, tiene %d", len(hoy))
	}
}

func TestRegistroBolsaPrioritaria(t *testing.T) {
	dir := t.TempDir()
	c := cfgPrueba(dir)
	c.MaxLogBytes = 100000
	c.LibresPorTipo = 1
	c.Prioritarios = []string{"smb.exploit"}
	c.LibresPrioritarios = 5
	r, err := NuevoRegistro(c)
	if err != nil {
		t.Fatal(err)
	}
	reloj := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	r.reloj = func() time.Time { return reloj }
	r.ultResumen = reloj

	// Simular un día ya lleno por el ruido de otras IP (tope global de bytes y
	// pase libre del tipo agotados): el camino normal bloquea todo.
	r.bytesHoy = r.maxBytes
	r.vistos["smb.exploit"] = c.LibresPorTipo

	// Un gusano entra desde una IP nueva: aunque el día esté lleno, su bolsa
	// prioritaria garantiza que sus sondas queden registradas.
	for i := 0; i < 10; i++ {
		r.Apunta(Evento{EventID: "smb.exploit", SrcIP: "198.51.100.9", Grave: "ms17-010-sonda"})
	}
	r.Cierra()

	evs := leerLineas(t, filepath.Join(dir, "smb.json"))
	nuevos := 0
	for _, e := range evs {
		if e.EventID == "smb.exploit" && e.SrcIP == "198.51.100.9" {
			nuevos++
		}
	}
	if nuevos < c.LibresPrioritarios {
		t.Fatalf("la IP nueva debía dejar %d smb.exploit por su bolsa prioritaria, dejó %d", c.LibresPrioritarios, nuevos)
	}
}

func TestRegistroResumenPeriodico(t *testing.T) {
	dir := t.TempDir()
	c := cfgPrueba(dir)
	c.MaxLogBytes = 1 // todo se calla
	c.LibresPorTipo = 0
	c.ResumenSeg = 1
	r, err := NuevoRegistro(c) // reloj real: el temporizador usa tiempo real
	if err != nil {
		t.Fatal(err)
	}
	r.IniciarResumenPeriodico()
	for i := 0; i < 9; i++ {
		r.Apunta(Evento{EventID: "smb.file.open", SrcIP: "203.0.113.7"})
	}
	// Sin más eventos: el temporizador debe emitir el resumen por su cuenta.
	time.Sleep(2500 * time.Millisecond)
	evs := leerLineas(t, filepath.Join(dir, "smb.json"))
	resumenes := 0
	for _, e := range evs {
		if e.EventID == "smb.log.omitidos" {
			resumenes++
		}
	}
	r.Cierra()
	if resumenes == 0 {
		t.Fatal("el temporizador no emitió ningún smb.log.omitidos sin un evento posterior")
	}
}
