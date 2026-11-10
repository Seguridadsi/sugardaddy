package actualizador

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/canodo"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// nodoConCAVieja deja una carpeta de nodo como la de uno instalado antes de la
// CA propia: .env sin CA_NODO, la CA de Caddy en su volumen, una copia que la
// lleva y la CA propia ya preparada.
func nodoConCAVieja(t *testing.T) (dir, datos string, ca *canodo.CA) {
	t.Helper()
	dir = t.TempDir()
	datos = t.TempDir()
	escribir := func(ruta, s string, modo os.FileMode) {
		_ = os.MkdirAll(filepath.Dir(ruta), 0o700)
		if err := os.WriteFile(ruta, []byte(s), modo); err != nil {
			t.Fatal(err)
		}
	}
	escribir(filepath.Join(dir, ".env"), "POSTGRES_PASSWORD=\"no-tocar\"\nTLS_MODO=interno\nCONSOLA_DOMINIO=consola.aldanza.local\n", 0o600)
	escribir(filepath.Join(dir, "versiones.env"), "SUGARDADDY_VERSION=0.25.0\n", 0o644)
	escribir(filepath.Join(dir, "compose.yml"), "services: {}\n", 0o644)
	escribir(filepath.Join(dir, "ca-raiz.crt"), "raiz vieja\n", 0o644)
	escribir(filepath.Join(datos, "caddy/pki/authorities/local/root.key"), "CLAVE VIEJA", 0o600)
	escribir(filepath.Join(datos, "caddy/pki/authorities/local/root.crt"), "raiz vieja", 0o644)
	escribir(filepath.Join(datos, "caddy/certificates/local/consola.aldanza.local/consola.aldanza.local.key"), "hoja vieja", 0o600)
	escribir(filepath.Join(datos, "caddy/certificates/nodo/consola.aldanza.local/consola.aldanza.local.crt"), "hoja nueva", 0o600)
	escribir(filepath.Join(dir, "clave-copias"), "clave\n", 0o600)
	_ = os.MkdirAll(filepath.Join(dir, "copias"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "copias", "sugardaddy-20261101-031500.tar.enc"), cifrarGo(t, tarDeCopia(t, 100), "clave"), 0o600)
	var err error
	if ca, err = canodo.Generar(filepath.Join(dir, DirCA), "consola.aldanza.local", "nodo-x", time.Now()); err != nil {
		t.Fatal(err)
	}
	return dir, datos, ca
}

func cambioDePrueba(t *testing.T, dir, datos, huella string, comprobar func(context.Context, *x509.Certificate, string) error) *CambioCA {
	return &CambioCA{
		Dir: dir, Datos: datos, Proyecto: "sugardaddy", Huella: huella,
		Docker: docker.Nuevo(dockerFalso(t, dir)), Binario: composeFalso(t, dir),
		Comprobar: comprobar, Pausa: time.Millisecond,
	}
}

func existe(ruta string) bool {
	_, err := os.Lstat(ruta)
	return err == nil
}

func llamadas(t *testing.T, dir string) string {
	b, _ := os.ReadFile(filepath.Join(dir, ".llamadas"))
	return string(b)
}

func TestCambioCA(t *testing.T) {
	dir, datos, ca := nodoConCAVieja(t)
	inodo := func() uint64 {
		fi, _ := os.Stat(filepath.Join(dir, "ca-raiz.crt"))
		return fi.Sys().(*syscall.Stat_t).Ino
	}
	antes := inodo()
	comprobado := false
	c := cambioDePrueba(t, dir, datos, strings.ToLower(ca.Huella()), func(_ context.Context, raiz *x509.Certificate, d string) error {
		env, _ := LeerEnv(filepath.Join(dir, ".env"))
		if env["CA_NODO"] != "nodo" || !strings.Contains(llamadas(t, dir), "up -d --no-deps --force-recreate --pull never https") {
			t.Fatal("it must check after recreating https with the new CA")
		}
		if !raiz.Equal(ca.Raiz) || d != "consola.aldanza.local" {
			t.Fatalf("checking %v for %s", raiz.Subject, d)
		}
		comprobado = true
		return nil
	})
	r := c.Aplicar(context.Background())
	if r.Estado != CAAplicada || !comprobado {
		t.Fatalf("%+v", r)
	}
	env, _ := LeerEnv(filepath.Join(dir, ".env"))
	if env["CA_NODO"] != "nodo" || env["POSTGRES_PASSWORD"] != "no-tocar" {
		t.Fatalf(".env: %v", env)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ca-raiz.crt")); !bytes.Equal(b, ca.RaizPEM()) || inodo() != antes {
		t.Fatal("ca-raiz.crt must hold the new root, written in place (the console mounts it)")
	}
	if existe(filepath.Join(datos, "caddy/pki/authorities/local")) || existe(filepath.Join(datos, "caddy/certificates/local")) {
		t.Fatal("the old CA must be gone from the Caddy volume")
	}
	if !existe(filepath.Join(datos, "caddy/certificates/nodo/consola.aldanza.local/consola.aldanza.local.crt")) {
		t.Fatal("the certificates of the new CA stay")
	}
	copia, _ := os.ReadFile(filepath.Join(dir, "copias", "sugardaddy-20261101-031500.tar.enc"))
	claro, err := descifrarGo(t, copia, "clave")
	if err != nil || bytes.Contains(claro, []byte("CLAVE VIEJA")) || r.Copias.Limpias != 1 {
		t.Fatalf("the backup still holds the old CA (%v, %+v)", err, r.Copias)
	}
	if existe(filepath.Join(dir, FicheroCambioCA)) {
		t.Fatal("the switch is finished: no pending marker")
	}
	if !mismaHuella(r.Huella, ca.Huella()) || !strings.Contains(r.Detalle, "in 1 backup") {
		t.Fatalf("%+v", r)
	}
}

func TestCambioCAOtraHuellaNoToca(t *testing.T) {
	dir, datos, _ := nodoConCAVieja(t)
	c := cambioDePrueba(t, dir, datos, "AA:BB", func(context.Context, *x509.Certificate, string) error {
		t.Fatal("nothing to check")
		return nil
	})
	r := c.Aplicar(context.Background())
	if r.Estado != CAFallida || !strings.Contains(r.Detalle, "not the one prepared") {
		t.Fatalf("%+v", r)
	}
	if env, _ := LeerEnv(filepath.Join(dir, ".env")); env["CA_NODO"] != "" || llamadas(t, dir) != "" {
		t.Fatal("nothing must change")
	}
	if !existe(filepath.Join(datos, "caddy/pki/authorities/local/root.key")) {
		t.Fatal("the old CA must stay")
	}
}

func TestCambioCAVuelveSiNoContestaConLaNueva(t *testing.T) {
	dir, datos, ca := nodoConCAVieja(t)
	c := cambioDePrueba(t, dir, datos, ca.Huella(), func(context.Context, *x509.Certificate, string) error {
		return errors.New("x509: certificate signed by unknown authority")
	})
	r := c.Aplicar(context.Background())
	if r.Estado != CAFallida || !strings.Contains(r.Detalle, "went back to the previous root") || !strings.Contains(r.Detalle, "unknown authority") {
		t.Fatalf("%+v", r)
	}
	if env, _ := LeerEnv(filepath.Join(dir, ".env")); env["CA_NODO"] != "" || env["POSTGRES_PASSWORD"] != "no-tocar" {
		t.Fatalf(".env must be back as it was: %v", env)
	}
	if strings.Count(llamadas(t, dir), "--force-recreate") != 2 {
		t.Fatalf("https must be recreated again with the old CA:\n%s", llamadas(t, dir))
	}
	if !existe(filepath.Join(datos, "caddy/pki/authorities/local/root.key")) || existe(filepath.Join(dir, FicheroCambioCA)) {
		t.Fatal("the old CA stays and nothing is pending")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ca-raiz.crt")); string(b) != "raiz vieja\n" {
		t.Fatal("ca-raiz.crt must not change")
	}
}

func TestCambioCAVuelveSiCaddyNoArranca(t *testing.T) {
	dir, datos, ca := nodoConCAVieja(t)
	_ = os.WriteFile(filepath.Join(dir, "CAE"), nil, 0o600) // https se reinicia en bucle
	c := cambioDePrueba(t, dir, datos, ca.Huella(), func(context.Context, *x509.Certificate, string) error {
		t.Fatal("it must not get to check")
		return nil
	})
	r := c.Aplicar(context.Background())
	if r.Estado != CAFallida || !strings.Contains(r.Detalle, "does not stay up") {
		t.Fatalf("%+v", r)
	}
	if env, _ := LeerEnv(filepath.Join(dir, ".env")); env["CA_NODO"] != "" {
		t.Fatal(".env must be back as it was")
	}
}

func TestCambioCARemataUnoCortado(t *testing.T) {
	dir, datos, ca := nodoConCAVieja(t)
	_ = fijarEnv(filepath.Join(dir, ".env"), "CA_NODO", "nodo")
	_ = os.WriteFile(filepath.Join(dir, FicheroCambioCA), []byte(`{"huella":"`+ca.Huella()+`"}`), 0o600)
	c := cambioDePrueba(t, dir, datos, ca.Huella(), func(context.Context, *x509.Certificate, string) error { return nil })
	r := c.Aplicar(context.Background())
	if r.Estado != CAAplicada {
		t.Fatalf("%+v", r)
	}
	if strings.Contains(llamadas(t, dir), " up ") {
		t.Fatal("https already runs with the new CA: it is not recreated")
	}
	if existe(filepath.Join(datos, "caddy/pki/authorities/local")) || existe(filepath.Join(dir, FicheroCambioCA)) {
		t.Fatal("the old CA must be destroyed and the switch finished")
	}
}

func TestCambioCANoCubreLaDireccion(t *testing.T) {
	dir, datos, ca := nodoConCAVieja(t)
	_ = fijarEnv(filepath.Join(dir, ".env"), "CONSOLA_DOMINIO", "otra.aldanza.local")
	r := cambioDePrueba(t, dir, datos, ca.Huella(), nil).Aplicar(context.Background())
	if r.Estado != CAFallida || !strings.Contains(r.Detalle, "does not cover") {
		t.Fatalf("%+v", r)
	}
}

func TestCambioCAConCertificadoDeLaEmpresa(t *testing.T) {
	dir, datos, ca := nodoConCAVieja(t)
	_ = fijarEnv(filepath.Join(dir, ".env"), "TLS_MODO", "ficheros")
	r := cambioDePrueba(t, dir, datos, ca.Huella(), nil).Aplicar(context.Background())
	if r.Estado != CAFallida || !strings.Contains(r.Detalle, "TLS_MODO=ficheros") {
		t.Fatalf("%+v", r)
	}
}

func TestDestruirCAViejaNoSigueEnlaces(t *testing.T) {
	datos := t.TempDir()
	fuera := filepath.Join(t.TempDir(), "importante")
	_ = os.WriteFile(fuera, []byte("no tocar"), 0o600)
	_ = os.MkdirAll(filepath.Join(datos, "caddy/pki/authorities/local"), 0o700)
	_ = os.Symlink(fuera, filepath.Join(datos, "caddy/pki/authorities/local/root.key"))
	if err := DestruirCAVieja(datos); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(fuera); string(b) != "no tocar" {
		t.Fatal("a symlink must not be followed")
	}
}

func TestLeerResultadoCA(t *testing.T) {
	r := LeerResultadoCA("{\"level\":\"info\"}\n{\"estado\":\"aplicada\",\"detalle\":\"ok\",\"huella\":\"AA\"}\n", 0)
	if r.Estado != CAAplicada || r.Huella != "AA" {
		t.Fatalf("%+v", r)
	}
	if r := LeerResultadoCA("panic\n", 2); r.Estado != CAFallida {
		t.Fatalf("%+v", r)
	}
}

// consolaCA hace de consola para el actualizador: contesta la huella
// confirmada y apunta los informes.
type consolaCA struct {
	cambiar  string
	informes []informeCA
	sinRuta  bool
}

func (c *consolaCA) servidor(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c.sinRuta {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer token" || r.URL.Path != "/api/actualizador/ca" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"cambiar": c.cambiar})
			return
		}
		var i informeCA
		_ = json.NewDecoder(r.Body).Decode(&i)
		c.informes = append(c.informes, i)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func caNodoDePrueba(t *testing.T, c *consolaCA, env string) (*CANodo, *[]PedidoCA) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "versiones.env"), []byte("ACTUALIZADOR_IMAGEN=actualizador:prueba\n"), 0o644)
	srv := c.servidor(t)
	var pedidos []PedidoCA
	n := &CANodo{Consola: srv.URL, Token: "token", HTTP: srv.Client(), Local: dir, Anfitrion: "/opt/sugardaddy", Proyecto: "sugardaddy",
		Lanzar: func(_ context.Context, p PedidoCA) ResultadoCA {
			pedidos = append(pedidos, p)
			// Lo que haría el auxiliar en el .env.
			_ = fijarEnv(filepath.Join(dir, ".env"), "CA_NODO", "nodo")
			return ResultadoCA{Estado: CAAplicada, Huella: p.Huella, Detalle: "ok"}
		}}
	return n, &pedidos
}

func TestCANodoPreparaYEspera(t *testing.T) {
	c := &consolaCA{}
	n, pedidos := caNodoDePrueba(t, c, "TLS_MODO=interno\nCONSOLA_DOMINIO=consola.aldanza.local\nNODO_ID=nodo-x\n")
	if err := n.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	ca, err := canodo.Leer(filepath.Join(n.Local, DirCA))
	if err != nil {
		t.Fatalf("the node CA must be prepared: %v", err)
	}
	if len(c.informes) != 1 || c.informes[0].Modo != "caddy" || c.informes[0].Huella != ca.Huella() || c.informes[0].Raiz != string(ca.RaizPEM()) || c.informes[0].Direccion != "consola.aldanza.local" {
		t.Fatalf("%+v", c.informes)
	}
	if len(*pedidos) != 0 {
		t.Fatal("nothing changes until the administrator confirms")
	}
	// Otra vuelta sin cambios: ni se regenera ni se repite el informe.
	_ = n.Vuelta(context.Background())
	if len(c.informes) != 1 {
		t.Fatalf("%d reports", len(c.informes))
	}
	if otra, _ := canodo.Leer(filepath.Join(n.Local, DirCA)); otra.Huella() != ca.Huella() {
		t.Fatal("the prepared CA must stay the same")
	}
	// Una confirmación de otra raíz no vale.
	c.cambiar = "AA:BB"
	_ = n.Vuelta(context.Background())
	if len(*pedidos) != 0 {
		t.Fatal("a confirmation for another root must not switch")
	}
	// La buena.
	c.cambiar = strings.ToLower(ca.Huella())
	if err := n.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*pedidos) != 1 || (*pedidos)[0].Huella != ca.Huella() || (*pedidos)[0].Imagen != "actualizador:prueba" || (*pedidos)[0].Anfitrion != "/opt/sugardaddy" {
		t.Fatalf("%+v", *pedidos)
	}
	ultimo := c.informes[len(c.informes)-1]
	if ultimo.Modo != "propia" || ultimo.Resultado == nil || ultimo.Resultado.Estado != CAAplicada {
		t.Fatalf("%+v", ultimo)
	}
	// Ya con la propia: se informa sin el resultado, que ya tiene la consola.
	c.cambiar = ""
	n.informado = ""
	_ = n.Vuelta(context.Background())
	if u := c.informes[len(c.informes)-1]; u.Modo != "propia" || u.Resultado != nil || len(*pedidos) != 1 {
		t.Fatalf("%+v", u)
	}
}

func TestCANodoSiCambiaLaDireccionPreparaOtra(t *testing.T) {
	c := &consolaCA{}
	n, _ := caNodoDePrueba(t, c, "CONSOLA_DOMINIO=consola.aldanza.local\n")
	_ = n.Vuelta(context.Background())
	antes := c.informes[0].Huella
	_ = fijarEnv(filepath.Join(n.Local, ".env"), "CONSOLA_DOMINIO", "10.70.0.10")
	_ = n.Vuelta(context.Background())
	if len(c.informes) != 2 || c.informes[1].Huella == antes || c.informes[1].Direccion != "10.70.0.10" {
		t.Fatalf("%+v", c.informes)
	}
}

func TestCANodoConCertificadoDeLaEmpresa(t *testing.T) {
	c := &consolaCA{}
	n, pedidos := caNodoDePrueba(t, c, "TLS_MODO=ficheros\nCONSOLA_DOMINIO=consola.aldanza.local\n")
	_ = n.Vuelta(context.Background())
	if existe(filepath.Join(n.Local, DirCA)) || len(c.informes) != 1 || c.informes[0].Modo != "ficheros" || len(*pedidos) != 0 {
		t.Fatalf("%+v", c.informes)
	}
}

func TestCANodoRemataUnCambioCortado(t *testing.T) {
	c := &consolaCA{}
	n, pedidos := caNodoDePrueba(t, c, "CONSOLA_DOMINIO=consola.aldanza.local\nCA_NODO=nodo\n")
	ca, _ := canodo.Generar(filepath.Join(n.Local, DirCA), "consola.aldanza.local", "", time.Now())
	_ = os.WriteFile(filepath.Join(n.Local, FicheroCambioCA), []byte(`{"huella":"`+ca.Huella()+`"}`), 0o600)
	_ = n.Vuelta(context.Background())
	if len(*pedidos) != 1 || c.informes[0].Modo != "propia" || c.informes[0].Resultado == nil {
		t.Fatalf("%+v %+v", *pedidos, c.informes)
	}
}

func TestCANodoConsolaAnterior(t *testing.T) {
	c := &consolaCA{sinRuta: true}
	n, _ := caNodoDePrueba(t, c, "CONSOLA_DOMINIO=consola.aldanza.local\n")
	if err := n.Vuelta(context.Background()); err != nil {
		t.Fatalf("an older console is not an error: %v", err)
	}
	if _, err := canodo.Leer(filepath.Join(n.Local, DirCA)); err != nil {
		t.Fatal("the CA is prepared anyway")
	}
}

func TestRaizRemota(t *testing.T) {
	_, _, vieja := nodoConCAVieja(t)
	_, _, nueva := nodoConCAVieja(t)
	dir := t.TempDir()
	fichero := filepath.Join(dir, "ca-consola.crt")
	_ = os.WriteFile(fichero, vieja.RaizPEM(), 0o644)
	fi, _ := os.Stat(fichero)
	inodo := fi.Sys().(*syscall.Stat_t).Ino
	ambas := string(vieja.RaizPEM()) + string(nueva.RaizPEM())
	var tiene string
	responder := &ambas
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/sensor/ca" || r.Header.Get("Authorization") != "Bearer token" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		tiene = r.URL.Query().Get("tiene")
		_ = json.NewEncoder(w).Encode(map[string]any{"raices": responder})
	}))
	t.Cleanup(srv.Close)
	probadas := 0
	falla := false
	r := &RaizRemota{Consola: srv.URL, Token: "token", HTTP: srv.Client(), Fichero: fichero,
		Probar: func(_ context.Context, b []byte) error {
			probadas++
			if falla {
				return errors.New("x509: certificate signed by unknown authority")
			}
			return nil
		}}
	if err := r.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(vieja.RaizPEM())
	if tiene != hex.EncodeToString(h[:]) {
		t.Fatal("it must say which roots it has")
	}
	b, _ := os.ReadFile(fichero)
	fi, _ = os.Stat(fichero)
	if string(b) != ambas || fi.Sys().(*syscall.Stat_t).Ino != inodo || probadas != 1 {
		t.Fatal("both roots must be written in place, after checking them")
	}
	// Sin cambios: nada.
	_ = r.Vuelta(context.Background())
	if probadas != 1 {
		t.Fatal("same roots: nothing to do")
	}
	// Unas que la consola no usa: no se escriben.
	solo := string(nueva.RaizPEM())
	responder, falla = &solo, true
	if err := r.Vuelta(context.Background()); err == nil {
		t.Fatal("roots the console does not answer with must be an error")
	}
	if b, _ := os.ReadFile(fichero); string(b) != ambas {
		t.Fatal("and must not be written")
	}
	// Algo que no son certificados de CA.
	falla = false
	basura := "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
	responder = &basura
	if err := r.Vuelta(context.Background()); err == nil || probadas != 2 {
		t.Fatalf("invalid roots must be rejected before trying them (%v, %d)", err, probadas)
	}
	// La consola no tiene nada que dar (certificado de la empresa): no se toca.
	responder = nil
	if err := r.Vuelta(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(fichero); string(b) != ambas {
		t.Fatal("nothing to change")
	}
}

// B2: una versión que se quedó a medias antes del cambio de CA deja su copia
// (con un .env sin CA_NODO). Si la siguiente falla y vuelve a esa copia, el
// nodo no puede volver a la CA de Caddy.
func TestVolverAtrasUnaVersionNoQuitaLaCAPropia(t *testing.T) {
	n := nuevoNodo(t)
	buena := filepath.Join(n.dir, ".respaldo", "20261016T110000Z")
	_ = os.MkdirAll(buena, 0o700)
	_ = os.WriteFile(filepath.Join(buena, "compose.yml"), []byte(leer(t, n.dir, "compose.yml")), 0o644)
	_ = os.WriteFile(filepath.Join(buena, "Caddyfile"), []byte("viejo\n"), 0o644)
	_ = os.WriteFile(filepath.Join(buena, ".env"), []byte(leer(t, n.dir, ".env")), 0o600)
	_ = GuardarResultado(n.dir, Resultado{Version: "0.12.0", Estado: "aplicando", Copia: buena})
	// Después, el nodo pasó a su CA propia.
	_ = fijarEnv(filepath.Join(n.dir, ".env"), "CA_NODO", "nodo")
	_ = os.WriteFile(filepath.Join(n.dir, "FALLA"), nil, 0o644)
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if r.Estado != "fallida" {
		t.Fatalf("%+v", r)
	}
	env, _ := LeerEnv(filepath.Join(n.dir, ".env"))
	if env["CA_NODO"] != "nodo" {
		t.Fatalf("going back to an older copy must keep CA_NODO=nodo:\n%s", leer(t, n.dir, ".env"))
	}
	if env["POSTGRES_PASSWORD"] != "no-tocar" || leer(t, n.dir, "Caddyfile") != "viejo\n" {
		t.Fatal("the rest comes back from the copy")
	}
}

// Lo mismo en un sensor remoto: su ca-consola.crt de ahora (con la raíz nueva)
// no vuelve a uno de la copia con solo la vieja.
func TestVolverAtrasNoQuitaLasRaicesDeUnSensorRemoto(t *testing.T) {
	_, _, vieja := nodoConCAVieja(t)
	_, _, nueva := nodoConCAVieja(t)
	dir := t.TempDir()
	copia := t.TempDir()
	ambas := append(vieja.RaizPEM(), nueva.RaizPEM()...)
	_ = os.WriteFile(filepath.Join(dir, "ca-consola.crt"), ambas, 0o644)
	_ = os.WriteFile(filepath.Join(copia, "ca-consola.crt"), vieja.RaizPEM(), 0o644)
	_ = os.WriteFile(filepath.Join(copia, ".env"), []byte("A=1\n"), 0o600)
	a := &Aplicacion{Dir: dir, Modo: ModoSensorRemoto}
	if err := a.restaurar(copia); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ca-consola.crt")); !bytes.Equal(b, ambas) {
		t.Fatal("the current roots must stay")
	}
	// Uno vacío o roto sí vuelve a la copia, como siempre.
	_ = os.WriteFile(filepath.Join(dir, "ca-consola.crt"), []byte("roto"), 0o644)
	_ = a.restaurar(copia)
	if b, _ := os.ReadFile(filepath.Join(dir, "ca-consola.crt")); !bytes.Equal(b, vieja.RaizPEM()) {
		t.Fatal("a broken file comes back from the copy")
	}
}

func TestCANodoNoCambiaConUnaVersionAMedias(t *testing.T) {
	c := &consolaCA{}
	n, pedidos := caNodoDePrueba(t, c, "CONSOLA_DOMINIO=consola.aldanza.local\n")
	_ = n.Vuelta(context.Background())
	c.cambiar = c.informes[0].Huella
	_ = GuardarResultado(n.Local, Resultado{Version: "0.30.0", Estado: "aplicando", Copia: "/x"})
	_ = n.Vuelta(context.Background())
	if len(*pedidos) != 0 {
		t.Fatal("no switch while a version is half-applied")
	}
	if u := c.informes[len(c.informes)-1]; !strings.Contains(u.Error, "half-done") {
		t.Fatalf("the console must be told why: %+v", u)
	}
	_ = GuardarResultado(n.Local, Resultado{Version: "0.30.0", Estado: "aplicada"})
	_ = n.Vuelta(context.Background())
	if len(*pedidos) != 1 {
		t.Fatal("once a version is applied whole, it switches")
	}
}

func TestCANodoPoneLosScriptsDeCopias(t *testing.T) {
	c := &consolaCA{}
	n, _ := caNodoDePrueba(t, c, "TLS_MODO=ficheros\n")
	_ = n.Vuelta(context.Background())
	b, _ := os.ReadFile(filepath.Join(n.Local, "copia.sh"))
	if !bytes.Contains(b, []byte("ca-nodo")) {
		t.Fatal("copia.sh of this version must be in the node folder")
	}
}

// A12: si rematar falla siempre (la clave vieja no se deja borrar), no se
// lanza un auxiliar en cada vuelta: espera 1 min, 2, 4…
func TestCANodoEsperaTrasUnFallo(t *testing.T) {
	c := &consolaCA{}
	n, _ := caNodoDePrueba(t, c, "CONSOLA_DOMINIO=consola.aldanza.local\nCA_NODO=nodo\n")
	ca, _ := canodo.Generar(filepath.Join(n.Local, DirCA), "consola.aldanza.local", "", time.Now())
	_ = os.WriteFile(filepath.Join(n.Local, FicheroCambioCA), []byte(`{"huella":"`+ca.Huella()+`"}`), 0o600)
	ahora := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	n.Ahora = func() time.Time { return ahora }
	lanzados := 0
	n.Lanzar = func(context.Context, PedidoCA) ResultadoCA {
		lanzados++
		return ResultadoCA{Estado: CAFallida, Detalle: "permission denied"}
	}
	vuelta := func(d time.Duration) { ahora = ahora.Add(d); _ = n.Vuelta(context.Background()) }
	vuelta(0)
	vuelta(30 * time.Second)
	if lanzados != 1 {
		t.Fatalf("%d helpers in 30 s", lanzados)
	}
	vuelta(31 * time.Second) // 1 min después del primero
	if lanzados != 2 {
		t.Fatalf("after a minute it tries again: %d", lanzados)
	}
	vuelta(90 * time.Second) // ahora espera 2 min
	if lanzados != 2 {
		t.Fatalf("the wait grows: %d", lanzados)
	}
	vuelta(31 * time.Second)
	if lanzados != 3 {
		t.Fatalf("after two minutes it tries again: %d", lanzados)
	}
	n.espera = 50 * time.Minute
	n.apuntarResultado(ResultadoCA{Estado: CAFallida})
	if n.espera != time.Hour {
		t.Fatalf("at most an hour: %v", n.espera)
	}
}

// Con un copia.sh en marcha, no se destruye ni se limpia: queda pendiente.
func TestCambioCAEsperaAUnaCopiaEnMarcha(t *testing.T) {
	dir, datos, ca := nodoConCAVieja(t)
	f, _ := os.OpenFile(filepath.Join(dir, "copias", ".cerrojo"), os.O_RDWR|os.O_CREATE, 0o600)
	defer f.Close()
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
	c := cambioDePrueba(t, dir, datos, ca.Huella(), func(context.Context, *x509.Certificate, string) error { return nil })
	c.EsperaCerrojo = time.Second
	r := c.Aplicar(context.Background())
	if r.Estado != CAFallida || !strings.Contains(r.Detalle, "copia.sh") {
		t.Fatalf("%+v", r)
	}
	if !existe(filepath.Join(datos, "caddy/pki/authorities/local/root.key")) || !existe(filepath.Join(dir, FicheroCambioCA)) {
		t.Fatal("nothing destroyed yet, and the switch stays pending to be finished")
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	if r := c.Aplicar(context.Background()); r.Estado != CAAplicada {
		t.Fatalf("then it finishes: %+v", r)
	}
}
