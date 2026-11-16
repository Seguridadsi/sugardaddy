package actualizador

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
)

// heredoc saca de instalar.sh el texto entre «cat > <ruta> <<MARCA» y «MARCA».
func heredoc(t *testing.T, ruta, marca string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "despliegue", "nodo", "instalar.sh"))
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`(?s)cat > ` + regexp.QuoteMeta(ruta) + ` <<'?` + marca + `'?\n(.*?)\n\t*` + marca + `\n`)
	m := re.FindSubmatch(b)
	if m == nil {
		t.Fatalf("instalar.sh no longer writes %s", ruta)
	}
	// Dentro de un if, cada línea lleva tabuladores delante solo en el guion, no en el heredoc.
	return string(m[1]) + "\n"
}

// El perfil y las unidades que pone el auxiliar son los de instalar.sh, letra por letra.
func TestElAislamientoEsElDeInstalar(t *testing.T) {
	if got := heredoc(t, "/etc/apparmor.d/sugardaddy-trampa", "PERFIL"); got != string(PerfilAppArmor) {
		t.Fatalf("sensor/internal/actualizador/scripts/sugardaddy-trampa.apparmor is not the profile in despliegue/nodo/instalar.sh:\n%s", got)
	}
	servicio, path := UnidadesDiscos("/opt/sugardaddy/datos/sensor")
	inst := strings.ReplaceAll(heredoc(t, "/etc/systemd/system/sd-discos.service", "UNIDAD"), "$DIR/datos/sensor", "/opt/sugardaddy/datos/sensor")
	if inst != servicio {
		t.Fatalf("sd-discos.service differs from instalar.sh:\n%s\n---\n%s", inst, servicio)
	}
	if inst := heredoc(t, "/etc/systemd/system/sd-discos.path", "UNIDAD"); inst != path {
		t.Fatalf("sd-discos.path differs from instalar.sh:\n%s\n---\n%s", inst, path)
	}
}

func TestRutaDatosValida(t *testing.T) {
	for p, ok := range map[string]bool{
		"/opt/sugardaddy/datos/sensor": true, "/srv/sd_1/datos": true,
		"": false, "datos": false, "/a b": false, "/a/../b": false, "/a/": false, "/a\nExecStart=/bin/sh": false, "/a;rm": false,
	} {
		if RutaDatosValida(p) != ok {
			t.Errorf("%q: %v", p, !ok)
		}
	}
}

type maquinaFalsa struct {
	ordenes   []string
	fallar    map[string]bool
	sinOrdena map[string]bool
}

func (m *maquinaFalsa) anfitrion(raiz string) Anfitrion {
	return Anfitrion{Raiz: raiz,
		Ejecutar: func(n string, args ...string) ([]byte, error) {
			o := strings.Join(append([]string{n}, args...), " ")
			m.ordenes = append(m.ordenes, o)
			if m.fallar[n] {
				return []byte("boom"), errors.New("exit status 1")
			}
			return nil, nil
		},
		Hay: func(n string) bool { return !m.sinOrdena[n] },
	}
}

func raizFalsa(t *testing.T, apparmor, systemd, binario bool) string {
	t.Helper()
	raiz := t.TempDir()
	if apparmor {
		_ = os.MkdirAll(filepath.Join(raiz, "sys/kernel/security/apparmor"), 0o755)
	}
	if systemd {
		_ = os.MkdirAll(filepath.Join(raiz, "run/systemd/system"), 0o755)
	}
	if binario {
		_ = os.MkdirAll(filepath.Join(raiz, "usr/local/lib/sugardaddy"), 0o755)
		_ = os.WriteFile(filepath.Join(raiz, "usr/local/lib/sugardaddy/sd-discos"), []byte("bin"), 0o755)
	}
	return raiz
}

func TestPrepararAnfitrionComoInstalar(t *testing.T) {
	raiz := raizFalsa(t, true, true, true)
	m := &maquinaFalsa{}
	r := m.anfitrion(raiz).Preparar("/opt/sugardaddy/datos/sensor")
	if r.AppArmor != PiezaPuesta || r.Discos != PiezaPuesta || len(r.Detalle) != 0 {
		t.Fatalf("%+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(raiz, rutaPerfil)); !bytes.Equal(b, PerfilAppArmor) {
		t.Fatal("profile not written")
	}
	servicio, _ := UnidadesDiscos("/opt/sugardaddy/datos/sensor")
	if b, _ := os.ReadFile(filepath.Join(raiz, rutaUnidad)); string(b) != servicio {
		t.Fatal("unit not written")
	}
	if _, err := os.Stat(filepath.Join(raiz, marcaInstalado)); err != nil {
		t.Fatal("sd-motor needs the «instalado» mark")
	}
	if fi, _ := os.Stat(filepath.Join(raiz, BuzonDiscos)); fi.Mode().Perm() != 0o700 {
		t.Fatalf("mailbox %v", fi.Mode())
	}
	esperado := []string{"apparmor_parser -r -W " + rutaPerfil, "systemctl daemon-reload", "systemctl enable --now sd-discos.path"}
	if strings.Join(m.ordenes, "|") != strings.Join(esperado, "|") {
		t.Fatalf("%v", m.ordenes)
	}
	// Otra vez: igual, sin recargar systemd (nada cambió).
	m.ordenes = nil
	if r := m.anfitrion(raiz).Preparar("/opt/sugardaddy/datos/sensor"); r.AppArmor != PiezaPuesta || r.Discos != PiezaPuesta {
		t.Fatalf("%+v", r)
	}
	for _, o := range m.ordenes {
		if o == "systemctl daemon-reload" {
			t.Fatal("nothing changed: no daemon-reload")
		}
	}
}

func TestPrepararAnfitrionSinAppArmorNiSystemd(t *testing.T) {
	raiz := raizFalsa(t, false, false, true)
	m := &maquinaFalsa{}
	r := m.anfitrion(raiz).Preparar("/d/sensor")
	if r.AppArmor != PiezaNoAplica || r.Discos != PiezaNoAplica || len(m.ordenes) != 0 {
		t.Fatalf("%+v %v", r, m.ordenes)
	}
	if _, err := os.Stat(filepath.Join(raiz, "etc")); err == nil {
		t.Fatal("nothing is written on a machine without AppArmor or systemd")
	}
	// Con la carpeta de AppArmor pero sin apparmor_parser, tampoco.
	raiz = raizFalsa(t, true, true, true)
	m = &maquinaFalsa{sinOrdena: map[string]bool{"apparmor_parser": true, "systemctl": true}}
	if r := m.anfitrion(raiz).Preparar("/d/sensor"); r.AppArmor != PiezaNoAplica || r.Discos != PiezaNoAplica {
		t.Fatalf("%+v", r)
	}
}

func TestPrepararAnfitrionDiceLoQueFalla(t *testing.T) {
	raiz := raizFalsa(t, true, true, false)
	m := &maquinaFalsa{fallar: map[string]bool{"apparmor_parser": true}}
	r := m.anfitrion(raiz).Preparar("/d/sensor")
	if r.AppArmor != PiezaFallo || r.Discos != PiezaFallo || len(r.Detalle) != 2 {
		t.Fatalf("%+v", r)
	}
	if _, err := os.Stat(filepath.Join(raiz, marcaInstalado)); err == nil {
		t.Fatal("without the binary there is no «instalado»")
	}
	raiz = raizFalsa(t, false, true, true)
	m = &maquinaFalsa{fallar: map[string]bool{"systemctl": true}}
	if r := m.anfitrion(raiz).Preparar("/d/sensor"); r.Discos != PiezaFallo || !strings.Contains(strings.Join(r.Detalle, " "), "boom") {
		t.Fatalf("%+v", r)
	}
	if _, err := os.Stat(filepath.Join(raiz, marcaInstalado)); err == nil {
		t.Fatal("systemd failed: no «instalado»")
	}
	if r := (&maquinaFalsa{}).anfitrion(raizFalsa(t, false, true, true)).Preparar("/d/../etc"); r.Discos != PiezaFallo {
		t.Fatalf("%+v", r)
	}
}

func TestLeerResultadoAnfitrion(t *testing.T) {
	if _, ok := LeerResultadoAnfitrion("algo\nnada\n"); ok {
		t.Fatal("no line")
	}
	r, ok := LeerResultadoAnfitrion("ruido\n" + `{"aislamiento":{"apparmor":"puesta","discos":"fallo","detalle":["x"]}}` + "\n")
	if !ok || r.AppArmor != PiezaPuesta || r.Discos != PiezaFallo || r.Detalle[0] != "x" {
		t.Fatalf("%+v %v", r, ok)
	}
}

// dockerAislamiento simula Docker para el auxiliar: el contenedor de la máquina
// contesta con salida, y la prueba del perfil sale con codigoPerfil.
func dockerAislamiento(t *testing.T, salida string, codigoPerfil int, creados map[string]map[string]any) *docker.Cliente {
	t.Helper()
	base, err := os.MkdirTemp("", "sd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/containers/create"):
			var c map[string]any
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &c)
			mu.Lock()
			creados[r.URL.Query().Get("name")] = c
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"Id": r.URL.Query().Get("name")})
		case strings.HasSuffix(p, NombrePruebaAppArmor+"/wait"):
			_ = json.NewEncoder(w).Encode(map[string]int{"StatusCode": codigoPerfil})
		case strings.HasSuffix(p, "/wait"):
			_, _ = w.Write([]byte(`{"StatusCode":0}`))
		case strings.HasSuffix(p, NombreAislarAnfitrion+"/logs"):
			cab := make([]byte, 8)
			cab[0] = 1
			binary.BigEndian.PutUint32(cab[4:], uint32(len(salida)))
			_, _ = w.Write(append(cab, salida...))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case strings.Contains(p, "/images/"):
			_, _ = w.Write([]byte(`{"Id":"sha256:1"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return docker.Nuevo(sock)
}

func nodoParaAislar(t *testing.T, env string) string {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "versiones.env"), []byte("SENSOR_IMAGEN=r/sensor@sha256:1\nACTUALIZADOR_IMAGEN=r/actualizador@sha256:2\n"), 0o644)
	return dir
}

func TestAsegurarAislamientoEnUnNodoDeAntes(t *testing.T) {
	dir := nodoParaAislar(t, "DATOS=/opt/sugardaddy/datos\n")
	creados := map[string]map[string]any{}
	a := &Aplicacion{Dir: dir, Modo: ModoNodo, Log: func(string, ...any) {},
		Docker: dockerAislamiento(t, `{"aislamiento":{"apparmor":"puesta","discos":"puesta"}}`+"\n", 0, creados)}
	if aviso := a.asegurarAislamiento(context.Background()); aviso != "" {
		t.Fatal(aviso)
	}
	env, _ := LeerEnv(filepath.Join(dir, ".env"))
	if env["TRAMPAS_APPARMOR"] != NombrePerfilAppArmor {
		t.Fatalf("%v", env)
	}
	m := creados[NombreAislarAnfitrion]
	h := m["HostConfig"].(map[string]any)
	if m["Image"] != "r/actualizador@sha256:2" || m["Cmd"].([]any)[0] != "aislar-anfitrion" ||
		m["Env"].([]any)[0] != "AISLAR_DATOS=/opt/sugardaddy/datos/sensor" ||
		h["Privileged"] != true || h["PidMode"] != "host" || h["NetworkMode"] != "none" {
		t.Fatalf("%v", m)
	}
	c := creados[NombreCopiarSdDiscos]
	if c["Image"] != "r/sensor@sha256:1" || c["HostConfig"].(map[string]any)["Binds"].([]any)[0] != "/usr/local/lib/sugardaddy:/salida" {
		t.Fatalf("%v", c)
	}
	p := creados[NombrePruebaAppArmor]["HostConfig"].(map[string]any)["SecurityOpt"].([]any)
	if p[1] != "apparmor="+NombrePerfilAppArmor {
		t.Fatalf("%v", p)
	}
}

// Un perfil que Docker no aplica no se deja en .env (haría fallar cada trampa), y se dice.
func TestAsegurarAislamientoQuitaUnPerfilQueDockerNoAplica(t *testing.T) {
	dir := nodoParaAislar(t, "DATOS=/d\nTRAMPAS_APPARMOR=sugardaddy-trampa\n")
	a := &Aplicacion{Dir: dir, Modo: ModoSensorRemoto, Log: func(string, ...any) {},
		Docker: dockerAislamiento(t, `{"aislamiento":{"apparmor":"fallo","discos":"no-aplica","detalle":["apparmor_parser: exit status 1"]}}`, 1, map[string]map[string]any{})}
	aviso := a.asegurarAislamiento(context.Background())
	if !strings.Contains(aviso, "apparmor_parser") || !strings.Contains(aviso, "seccomp only") {
		t.Fatal(aviso)
	}
	env, _ := LeerEnv(filepath.Join(dir, ".env"))
	if v, ok := env["TRAMPAS_APPARMOR"]; !ok || v != "" {
		t.Fatalf("%v", env)
	}
}

func TestAsegurarAislamientoSinSalidaEsUnAviso(t *testing.T) {
	dir := nodoParaAislar(t, "DATOS=/d\n")
	a := &Aplicacion{Dir: dir, Modo: ModoNodo, Log: func(string, ...any) {},
		Docker: dockerAislamiento(t, "exec format error", 0, map[string]map[string]any{})}
	if aviso := a.asegurarAislamiento(context.Background()); !strings.Contains(aviso, "could not be prepared") {
		t.Fatal(aviso)
	}
	if env, _ := LeerEnv(filepath.Join(dir, ".env")); env["TRAMPAS_APPARMOR"] != "" {
		t.Fatalf("%v", env)
	}
	// Quien no lo quiere (AISLAMIENTO_ANFITRION=no) no lanza nada.
	creados := map[string]map[string]any{}
	dir = nodoParaAislar(t, "DATOS=/d\nAISLAMIENTO_ANFITRION=no\n")
	a = &Aplicacion{Dir: dir, Modo: ModoNodo, Log: func(string, ...any) {}, Docker: dockerAislamiento(t, "", 0, creados)}
	if aviso := a.asegurarAislamiento(context.Background()); aviso != "" || len(creados) != 0 {
		t.Fatal(aviso, creados)
	}
}

// dockerRedes: la red de trampas de antes (sin nombre de puente) con lo que se le diga dentro.
func dockerRedes(t *testing.T, etiquetas string, borrados *[]string) *docker.Cliente {
	t.Helper()
	base, err := os.MkdirTemp("", "sd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodDelete:
			*borrados = append(*borrados, p[strings.LastIndex(p, "/")+1:])
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(p, "/networks/sugardaddy-trampas-aisladas"):
			_, _ = w.Write([]byte(`{"Driver":"bridge","Options":{"com.docker.network.bridge.enable_icc":"false"},"Containers":{"c1":{}}}`))
		case strings.HasSuffix(p, "/containers/c1/json"):
			_, _ = w.Write([]byte(`{"Config":{"Labels":` + etiquetas + `}}`))
		case strings.HasSuffix(p, "/containers/json"):
			_, _ = w.Write([]byte(`[{"Id":"cap1","Names":["/sd_captura_s_t"],"Labels":{"sugardaddy.captura":"t"}}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"no such network"}`))
		}
	}))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return docker.Nuevo(sock)
}

func TestRehacerRedesTrampasDeAntes(t *testing.T) {
	dir := t.TempDir()
	var borrados []string
	a := &Aplicacion{Dir: dir, Modo: ModoNodo, Proyecto: "sugardaddy", Compose: composeFalso(t, dir), Log: func(string, ...any) {},
		Docker: dockerRedes(t, `{"sugardaddy.trampa":"redis"}`, &borrados)}
	if aviso := a.rehacerRedesTrampas(context.Background()); aviso != "" {
		t.Fatal(aviso)
	}
	llamadas, _ := os.ReadFile(filepath.Join(dir, ".llamadas"))
	if !strings.Contains(string(llamadas), "stop sensor") {
		t.Fatalf("the sensor is stopped first: %s", llamadas)
	}
	if strings.Join(borrados, ",") != "c1,sugardaddy-trampas-aisladas,cap1" {
		t.Fatalf("%v", borrados)
	}
	// Con algo que no es del sensor dentro, no se toca y se dice.
	borrados = nil
	a.Docker = dockerRedes(t, `{"otra.cosa":"x"}`, &borrados)
	if aviso := a.rehacerRedesTrampas(context.Background()); !strings.Contains(aviso, "not a decoy") || len(borrados) != 0 {
		t.Fatal(aviso, borrados)
	}
}
