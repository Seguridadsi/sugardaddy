package adaptador

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// cowrie.jsonl son líneas reales de Cowrie 3.1.2 más tres escritas a mano para
// probar lo hostil. cowrie.manifiesto.json es el manifiesto del repositorio
// pasado a JSON; el contrato en TS comprueba que no se ha quedado atrás.
func cargar(t *testing.T) (plan.TrampaPlan, []evento.Evento, int) {
	t.Helper()
	var m plan.Manifiesto
	datos, err := os.ReadFile("testdata/cowrie.manifiesto.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(datos, &m); err != nil {
		t.Fatal(err)
	}
	s := plan.TrampaPlan{ID: "ssh-backup", Manifiesto: m}

	f, err := os.Open("testdata/cowrie.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var eventos []evento.Evento
	ignoradas := 0
	lector := bufio.NewScanner(f)
	lector.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for lector.Scan() {
		e, err := Adaptar("servidores", s, lector.Bytes())
		if errors.Is(err, ErrIgnorada) {
			ignoradas++
			continue
		}
		if err != nil {
			t.Fatalf("línea %q: %v", lector.Text()[:60], err)
		}
		eventos = append(eventos, e)
	}
	return s, eventos, ignoradas
}

func TestCowrie(t *testing.T) {
	_, eventos, ignoradas := cargar(t)

	// Solo log.closed no es un evento; kex, version y closed son contexto de la sesión.
	if ignoradas != 1 {
		t.Errorf("ignoradas = %d, quería 1", ignoradas)
	}
	cuenta := map[string]int{}
	for _, e := range eventos {
		cuenta[e.Accion]++
	}
	if cuenta["conexion"] != 2 || cuenta["autenticacion"] != 5 || cuenta["comando"] != 1 || cuenta["otra"] != 6 {
		t.Errorf("acciones = %v", cuenta)
	}

	primero := eventos[0]
	if primero.Origen.IP != "192.168.97.1" || primero.Origen.Puerto != 36736 || primero.Trampa.Modulo != "cowrie" {
		t.Errorf("primer evento mal traducido: %+v", primero)
	}
	if !primero.ConexionEstablecida || primero.Severidad != "media" {
		t.Errorf("conexión: %+v", primero)
	}

	for _, e := range eventos {
		if e.Accion == "comando" {
			if e.Severidad != "critica" || !strings.Contains(e.Detalle["input"].(string), "k.sh") {
				t.Errorf("comando mal traducido: %+v", e)
			}
		}
		if e.Accion == "autenticacion" {
			if _, hay := e.Detalle["password"]; !hay {
				t.Errorf("falta la contraseña probada: %+v", e)
			}
		}
		if e.Accion == "otra" && e.Severidad != "baja" {
			t.Errorf("el contexto de la sesión debería ser de severidad baja: %+v", e)
		}
	}
}

func TestLoHostil(t *testing.T) {
	_, eventos, _ := cargar(t)
	hostil := eventos[len(eventos)-1]
	if hostil.Origen.IP != "" {
		t.Errorf("una IP inválida no debe pasar: %q", hostil.Origen.IP)
	}
	if hostil.Origen.Puerto != 0 {
		t.Errorf("un puerto fuera de rango no debe pasar: %d", hostil.Origen.Puerto)
	}
	if len(hostil.Origen.Usuario) != maxTexto {
		t.Errorf("el usuario debería recortarse a %d, mide %d", maxTexto, len(hostil.Origen.Usuario))
	}
}

func TestRecortarNoParteCaracteres(t *testing.T) {
	if r := recortar("añ", 2); r != "a" {
		t.Errorf("recortar partió la ñ: %q", r)
	}
}

func TestIdFijoPorLinea(t *testing.T) {
	a := idDe("servidores", "ssh-1", []byte(`{"eventid":"cowrie.login.failed"}`))
	if a != idDe("servidores", "ssh-1", []byte(`{"eventid":"cowrie.login.failed"}`)) {
		t.Fatal("la misma línea tiene que dar el mismo id")
	}
	if a == idDe("servidores", "ssh-2", []byte(`{"eventid":"cowrie.login.failed"}`)) {
		t.Fatal("otra trampa, otro id")
	}
	if len(a) != 36 || a[14] != '8' {
		t.Fatalf("no es un UUID v8: %s", a)
	}
}

// Lo que escriben otros honeypots: fechas sin zona o en segundos, claves con
// punto literal, puertos entre comillas y reglas por campo.
func TestFormatosDeOtrosHoneypots(t *testing.T) {
	var m plan.Manifiesto
	m.ID, m.Tipo = "otro", "contenedor"
	ev := &m.Eventos
	ev.Campos.Cuando, ev.Campos.IP, ev.Campos.Puerto, ev.Campos.Usuario = "ts", "src.ip", "src.port", "smtp.user"
	ev.Accion.Campo, ev.Accion.PorDefecto = "tipo", "otra"
	ev.Accion.Valores = map[string]string{"auth": "autenticacion", "query": "otra"}
	ev.Severidad.PorDefecto = "media"
	ev.Severidad.PorCampo = &plan.SegunCampo{Campo: "cve", Valores: map[string]string{"CVE-2023-20269": "critica"}}
	ev.ConexionEstablecida = true
	ev.ConexionPorCampo = &plan.SegunCampoBool{Campo: "proto", Valores: map[string]bool{"udp": false}}
	s := plan.TrampaPlan{ID: "t", Manifiesto: m}

	casos := []struct {
		linea, cuando string
		puerto        int
		usuario       string
		conexion      bool
		severidad     string
	}{
		{`{"ts":"2026-10-16T10:00:00.123456","src":{"ip":"10.1.2.3","port":"51234"},"smtp.user":"ana","tipo":"auth","proto":"tcp"}`, "2026-10-16T10:00:00.123456Z", 51234, "ana", true, "media"},
		{`{"ts":"2026-10-16 10:00:00","src":{"ip":"10.1.2.3","port":53},"tipo":"query","proto":"udp"}`, "2026-10-16T10:00:00Z", 53, "", false, "media"},
		{`{"ts":1792152000,"src":{"ip":"10.1.2.3","port":1},"tipo":"auth","cve":"CVE-2023-20269"}`, "2026-10-16T12:00:00Z", 1, "", true, "critica"},
		{`{"ts":"2026-10-16T12:00:00.000+0200","src":{"ip":"10.1.2.3","port":1},"tipo":"auth"}`, "2026-10-16T10:00:00Z", 1, "", true, "media"},
		{`{"ts":"1792152000123","src":{"ip":"10.1.2.3","port":1},"tipo":"auth"}`, "2026-10-16T12:00:00.123Z", 1, "", true, "media"},
	}
	for _, c := range casos {
		e, err := Adaptar("s", s, []byte(c.linea))
		if err != nil {
			t.Fatalf("%s: %v", c.linea, err)
		}
		if e.Cuando != c.cuando || e.Origen.Puerto != c.puerto || e.Origen.Usuario != c.usuario || e.ConexionEstablecida != c.conexion || e.Severidad != c.severidad {
			t.Fatalf("%s:\n%+v", c.linea, e)
		}
	}
	if _, err := Adaptar("s", s, []byte(`{"ts":"ayer","tipo":"auth"}`)); err == nil {
		t.Fatal("una fecha que no se entiende no se inventa")
	}
}

func TestResumenDeLoDescartadoConLaColaLlena(t *testing.T) {
	var s plan.TrampaPlan
	s.ID, s.Manifiesto.ID, s.Manifiesto.Tipo = "t1", "cowrie", "contenedor"
	var d Descarte
	d.Tope = 1 << 20
	d.Apuntar(evento.Evento{Cuando: "2026-10-01T10:05:00Z", Severidad: "baja", Accion: "conexion", Origen: evento.Origen{IP: "10.0.0.1"}}, 300, 5)
	d.Apuntar(evento.Evento{Cuando: "2026-10-01T10:01:00Z", Severidad: "media", Accion: "comando", Origen: evento.Origen{IP: "10.0.0.2"}}, 200, 5)
	// Un resumen de los topes por minuto que tampoco cupo: cuenta lo que resume.
	var r Resumen
	r.Apuntar(evento.Evento{Severidad: "critica", Accion: "descarga"}, 5)
	r.Apuntar(evento.Evento{Severidad: "baja", Accion: "conexion"}, 5)
	d.Apuntar(Omitidos("s1", s, time.Date(2026, 10, 1, 10, 3, 0, 0, time.UTC), r), 500, 5)

	if d.Resumen.N != 2 || d.Omitidos != 2 || d.Bytes != 1000 || d.PorSeveridadOmitidos["critica"] != 1 {
		t.Fatalf("cuenta los eventos, lo que resumían los resúmenes y los bytes: %+v", d)
	}
	e := Descartados("s1", s, d)
	if e.Detalle["codigo"] != CodigoColaLlena || e.Detalle["descartados"] != 2 || e.Detalle["omitidosEnResumenes"] != 2 {
		t.Fatalf("detalle: %v", e.Detalle)
	}
	if aviso := e.Detalle["aviso"].(string); !strings.Contains(aviso, "comprobar que el sensor llega a la consola") {
		t.Fatalf("con la cola llena, el aviso dice qué mirar: %q", aviso)
	}
	if e.Detalle["desde"] != "2026-10-01T10:01:00Z" || e.Cuando != "2026-10-01T10:05:00Z" {
		t.Fatalf("de cuándo es lo descartado: %v → %s", e.Detalle["desde"], e.Cuando)
	}
	if e.Severidad != "critica" {
		t.Fatalf("su severidad es la más alta de lo descartado, también de lo resumido: %s", e.Severidad)
	}
	if e.Trampa.ID != "t1" || e.Accion != "otra" || e.Version != 2 || e.ID == "" {
		t.Fatalf("es un evento de su trampa: %+v", e)
	}
	// Otro resumen con otros datos lleva otro id: la consola no lo da por repetido.
	d.Apuntar(evento.Evento{Cuando: "2026-10-01T10:06:00Z", Severidad: "baja"}, 10, 5)
	if Descartados("s1", s, d).ID == e.ID {
		t.Fatal("cada resumen tiene su id")
	}
	// Con el tope recortado por el poco disco libre y la consola recogiendo, el
	// resumen pide liberar disco: no es que la consola no recogiera.
	d.PocoDisco = true
	if e := Descartados("s1", s, d); e.Detalle["codigo"] != CodigoColaPocoDisco ||
		!strings.Contains(e.Detalle["aviso"].(string), "liberar espacio") || strings.Contains(e.Detalle["aviso"].(string), "no recogió") {
		t.Fatalf("poco disco: %v", e.Detalle)
	}
	// Sin disco, el resumen lo dice con su código, también si además faltaba sitio en la cola.
	d.SinDisco = true
	if e := Descartados("s1", s, d); e.Detalle["codigo"] != CodigoColaSinDisco || !strings.Contains(e.Detalle["aviso"].(string), "disco") {
		t.Fatalf("sin disco: %v", e.Detalle)
	}
	// Una línea nativa nunca pasa por un resumen de omitidos, ni con ese campo.
	if _, _, ok := OmitidosDe(evento.Evento{Detalle: map[string]any{"omitidos": float64(3)}}); ok {
		t.Fatal("un número de JSON no es un resumen de omitidos")
	}
}
