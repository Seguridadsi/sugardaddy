package despliegue

import (
	"encoding/json"
	"net/netip"
	"slices"
	"strings"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/intermediario"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Lo que el sensor pide crear lo acepta sd-motor (docs/diseno/aislamiento-trampas.md):
// con disco y sin él, con licencia, ficheros, escribibles, VOLUME de la imagen y en
// modo IP propia con captura. Si un cambio del despliegue añade un campo que
// sd-motor no conoce, esta prueba lo dice antes que el banco.
func TestSdMotorAceptaLoQueCreaElSensor(t *testing.T) {
	if intermediario.RedTrampas != redTrampas || intermediario.PuenteTrampas != PuenteTrampas || intermediario.OpcionNombrePuente != docker.OpcionNombrePuente ||
		!strings.HasPrefix(PuenteTrampas, cortafuegos.PrefijoPuenteTrampas) || !strings.HasPrefix(PuenteConSalida, cortafuegos.PrefijoPuenteTrampas) {
		t.Fatal("la red de trampas, el nombre de su puente y la regla de SEN-5 tienen que decir lo mismo en sd-motor, el sensor y el cortafuegos")
	}
	var m plan.Manifiesto
	if err := json.Unmarshal([]byte(`{
		"id": "redis",
		"contenedor": {"imagen": "r/redis@sha256:aaaa", "registros": "/log", "escribibles": ["/data"],
			"ficheros": [{"destino": "/etc/redis.conf", "contenido": "port ${puerto}"}],
			"puertos": [{"interno": 6379, "expuesto": "${puerto}", "protocolo": "tcp"}]},
		"aislamiento": {"soloLectura": true, "cpu": 0.5, "memoriaMb": 64}
	}`), &m); err != nil {
		t.Fatal(err)
	}
	datos := t.TempDir()
	o := Opciones{Datos: datos, Escucha: "0.0.0.0"}
	s := plan.TrampaPlan{ID: "cache-1", Parametros: map[string]any{"puerto": 6379}, Manifiesto: m}
	reglas := intermediario.Reglas{
		Datos:           datos,
		UsuarioImagen:   func(string) (string, error) { return "65534", nil },
		VolumenesImagen: func(string) ([]string, error) { return []string{"/var/lib/extra"}, nil },
	}
	validar := func(nombre string, cfg map[string]any, m plan.Manifiesto) {
		t.Helper()
		b, _ := json.Marshal(cfg)
		var ida map[string]any
		_ = json.Unmarshal(b, &ida)
		if _, err := reglas.Validar(intermediario.Peticion{Config: ida, Manifiesto: &m}); err != nil {
			t.Errorf("%s: sd-motor rechaza lo que crea el sensor: %v", nombre, err)
		}
	}
	for _, conDisco := range []bool{false, true} {
		cfg, _, err := config(o, "local", datos+"/licencia.json", s, conDisco, []string{"/var/lib/extra"})
		if err != nil {
			t.Fatal(err)
		}
		validar(map[bool]string{false: "sin disco", true: "con disco"}[conDisco], cfg, m)
	}

	// IP propia con captura: la trampa ni es root ni tiene NET_RAW; va SD_ENLACE.
	var red plan.Manifiesto
	if err := json.Unmarshal([]byte(`{
		"id": "darknet",
		"contenedor": {"imagen": "r/darknet@sha256:cccc", "registros": "/log"},
		"red": {"modo": "ip-propia", "capturar": "10.0.0.0/24"},
		"aislamiento": {"soloLectura": true, "cpu": 0.25, "memoriaMb": 64}
	}`), &red); err != nil {
		t.Fatal(err)
	}
	o.RedPropia = &RedPropia{Puente: "sd-banco-ip-propia", IPFija: "172.31.201.10", Rango: netip.MustParsePrefix("172.31.201.0/24")}
	sr := plan.TrampaPlan{ID: "darknet", Manifiesto: red}
	cfg, _, err := config(o, "local", "", sr, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := cfg["HostConfig"].(map[string]any)
	if h["CapAdd"] != nil || cfg["User"] != nil {
		t.Fatalf("la trampa de enlace no lleva NET_RAW ni root: CapAdd=%v User=%v", h["CapAdd"], cfg["User"])
	}
	env := cfg["Env"].([]string)
	if !slices.Contains(env, "SD_ENLACE="+EnlaceAcompanante) || !slices.ContainsFunc(env, func(e string) bool { return strings.HasPrefix(e, "SD_RED_BPF=") }) {
		t.Fatalf("entorno de la trampa de enlace: %v", env)
	}
	validar("IP propia con captura", cfg, red)
}

func TestCodigoMotor(t *testing.T) {
	if c := codigoMotor(&docker.ErrAPI{Codigo: 403, Mensaje: "sd-motor: decoys get no added capabilities [motor.rechazo]"}); c != "motor.rechazo" {
		t.Fatal(c)
	}
	if c := codigoMotor(&docker.ErrAPI{Codigo: 404, Mensaje: "no such image"}); c != "" {
		t.Fatal(c)
	}
}
