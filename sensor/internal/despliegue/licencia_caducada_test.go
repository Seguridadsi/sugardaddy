package despliegue

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Licencia caducada (docs/diseno/licencias-de-pago.md, B-06): lo desplegado sigue, también
// si se cae y se rehace; lo nuevo y los cambios de las trampas de pago esperan a renovarla.

var ahoraFijo = time.Date(2027, 3, 1, 12, 0, 0, 0, time.UTC)

type motorLicencia struct {
	mu         sync.Mutex
	existentes []map[string]any
	creados    []map[string]any
	borrados   []string
}

func (m *motorLicencia) servir(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	responder := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	p := r.URL.Path
	switch {
	case r.Method == http.MethodGet && p == "/containers/json":
		responder(m.existentes)
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/networks/"):
		responder(map[string]any{"Options": map[string]string{"com.docker.network.bridge.enable_icc": "false"}, "Containers": map[string]any{}})
	case r.Method == http.MethodPost && p == "/containers/create":
		var c map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &c)
		m.creados = append(m.creados, c)
		responder(map[string]string{"Id": "nuevo"})
	case r.Method == http.MethodDelete && strings.HasPrefix(p, "/containers/"):
		m.borrados = append(m.borrados, strings.TrimPrefix(p, "/containers/"))
		responder(map[string]any{})
	case r.Method == http.MethodGet && p == "/volumes":
		responder(map[string]any{"Volumes": []any{}})
	default:
		responder(map[string]any{})
	}
}

func sobreLicencia(caduca string) json.RawMessage {
	interior, _ := json.Marshal(map[string]string{"caduca": caduca})
	b, _ := json.Marshal(map[string]string{"licencia": string(interior), "firma": "x"})
	return b
}

func trampaDePago(id string) plan.TrampaPlan {
	s := trampa(id, "r/pago@sha256:1")
	si := true
	s.Licencia = &si
	return s
}

// La huella con la que Aplicar verá esta trampa en esta máquina.
func huellaDe(t *testing.T, o Opciones, s plan.TrampaPlan) string {
	t.Helper()
	cfg, _, err := config(o, "s1", filepath.Join(o.Datos, "licencia.json"), s, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	return huella(cfg)
}

func entornoDe(c map[string]any) []string {
	var e []string
	l, _ := c["Env"].([]any)
	for _, v := range l {
		e = append(e, v.(string))
	}
	return e
}

func aplicarCon(t *testing.T, m *motorLicencia, o Opciones, caduca string, s plan.TrampaPlan) []Estado {
	t.Helper()
	antes := reloj
	reloj = func() time.Time { return ahoraFijo }
	t.Cleanup(func() { reloj = antes })
	d := servirMotor(t, motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(m.servir)))
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{s}, Licencia: sobreLicencia(caduca)}
	estados, _ := Aplicar(context.Background(), d, o, p)
	return estados
}

func TestCaducadaNoDespliegaNiCambiaLasDePago(t *testing.T) {
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
	// Nueva: no se crea.
	m := &motorLicencia{}
	e := aplicarCon(t, m, o, "2027-01-01T00:00:00Z", trampaDePago("t1"))
	if len(m.creados) != 0 || !strings.HasPrefix(e[0].Donde, "error: the Cloud license has expired") {
		t.Fatalf("con la licencia caducada no se despliega una de pago: %+v creados=%d", e, len(m.creados))
	}
	// Cambiada y en marcha: sigue la de antes, sin tocarla.
	m = &motorLicencia{existentes: []map[string]any{{
		"Id": "c-t1", "State": "running",
		"Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaHuella: "otra"},
	}}}
	e = aplicarCon(t, m, o, "2027-01-01T00:00:00Z", trampaDePago("t1"))
	if len(m.creados) != 0 || len(m.borrados) != 0 || !strings.Contains(e[0].Donde, "it keeps running as before") {
		t.Fatalf("una de pago en marcha no se cambia con la licencia caducada: %+v creados=%d borrados=%v", e, len(m.creados), m.borrados)
	}
	// Una gratis (licencia=false) sí se despliega.
	m = &motorLicencia{}
	gratis := trampa("t2", "r/gratis@sha256:2")
	no := false
	gratis.Licencia = &no
	aplicarCon(t, m, o, "2027-01-01T00:00:00Z", gratis)
	if len(m.creados) != 1 {
		t.Fatal("una gratis no depende de la licencia")
	}
}

// Caducada, una de pago que se cayó con la misma configuración se rehace: la trampa decide
// si arranca (hasta funcionaHasta, firmado en la licencia). Ya no se le pasa ninguna fecha.
func TestCaducadaSeRehaceSinFechaDelSensor(t *testing.T) {
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
	s := trampaDePago("t1")
	h := huellaDe(t, o, s)
	m := &motorLicencia{existentes: []map[string]any{{
		"Id": "c-t1", "State": "exited",
		"Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaHuella: h, "sugardaddy.desplegada": "2026-11-01T00:00:00Z"},
	}}}
	aplicarCon(t, m, o, "2027-01-01T00:00:00Z", s)
	if len(m.creados) != 1 {
		t.Fatalf("se rehace con la misma configuración: %+v", m.creados)
	}
	if contieneConPrefijo(entornoDe(m.creados[0]), "SUGARDADDY_LICENCIA_DESPLEGADA=") {
		t.Fatal("el sensor ya no pasa una fecha de despliegue: la trampa no la mira")
	}
	if _, si := m.creados[0]["Labels"].(map[string]any)["sugardaddy.desplegada"]; si {
		t.Fatal("ni la etiqueta de despliegue")
	}
}

func TestLicenciaCaducadaSeLeeSinVerificar(t *testing.T) {
	if !licenciaCaducada(sobreLicencia("2027-01-01T00:00:00Z"), ahoraFijo) {
		t.Fatal("caducada")
	}
	if licenciaCaducada(sobreLicencia("2028-01-01T00:00:00Z"), ahoraFijo) {
		t.Fatal("vigente")
	}
	for _, raro := range []string{"", "{", `{"licencia":"no-json"}`, `{"licencia":"{\"caduca\":\"ayer\"}"}`} {
		if licenciaCaducada(json.RawMessage(raro), ahoraFijo) {
			t.Fatalf("lo que no se entiende no está caducado: %q", raro)
		}
	}
}

func contiene(l []string, x string) bool {
	for _, v := range l {
		if v == x {
			return true
		}
	}
	return false
}

func contieneConPrefijo(l []string, p string) bool {
	for _, v := range l {
		if strings.HasPrefix(v, p) {
			return true
		}
	}
	return false
}
