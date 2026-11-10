package actualizador

import (
	"archive/tar"
	"bytes"
	"crypto/rand"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/canodo"
)

// tarDeCopia arma una copia como la de copia.sh: el volcado, .env y la carpeta
// /data de Caddy bajo caddy/, con la CA de antes y la propia.
func tarDeCopia(t *testing.T, grande int) []byte {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	volcado := make([]byte, grande)
	_, _ = rand.Read(volcado)
	ficheros := []struct {
		nombre string
		datos  []byte
	}{
		{"./consola.dump", volcado},
		{"./.env", []byte("POSTGRES_PASSWORD=x\n")},
		{"./caddy/caddy/pki/authorities/local/root.crt", []byte("raiz vieja")},
		{"./caddy/caddy/pki/authorities/local/root.key", []byte("CLAVE VIEJA")},
		{"./caddy/caddy/pki/authorities/local/intermediate.key", []byte("CLAVE VIEJA 2")},
		{"./caddy/caddy/certificates/local/consola.local/consola.local.key", []byte("hoja vieja")},
		{"./caddy/caddy/certificates/nodo/consola.local/consola.local.crt", []byte("hoja nueva")},
		{"./ca-nodo/raiz.crt", []byte("raiz nueva")},
	}
	for _, d := range []string{"./", "./caddy/", "./caddy/caddy/", "./caddy/caddy/pki/", "./caddy/caddy/pki/authorities/", "./caddy/caddy/pki/authorities/local/"} {
		_ = tw.WriteHeader(&tar.Header{Name: d, Typeflag: tar.TypeDir, Mode: 0o700})
	}
	for _, f := range ficheros {
		_ = tw.WriteHeader(&tar.Header{Name: f.nombre, Mode: 0o600, Size: int64(len(f.datos))})
		_, _ = tw.Write(f.datos)
	}
	_ = tw.Close()
	return b.Bytes()
}

func nombresDelTar(t *testing.T, b []byte) []string {
	t.Helper()
	tr := tar.NewReader(bytes.NewReader(b))
	var n []string
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		n = append(n, h.Name)
	}
	sort.Strings(n)
	return n
}

func cifrarGo(t *testing.T, claro []byte, clave string) []byte {
	t.Helper()
	var b bytes.Buffer
	c, err := nuevoCifrador(&b, clave)
	if err != nil {
		t.Fatal(err)
	}
	// En trozos raros, para probar el búfer.
	for i := 0; i < len(claro); i += 7777 {
		_, _ = c.Write(claro[i:min(i+7777, len(claro))])
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func descifrarGo(t *testing.T, cifrado []byte, clave string) ([]byte, error) {
	t.Helper()
	d, err := nuevoDescifrador(bytes.NewReader(cifrado), clave)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(d)
}

func TestCifradoIdaYVuelta(t *testing.T) {
	for _, n := range []int{0, 1, 15, 16, 17, 64*1024 - 1, 64 * 1024, 200001} {
		claro := make([]byte, n)
		_, _ = rand.Read(claro)
		got, err := descifrarGo(t, cifrarGo(t, claro, "clave"), "clave")
		if err != nil || !bytes.Equal(got, claro) {
			t.Fatalf("%d bytes: %v", n, err)
		}
	}
	if _, err := descifrarGo(t, cifrarGo(t, []byte("hola"), "buena"), "mala"); err == nil {
		t.Fatal("a wrong key must be an error")
	}
	c := cifrarGo(t, make([]byte, 100), "k")
	if _, err := descifrarGo(t, c[:len(c)-5], "k"); err == nil {
		t.Fatal("a truncated backup must be an error")
	}
}

// Con el openssl de verdad, en los dos sentidos: lo que cifra copia.sh lo lee
// esto, y lo que escribe esto lo lee restaurar.sh.
func TestCompatibleConOpenSSL(t *testing.T) {
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("no openssl")
	}
	dir := t.TempDir()
	claveF := filepath.Join(dir, "clave-copias")
	_ = os.WriteFile(claveF, []byte("Zm9vYmFyYmF6cXV4cXV1eA9xvJ2s4Y1PuK3KfQ1Lr6V0d3Bk4m6m7m8n9o0p1q2r3s4\n"), 0o600)
	claro := tarDeCopia(t, 300000)
	en := filepath.Join(dir, "claro")
	_ = os.WriteFile(en, claro, 0o600)
	cif := filepath.Join(dir, "c.enc")
	if out, err := exec.Command("openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt", "-pass", "file:"+claveF, "-in", en, "-out", cif).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	b, _ := os.ReadFile(cif)
	clave, err := claveDeCopias(claveF)
	if err != nil {
		t.Fatal(err)
	}
	got, err := descifrarGo(t, b, clave)
	if err != nil || !bytes.Equal(got, claro) {
		t.Fatalf("Go cannot read what openssl wrote: %v", err)
	}
	_ = os.WriteFile(cif, cifrarGo(t, claro, clave), 0o600)
	out, err := exec.Command("openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-pass", "file:"+claveF, "-in", cif).Output()
	if err != nil || !bytes.Equal(out, claro) {
		t.Fatalf("openssl cannot read what Go wrote: %v", err)
	}
}

func TestLimpiarCopias(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "copias"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "clave-copias"), []byte("la-clave\n"), 0o600)
	if _, err := canodo.Generar(filepath.Join(dir, DirCA), "consola.local", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	con := tarDeCopia(t, 1000)
	_ = os.WriteFile(filepath.Join(dir, "copias", "sugardaddy-20261101-031500.tar.enc"), cifrarGo(t, con, "la-clave"), 0o600)
	// Una copia ya sin la CA vieja: no se reescribe.
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	_ = tw.WriteHeader(&tar.Header{Name: "./consola.dump", Mode: 0o600, Size: 2})
	_, _ = tw.Write([]byte("ok"))
	_ = tw.Close()
	sinCA := cifrarGo(t, b.Bytes(), "la-clave")
	limpia := filepath.Join(dir, "copias", "sugardaddy-20261102-031500.tar.enc")
	_ = os.WriteFile(limpia, sinCA, 0o600)
	// Una cifrada con otra clave: no se puede leer, no se toca.
	otra := cifrarGo(t, con, "otra")
	ajena := filepath.Join(dir, "copias", "sugardaddy-20261103-031500.tar.enc")
	_ = os.WriteFile(ajena, otra, 0o600)

	r, err := LimpiarCopias(dir)
	if err != nil {
		t.Fatal(err)
	}
	if r.Limpias != 1 || len(r.Ilegibles) != 1 || r.Ilegibles[0] != "sugardaddy-20261103-031500.tar.enc" {
		t.Fatalf("%+v", r)
	}
	nueva, _ := os.ReadFile(filepath.Join(dir, "copias", "sugardaddy-20261101-031500.tar.enc"))
	claro, err := descifrarGo(t, nueva, "la-clave")
	if err != nil {
		t.Fatal(err)
	}
	nombres := strings.Join(nombresDelTar(t, claro), "\n")
	if strings.Contains(nombres, "/local") || bytes.Contains(claro, []byte("CLAVE VIEJA")) || bytes.Contains(claro, []byte("hoja vieja")) {
		t.Fatalf("the old CA is still in the backup:\n%s", nombres)
	}
	for _, queda := range []string{"./consola.dump", "./.env", "./caddy/caddy/certificates/nodo/consola.local/consola.local.crt", "./ca-nodo/raiz.crt", "./caddy/caddy/pki/authorities/"} {
		if !strings.Contains(nombres, queda) {
			t.Fatalf("%s must stay in the backup:\n%s", queda, nombres)
		}
	}
	if fi, _ := os.Stat(filepath.Join(dir, "copias", "sugardaddy-20261101-031500.tar.enc")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	if b, _ := os.ReadFile(limpia); !bytes.Equal(b, sinCA) {
		t.Fatal("a backup without the old CA must not be rewritten")
	}
	if b, _ := os.ReadFile(ajena); !bytes.Equal(b, otra) {
		t.Fatal("an unreadable backup must not be touched")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "copias", "*.tmp")); len(m) != 0 {
		t.Fatalf("temporary files left: %v", m)
	}
	// Otra pasada: ya no hay nada que quitar.
	if r, _ := LimpiarCopias(dir); r.Limpias != 0 {
		t.Fatalf("second pass: %+v", r)
	}
}

func TestDeLaCAVieja(t *testing.T) {
	si := []string{"./caddy/caddy/pki/authorities/local/root.key", "caddy/caddy/pki/authorities/local", "./caddy/caddy/certificates/local/x/x.key", "./caddy/pki/authorities/local/"}
	no := []string{"./caddy/caddy/pki/authorities/nodo/x", "./caddy/caddy/certificates/nodo/x.crt", "./consola.dump", "./otra/pki/authorities/local/root.key", "./caddy/caddy/pki/authorities/localidad/x", "./caddy/caddy/pki/authorities/"}
	for _, n := range si {
		if !deLaCAVieja(n) {
			t.Errorf("%s must be removed", n)
		}
	}
	for _, n := range no {
		if deLaCAVieja(n) {
			t.Errorf("%s must stay", n)
		}
	}
}

// contenidoDelTar devuelve lo que hay en cada entrada (y su modo) de una copia en claro.
func contenidoDelTar(t *testing.T, b []byte) map[string]*tar.Header {
	t.Helper()
	tr := tar.NewReader(bytes.NewReader(b))
	m := map[string]*tar.Header{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return m
		}
		if err != nil {
			t.Fatal(err)
		}
		datos, _ := io.ReadAll(tr)
		h.PAXRecords = map[string]string{"datos": string(datos)}
		m[h.Name] = h
	}
}

// Una copia de antes del cambio: sin ca-nodo/, con la CA de Caddy y su raíz.
func tarDeAntesDelCambio(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for _, f := range []struct{ n, d string }{
		{"./consola.dump", "volcado"},
		{"./.env", "POSTGRES_PASSWORD=x\nCA_NODO=\nTLS_MODO=interno"},
		{"./ca-raiz.crt", "raiz vieja"},
		{"./caddy/caddy/pki/authorities/local/root.key", "CLAVE VIEJA"},
	} {
		_ = tw.WriteHeader(&tar.Header{Name: f.n, Mode: 0o600, Size: int64(len(f.d))})
		_, _ = tw.Write([]byte(f.d))
	}
	_ = tw.Close()
	return b.Bytes()
}

// A5: una copia de antes del cambio, ya sin la CA de Caddy, se tiene que poder
// restaurar en otra máquina con la raíz que tienen los equipos.
func TestLimpiarCopiasLesPoneLaCAPropia(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "copias"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "clave-copias"), []byte("k\n"), 0o600)
	ca, err := canodo.Generar(filepath.Join(dir, DirCA), "consola.local", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	copia := filepath.Join(dir, "copias", "sugardaddy-20261101-031500.tar.enc")
	viejo := cifrarGo(t, tarDeAntesDelCambio(t), "k")
	_ = os.WriteFile(copia, viejo, 0o600)
	// Un enlace duro al fichero de antes: lo que ve es lo que queda en disco del viejo.
	enlace := filepath.Join(t.TempDir(), "enlace")
	if err := os.Link(copia, enlace); err != nil {
		t.Fatal(err)
	}
	if r, err := LimpiarCopias(dir); err != nil || r.Limpias != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	b, _ := os.ReadFile(copia)
	claro, err := descifrarGo(t, b, "k")
	if err != nil {
		t.Fatal(err)
	}
	m := contenidoDelTar(t, claro)
	if _, ok := m["./caddy/caddy/pki/authorities/local/root.key"]; ok {
		t.Fatal("the old CA is still there")
	}
	env := m["./.env"].PAXRecords["datos"]
	if env != "POSTGRES_PASSWORD=x\nTLS_MODO=interno\nCA_NODO=nodo\n" {
		t.Fatalf(".env: %q", env)
	}
	if m["./ca-raiz.crt"].PAXRecords["datos"] != string(ca.RaizPEM()) {
		t.Fatal("ca-raiz.crt must be the new root")
	}
	for _, n := range []string{"raiz.crt", "intermedia.crt", "intermedia.key"} {
		h := m["./ca-nodo/"+n]
		propio, _ := os.ReadFile(filepath.Join(dir, DirCA, n))
		if h == nil || h.PAXRecords["datos"] != string(propio) {
			t.Fatalf("ca-nodo/%s must be in the backup", n)
		}
	}
	if m["./ca-nodo/intermedia.key"].Mode != 0o600 || m["./ca-nodo/"].Mode != 0o700 {
		t.Fatal("the key keeps its modes")
	}
	if m["./consola.dump"].PAXRecords["datos"] != "volcado" {
		t.Fatal("the rest stays")
	}
	// Lo que quedó del fichero viejo ya no es la copia cifrada.
	quedo, _ := os.ReadFile(enlace)
	if len(quedo) != len(viejo) || bytes.Equal(quedo, viejo) {
		t.Fatal("the old file must be overwritten before it is replaced")
	}
	if _, err := descifrarGo(t, quedo, "k"); err == nil {
		t.Fatal("what is left of the old file must not decrypt")
	}
	// Y la lee el tar de verdad, como restaurar.sh.
	if _, err := exec.LookPath("openssl"); err == nil {
		out, err := exec.Command("sh", "-c", "openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:"+filepath.Join(dir, "clave-copias")+" -in "+copia+" | tar -tvf -").CombinedOutput()
		if err != nil || !strings.Contains(string(out), "ca-nodo/intermedia.key") {
			t.Fatalf("%v\n%s", err, out)
		}
	}
}

// A11: copia.sh y la limpieza no van a la vez.
func TestCerrojoDeCopias(t *testing.T) {
	dir := t.TempDir()
	soltar, err := cerrojoCopias(dir, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// Otro (como copia.sh con flock) no lo coge mientras tanto.
	f, _ := os.OpenFile(filepath.Join(dir, "copias", ".cerrojo"), os.O_RDWR, 0)
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
		t.Fatal("the lock must be held")
	}
	soltar()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("released: %v", err)
	}
	if _, err := cerrojoCopias(dir, 1500*time.Millisecond); err == nil || !strings.Contains(err.Error(), "copia.sh") {
		t.Fatalf("while a backup runs it waits and then says so: %v", err)
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
