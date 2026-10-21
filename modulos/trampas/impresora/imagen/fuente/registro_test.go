package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

// relojFijo devuelve un reloj controlable para las pruebas del registro.
func relojFijo(t *time.Time) func() time.Time {
	return func() time.Time { return *t }
}

func contarEventos(ruta, id string) (n int) {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return 0
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.Contains(l, `"eventid":"`+id+`"`) {
			n++
		}
	}
	return
}

// TestTopeDiarioAcotado: por mucho que escriba un atacante, el fichero no pasa
// del tope diario.
func TestTopeDiarioAcotado(t *testing.T) {
	ruta := t.TempDir() + "/impresora.json"
	ahora := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	topeDia := int64(40000)
	reg, err := nuevoRegistrador(ruta, topeDia, time.Minute, relojFijo(&ahora))
	if err != nil {
		t.Fatal(err)
	}
	defer reg.cerrar()
	for i := 0; i < 20000; i++ {
		reg.escribir(evento{
			EventID: "impresora.pjl.info", SrcIP: "198.51.100.1", Servicio: "raw",
			Comando: "INFO ID", Args: strings.Repeat("x", 400),
		})
	}
	reg.resumirAhora()
	fi, err := os.Stat(ruta)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() > topeDia {
		t.Fatalf("el registro (%d) pasa del tope diario (%d)", fi.Size(), topeDia)
	}
	if contarEventos(ruta, "impresora.log.tope")+contarEventos(ruta, "impresora.log.omitidos") == 0 {
		t.Fatal("no avisó de que se está callando eventos")
	}
}

// TestPrimerosDeCadaTipo: cuando una IP ha llenado su bolsa a base de @PJL INFO,
// su primer evento grave (un passback, un recorrido de rutas) sigue entrando.
func TestPrimerosDeCadaTipo(t *testing.T) {
	ruta := t.TempDir() + "/impresora.json"
	ahora := time.Date(2026, 10, 17, 1, 0, 0, 0, time.UTC)
	reg, err := nuevoRegistrador(ruta, 60000, time.Minute, relojFijo(&ahora))
	if err != nil {
		t.Fatal(err)
	}
	defer reg.cerrar()
	ip := "203.0.113.9"
	// Mucho reconocimiento: llena la parte de la bolsa general de esta IP.
	for i := 0; i < 5000; i++ {
		reg.escribir(evento{
			EventID: "impresora.pjl.info", SrcIP: ip, Servicio: "raw",
			Comando: "INFO ID", Args: strings.Repeat("x", 300),
		})
	}
	// Su primer passback, aunque llegue tarde, se apunta.
	reg.escribir(evento{
		EventID: "impresora.web.passback", SrcIP: ip, Servicio: "web",
		Campo: "ldap_server", Servidor: "203.0.113.9", Grave: "robo de la cuenta de servicio",
	})
	reg.resumirAhora()
	if contarEventos(ruta, "impresora.web.passback") == 0 {
		t.Fatal("el primer evento grave de la IP no se apuntó")
	}
}

// TestRotaPorDia: al cambiar el día (UTC) el registro se renombra y empieza
// uno nuevo, para que no crezca sin fin.
func TestRotaPorDia(t *testing.T) {
	dir := t.TempDir()
	ruta := dir + "/impresora.json"
	ahora := time.Date(2026, 10, 17, 23, 59, 0, 0, time.UTC)
	reg, err := nuevoRegistrador(ruta, 1<<20, time.Minute, relojFijo(&ahora))
	if err != nil {
		t.Fatal(err)
	}
	defer reg.cerrar()
	reg.escribir(evento{EventID: "impresora.pjl.info", SrcIP: "198.51.100.2", Comando: "INFO ID"})
	ahora = ahora.Add(2 * time.Minute) // cruza la medianoche UTC
	reg.escribir(evento{EventID: "impresora.pjl.info", SrcIP: "198.51.100.2", Comando: "INFO STATUS"})
	entradas, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	rotados := 0
	for _, e := range entradas {
		if strings.HasPrefix(e.Name(), "impresora.json.") {
			rotados++
		}
	}
	if rotados == 0 {
		t.Fatal("el registro no se rotó al cambiar el día")
	}
}
