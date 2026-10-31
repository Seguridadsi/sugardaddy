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
