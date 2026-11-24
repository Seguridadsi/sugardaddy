package intermediario

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// carpetaDeRegistros: datos/registros/abc/log.txt y, fuera de la carpeta del
// sensor, otro log.txt (el fichero de root que no se puede tocar).
func carpetaDeRegistros(t *testing.T) (datos, dentro, fuera string) {
	t.Helper()
	datos = t.TempDir()
	dir := filepath.Join(datos, "registros", "abc")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f := t.TempDir()
	for _, d := range []string{dir, f} {
		if err := os.WriteFile(filepath.Join(d, "log.txt"), make([]byte, 64<<10), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return datos, filepath.Join(dir, "log.txt"), filepath.Join(f, "log.txt")
}

func conLiberar(t *testing.T, f func(*os.File, int64) error) {
	antes := liberar
	liberar = f
	t.Cleanup(func() { liberar = antes })
}

// TestPerforarEnlacePlantadoTrasValidar: la carpeta del registro pasa a ser un
// enlace a otra parte después de validar la ruta (lo que hacía el sensor en la
// carrera de la auditoría, §4.5). Antes se volvía a resolver la ruta y root
// perforaba el fichero de fuera; ahora la apertura es la decisión y no se sigue.
func TestPerforarEnlacePlantadoTrasValidar(t *testing.T) {
	datos, _, fuera := carpetaDeRegistros(t)
	s := &Servidor{Reglas: Reglas{Datos: datos}}
	rel, err := s.Reglas.RegistroDeTrampa(filepath.Join(datos, "registros", "abc", "log.txt"))
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(datos, "registros", "abc")
	if err := os.Rename(dir, dir+".real"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(fuera), dir); err != nil {
		t.Fatal(err)
	}
	llamado := false
	conLiberar(t, func(*os.File, int64) error { llamado = true; return nil })
	if err := s.liberarEn(rel, 64<<10); err == nil || llamado {
		t.Fatalf("con la carpeta cambiada por un enlace no se perfora nada: err=%v llamado=%v", err, llamado)
	}
}

// TestPerforarCarrera: mientras se perfora una y otra vez, otra rutina cambia la
// carpeta del registro por un enlace a fuera y la vuelve a poner. Nunca llega a
// perforarse un descriptor que no sea el registro de dentro.
func TestPerforarCarrera(t *testing.T) {
	datos, dentro, fuera := carpetaDeRegistros(t)
	fiDentro, _ := os.Stat(dentro)
	fiFuera, _ := os.Stat(fuera)
	s := &Servidor{Reglas: Reglas{Datos: datos}}
	rel, err := s.Reglas.RegistroDeTrampa(dentro)
	if err != nil {
		t.Fatal(err)
	}
	var buenas, fueraVistas atomic.Int64
	conLiberar(t, func(f *os.File, _ int64) error {
		fi, err := f.Stat()
		if err != nil {
			return err
		}
		switch {
		case os.SameFile(fi, fiFuera):
			fueraVistas.Add(1)
		case os.SameFile(fi, fiDentro):
			buenas.Add(1)
		}
		return nil
	})
	dir := filepath.Join(datos, "registros", "abc")
	parar := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-parar:
				_ = os.Remove(dir)
				_ = os.Rename(dir+".real", dir)
				return
			default:
			}
			_ = os.Rename(dir, dir+".real")
			_ = os.Symlink(filepath.Dir(fuera), dir)
			_ = os.Remove(dir)
			_ = os.Rename(dir+".real", dir)
		}
	}()
	for i := 0; i < 3000; i++ {
		_ = s.liberarEn(rel, 64<<10)
	}
	close(parar)
	wg.Wait()
	if n := fueraVistas.Load(); n > 0 {
		t.Fatalf("se perforó %d veces el fichero de fuera de la carpeta del sensor", n)
	}
	if buenas.Load() == 0 {
		t.Log("la carrera no dejó ninguna apertura buena (no invalida la prueba)")
	}
}

// TestBindPorEnlaceDentro: un origen de bind que pasa por un enlace, aunque acabe
// dentro de la carpeta del sensor, no vale (antes se resolvía entero y pasaba).
func TestBindPorEnlaceDentro(t *testing.T) {
	datos := t.TempDir()
	if err := os.MkdirAll(filepath.Join(datos, "discos", "abc", "escribible-0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(datos, "registros"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../discos/abc/escribible-0", filepath.Join(datos, "registros", "abc")); err != nil {
		t.Fatal(err)
	}
	r := Reglas{Datos: datos}
	if err := r.bind("abc", filepath.Join(datos, "registros", "abc"), "/log", false); err == nil {
		t.Fatal("un bind por un enlace tenía que rechazarse")
	}
	if err := os.Remove(filepath.Join(datos, "registros", "abc")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(datos, "registros", "abc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := r.bind("abc", filepath.Join(datos, "registros", "abc"), "/log", false); err != nil {
		t.Fatalf("su carpeta de registros de verdad: %v", err)
	}
}

// TestArrancarRevisaLosBinds: Docker resuelve el origen de un bind al arrancar; si
// desde la creación el sensor ha cambiado la carpeta por un enlace, sd-motor no
// deja arrancar la trampa (y con la carpeta de verdad, sí).
func TestArrancarRevisaLosBinds(t *testing.T) {
	datos, _, fuera := carpetaDeRegistros(t)
	origen := filepath.Join(datos, "registros", "abc")
	var arrancadas atomic.Int64
	docker := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/containers/sd-local-abc/json"):
			_, _ = io.WriteString(w, `{"Config":{"Labels":{"sugardaddy.trampa":"abc","sugardaddy.sensor":"local"}},
				"HostConfig":{"Mounts":[{"Type":"bind","Source":`+strconv.Quote(origen)+`,"Target":"/log"}]}}`)
		case strings.HasSuffix(r.URL.Path, "/start"):
			arrancadas.Add(1)
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	})
	dir := t.TempDir()
	lnD, err := net.Listen("unix", filepath.Join(dir, "d.sock"))
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = http.Serve(lnD, docker) }()
	s := &Servidor{Docker: filepath.Join(dir, "d.sock"), Reglas: Reglas{Datos: datos}}
	arrancar := func() int {
		req := httptest.NewRequest(http.MethodPost, "/v1.43/containers/sd-local-abc/start", nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := arrancar(); c != 204 || arrancadas.Load() != 1 {
		t.Fatalf("con su carpeta de verdad arranca: %d", c)
	}
	if err := os.Rename(origen, origen+".real"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(fuera), origen); err != nil {
		t.Fatal(err)
	}
	if c := arrancar(); c != http.StatusForbidden || arrancadas.Load() != 1 {
		t.Fatalf("con la carpeta cambiada por un enlace no arranca: %d", c)
	}
}
