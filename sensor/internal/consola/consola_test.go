package consola

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// SubirArtefacto manda los metadatos en la query y el binario en el cuerpo,
// autenticado con el token; mapea el estado de la consola a sus errores.
func TestSubirArtefacto(t *testing.T) {
	var gotPath, gotAuth, gotTipo, gotCuerpo string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		gotTipo = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotCuerpo = string(b)
		switch r.URL.Query().Get("sha256") {
		case "ok":
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "nuevo":
			w.WriteHeader(http.StatusNotFound)
		case "grande":
			w.WriteHeader(http.StatusRequestEntityTooLarge)
		case "apagado":
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()
	c := Nuevo(srv.URL, "tok")
	ctx := context.Background()

	if err := c.SubirArtefacto(ctx, "ev-1", "descarga", "ok", "virus.sh", []byte("hola")); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer tok" || gotTipo != "application/octet-stream" || gotCuerpo != "hola" {
		t.Fatalf("petición mal armada: auth=%q tipo=%q cuerpo=%q", gotAuth, gotTipo, gotCuerpo)
	}
	for _, trozo := range []string{"evento=ev-1", "tipo=descarga", "sha256=ok", "nombre=virus.sh"} {
		if !strings.Contains(gotPath, trozo) {
			t.Fatalf("la query no lleva %q: %q", trozo, gotPath)
		}
	}
	// 404: el evento aún no llegó a la consola → transitorio, se reintenta.
	if err := c.SubirArtefacto(ctx, "ev", "descarga", "nuevo", "", nil); !errors.Is(err, ErrEventoNoVisto) {
		t.Fatalf("un 404 tenía que ser ErrEventoNoVisto: %v", err)
	}
	// 413 y 403: rechazo definitivo, no se reintenta.
	for _, sha := range []string{"grande", "apagado"} {
		if err := c.SubirArtefacto(ctx, "ev", "descarga", sha, "", nil); !errors.Is(err, ErrArtefactoRechazado) {
			t.Fatalf("%s tenía que ser ErrArtefactoRechazado: %v", sha, err)
		}
	}
	// Sin nombre: el parámetro no va.
	_ = c.SubirArtefacto(ctx, "ev", "escritura", "ok", "", []byte("x"))
	if strings.Contains(gotPath, "nombre=") {
		t.Fatalf("sin nombre no debía ir el parámetro: %q", gotPath)
	}
}

// El plan trae los toques pedidos, y cómo fue cada uno se cuenta con el token.
func TestToques(t *testing.T) {
	var gotAuth, gotRuta, gotCuerpo string
	estado := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"sensor":"s1","trampas":[],"toques":[{"id":"t1","trampa":"ftp","direccion":"10.0.0.11","puerto":21,"codigo":"abc12345","ips":["172.20.0.1"]}]}`))
			return
		}
		gotAuth, gotRuta = r.Header.Get("Authorization"), r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotCuerpo = string(b)
		w.WriteHeader(estado)
	}))
	defer srv.Close()
	c := Nuevo(srv.URL, "tok")
	ctx := context.Background()

	p, err := c.Plan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Toques) != 1 || p.Toques[0].Puerto != 21 || p.Toques[0].Codigo != "abc12345" || p.Toques[0].IPs[0] != "172.20.0.1" {
		t.Fatalf("toques = %+v", p.Toques)
	}

	if err := c.InformarToque(ctx, "t1", false, "connection refused"); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer tok" || gotRuta != "/api/sensor/toques" {
		t.Fatalf("auth %q, ruta %q", gotAuth, gotRuta)
	}
	if !strings.Contains(gotCuerpo, `"ok":false`) || !strings.Contains(gotCuerpo, "connection refused") {
		t.Fatalf("cuerpo = %s", gotCuerpo)
	}

	estado = http.StatusInternalServerError
	if err := c.InformarToque(ctx, "t1", true, ""); err == nil {
		t.Fatal("un 500 tiene que ser un error")
	}
}

// El plan lleva su huella: si la consola contesta que no ha cambiado (304), el
// sensor usa el que ya tiene; si cambia, lo baja de nuevo; y con una consola
// anterior, que no manda ETag, lo baja siempre.
func TestPlanSinCambiosNoSeVuelveABajar(t *testing.T) {
	cuerpo := `{"sensor":"s1","ultimoHash":"h1","trampas":[{"id":"t1"}]}`
	etag := `"v1"`
	var enviados, sinCuerpo int
	var conEtag bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if conEtag {
			w.Header().Set("ETag", etag)
			if r.Header.Get("If-None-Match") == etag {
				sinCuerpo++
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		enviados++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(cuerpo))
	}))
	defer srv.Close()
	c := Nuevo(srv.URL, "token")
	pedir := func() string {
		t.Helper()
		p, err := c.Plan(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if len(p.Trampas) != 1 {
			t.Fatalf("plan sin sus trampas: %+v", p)
		}
		return p.Trampas[0].ID
	}

	// Consola anterior: sin ETag, cada petición trae el plan entero.
	pedir()
	pedir()
	if enviados != 2 || sinCuerpo != 0 {
		t.Fatalf("sin ETag: enviados=%d sinCuerpo=%d", enviados, sinCuerpo)
	}

	// Con ETag: la primera lo baja, las siguientes reciben 304 y sirve el guardado.
	conEtag = true
	if pedir() != "t1" || pedir() != "t1" || pedir() != "t1" {
		t.Fatal("el plan guardado no es el mismo")
	}
	if enviados != 3 || sinCuerpo != 2 {
		t.Fatalf("con ETag: enviados=%d sinCuerpo=%d", enviados, sinCuerpo)
	}

	// Cambia el plan: huella nueva, se baja otra vez.
	cuerpo, etag = `{"sensor":"s1","ultimoHash":"h2","trampas":[{"id":"t2"}]}`, `"v2"`
	if pedir() != "t2" {
		t.Fatal("no bajó el plan nuevo")
	}
	if enviados != 4 {
		t.Fatalf("tras el cambio: enviados=%d", enviados)
	}
}
