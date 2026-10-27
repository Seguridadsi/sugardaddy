package despliegue

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

func TestCadaContenedorLlevaSuSensor(t *testing.T) {
	s := plan.TrampaPlan{
		ID:         "ssh-backup",
		Parametros: map[string]any{"nombre": "srv01"},
		Manifiesto: plan.Manifiesto{
			Contenedor:  &plan.Contenedor{Imagen: "x@sha256:1", Entorno: map[string]any{"H": "${nombre}"}, Escribibles: []string{"/var"}, Registros: "/log"},
			Aislamiento: &plan.Aislamiento{SoloLectura: true, CPU: 0.5, MemoriaMb: 64},
		},
	}
	cfg, _, err := config(Opciones{Datos: "/d", Escucha: "127.0.0.1"}, "servidores", "", s)
	if err != nil {
		t.Fatal(err)
	}
	et := cfg["Labels"].(map[string]string)
	if et[etiquetaSensor] != "servidores" || et[etiquetaTrampa] != "ssh-backup" {
		t.Fatalf("etiquetas: %v", et)
	}
	montajes := cfg["HostConfig"].(map[string]any)["Mounts"].([]map[string]any)
	if montajes[1]["Source"] != "sd-servidores-ssh-backup-0" {
		t.Fatalf("el volumen debe llevar el sensor para no chocar con otro: %v", montajes[1]["Source"])
	}
	if cfg["Env"].([]string)[0] != "H=srv01" {
		t.Fatalf("parámetro no sustituido: %v", cfg["Env"])
	}
	hc := cfg["HostConfig"].(map[string]any)
	if hc["ReadonlyRootfs"] != true || hc["CapDrop"].([]string)[0] != "ALL" {
		t.Fatalf("el endurecimiento mínimo no puede faltar: %v", hc)
	}
}

func TestLicenciaSeMontaDeSoloLectura(t *testing.T) {
	s := plan.TrampaPlan{
		ID: "mysql-1",
		Manifiesto: plan.Manifiesto{
			Contenedor:  &plan.Contenedor{Imagen: "x@sha256:1", Registros: "/log"},
			Aislamiento: &plan.Aislamiento{CPU: 0.5, MemoriaMb: 64},
		},
	}
	// Con licencia: va montada de solo lectura en la ruta fija.
	cfg, _, err := config(Opciones{Datos: "/d", Escucha: "127.0.0.1"}, "s", "/d/licencia.json", s)
	if err != nil {
		t.Fatal(err)
	}
	montajes := cfg["HostConfig"].(map[string]any)["Mounts"].([]map[string]any)
	var lic map[string]any
	for _, m := range montajes {
		if m["Target"] == rutaLicenciaTrampa {
			lic = m
		}
	}
	if lic == nil {
		t.Fatalf("la licencia debería montarse en %s: %v", rutaLicenciaTrampa, montajes)
	}
	if lic["Source"] != "/d/licencia.json" || lic["ReadOnly"] != true || lic["Type"] != "bind" {
		t.Fatalf("la licencia tiene que entrar de solo lectura por bind: %v", lic)
	}
	// Sin licencia: no se monta nada (edición gratis).
	cfg2, _, _ := config(Opciones{Datos: "/d", Escucha: "127.0.0.1"}, "s", "", s)
	for _, m := range cfg2["HostConfig"].(map[string]any)["Mounts"].([]map[string]any) {
		if m["Target"] == rutaLicenciaTrampa {
			t.Fatal("sin licencia no se debe montar nada")
		}
	}
}

func TestPuertosEntornoYFicherosDelFormulario(t *testing.T) {
	var c plan.Contenedor
	if err := json.Unmarshal([]byte(`{
		"imagen": "x@sha256:1", "registros": "/log",
		"puertos": [
			{"interno": 2222, "expuesto": "${ssh}", "protocolo": "tcp"},
			{"interno": 2223, "expuesto": "${tel}", "protocolo": "tcp", "si": "telnet"},
			{"interno": 80, "expuesto": 80, "protocolo": "tcp"}
		],
		"entorno": {"V": {"segun": "sistema", "valores": {"debian-12": "OpenSSH_9.2", "centos-7": "OpenSSH_7.4"}}},
		"ficheros": [{"destino": "/etc/sd/userdb.txt", "contenido": "${accesos}"}]
	}`), &c); err != nil {
		t.Fatal(err)
	}
	datos := t.TempDir()
	s := plan.TrampaPlan{
		ID:         "ssh-2",
		Parametros: map[string]any{"ssh": float64(22), "tel": float64(23), "telnet": "no", "sistema": "centos-7", "accesos": "root:x:*"},
		Manifiesto: plan.Manifiesto{Contenedor: &c, Aislamiento: &plan.Aislamiento{CPU: 0.5, MemoriaMb: 64}},
	}
	cfg, donde, err := config(Opciones{Datos: datos, Escucha: "0.0.0.0", Desplazar: 2200}, "servidores", "", s)
	if err != nil {
		t.Fatal(err)
	}
	// El del parámetro, tal cual; el fijo, desplazado; Telnet, apagado.
	if len(donde) != 2 || donde[0] != "0.0.0.0:22" || donde[1] != "0.0.0.0:2280" {
		t.Fatalf("puertos: %v", donde)
	}
	if env := cfg["Env"].([]string); len(env) != 1 || env[0] != "V=OpenSSH_7.4" {
		t.Fatalf("entorno según el sistema: %v", env)
	}
	b, err := os.ReadFile(filepath.Join(datos, "config", "ssh-2", "0"))
	if err != nil || string(b) != "root:x:*" {
		t.Fatalf("fichero de accesos: %q %v", b, err)
	}
	antes := huella(cfg)
	s.Parametros["accesos"] = "root:x:!root"
	cfg2, _, _ := config(Opciones{Datos: datos, Escucha: "0.0.0.0", Desplazar: 2200}, "servidores", "", s)
	if huella(cfg2) == antes {
		t.Fatal("cambiar las contraseñas tiene que rehacer el contenedor")
	}
}

// En un Ubuntu de serie el resolvedor del sistema tiene 127.0.0.53:53: un DNS
// en 0.0.0.0:53 no arrancaría («address already in use»). Con EnLaRed, ese
// puerto se publica en la IP de red de la máquina; los demás, como siempre.
func TestPuertoLocalSePublicaEnLaIPDeRed(t *testing.T) {
	var c plan.Contenedor
	if err := json.Unmarshal([]byte(`{
		"imagen": "x@sha256:1", "registros": "/log",
		"puertos": [
			{"interno": 1053, "expuesto": 53, "protocolo": "udp"},
			{"interno": 1123, "expuesto": 123, "protocolo": "udp"}
		]
	}`), &c); err != nil {
		t.Fatal(err)
	}
	s := plan.TrampaPlan{
		ID:         "dns",
		Manifiesto: plan.Manifiesto{Contenedor: &c, Aislamiento: &plan.Aislamiento{CPU: 0.25, MemoriaMb: 128}},
	}
	enLaRed := func(proto string, puerto int) []string {
		if proto == "udp" && puerto == 53 {
			return []string{"10.0.0.4", "192.168.1.4"}
		}
		return nil
	}
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0", EnLaRed: enLaRed}
	cfg, donde, err := config(o, "local", "", s)
	if err != nil {
		t.Fatal(err)
	}
	if quiero := []string{"10.0.0.4:53", "192.168.1.4:53", "0.0.0.0:123"}; !reflect.DeepEqual(donde, quiero) {
		t.Fatalf("donde: %v, quiero %v", donde, quiero)
	}
	enlaces := cfg["HostConfig"].(map[string]any)["PortBindings"].(map[string]any)["1053/udp"].([]map[string]string)
	if len(enlaces) != 2 || enlaces[0]["HostIp"] != "10.0.0.4" || enlaces[1]["HostIp"] != "192.168.1.4" {
		t.Fatalf("enlaces del 53: %v", enlaces)
	}
	// Cambiar dónde se publica rehace el contenedor.
	o.EnLaRed = nil
	cfg2, _, _ := config(o, "local", "", s)
	if huella(cfg2) == huella(cfg) {
		t.Fatal("publicar en otra dirección tiene que rehacer el contenedor")
	}
	// Con una Escucha concreta (no 0.0.0.0) manda la Escucha.
	o.Escucha, o.EnLaRed = "10.9.9.9", enLaRed
	_, donde, _ = config(o, "local", "", s)
	if donde[0] != "10.9.9.9:53" {
		t.Fatalf("con Escucha fija: %v", donde)
	}
}
