package actualizador

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
)

func TestLeerResultadoCortafuegos(t *testing.T) {
	r := LeerResultadoCortafuegos("aviso suelto\n{\"estado\":\"aplicada\",\"detalle\":\"IPv4 with iptables-nft, 2 allowed\"}\n", 0)
	if r.Estado != "aplicada" || r.Detalle == "" {
		t.Fatalf("%+v", r)
	}
	if r := LeerResultadoCortafuegos("panic: algo\n", 2); r.Estado != "error" {
		t.Fatalf("without a JSON line it must be an error: %+v", r)
	}
}

func TestUltimaListaGuardada(t *testing.T) {
	a := &Acceso{Local: t.TempDir()}
	if _, ok := a.leerUltima(); ok {
		t.Fatal("nothing saved yet")
	}
	a.guardarUltima(listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}})
	l, ok := a.leerUltima()
	if !ok || l.Estado != "restringida" || len(l.Redes) != 1 || l.Redes[0] != "10.0.5.20" {
		t.Fatalf("%+v %v", l, ok)
	}
}

// consolaFalsa contesta la lista y apunta lo que le informa el actualizador.
type consolaFalsa struct {
	lista    listaConsola
	caida    bool
	falla    bool // el informe da 500
	informes []map[string]any
}

func (c *consolaFalsa) servidor(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c.caida {
			http.Error(w, "starting", http.StatusBadGateway)
			return
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(c.lista)
			return
		}
		if c.falla {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		c.informes = append(c.informes, m)
	}))
}

func nuevoAcceso(t *testing.T, c *consolaFalsa) (*Acceso, *[]cortafuegos.Pedido) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "versiones.env"), []byte("ACTUALIZADOR_IMAGEN=actualizador:prueba\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("CONSOLA_PUERTO=8443\n"), 0o600)
	srv := c.servidor(t)
	t.Cleanup(srv.Close)
	var pedidos []cortafuegos.Pedido
	a := &Acceso{Consola: srv.URL, Token: "token", HTTP: srv.Client(), Local: dir,
		Lanzar: func(_ context.Context, imagen string, p cortafuegos.Pedido) cortafuegos.Resultado {
			if imagen != "actualizador:prueba" {
				t.Fatalf("image %q", imagen)
			}
			pedidos = append(pedidos, p)
			if p.Abierta {
				return cortafuegos.Resultado{Estado: cortafuegos.Abierta}
			}
			return cortafuegos.Resultado{Estado: cortafuegos.Aplicada, Detalle: "ok"}
		}}
	return a, &pedidos
}

func TestVueltaAplicaInformaYNoRepite(t *testing.T) {
	c := &consolaFalsa{lista: listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}, Huella: "abc"}}
	a, pedidos := nuevoAcceso(t, c)
	if err := a.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*pedidos) != 1 || (*pedidos)[0].Puerto != 8443 || (*pedidos)[0].Abierta {
		t.Fatalf("%+v", *pedidos)
	}
	if len(c.informes) != 1 || c.informes[0]["estado"] != "aplicada" || c.informes[0]["huella"] != "abc" {
		t.Fatalf("report: %+v", c.informes)
	}
	// La misma lista: ni se vuelve a lanzar ni se vuelve a informar.
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 1 || len(c.informes) != 1 {
		t.Fatalf("repeated: %d launches, %d reports", len(*pedidos), len(c.informes))
	}
	// Pasado el repaso, otra vez las dos cosas: la regla puede haberse perdido.
	a.cuando = time.Now().Add(-RepasoCortafuegos - time.Second)
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 2 || len(c.informes) != 2 {
		t.Fatalf("no re-check: %d launches, %d reports", len(*pedidos), len(c.informes))
	}
	if l, ok := a.leerUltima(); !ok || l.Huella != "abc" || l.Redes[0] != "10.0.5.20" {
		t.Fatalf("saved list: %+v", l)
	}
}

func TestVueltaInformeFallidoSeRepiteSinRelanzar(t *testing.T) {
	c := &consolaFalsa{lista: listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}}, falla: true}
	a, pedidos := nuevoAcceso(t, c)
	if err := a.Vuelta(context.Background()); err == nil {
		t.Fatal("a failed report must be an error")
	}
	c.falla = false
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 1 || len(c.informes) != 1 {
		t.Fatalf("%d launches, %d reports", len(*pedidos), len(c.informes))
	}
}

func TestEmergenciaAbreAunqueLaConsolaNoConteste(t *testing.T) {
	c := &consolaFalsa{lista: listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}}, caida: true}
	a, pedidos := nuevoAcceso(t, c)
	_ = os.WriteFile(filepath.Join(a.Local, FicheroAbrir), nil, 0o600)
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 1 || !(*pedidos)[0].Abierta {
		t.Fatalf("emergency without console did not open: %+v", *pedidos)
	}
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 1 {
		t.Fatal("relaunched every round while the console is down")
	}
	// Vuelve la consola: se le dice que se abrió por emergencia y el fichero se va.
	c.caida = false
	_ = a.Vuelta(context.Background())
	if len(c.informes) != 1 || c.informes[0]["emergencia"] != true || c.informes[0]["estado"] != "abierta" {
		t.Fatalf("report: %+v", c.informes)
	}
	if _, err := os.Stat(filepath.Join(a.Local, FicheroAbrir)); err == nil {
		t.Fatal("the emergency file is still there")
	}
}

func TestTrasReinicioPoneLaUltimaListaSinConsola(t *testing.T) {
	c := &consolaFalsa{lista: listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}, Huella: "abc"}, caida: true}
	a, pedidos := nuevoAcceso(t, c)
	a.guardarUltima(listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}, Huella: "abc"})
	_ = a.Vuelta(context.Background())
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 1 || (*pedidos)[0].Redes[0] != "10.0.5.20" {
		t.Fatalf("saved list not applied exactly once: %+v", *pedidos)
	}
	// Con la consola, la misma lista: no se relanza, pero se informa.
	c.caida = false
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 1 || len(c.informes) != 1 || c.informes[0]["huella"] != "abc" {
		t.Fatalf("%d launches, reports %+v", len(*pedidos), c.informes)
	}
}

func TestListaGuardadaSinHuellaSeConfirmaConLaDeLaConsola(t *testing.T) {
	c := &consolaFalsa{lista: listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}, Huella: "nueva"}, caida: true}
	a, pedidos := nuevoAcceso(t, c)
	a.guardarUltima(listaConsola{Estado: "restringida", Redes: []string{"10.0.5.20"}})
	_ = a.Vuelta(context.Background())
	c.caida = false
	_ = a.Vuelta(context.Background())
	if len(*pedidos) != 1 || len(c.informes) != 1 || c.informes[0]["huella"] != "nueva" {
		t.Fatalf("%d launches, reports %+v", len(*pedidos), c.informes)
	}
}
