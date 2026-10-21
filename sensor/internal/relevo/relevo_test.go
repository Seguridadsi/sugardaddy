package relevo

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
)

var ahora = time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)

type escenario struct {
	pub        string
	priv       ed25519.PrivateKey
	etiquetaOk bool   // el actualizador ya lleva la etiqueta nueva
	anterior   bool   // hay un contenedor «-anterior»
	arrancado  string // cuándo arrancó el sensor
	mu         sync.Mutex
	llamadas   []string
	creado     map[string]any
}

func (e *escenario) apuntar(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.llamadas = append(e.llamadas, s)
}

func (e *escenario) hizo(prefijo string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, l := range e.llamadas {
		if strings.HasPrefix(l, prefijo) {
			return true
		}
	}
	return false
}

func (e *escenario) servir(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	e.apuntar(r.Method + " " + p)
	responder := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	etiquetaAct := map[string]string{"com.docker.compose.project": "sugardaddy", "com.docker.compose.service": "actualizador"}
	if e.etiquetaOk {
		etiquetaAct[actualizador.EtiquetaServicio] = "actualizador"
	}
	switch {
	case r.Method == http.MethodGet && p == "/containers/json":
		lista := []map[string]any{
			{"Id": "sen", "Names": []string{"/sugardaddy-sensor-1"}, "State": "running", "Labels": map[string]string{"com.docker.compose.project": "sugardaddy", "com.docker.compose.service": "sensor"}},
			{"Id": "con", "Names": []string{"/sugardaddy-consola-1"}, "State": "running", "Labels": map[string]string{"com.docker.compose.project": "sugardaddy", "com.docker.compose.service": "consola"}},
			{"Id": "act", "Names": []string{"/sugardaddy-actualizador-1"}, "State": "running", "Labels": etiquetaAct},
		}
		if e.anterior {
			lista = append(lista, map[string]any{"Id": "ant", "Names": []string{"/sugardaddy-consola-1-anterior"}, "State": "exited", "Labels": map[string]string{"com.docker.compose.project": "sugardaddy"}})
		}
		responder(lista)
	case p == "/containers/sen/json":
		responder(map[string]any{"Config": map[string]any{"Labels": map[string]string{"com.docker.compose.project": "sugardaddy"}}, "State": map[string]any{"StartedAt": e.arrancado}})
	case p == "/containers/act/json":
		responder(map[string]any{
			"Config": map[string]any{"Labels": etiquetaAct, "Env": []string{"PUBLICACION_CLAVE_PUBLICA=" + e.pub, "REGISTRO=r.example", "REGISTRO_USUARIO=u", "REGISTRO_TOKEN=t"}},
			"Mounts": []map[string]any{{"Source": "/opt/sugardaddy", "Destination": "/nodo"}},
		})
	case strings.HasPrefix(p, "/containers/sugardaddy-aplicar"):
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"no existe"}`))
	case p == "/containers/create":
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &e.creado)
		responder(map[string]string{"Id": "aux"})
	default:
		_, _ = w.Write([]byte(`{}`))
	}
}

type consolaFalsa struct {
	oferta     *Oferta
	informado  []string
	sinCerrojo bool // otro sensor se adelantó
}

func (c *consolaFalsa) Relevo(context.Context) (*Oferta, error) { return c.oferta, nil }
func (c *consolaFalsa) InformarRelevo(_ context.Context, estado, _ string) error {
	c.informado = append(c.informado, estado)
	if estado == "aplicando" && c.sinCerrojo {
		return errors.New("relevo: 409")
	}
	return nil
}

func preparar(t *testing.T, e *escenario, version string, firmaMala bool) (*Relevo, *consolaFalsa) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	e.pub, e.priv = base64.StdEncoding.EncodeToString(der), priv
	if e.arrancado == "" {
		e.arrancado = ahora.Add(-10 * time.Minute).Format(time.RFC3339Nano)
	}
	base, err := os.MkdirTemp("", "rl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker29_3, http.HandlerFunc(e.servir))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })

	rel := actualizador.Release{
		Version: version, Servicios: map[string]string{"consola": "r.example/c@sha256:" + strings.Repeat("a", 64)},
		Actualizador: "r.example/a@sha256:" + strings.Repeat("b", 64),
		Nodo:         &actualizador.Configuracion{Ficheros: map[string]string{"compose.yml": "services: {}\n"}},
	}
	b, _ := json.Marshal(rel)
	firma := ed25519.Sign(priv, b)
	if firmaMala {
		firma[0] ^= 1
	}
	c := &consolaFalsa{oferta: &Oferta{Version: version, Release: actualizador.ReleaseFirmada{Release: string(b), Firma: base64.StdEncoding.EncodeToString(firma)}}}
	return &Relevo{
		Docker: docker.Nuevo(sock), Consola: c, Version: "0.12.0", Datos: t.TempDir(), Socket: sock,
		Log: func(string, ...any) {}, Ahora: func() time.Time { return ahora },
		Hostname:  func() (string, error) { return "sen", nil },
		Mountinfo: func() ([]byte, error) { return nil, os.ErrNotExist },
	}, c
}

func TestRelevoLanzaElAuxiliar(t *testing.T) {
	e := &escenario{}
	r, c := preparar(t, e, "0.12.0", false)
	if err := r.Intentar(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !e.hizo("POST /containers/act/stop") {
		t.Fatal("hay que parar el actualizador viejo antes de lanzar el auxiliar")
	}
	if e.creado == nil {
		t.Fatal("no se ha creado el auxiliar")
	}
	hc := e.creado["HostConfig"].(map[string]any)
	if hc["NetworkMode"] != "bridge" || !strings.Contains(strings.Join(aTextos(hc["Binds"]), " "), "/opt/sugardaddy:/opt/sugardaddy") {
		t.Fatalf("auxiliar mal montado: %v", hc)
	}
	env := strings.Join(aTextos(e.creado["Env"]), " ")
	if !strings.Contains(env, "APLICAR_MODO=nodo") || !strings.Contains(env, "APLICAR_DIR=/opt/sugardaddy") || !strings.Contains(env, "APLICAR_RED=sugardaddy_nodo") {
		t.Fatalf("entorno del auxiliar: %s", env)
	}
	if len(c.informado) == 0 || c.informado[0] != "aplicando" {
		t.Fatalf("hay que avisar a la consola: %v", c.informado)
	}
	// Y no se repite enseguida.
	e.creado = nil
	if err := r.Intentar(context.Background()); err != nil || e.creado != nil {
		t.Fatal("tras un intento hay que esperar")
	}
}

func TestRelevoNoToca(t *testing.T) {
	casos := map[string]func(*escenario){
		"el actualizador ya es el nuevo": func(e *escenario) { e.etiquetaOk = true },
		"un cambio 0.11 a medias":        func(e *escenario) { e.anterior = true },
		"el sensor acaba de arrancar":    func(e *escenario) { e.arrancado = ahora.Add(-30 * time.Second).Format(time.RFC3339Nano) },
	}
	for nombre, ajustar := range casos {
		t.Run(nombre, func(t *testing.T) {
			e := &escenario{}
			ajustar(e)
			r, _ := preparar(t, e, "0.12.0", false)
			if err := r.Intentar(context.Background()); err != nil {
				t.Fatal(err)
			}
			if e.hizo("POST /containers/act/stop") || e.creado != nil {
				t.Fatal("no tenía que tocar nada")
			}
		})
	}
}

func TestRelevoSinPermisoDeLaConsola(t *testing.T) {
	e := &escenario{}
	r, c := preparar(t, e, "0.12.0", false)
	c.oferta = nil
	if err := r.Intentar(context.Background()); err != nil || e.hizo("POST /containers/act/stop") {
		t.Fatal("sin permiso de la consola no se toca nada")
	}
}

func TestRelevoSinCerrojoNoTocaNada(t *testing.T) {
	e := &escenario{}
	r, c := preparar(t, e, "0.12.0", false)
	c.sinCerrojo = true
	if err := r.Intentar(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.hizo("POST /containers/act/stop") || e.creado != nil {
		t.Fatal("sin el cerrojo de la consola no se toca nada")
	}
}

func TestRelevoRechazaVersionesQueNoSonLaSuya(t *testing.T) {
	for nombre, c := range map[string]struct {
		version string
		mala    bool
	}{"otra versión": {"0.13.0", false}, "firma mala": {"0.12.0", true}} {
		t.Run(nombre, func(t *testing.T) {
			e := &escenario{}
			r, _ := preparar(t, e, c.version, c.mala)
			if err := r.Intentar(context.Background()); err == nil {
				t.Fatal("tenía que rechazarla")
			}
			if e.hizo("POST /containers/act/stop") || e.creado != nil {
				t.Fatal("no tenía que tocar nada")
			}
		})
	}
}

func aTextos(v any) []string {
	var r []string
	l, _ := v.([]any)
	for _, x := range l {
		r = append(r, x.(string))
	}
	return r
}

func TestIdPropioPorMontajesYNoPorHostname(t *testing.T) {
	id := strings.Repeat("ab", 32)
	r := &Relevo{
		// El hostname es el del contenedor anterior: lo copió el actualizador 0.11.
		Hostname: func() (string, error) { return "a2f13048217d", nil },
		Mountinfo: func() ([]byte, error) {
			return []byte("1234 567 0:89 /var/lib/docker/containers/" + id + "/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw\n"), nil
		},
	}
	if got := r.idPropio(); got != id {
		t.Fatalf("idPropio = %q", got)
	}
	r.Mountinfo = func() ([]byte, error) { return nil, os.ErrNotExist }
	if got := r.idPropio(); got != "a2f13048217d" {
		t.Fatalf("sin montajes, el hostname: %q", got)
	}
}
