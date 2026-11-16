package actualizador

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/copias"
)

type consolaCopias struct {
	mu       sync.Mutex
	cfg      map[string]any
	informes []InformeCopias
}

func (c *consolaCopias) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer tok" {
		w.WriteHeader(401)
		return
	}
	if r.Method == http.MethodGet {
		json.NewEncoder(w).Encode(c.cfg)
		return
	}
	var inf InformeCopias
	b, _ := io.ReadAll(r.Body)
	json.Unmarshal(b, &inf)
	c.informes = append(c.informes, inf)
	w.Write([]byte(`{"ok":true}`))
}

func (c *consolaCopias) ultimo(t *testing.T) InformeCopias {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.informes) == 0 {
		t.Fatal("sin informe")
	}
	return c.informes[len(c.informes)-1]
}

// destinoFallon envuelve una carpeta y falla cuando se le pide.
type destinoFallon struct {
	copias.Carpeta
	fallar error
}

func (d *destinoFallon) Subir(ctx context.Context, n, r, s string, b int64) error {
	if d.fallar != nil {
		return d.fallar
	}
	return d.Carpeta.Subir(ctx, n, r, s, b)
}

func TestPendientes(t *testing.T) {
	l := []LocalCopia{{Nombre: "sugardaddy-20261105-031500.tar.age"}, {Nombre: "sugardaddy-20261104-031500.tar.age"}, {Nombre: "sugardaddy-20261103-031500.tar.age"}, {Nombre: "sugardaddy-20261102-031500.tar.age"}}
	if p := Pendientes(l, nil, 14); len(p) != 1 || p[0].Nombre != l[0].Nombre {
		t.Fatalf("la primera vez, solo la última: %v", p)
	}
	p := Pendientes(l, map[string]Subida{"sugardaddy-20261102-031500.tar.age": {}}, 14)
	if len(p) != 3 || p[0].Nombre != "sugardaddy-20261103-031500.tar.age" || p[2].Nombre != l[0].Nombre {
		t.Fatalf("las que faltan, de la vieja a la nueva: %v", p)
	}
	if p := Pendientes(l, map[string]Subida{"sugardaddy-20261102-031500.tar.age": {}}, 2); len(p) != 2 || p[1].Nombre != l[0].Nombre {
		t.Fatalf("como mucho «conservar», las más nuevas: %v", p)
	}
	if p := Pendientes(l, map[string]Subida{l[0].Nombre: {}}, 14); len(p) != 0 {
		t.Fatalf("nada nuevo: %v", p)
	}
}

func TestCopiasFueraVuelta(t *testing.T) {
	nodo := t.TempDir()
	dirCopias := filepath.Join(nodo, "copias")
	os.MkdirAll(dirCopias, 0o700)
	poner := func(n string) {
		os.WriteFile(filepath.Join(dirCopias, n), []byte("age-encryption.org/v1\n"+n), 0o600)
	}
	poner("sugardaddy-20261101-031500.tar.age")
	poner("sugardaddy-20261102-031500.tar.age")
	os.WriteFile(filepath.Join(dirCopias, "sugardaddy-20261103-031500.tar.age.tmp"), []byte("a medias"), 0o600)
	remoto := t.TempDir()
	d := &destinoFallon{Carpeta: copias.Carpeta{Raiz: remoto}}
	con := &consolaCopias{cfg: map[string]any{
		"activo": true, "huella": "h1", "conservar": 2,
		"destino": map[string]any{"tipo": "s3", "s3": map[string]any{"claveSecreta": "SuperSecreta123"}},
	}}
	srv := httptest.NewServer(con)
	defer srv.Close()
	c := &CopiasFuera{Consola: srv.URL, Token: "tok", HTTP: srv.Client(), Local: nodo,
		Destino: func(copias.Config) (copias.Destino, error) { return d, nil }}
	ctx := context.Background()

	// 1. La primera vez sube solo la última.
	if err := c.Vuelta(ctx); err != nil {
		t.Fatal(err)
	}
	inf := con.ultimo(t)
	if len(inf.Subidas) != 1 || inf.Subidas[0].Nombre != "sugardaddy-20261102-031500.tar.age" || inf.Error != "" || len(inf.Remotas) != 1 || inf.Local.Nombre != "sugardaddy-20261102-031500.tar.age" {
		t.Fatalf("%+v", inf)
	}
	// 2. Dos noches más: sube las dos y deja solo dos en el destino.
	poner("sugardaddy-20261103-031500.tar.age")
	poner("sugardaddy-20261104-031500.tar.age")
	if err := c.Vuelta(ctx); err != nil {
		t.Fatal(err)
	}
	inf = con.ultimo(t)
	r, _ := d.Listar(ctx)
	if len(inf.Subidas) != 2 || len(r) != 2 || r[0].Nombre != "sugardaddy-20261104-031500.tar.age" || len(inf.Remotas) != 2 {
		t.Fatalf("%+v %v", inf, r)
	}
	// 3. Nada nuevo: no se informa otra vez enseguida.
	n := len(con.informes)
	c.Vuelta(ctx)
	if len(con.informes) != n {
		t.Fatal("sin cambios no informa en cada vuelta")
	}
	// 4. La prueba de restauración: sin clave privada en la máquina, «sin-clave», con la huella comprobada.
	con.cfg["pruebaToca"] = true
	con.cfg["pedidos"] = map[string]any{"prueba": "p1"}
	c.Vuelta(ctx)
	inf = con.ultimo(t)
	if inf.Prueba == nil || inf.Hechos["prueba"] != "p1" || inf.Prueba.Nombre != "sugardaddy-20261104-031500.tar.age" {
		t.Fatalf("%+v", inf)
	}
	// Lo de prueba no es age de verdad: falla por la forma, pero la huella coincide.
	if inf.Prueba.Resultado != copias.PruebaFallo || inf.Prueba.Huella != "coincide" {
		t.Fatalf("%+v", inf.Prueba)
	}
	if _, err := os.Stat(filepath.Join(dirCopias, copias.Prueba, "sugardaddy-20261104-031500.tar.age.bajada")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("la copia bajada no se queda en la máquina")
	}
	delete(con.cfg, "pruebaToca")
	delete(con.cfg, "pedidos")
	// 5. El destino falla: se informa sin el secreto y no se reintenta en cada vuelta.
	poner("sugardaddy-20261105-031500.tar.age")
	d.fallar = errors.New("403 InvalidAccessKeyId SuperSecreta123")
	c.Vuelta(ctx)
	inf = con.ultimo(t)
	if !strings.Contains(inf.Error, "uploading sugardaddy-20261105") || strings.Contains(inf.Error, "SuperSecreta123") {
		t.Fatalf("%+v", inf)
	}
	n = len(con.informes)
	d.fallar = nil
	c.Vuelta(ctx)
	if len(con.informes) != n {
		t.Fatal("tras un fallo espera antes de reintentar")
	}
	// 6. Cambia el destino: empieza de cero con la última.
	con.cfg["huella"] = "h2"
	remoto2 := t.TempDir()
	d.Carpeta = copias.Carpeta{Raiz: remoto2}
	c.Vuelta(ctx)
	inf = con.ultimo(t)
	if len(inf.Subidas) != 1 || inf.Subidas[0].Nombre != "sugardaddy-20261105-031500.tar.age" || inf.Error != "" {
		t.Fatalf("%+v", inf)
	}
	// 7. Apagado: solo cuenta la copia local.
	con.cfg["activo"] = false
	c.ultimoInforme = time.Time{}
	c.Vuelta(ctx)
	if inf = con.ultimo(t); inf.Local == nil || len(inf.Subidas) != 0 {
		t.Fatalf("%+v", inf)
	}
}
