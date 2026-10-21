package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Arranque del servidor real en el propio proceso de pruebas, como hace el
// banco: conf temporal (registro en la carpeta del test), servidor net/http
// sobre el oyente envuelto y cliente HTTP sin keep-alive (cada petición es su
// conexión, para que los eventos de conexión y cierre salgan donde se espera).

const (
	usuarioPrueba = "admin"
	clavePrueba   = "Admin-2026"
)

type entorno struct {
	base string // http://127.0.0.1:PUERTO
	reg  *registrador
	ruta string // ruta del registro
	s    *servidor
	srv  *http.Server
}

func arrancarServidor(t *testing.T, c conf) *entorno {
	t.Helper()
	dir := t.TempDir()
	c.registro = filepath.Join(dir, "login-web.json")
	c = c.conMinimos()
	reg, err := nuevoRegistrador(c.registro, c.maxLogDia, c.resumen, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	s := nuevoServidor(c, nuevaIdentidad(c, "semilla-de-prueba-fija-0001"), reg)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler:           http.HandlerFunc(s.atenderHTTP),
		ConnContext:       contextoConn,
		MaxHeaderBytes:    16 << 10,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	hecho := make(chan struct{})
	go func() {
		defer close(hecho)
		_ = srv.Serve(&escuchaTrampa{ln: ln, s: s})
	}()
	ctxT, cancelarT := context.WithCancel(context.Background())
	go s.tareasPeriodicas(ctxT)
	t.Cleanup(func() {
		cancelarT()
		bctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = srv.Shutdown(bctx)
		cancel()
		_ = srv.Close()
		esperarCon(&s.vivas, 3*time.Second)
		<-hecho
		reg.cerrar()
	})
	return &entorno{base: "http://" + ln.Addr().String(), reg: reg, ruta: c.registro, s: s, srv: srv}
}

// cliente: sin keep-alive, para que cada petición viva su propia conexión.
func cliente() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DisableKeepAlives: true,
		},
	}
}

// pedir hace una petición y devuelve el código y el cuerpo (y la respuesta
// para quien quiera mirar cabeceras; el cuerpo ya está leído).
func pedir(t *testing.T, e *entorno, metodo, ruta string, cuerpo string) (int, string, *http.Response) {
	t.Helper()
	req, err := http.NewRequest(metodo, e.base+ruta, strings.NewReader(cuerpo))
	if err != nil {
		t.Fatal(err)
	}
	if cuerpo != "" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := cliente().Do(req)
	if err != nil {
		t.Fatalf("petición %s %s: %v", metodo, ruta, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("leyendo respuesta de %s: %v", ruta, err)
	}
	return resp.StatusCode, string(b), resp
}

// form codifica un formulario como el del portal.
func form(campos map[string]string) string {
	v := url.Values{}
	for k, c := range campos {
		v.Set(k, c)
	}
	return v.Encode()
}

// eventos lee el registro y devuelve una línea por evento como mapa.
func eventos(t *testing.T, ruta string) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(ruta)
	if err != nil {
		return nil
	}
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

// esperarEvento sondea el registro hasta que haya un evento con ese eventid que
// cumpla el predicado, o falla pasado el plazo (sin sleeps fijos: se sondea).
func esperarEvento(t *testing.T, ruta, eventid string, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	fin := time.Now().Add(8 * time.Second)
	for {
		for _, e := range eventos(t, ruta) {
			if e["eventid"] == eventid && (pred == nil || pred(e)) {
				return e
			}
		}
		if time.Now().After(fin) {
			t.Fatalf("no apareció el evento %q a tiempo", eventid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func contiene(e map[string]any, campo, trozo string) bool {
	v, ok := e[campo].(string)
	return ok && strings.Contains(v, trozo)
}
