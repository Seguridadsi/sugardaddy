package actualizador

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// El vector lo genera TypeScript (paquetes/canal/src/vectores/transparencia.json).
type vectorTransparencia struct {
	Registro     string         `json:"registro"`
	Cabeza       CabezaRegistro `json:"cabeza"`
	Version      string         `json:"version"`
	Prueba       PruebaRegistro `json:"prueba"`
	VersionVieja string         `json:"versionVieja"`
	PruebaVieja  PruebaRegistro `json:"pruebaVieja"`
	Marcas       string         `json:"marcas"`
	Ahora        string         `json:"ahora"`
	Marca        MarcaFirmada   `json:"marca"`
}

func leerVectorTransparencia(t *testing.T) (vectorTransparencia, time.Time) {
	t.Helper()
	b, err := os.ReadFile("../../../paquetes/canal/src/vectores/transparencia.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorTransparencia
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	ahora, _ := time.Parse(time.RFC3339, v.Ahora)
	return v, ahora
}

func TestTransparenciaVectorComun(t *testing.T) {
	v, _ := leerVectorTransparencia(t)
	lineas := strings.Split(strings.TrimSpace(v.Registro), "\n")
	if hex.EncodeToString(RaizDe(lineas)) != v.Cabeza.Raiz || int64(len(lineas)) != v.Cabeza.Tamano {
		t.Fatal("la raíz de Go no es la de TypeScript")
	}
	if !VersionEnRegistro(v.Version, v.Cabeza, v.Prueba) {
		t.Fatal("la versión del vector debería estar")
	}
	if VersionEnRegistro(v.Version+" ", v.Cabeza, v.Prueba) || VersionEnRegistro(v.VersionVieja, v.Cabeza, v.Prueba) {
		t.Fatal("otro texto no debería estar con esa prueba")
	}
	if !VersionEnRegistro(v.VersionVieja, v.Cabeza, v.PruebaVieja) {
		t.Fatal("la vieja, con su prueba, sí")
	}
	otra := v.Cabeza
	otra.Tamano++
	if VersionEnRegistro(v.Version, otra, v.Prueba) {
		t.Fatal("una prueba de otro tamaño no vale")
	}
	// Las vacías y de una hoja, como RFC 6962.
	if hex.EncodeToString(RaizDe(nil)) != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ||
		hex.EncodeToString(RaizDe([]string{""})) != "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d" {
		t.Fatal("raíces de RFC 6962 mal")
	}
}

// Todas las rutas de todos los tamaños pequeños llevan a la raíz (rutas calculadas aquí).
func TestIncluidaTodos(t *testing.T) {
	ruta := func(h [][]byte, i int) [][]byte {
		var r [][]byte
		var rec func(h [][]byte, i int)
		rec = func(h [][]byte, i int) {
			if len(h) <= 1 {
				return
			}
			k := 1
			for k*2 < len(h) {
				k *= 2
			}
			if i < k {
				rec(h[:k], i)
				r = append(r, raizHojas(h[k:]))
			} else {
				rec(h[k:], i-k)
				r = append(r, raizHojas(h[:k]))
			}
		}
		rec(h, i)
		return r
	}
	for n := 1; n <= 20; n++ {
		var hojas [][]byte
		for i := 0; i < n; i++ {
			hojas = append(hojas, hojaDe(fmt.Sprint(i)))
		}
		raiz := raizHojas(hojas)
		for i := 0; i < n; i++ {
			if !Incluida(hojas[i], int64(i), int64(n), ruta(hojas, i), raiz) {
				t.Fatalf("n=%d i=%d no se comprueba", n, i)
			}
			if n > 1 && Incluida(hojas[i], int64((i+1)%n), int64(n), ruta(hojas, i), raiz) {
				t.Fatalf("n=%d i=%d vale con otro índice", n, i)
			}
		}
	}
}

// El vigía comprueba una versión con la marca de la copia estática: con la prueba de la
// propia marca, con la de pruebas/<huella>.json, y no la da por buena si no está.
func TestComprobarRegistro(t *testing.T) {
	v, ahora := leerVectorTransparencia(t)
	huellaVieja := sha256.Sum256([]byte(v.VersionVieja))
	conPrueba := true
	estatica := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/t/marca.json":
			_ = json.NewEncoder(w).Encode(v.Marca)
		case "/t/pruebas/" + hex.EncodeToString(huellaVieja[:]) + ".json":
			if !conPrueba {
				w.WriteHeader(404)
				return
			}
			_ = json.NewEncoder(w).Encode(v.PruebaVieja)
		default:
			w.WriteHeader(404)
		}
	}))
	defer estatica.Close()
	vg := &Vigia{Estatica: estatica.URL + "/t", Fuera: estatica.Client(), Dir: t.TempDir(),
		Marcas: []string{v.Marcas}, Edicion: "cloud"}
	ctx := context.Background()
	if e, d := vg.ComprobarRegistro(ctx, "cloud", v.Version, ahora); e != RegistroIncluida {
		t.Fatalf("la última, con la prueba de la marca: %s %s", e, d)
	}
	if e, d := vg.ComprobarRegistro(ctx, "cloud", v.VersionVieja, ahora); e != RegistroIncluida {
		t.Fatalf("la vieja, con pruebas/: %s %s", e, d)
	}
	if e, _ := vg.ComprobarRegistro(ctx, "cloud", `{"version":"9.9.9"}`, ahora); e != RegistroAusente {
		t.Fatalf("una que no está: %s", e)
	}
	// Sin red: no se sabe.
	sinRed := &Vigia{Estatica: "http://127.0.0.1:1/t", Fuera: &http.Client{Timeout: time.Second}, Dir: t.TempDir(),
		Marcas: []string{v.Marcas}, Edicion: "cloud"}
	sinRed.actual = &MarcaVista{}
	if m, err := VerificarMarca(Confianza{}, []string{v.Marcas}, "cloud", v.Marca, ahora); err == nil {
		m.Origen = "panel"
		sinRed.actual = &m
	}
	if e, _ := sinRed.ComprobarRegistro(ctx, "cloud", v.VersionVieja, ahora); e != RegistroSinPrueba {
		t.Fatalf("sin red: %s", e)
	}
	// Sin cabeza en ninguna marca, aún no hay registro.
	nada := &Vigia{Dir: t.TempDir(), Edicion: "cloud"}
	if e, _ := nada.ComprobarRegistro(ctx, "cloud", v.Version, ahora); e != RegistroSinRegistro {
		t.Fatalf("sin registro: %s", e)
	}
}
