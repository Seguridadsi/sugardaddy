package actualizador

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
)

// dockerFalso responde lo justo de la API de Docker por un socket unix. Hay
// un contenedor de https; si existe <dir>/CAE, se reinicia en bucle.
func dockerFalso(t *testing.T, dir string) string {
	t.Helper()
	return dockerFalsoComo(t, dir, motorfalso.Docker24)
}

// dockerFalsoComo es dockerFalso con la versión y la API de un motor concreto.
func dockerFalsoComo(t *testing.T, dir string, m motorfalso.Motor) string {
	t.Helper()
	// Ruta corta: macOS no admite rutas de socket de más de 104 caracteres.
	base, err := os.MkdirTemp("", "sd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var reinicios atomic.Int64
	srv := &http.Server{Handler: motorfalso.Envolver(m, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/version"):
			_, _ = w.Write([]byte(`{"ApiVersion":"1.43"}`))
		case strings.HasSuffix(r.URL.Path, "/containers/json"):
			_, _ = w.Write([]byte(`[{"Id":"https","Names":["/sugardaddy-https-1"],"State":"running","Labels":{"com.docker.compose.project":"sugardaddy","com.docker.compose.service":"https"}}]`))
		case strings.HasSuffix(r.URL.Path, "/containers/https/json"):
			reinicios.Add(1)
			n := 0
			if _, err := os.Stat(filepath.Join(dir, "CAE")); err == nil {
				n = int(reinicios.Load())
			}
			_, _ = fmt.Fprintf(w, `{"State":{"Running":true},"RestartCount":%d}`, n)
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sock
}

// composeFalso apunta sus argumentos y falla en «up» si existe el fichero
// FALLA, y en «validate» si existe CADDY_MALO. «cp» deja <dir>/RAIZ en el
// destino, o un enlace a .env si existe ENLACE.
func composeFalso(t *testing.T, dir string) string {
	t.Helper()
	ruta := filepath.Join(t.TempDir(), "compose")
	script := "#!/bin/sh\necho \"$@\" >> " + dir + "/.llamadas\n" +
		"case \"$*\" in *' up '*) [ -f " + dir + "/FALLA ] && { echo 'consola no ha quedado sana' ; exit 1; } ;; esac\n" +
		"case \"$*\" in *' validate '*) [ -f " + dir + "/CADDY_MALO ] && { echo 'unrecognized directive' ; exit 1; } ;; esac\n" +
		"case \"$*\" in *' cp '*) for d; do :; done; if [ -f " + dir + "/ENLACE ]; then ln -s " + dir + "/.env \"$d\"; elif [ -f " + dir + "/RAIZ ]; then cp " + dir + "/RAIZ \"$d\"; fi ;; esac\n" +
		"case \"$*\" in *'--images'*) echo 'r/consola@sha256:1' ;; esac\nexit 0\n"
	if err := os.WriteFile(ruta, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return ruta
}

type nodoDePrueba struct {
	dir  string
	priv ed25519.PrivateKey
	app  *Aplicacion
}

const envOriginal = "# secretos\nPOSTGRES_PASSWORD=\"no-tocar\"\nNODO_NOMBRE=\"Grupo Aldanza\"\nPUBLICACION_CLAVE_PUBLICA=%s\n"

func nuevoNodo(t *testing.T) *nodoDePrueba {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	dir := t.TempDir()
	escribir := func(n, s string, p os.FileMode) {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(s), p); err != nil {
			t.Fatal(err)
		}
	}
	escribir(".env", strings.Replace(envOriginal, "%s", base64.StdEncoding.EncodeToString(der), 1), 0o600)
	escribir("compose.yml", "services:\n  postgres:\n    image: postgres:17-alpine@sha256:x\n", 0o644)
	escribir("versiones.env", "SUGARDADDY_VERSION=0.11.0\n", 0o644)
	escribir("Caddyfile", "viejo\n", 0o644)
	n := 0
	return &nodoDePrueba{dir: dir, priv: priv, app: &Aplicacion{
		Dir: dir, Modo: ModoNodo, Proyecto: "sugardaddy", Compose: composeFalso(t, dir),
		Docker: docker.Nuevo(dockerFalso(t, dir)), Log: func(string, ...any) {},
		Ahora: func() time.Time { n++; return time.Date(2026, 10, 16, 12, 0, n, 0, time.UTC) },
		Pausa: time.Millisecond,
	}}
}

func (n *nodoDePrueba) firmada(t *testing.T, r Release) ReleaseFirmada {
	t.Helper()
	b, _ := json.Marshal(r)
	return ReleaseFirmada{Release: string(b), Firma: base64.StdEncoding.EncodeToString(ed25519.Sign(n.priv, b))}
}

func releaseConConfiguracion(compose string) Release {
	r := Release{
		Version: "0.12.0", Servicios: map[string]string{"consola": "r/consola@sha256:" + strings.Repeat("a", 64)},
		Actualizador: "r/actualizador@sha256:" + strings.Repeat("b", 64),
		Nodo:         &Configuracion{Ficheros: map[string]string{"compose.yml": compose, "Caddyfile": "nuevo\n"}},
	}
	r.Nodo.Entorno = &struct {
		Nuevas  map[string]string `json:"nuevas,omitempty"`
		Generar []string          `json:"generar,omitempty"`
	}{Nuevas: map[string]string{"TLS_MODO": "interno", "POSTGRES_PASSWORD": "pisado"}, Generar: []string{"SECRETO_NUEVO"}}
	return r
}

func leer(t *testing.T, dir, n string) string {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(dir, n))
	return string(b)
}

func TestAplicarConfiguracion(t *testing.T) {
	n := nuevoNodo(t)
	antes := leer(t, n.dir, ".env")
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services:\n  postgres:\n    image: postgres:17-alpine@sha256:y\n")))
	if r.Estado != "aplicada" || r.Version != "0.12.0" {
		t.Fatalf("resultado: %+v", r)
	}
	env := leer(t, n.dir, ".env")
	if !strings.HasPrefix(env, antes) {
		t.Fatalf(".env solo puede ganar líneas al final:\n%s", env)
	}
	if !strings.Contains(env, "\nTLS_MODO=interno\n") || !strings.Contains(env, "\nSECRETO_NUEVO=") {
		t.Fatalf("faltan las variables nuevas:\n%s", env)
	}
	if strings.Contains(env, "pisado") {
		t.Fatal("una variable que ya existía no se cambia nunca")
	}
	if ConfiguracionAplicada(filepath.Join(n.dir, "versiones.env")) != "0.12.0" || !strings.Contains(leer(t, n.dir, "versiones.env"), "ACTUALIZADOR_IMAGEN=r/actualizador@") {
		t.Fatalf("versiones.env:\n%s", leer(t, n.dir, "versiones.env"))
	}
	if leer(t, n.dir, "Caddyfile") != "nuevo\n" {
		t.Fatal("el Caddyfile firmado tenía que escribirse")
	}
	llamadas := leer(t, n.dir, ".llamadas")
	for _, quiero := range []string{"config -q", "config --images", "up -d --wait", "--remove-orphans", "restart https"} {
		if !strings.Contains(llamadas, quiero) {
			t.Fatalf("falta la llamada %q:\n%s", quiero, llamadas)
		}
	}
	if fi, _ := os.Stat(filepath.Join(n.dir, ".env")); fi.Mode().Perm() != 0o600 {
		t.Fatalf(".env tiene que seguir siendo 0600: %v", fi.Mode().Perm())
	}
}

// Docker 29.0 a 29.2 no admiten la API 1.43 que antes iba fija: con la
// versión negociada, la configuración se aplica.
func TestAplicaConDocker29(t *testing.T) {
	n := nuevoNodo(t)
	n.app.Docker = docker.Nuevo(dockerFalsoComo(t, n.dir, motorfalso.Docker29_0))
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if r.Estado != "aplicada" {
		t.Fatalf("resultado: %+v", r)
	}
}

// Un Docker 20.10 de distribución (Debian 11, Ubuntu 20.04) no se rechaza
// por su número: habla la API 1.41, que es lo que necesitan compose y el
// auxiliar.
func TestAplicaConUnDocker20_10DeDistribucion(t *testing.T) {
	for _, m := range []motorfalso.Motor{motorfalso.Docker20_10_5, motorfalso.Docker20_10_7Ubuntu} {
		n := nuevoNodo(t)
		n.app.Docker = docker.Nuevo(dockerFalsoComo(t, n.dir, m))
		r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
		if r.Estado != "aplicada" {
			t.Fatalf("Docker %s: %+v", m.Version, r)
		}
	}
}

// Con un motor por debajo del mínimo no se toca nada y se dice qué hace falta.
func TestConUnMotorAntiguoNoTocaNada(t *testing.T) {
	n := nuevoNodo(t)
	n.app.Docker = docker.Nuevo(dockerFalsoComo(t, n.dir, motorfalso.Docker19))
	antes := leer(t, n.dir, "compose.yml")
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if r.Estado != "fallida" || !strings.Contains(r.Detalle, docker.MotorAntiguo) || !strings.Contains(r.Detalle, "Docker 20.10 o posterior") {
		t.Fatalf("resultado: %+v", r)
	}
	if leer(t, n.dir, ".llamadas") != "" || leer(t, n.dir, "compose.yml") != antes {
		t.Fatal("con un motor antiguo no se toca nada")
	}
}

func TestSiFallaVuelveExactamenteALoAnterior(t *testing.T) {
	n := nuevoNodo(t)
	antes := map[string]string{}
	for _, f := range []string{".env", "compose.yml", "versiones.env", "Caddyfile"} {
		antes[f] = leer(t, n.dir, f)
	}
	_ = os.WriteFile(filepath.Join(n.dir, "FALLA"), nil, 0o644)
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if r.Estado != "fallida" || !strings.Contains(r.Detalle, "consola no ha quedado sana") {
		t.Fatalf("resultado: %+v", r)
	}
	for f, s := range antes {
		if leer(t, n.dir, f) != s {
			t.Fatalf("%s no ha quedado idéntico:\n%s", f, leer(t, n.dir, f))
		}
	}
	if strings.Count(leer(t, n.dir, ".llamadas"), " up ") != 2 {
		t.Fatal("tras restaurar hay que volver a levantar lo anterior")
	}
}

func TestNoCambiaLaVersionMayorDePostgres(t *testing.T) {
	n := nuevoNodo(t)
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services:\n  postgres:\n    image: postgres:18-alpine@sha256:z\n")))
	if r.Estado != "fallida" || !strings.Contains(r.Detalle, "Postgres de 17 a 18") {
		t.Fatalf("resultado: %+v", r)
	}
	if !strings.Contains(leer(t, n.dir, "compose.yml"), "postgres:17") {
		t.Fatal("no se puede tocar nada")
	}
}

func TestSinFirmaValidaNoSeTocaNada(t *testing.T) {
	n := nuevoNodo(t)
	f := n.firmada(t, releaseConConfiguracion("services: {}\n"))
	f.Release = strings.Replace(f.Release, "0.12.0", "0.12.1", 1)
	r := n.app.Aplicar(context.Background(), f)
	if r.Estado != "fallida" || !strings.Contains(r.Detalle, "no está firmada") {
		t.Fatalf("resultado: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(n.dir, ".llamadas")); err == nil {
		t.Fatal("con una firma mala no se llama a compose")
	}
}

func TestConfiguracionNoPermitida(t *testing.T) {
	n := nuevoNodo(t)
	r := releaseConConfiguracion("services: {}\n")
	r.Nodo.Ficheros[".env"] = "PUBLICACION_CLAVE_PUBLICA=otra\n"
	res := n.app.Aplicar(context.Background(), n.firmada(t, r))
	if res.Estado != "fallida" || !strings.Contains(res.Detalle, "fichero no permitido") {
		t.Fatalf("una versión no puede escribir .env entero: %+v", res)
	}
}

func TestCaddyfileQueCaddyNoAceptaNoSeLevanta(t *testing.T) {
	n := nuevoNodo(t)
	_ = os.WriteFile(filepath.Join(n.dir, "CADDY_MALO"), nil, 0o644)
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if r.Estado != "fallida" || !strings.Contains(r.Detalle, "Caddy no acepta el Caddyfile") {
		t.Fatalf("resultado: %+v", r)
	}
	if leer(t, n.dir, "Caddyfile") != "viejo\n" {
		t.Fatal("hay que volver al Caddyfile anterior")
	}
	llamadas := leer(t, n.dir, ".llamadas")
	if strings.Index(llamadas, " validate ") > strings.Index(llamadas, " up ") {
		t.Fatalf("se valida antes de levantar nada:\n%s", llamadas)
	}
	if strings.Contains(llamadas, "restart https") {
		t.Fatal("https no llegó a ver el Caddyfile nuevo: no hay que reiniciarlo")
	}
}

func TestHttpsQueSeCaeVuelveAtras(t *testing.T) {
	n := nuevoNodo(t)
	_ = os.WriteFile(filepath.Join(n.dir, "CAE"), nil, 0o644)
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if r.Estado != "fallida" || !strings.Contains(r.Detalle, "https no aguanta en marcha") {
		t.Fatalf("un https en bucle de reinicios no es «aplicada»: %+v", r)
	}
	if leer(t, n.dir, "Caddyfile") != "viejo\n" {
		t.Fatal("hay que volver al Caddyfile anterior")
	}
	if strings.Count(leer(t, n.dir, ".llamadas"), "restart https") != 2 {
		t.Fatal("tras restaurar el Caddyfile hay que reiniciar https otra vez")
	}
}

func TestUnaPasadaAMediasSeRetomaDesdeSuCopia(t *testing.T) {
	n := nuevoNodo(t)
	// La pasada anterior copió lo bueno, escribió la mitad y murió.
	buena := filepath.Join(n.dir, ".respaldo", "20261016T110000Z")
	_ = os.MkdirAll(buena, 0o700)
	original := leer(t, n.dir, "compose.yml")
	_ = os.WriteFile(filepath.Join(buena, "compose.yml"), []byte(original), 0o644)
	_ = os.WriteFile(filepath.Join(buena, "Caddyfile"), []byte("viejo\n"), 0o644)
	_ = os.WriteFile(filepath.Join(buena, ".env"), []byte(leer(t, n.dir, ".env")), 0o600)
	_ = os.WriteFile(filepath.Join(n.dir, "compose.yml"), []byte("services: {} # a medias\n"), 0o644)
	_ = GuardarResultado(n.dir, Resultado{Version: "0.12.0", Estado: "aplicando", Copia: buena})

	_ = os.WriteFile(filepath.Join(n.dir, "FALLA"), nil, 0o644)
	r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if r.Estado != "fallida" {
		t.Fatalf("resultado: %+v", r)
	}
	if leer(t, n.dir, "compose.yml") != original {
		t.Fatalf("hay que volver a la copia buena, no a lo que quedó a medias:\n%s", leer(t, n.dir, "compose.yml"))
	}
}

func TestElDiarioDiceQueSeEstaAplicando(t *testing.T) {
	n := nuevoNodo(t)
	_ = GuardarResultado(n.dir, Resultado{Version: "0.11.9", Estado: "fallida", Informado: false})
	_ = os.WriteFile(filepath.Join(n.dir, "FALLA"), nil, 0o644)
	// El compose falso deja ver el diario en el momento del «up».
	n.app.Compose = composeQueMiraElDiario(t, n.dir)
	n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n")))
	if d := leer(t, n.dir, ".diario-en-up"); !strings.Contains(d, `"estado": "aplicando"`) || !strings.Contains(d, ".respaldo") {
		t.Fatalf("mientras se aplica, el diario tiene que decirlo (y su copia):\n%s", d)
	}
}

func composeQueMiraElDiario(t *testing.T, dir string) string {
	t.Helper()
	ruta := filepath.Join(t.TempDir(), "compose")
	script := "#!/bin/sh\ncase \"$*\" in *' up '*) cp " + dir + "/.aplicacion.json " + dir + "/.diario-en-up 2>/dev/null; exit 1 ;; esac\nexit 0\n"
	if err := os.WriteFile(ruta, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return ruta
}

func raizDePrueba(t *testing.T) []byte {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	plantilla := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Caddy Local Authority"},
		NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, plantilla, plantilla, pub, priv)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func inodo(t *testing.T, ruta string) uint64 {
	t.Helper()
	fi, err := os.Lstat(ruta)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Sys().(*syscall.Stat_t).Ino
}

func TestLaRaizSeEscribeEncimaSinCambiarElInodo(t *testing.T) {
	n := nuevoNodo(t)
	raiz := raizDePrueba(t)
	_ = os.WriteFile(filepath.Join(n.dir, "RAIZ"), raiz, 0o600)
	destino := filepath.Join(n.dir, "ca-raiz.crt")
	_ = os.WriteFile(destino, nil, 0o600)
	antes := inodo(t, destino)
	if r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n"))); r.Estado != "aplicada" {
		t.Fatalf("resultado: %+v", r)
	}
	if leer(t, n.dir, "ca-raiz.crt") != string(raiz) {
		t.Fatal("ca-raiz.crt tiene que llevar la raíz de Caddy")
	}
	if inodo(t, destino) != antes {
		t.Fatal("la consola monta ca-raiz.crt suelto: hay que escribir encima, sin cambiar el inodo")
	}
	if fi, _ := os.Stat(destino); fi.Mode().Perm() != 0o644 {
		t.Fatalf("la consola tiene que poder leerla: %v", fi.Mode().Perm())
	}
}

func TestUnaRaizQueEsUnEnlaceNoSeSigue(t *testing.T) {
	n := nuevoNodo(t)
	_ = os.WriteFile(filepath.Join(n.dir, "ENLACE"), nil, 0o644)
	_ = os.WriteFile(filepath.Join(n.dir, "ca-raiz.crt"), nil, 0o644)
	if r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n"))); r.Estado != "aplicada" {
		t.Fatalf("resultado: %+v", r)
	}
	if fi, _ := os.Stat(filepath.Join(n.dir, ".env")); fi.Mode().Perm() != 0o600 {
		t.Fatalf(".env no puede acabar legible: %v", fi.Mode().Perm())
	}
	if fi, _ := os.Lstat(filepath.Join(n.dir, "ca-raiz.crt")); !fi.Mode().IsRegular() || leer(t, n.dir, "ca-raiz.crt") != "" {
		t.Fatal("ca-raiz.crt sigue siendo el fichero vacío de antes")
	}
}

func TestUnEnlaceEnLugarDeCaRaizSeSustituye(t *testing.T) {
	n := nuevoNodo(t)
	raiz := raizDePrueba(t)
	_ = os.WriteFile(filepath.Join(n.dir, "RAIZ"), raiz, 0o600)
	_ = os.Symlink(filepath.Join(n.dir, ".env"), filepath.Join(n.dir, "ca-raiz.crt"))
	if r := n.app.Aplicar(context.Background(), n.firmada(t, releaseConConfiguracion("services: {}\n"))); r.Estado != "aplicada" {
		t.Fatalf("resultado: %+v", r)
	}
	if fi, _ := os.Stat(filepath.Join(n.dir, ".env")); fi.Mode().Perm() != 0o600 || !strings.Contains(leer(t, n.dir, ".env"), "no-tocar") {
		t.Fatal(".env no se toca")
	}
	if fi, _ := os.Lstat(filepath.Join(n.dir, "ca-raiz.crt")); !fi.Mode().IsRegular() || leer(t, n.dir, "ca-raiz.crt") != string(raiz) {
		t.Fatal("el enlace se sustituye por un fichero con la raíz")
	}
	if !strings.Contains(leer(t, n.dir, ".llamadas"), "restart consola") {
		t.Fatal("con un fichero nuevo, la consola se reinicia para verlo")
	}
}
