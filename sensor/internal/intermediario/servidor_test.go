package intermediario

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// dockerFalso: lo que llega a Docker detrás de sd-motor.
type dockerFalso struct {
	mu        sync.Mutex
	recibidas []string
	creada    map[string]any
}

func (d *dockerFalso) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	d.recibidas = append(d.recibidas, r.Method+" "+r.URL.Path)
	d.mu.Unlock()
	switch {
	case strings.HasSuffix(r.URL.Path, "/containers/json"):
		w.WriteHeader(204)
	case r.URL.Path == "/info":
		_, _ = io.WriteString(w, `{"Runtimes":{"runc":{}}}`)
	case strings.HasSuffix(r.URL.Path, "/containers/sd-local-cache-1/json"):
		_, _ = io.WriteString(w, `{"Config":{"Labels":{"sugardaddy.trampa":"cache-1","sugardaddy.sensor":"local"}}}`)
	case strings.HasSuffix(r.URL.Path, "/containers/sugardaddy-consola-1/json"):
		_, _ = io.WriteString(w, `{"Config":{"Labels":{"com.docker.compose.service":"consola"}}}`)
	case strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json"):
		w.WriteHeader(404)
		_, _ = io.WriteString(w, `{"message":"No such container"}`)
	case strings.Contains(r.URL.Path, "/images/") && strings.HasSuffix(r.URL.Path, "/json"):
		_, _ = io.WriteString(w, `{"Config":{"User":"65534"}}`)
	case strings.HasSuffix(r.URL.Path, "/containers/create"):
		b, _ := io.ReadAll(r.Body)
		d.mu.Lock()
		_ = json.Unmarshal(b, &d.creada)
		d.mu.Unlock()
		_, _ = io.WriteString(w, `{"Id":"abc"}`)
	default:
		w.WriteHeader(204)
	}
}

func arrancar(t *testing.T) (*http.Client, *dockerFalso) {
	t.Helper()
	dir, err := os.MkdirTemp("", "sdm")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	falso := &dockerFalso{}
	lnD, err := net.Listen("unix", filepath.Join(dir, "d.sock"))
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = http.Serve(lnD, falso) }()
	s := &Servidor{Docker: filepath.Join(dir, "d.sock"), UsarRunsc: true, Reglas: reglasPrueba()}
	s.Reglas.TrampaDe = nil // la de verdad, preguntando a Docker
	ln, err := escuchar(filepath.Join(dir, "m", "motor.sock"), os.Getgid())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancelar := context.WithCancel(context.Background())
	t.Cleanup(cancelar)
	go func() { _ = s.Escuchar(ctx, ln) }()
	c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(dir, "m", "motor.sock"))
	}}}
	return c, falso
}

func pedir(t *testing.T, c *http.Client, metodo, ruta, cuerpo string, cab map[string]string) (int, string) {
	t.Helper()
	var r io.Reader
	if cuerpo != "" {
		r = strings.NewReader(cuerpo)
	}
	req, _ := http.NewRequest(metodo, "http://motor"+ruta, r)
	for k, v := range cab {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestServidor(t *testing.T) {
	c, falso := arrancar(t)
	casos := []struct {
		metodo, ruta string
		quiero       int
	}{
		{"GET", "/v1.47/version", 204},
		{"GET", "/v1.47/containers/json?all=1", 403},
		{"GET", `/v1.47/containers/json?filters={"label":["sugardaddy.sensor=local"]}`, 204},
		{"POST", "/v1.47/containers/sd-local-cache-1/start", 204},
		{"POST", "/v1.47/containers/sd-local-cache-1/exec", 403},
		{"PUT", "/v1.47/containers/sd-local-cache-1/archive", 403},
		{"DELETE", "/v1.47/containers/sugardaddy-consola-1", 403},
		{"POST", "/v1.47/containers/sugardaddy-consola-1/stop", 403},
		{"DELETE", "/v1.47/containers/ya-no-esta", 404},
		{"POST", "/v1.47/images/create?fromImage=alpine:latest", 403},
		{"POST", "/v1.47/images/create?fromImage=r/x@sha256:" + strings.Repeat("a", 64), 204},
		{"DELETE", "/v1.47/volumes/sugardaddy_datos-postgres", 403},
		{"DELETE", "/v1.47/volumes/sd-local-cache-1-0", 204},
		{"POST", "/v1.47/networks/sugardaddy_nodo/connect", 403},
		{"POST", "/v1.47/build", 403},
		{"POST", "/v1.47/swarm/init", 403},
		{"GET", "/v1.47/containers/sd-local-cache-1/logs", 204},
	}
	for _, x := range casos {
		if cod, cuerpo := pedir(t, c, x.metodo, x.ruta, "", nil); cod != x.quiero {
			t.Errorf("%s %s: %d (quería %d) %s", x.metodo, x.ruta, cod, x.quiero, cuerpo)
		}
	}
	// Crear una trampa: sin manifiesto, no; con él, llega a Docker con el perfil puesto.
	cfg, _ := json.Marshal(configPrueba())
	if cod, cuerpo := pedir(t, c, "POST", "/v1.47/containers/create?name=sd-local-cache-1", string(cfg), nil); cod != 403 || !strings.Contains(cuerpo, CodigoSinManif) {
		t.Fatalf("sin manifiesto: %d %s", cod, cuerpo)
	}
	man, _ := json.Marshal(manifiestoPrueba())
	cab := map[string]string{CabeceraManifiesto: base64.StdEncoding.EncodeToString(man)}
	if cod, cuerpo := pedir(t, c, "POST", "/v1.47/containers/create?name=sd-local-cache-1", string(cfg), cab); cod != 200 {
		t.Fatalf("con manifiesto: %d %s", cod, cuerpo)
	}
	opts := lista(falso.creada["HostConfig"].(map[string]any)["SecurityOpt"])
	if len(opts) != 2 || !strings.HasPrefix(opts[1], "seccomp=") {
		t.Fatalf("sd-motor tiene que poner su seccomp: %v", opts)
	}
	// Privileged no llega nunca a Docker.
	priv := configPrueba()
	hc(priv)["Privileged"] = true
	b, _ := json.Marshal(priv)
	if cod, _ := pedir(t, c, "POST", "/v1.47/containers/create?name=x", string(b), cab); cod != 403 {
		t.Fatalf("privileged: %d", cod)
	}
	// Lo que sd-motor dice de su aislamiento.
	if cod, cuerpo := pedir(t, c, "GET", RutaAislamiento, "", nil); cod != 200 || !strings.Contains(cuerpo, AislamientoSeccomp) || !strings.Contains(cuerpo, MotivoSinRunsc) {
		t.Fatalf("aislamiento: %d %s", cod, cuerpo)
	}
	// Sin servicio de discos se rechaza; nunca llega a Docker.
	if cod, _ := pedir(t, c, "POST", RutaDiscos, `{}`, nil); cod != 403 {
		t.Fatalf("discos sin servicio: %d", cod)
	}
	for _, r := range falso.recibidas {
		if strings.Contains(r, "consola") && !strings.HasSuffix(r, "/json") {
			t.Fatalf("una acción sobre un contenedor ajeno llegó a Docker: %s", r)
		}
	}
}
