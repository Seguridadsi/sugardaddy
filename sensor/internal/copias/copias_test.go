package copias

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestPrefijo(t *testing.T) {
	for entra, sale := range map[string]string{"": "", "/": "", "nodo": "nodo/", "/a/b/": "a/b/", " copias/madrid ": "copias/madrid/"} {
		if p, err := Prefijo(entra); err != nil || p != sale {
			t.Errorf("Prefijo(%q) = %q, %v; quería %q", entra, p, err, sale)
		}
	}
	for _, mal := range []string{"..", "a/../b", "a//b", "a b", "a?b", "a\\b"} {
		if _, err := Prefijo(mal); err == nil {
			t.Errorf("Prefijo(%q) debería fallar", mal)
		}
	}
}

func TestSobrantes(t *testing.T) {
	r := []Remota{{Nombre: "sugardaddy-20261101-031500.tar.age"}, {Nombre: "sugardaddy-20261103-031500.tar.age"}, {Nombre: "sugardaddy-20261102-031500.tar.age"}}
	s := Sobrantes(r, 2)
	if len(s) != 1 || s[0].Nombre != "sugardaddy-20261101-031500.tar.age" {
		t.Fatalf("sobrantes: %v", s)
	}
	if Sobrantes(r, 3) != nil || len(Sobrantes(r, 0)) != 2 {
		t.Fatal("conservar 3 no borra nada; 0 cuenta como 1")
	}
}

func TestValidar(t *testing.T) {
	bien := []Config{
		{Tipo: TipoS3, S3: &S3Config{Region: "us-east-1", Bucket: "copias-banco", ClaveID: "a", ClaveSecreta: "b", Endpoint: "https://minio.local:9000"}},
		{Tipo: TipoS3, S3: &S3Config{Region: "eu-west-1", Bucket: "copias", ClaveID: "a", ClaveSecreta: "b"}, Inmutable: &Inmutable{Dias: 30, Modo: "compliance"}},
		{Tipo: TipoAzure, Azure: &AzConfig{URL: "https://cuenta.blob.core.windows.net/copias?sv=2022-11-02&sp=racwdl&sig=abc%3D"}},
		{Tipo: TipoSMB, SMB: &SMBCfg{Servidor: "nas.empresa.local", Recurso: "Copias$", Usuario: "sd", Clave: "x,y", Cifrado: true}},
		{Tipo: TipoSMB, SMB: &SMBCfg{Servidor: "10.0.0.5", Recurso: "copias", Usuario: "EMPRESA.sd", Clave: "x"}},
	}
	for i, c := range bien {
		if err := c.Validar(); err != nil {
			t.Errorf("%d: %v", i, err)
		}
	}
	mal := []Config{
		{Tipo: "ftp"},
		{Tipo: TipoS3, S3: &S3Config{Region: "us-east-1", Bucket: "Mayus", ClaveID: "a", ClaveSecreta: "b"}},
		{Tipo: TipoS3, S3: &S3Config{Region: "us-east-1", Bucket: "ok-bucket", ClaveID: "a", ClaveSecreta: "b", Endpoint: "https://x/ruta"}},
		{Tipo: TipoS3, S3: &S3Config{Region: "us-east-1", Bucket: "ok-bucket", ClaveID: "a"}},
		{Tipo: TipoS3, S3: &S3Config{Region: "us-east-1", Bucket: "ok-bucket", ClaveID: "a", ClaveSecreta: "b"}, Inmutable: &Inmutable{Dias: 5, Modo: "otro"}},
		{Tipo: TipoAzure, Azure: &AzConfig{URL: "http://cuenta.blob.core.windows.net/copias?sv=1&sig=a"}},
		{Tipo: TipoAzure, Azure: &AzConfig{URL: "https://cuenta.blob.core.windows.net/copias"}},
		{Tipo: TipoAzure, Azure: &AzConfig{URL: "https://cuenta.blob.core.windows.net/?sv=1&sig=a"}},
		{Tipo: TipoSMB, SMB: &SMBCfg{Servidor: "nas", Recurso: "a/b", Usuario: "u", Clave: "c"}},
		{Tipo: TipoSMB, SMB: &SMBCfg{Servidor: "nas;rm", Recurso: "a", Usuario: "u", Clave: "c"}},
		{Tipo: TipoSMB, SMB: &SMBCfg{Servidor: "nas", Recurso: "a", Usuario: "u,v", Clave: "c"}},
		{Tipo: TipoSMB, SMB: &SMBCfg{Servidor: "nas", Recurso: "a", Usuario: "u", Clave: "c"}, Inmutable: &Inmutable{Dias: 5, Modo: "compliance"}},
	}
	for i, c := range mal {
		if err := c.Validar(); err == nil {
			t.Errorf("%d debería fallar", i)
		}
	}
}

// Los vectores de la documentación de AWS (Signature V4 para S3, «GET Bucket
// Lifecycle» y «Get Bucket (List Objects)»).
func TestFirmaSigV4(t *testing.T) {
	s := &S3{C: S3Config{Region: "us-east-1", Bucket: "examplebucket", ClaveID: "AKIAIOSFODNN7EXAMPLE",
		ClaveSecreta: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"},
		Ahora: func() time.Time { return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC) }}
	for url, firma := range map[string]string{
		"https://examplebucket.s3.amazonaws.com/?lifecycle":           "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
		"https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J": "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
	} {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		s.firmar(req, sinCuerpo)
		a := req.Header.Get("Authorization")
		if !strings.HasSuffix(a, "Signature="+firma) || !strings.Contains(a, "SignedHeaders=host;x-amz-content-sha256;x-amz-date") {
			t.Errorf("%s: %s", url, a)
		}
	}
}

func TestS3ContraUnDoble(t *testing.T) {
	var puesto http.Header
	var ruta string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut:
			puesto, ruta = r.Header.Clone(), r.URL.Path
			b, _ := io.ReadAll(r.Body)
			if string(b) != "contenido" {
				w.WriteHeader(400)
			}
		case r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2":
			if r.URL.Query().Get("prefix") != "nodo/" {
				w.WriteHeader(400)
				return
			}
			if r.URL.Query().Get("continuation-token") == "" {
				io.WriteString(w, `<ListBucketResult><Contents><Key>nodo/sugardaddy-20261101-031500.tar.age</Key><Size>10</Size></Contents><Contents><Key>nodo/otra-cosa.txt</Key><Size>1</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>`)
				return
			}
			io.WriteString(w, `<ListBucketResult><Contents><Key>nodo/sugardaddy-20261102-031500.tar.age</Key><Size>20</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`)
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "20261101-031500.tar.age"):
			w.WriteHeader(403)
			io.WriteString(w, `<Error><Code>AccessDenied</Code><Message>Access Denied because object protected by object lock.</Message></Error>`)
		case r.Method == http.MethodDelete:
			w.WriteHeader(204)
		case r.Method == http.MethodGet:
			io.WriteString(w, "bajada")
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	f := filepath.Join(dir, "c")
	os.WriteFile(f, []byte("contenido"), 0o600)
	suma, n, _ := HuellaFichero(f)
	s := &S3{C: S3Config{Endpoint: srv.URL, Region: "us-east-1", Bucket: "copias", Prefijo: "nodo", EstiloRuta: true, ClaveID: "id", ClaveSecreta: "secreto"},
		Inmutable: &Inmutable{Dias: 30, Modo: "compliance"}, HTTP: srv.Client(),
		Ahora: func() time.Time { return time.Date(2026, 11, 15, 3, 0, 0, 0, time.UTC) }}
	ctx := context.Background()
	if err := s.Subir(ctx, "sugardaddy-20261115-031500.tar.age", f, suma, n); err != nil {
		t.Fatal(err)
	}
	if ruta != "/copias/nodo/sugardaddy-20261115-031500.tar.age" || puesto.Get("X-Amz-Object-Lock-Mode") != "COMPLIANCE" ||
		puesto.Get("X-Amz-Object-Lock-Retain-Until-Date") != "2026-12-15T03:00:00Z" || puesto.Get("X-Amz-Checksum-Sha256") == "" ||
		puesto.Get("X-Amz-Content-Sha256") != suma || !strings.Contains(puesto.Get("Authorization"), "x-amz-object-lock-mode") {
		t.Fatalf("PUT: %s %v", ruta, puesto)
	}
	r, err := s.Listar(ctx)
	if err != nil || len(r) != 2 || r[0].Nombre != "sugardaddy-20261102-031500.tar.age" || r[1].Bytes != 10 {
		t.Fatalf("listar: %v %v", r, err)
	}
	if err := s.Borrar(ctx, "sugardaddy-20261102-031500.tar.age"); err != nil {
		t.Fatal(err)
	}
	if err := s.Borrar(ctx, "sugardaddy-20261101-031500.tar.age"); !errors.Is(err, ErrBloqueada) {
		t.Fatalf("bloqueada: %v", err)
	}
	var b bytes.Buffer
	if err := s.Bajar(ctx, "sugardaddy-20261102-031500.tar.age", &b); err != nil || b.String() != "bajada" {
		t.Fatal(err, b.String())
	}
}

func TestAzureContraUnDoble(t *testing.T) {
	var puesto http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("sig") != "firma/secreta=" {
			w.WriteHeader(403)
			return
		}
		switch {
		case r.Method == http.MethodPut:
			puesto = r.Header.Clone()
			if r.URL.Path != "/copias/nodo/sugardaddy-20261115-031500.tar.age" {
				w.WriteHeader(400)
				return
			}
			w.WriteHeader(201)
		case r.Method == http.MethodGet && r.URL.Query().Get("comp") == "list":
			if r.URL.Query().Get("marker") == "" {
				io.WriteString(w, `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>nodo/sugardaddy-20261101-031500.tar.age</Name><Properties><Content-Length>10</Content-Length></Properties></Blob></Blobs><NextMarker>m2</NextMarker></EnumerationResults>`)
				return
			}
			io.WriteString(w, `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>nodo/sugardaddy-20261102-031500.tar.age</Name><Properties><Content-Length>20</Content-Length></Properties></Blob></Blobs><NextMarker/></EnumerationResults>`)
		case r.Method == http.MethodDelete:
			w.Header().Set("x-ms-error-code", "BlobImmutableDueToPolicy")
			w.WriteHeader(409)
			io.WriteString(w, `<?xml version="1.0"?><Error><Code>BlobImmutableDueToPolicy</Code><Message>This operation is not permitted as the blob is immutable due to a policy.</Message></Error>`)
		case r.Method == http.MethodGet:
			io.WriteString(w, "bajada")
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	f := filepath.Join(dir, "c")
	os.WriteFile(f, []byte("contenido"), 0o600)
	a := &Azure{C: AzConfig{URL: srv.URL + "/copias?sv=2022-11-02&sp=racwdli&sig=firma%2Fsecreta%3D", Prefijo: "nodo"},
		Inmutable: &Inmutable{Dias: 7, Modo: "governance"}, HTTP: srv.Client(),
		Ahora: func() time.Time { return time.Date(2026, 11, 15, 3, 0, 0, 0, time.UTC) }}
	if err := a.C.validar(); err != nil {
		t.Fatal(err) // http solo vale en esta máquina (Azurite); httptest escucha en 127.0.0.1
	}
	ctx := context.Background()
	if err := a.Subir(ctx, "sugardaddy-20261115-031500.tar.age", f, "ab", 9); err != nil {
		t.Fatal(err)
	}
	if puesto.Get("x-ms-blob-type") != "BlockBlob" || puesto.Get("x-ms-immutability-policy-mode") != "Unlocked" ||
		puesto.Get("x-ms-immutability-policy-until-date") != "Sun, 22 Nov 2026 03:00:00 GMT" || puesto.Get("x-ms-meta-sha256") != "ab" {
		t.Fatalf("PUT: %v", puesto)
	}
	r, err := a.Listar(ctx)
	if err != nil || len(r) != 2 || r[0].Bytes != 20 {
		t.Fatalf("listar: %v %v", r, err)
	}
	if err := a.Borrar(ctx, "sugardaddy-20261101-031500.tar.age"); !errors.Is(err, ErrBloqueada) {
		t.Fatalf("bloqueada: %v", err)
	}
	// Un error de red no repite la SAS.
	a.C.URL = "https://127.0.0.1:1/copias?sv=1&sig=muysecreta"
	err = a.Bajar(ctx, "sugardaddy-20261101-031500.tar.age", io.Discard)
	if err == nil || strings.Contains(err.Error(), "muysecreta") {
		t.Fatalf("error de red: %v", err)
	}
}

func TestOpcionesMontaje(t *testing.T) {
	c := SMBCfg{Servidor: "nas", Recurso: "Copias$", Usuario: "sd", Clave: "a,b", Dominio: "EMPRESA", Cifrado: true}
	o := c.OpcionesMontaje("10.0.0.5")
	if o["type"] != "cifs" || o["device"] != "//nas/Copias$" ||
		o["o"] != "addr=10.0.0.5,username=sd,password=a,,b,domain=EMPRESA,vers=3,seal,uid=0,gid=0,file_mode=0600,dir_mode=0700,nobrl" {
		t.Fatalf("%v", o)
	}
}

func TestTaparMontaje(t *testing.T) {
	// Docker tapa solo hasta la primera coma de la contraseña.
	e := "mount //nas/c, data: addr=1.2.3.4,username=u,password=********,,Clave-Prueba,uid=0: permission denied"
	if x := TaparMontaje(e, "Mala,Clave-Prueba"); strings.Contains(x, "Clave-Prueba") || !strings.Contains(x, "password=••••,uid=0") {
		t.Fatal(x)
	}
}

func TestConfigAuxiliarSMB(t *testing.T) {
	cfg := ConfigAuxiliarSMB("act@sha256:x", "vol", "/opt/sugardaddy/copias", "nodo", "bajar", "sugardaddy-20261101-031500.tar.age", nil)
	h := cfg["HostConfig"].(map[string]any)
	if h["NetworkMode"] != "none" || h["ReadonlyRootfs"] != true || h["CapDrop"].([]string)[0] != "ALL" {
		t.Fatalf("%v", h)
	}
	b := h["Binds"].([]string)
	if len(b) != 2 || b[0] != "/opt/sugardaddy/copias:/copias:ro" || b[1] != "/opt/sugardaddy/copias/.prueba:/prueba" {
		t.Fatalf("binds %v", b)
	}
	if b := ConfigAuxiliarSMB("i", "v", "/c", "", "subir", "x", nil)["HostConfig"].(map[string]any)["Binds"].([]string); len(b) != 1 {
		t.Fatalf("subir no escribe en copias/: %v", b)
	}
}

func TestAuxiliarCarpeta(t *testing.T) {
	r := Raices{Destino: t.TempDir(), Copias: t.TempDir(), Prueba: t.TempDir()}
	n := "sugardaddy-20261101-031500.tar.age"
	os.WriteFile(filepath.Join(r.Copias, n), []byte("copia"), 0o600)
	var out bytes.Buffer
	ctx := context.Background()
	if Auxiliar(ctx, []string{"subir", n}, "a/b", r, &out) != 0 {
		t.Fatal(out.String())
	}
	if b, _ := os.ReadFile(filepath.Join(r.Destino, "a/b", n)); string(b) != "copia" {
		t.Fatal("no subió")
	}
	out.Reset()
	Auxiliar(ctx, []string{"listar"}, "a/b", r, &out)
	if !strings.Contains(out.String(), `"nombre":"`+n+`","bytes":5`) {
		t.Fatal(out.String())
	}
	if Auxiliar(ctx, []string{"bajar", n}, "a/b", r, io.Discard) != 0 {
		t.Fatal("bajar")
	}
	if b, _ := os.ReadFile(filepath.Join(r.Prueba, n)); string(b) != "copia" {
		t.Fatal("no bajó")
	}
	if Auxiliar(ctx, []string{"borrar", n}, "a/b", r, io.Discard) != 0 {
		t.Fatal("borrar")
	}
	out.Reset()
	if Auxiliar(ctx, []string{"subir", "../../etc/passwd"}, "", r, &out) == 0 || !strings.Contains(out.String(), "not a backup name") {
		t.Fatal("un nombre que no es de copia no se toca")
	}
}

type motorDoble struct {
	volumenes   map[string]map[string]string
	borrados    []string
	errArranque error
	salida      string
}

func (m *motorDoble) CrearVolumen(_ context.Context, n, _ string, o, _ map[string]string) error {
	if m.volumenes == nil {
		m.volumenes = map[string]map[string]string{}
	}
	m.volumenes[n] = o
	return nil
}
func (m *motorDoble) BorrarVolumen(_ context.Context, n string) error {
	m.borrados = append(m.borrados, n)
	return nil
}
func (m *motorDoble) AsegurarImagen(context.Context, string) error { return nil }
func (m *motorDoble) Crear(context.Context, string, map[string]any) (string, error) {
	return "id", nil
}
func (m *motorDoble) Arrancar(context.Context, string) error              { return m.errArranque }
func (m *motorDoble) Esperar(context.Context, string) (int, error)        { return 0, nil }
func (m *motorDoble) Salida(context.Context, string, int) (string, error) { return m.salida, nil }
func (m *motorDoble) Borrar(context.Context, string) error                { return nil }

func TestSMBTapaLaContrasena(t *testing.T) {
	m := &motorDoble{errArranque: errors.New(`error while mounting volume: failed to mount local volume: mount //nas/c:/var/lib/docker/volumes/x/_data, data: addr=10.0.0.5,username=sd,password=Secreta,,1: permission denied`)}
	s := &SMB{C: SMBCfg{Servidor: "10.0.0.5", Recurso: "c", Usuario: "sd", Clave: "Secreta,1"}, Motor: m, Imagen: "i", CopiasAnfitrion: "/c", CopiasLocal: t.TempDir()}
	_, err := s.Listar(context.Background())
	if err == nil || strings.Contains(err.Error(), "Secreta") || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("%v", err)
	}
	if len(m.borrados) != 1 {
		t.Fatal("el volumen con la contraseña se borra siempre")
	}
	m.errArranque, m.salida = nil, `{"remotas":[{"nombre":"sugardaddy-20261101-031500.tar.age","bytes":3}]}`
	r, err := s.Listar(context.Background())
	if err != nil || len(r) != 1 {
		t.Fatal(r, err)
	}
	m.salida = `{"error":"remove x: permission denied","bloqueada":true}`
	if err := s.Borrar(context.Background(), "sugardaddy-20261101-031500.tar.age"); !errors.Is(err, ErrBloqueada) {
		t.Fatal(err)
	}
}

// Un fichero con la forma de age, sin cifrar nada de verdad.
func ageFalso(t *testing.T, cuerpo int, estrofa string) string {
	t.Helper()
	b64 := func(n int) string {
		x := make([]byte, n)
		rand.Read(x)
		return base64.RawStdEncoding.EncodeToString(x)
	}
	if estrofa == "" {
		estrofa = "-> X25519 " + b64(32) + "\n" + b64(32) + "\n"
	}
	cab := "age-encryption.org/v1\n" + estrofa + "--- " + b64(32) + "\n"
	datos := make([]byte, 16+cuerpo)
	f := filepath.Join(t.TempDir(), "c.tar.age")
	os.WriteFile(f, append([]byte(cab), datos...), 0o600)
	return f
}

func TestEstructura(t *testing.T) {
	for _, n := range []int{16, 17, 100, trozoAge, trozoAge + 17, 3 * trozoAge} {
		if d, err := Estructura(ageFalso(t, n, "")); err != nil || d != 1 {
			t.Errorf("cuerpo %d: %d %v", n, d, err)
		}
	}
	for _, n := range []int{0, 15, trozoAge + 16, trozoAge + 3} {
		if _, err := Estructura(ageFalso(t, n, "")); err == nil {
			t.Errorf("cuerpo %d debería fallar", n)
		}
	}
	if _, err := Estructura(ageFalso(t, 100, "-> scrypt c2FsdA 18\nYWJj\n")); err == nil {
		t.Error("sin X25519 no es una copia de copia.sh")
	}
	if _, err := Estructura(ageFalso(t, 100, "-> X25519 corto\nYWJj\n")); err == nil {
		t.Error("X25519 mal formada")
	}
	f := filepath.Join(t.TempDir(), "x")
	os.WriteFile(f, []byte("Salted__abcdefgh"), 0o600)
	if _, err := Estructura(f); err == nil {
		t.Error("no es age")
	}
	if d, err := Estructura("testdata/sugardaddy-20261101-031500.tar.age"); err != nil || d != 1 {
		t.Errorf("la de verdad: %d %v", d, err)
	}
}

func TestComprobarSinClave(t *testing.T) {
	f := "testdata/sugardaddy-20261101-031500.tar.age"
	suma, _, _ := HuellaFichero(f)
	c := Comprobar(context.Background(), f, "x", suma, "", "")
	if c.Resultado != PruebaSinClave || c.Huella != "coincide" || c.Descifrada || !strings.Contains(c.Detalle, "cannot be verified") {
		t.Fatalf("%+v", c)
	}
	if c := Comprobar(context.Background(), f, "x", strings.Repeat("0", 64), "", ""); c.Resultado != PruebaFallo || c.Huella != "distinta" {
		t.Fatalf("%+v", c)
	}
	// Cortada dentro de la cabecera o del nonce: la forma de age ya no cuadra.
	b, _ := os.ReadFile(f)
	g := filepath.Join(t.TempDir(), "cortada")
	fin := bytes.Index(b, []byte("\n---"))
	os.WriteFile(g, b[:fin+60+20], 0o600)
	if c := Comprobar(context.Background(), g, "x", "", "", ""); c.Resultado != PruebaFallo || c.Huella != "sin-apuntar" {
		t.Fatalf("%+v", c)
	}
	// Cortada dentro del último trozo: sin la clave no se nota por la forma (sí por la
	// huella apuntada al subirla, y con la clave, por el MAC). Por eso es «sin-clave».
	os.WriteFile(g, b[:len(b)-5], 0o600)
	if c := Comprobar(context.Background(), g, "x", suma, "", ""); c.Resultado != PruebaFallo || c.Huella != "distinta" {
		t.Fatalf("%+v", c)
	}
}

// Con age instalado (en la imagen del actualizador lo está), la prueba entera.
func TestComprobarConClave(t *testing.T) {
	age, err := exec.LookPath("age")
	if err != nil {
		t.Skip("age no está en esta máquina")
	}
	ctx := context.Background()
	if c := Comprobar(ctx, "testdata/sugardaddy-20261101-031500.tar.age", "x", "", "testdata/clave-prueba.age", age); c.Resultado != PruebaOK || !c.Descifrada || !c.CA {
		t.Fatalf("%+v", c)
	}
	if c := Comprobar(ctx, "testdata/incompleta.tar.age", "x", "", "testdata/clave-prueba.age", age); c.Resultado != PruebaFallo || !strings.Contains(c.Detalle, "versiones.env") {
		t.Fatalf("%+v", c)
	}
	// Un byte cambiado en medio: age lo nota (el MAC del trozo).
	b, _ := os.ReadFile("testdata/sugardaddy-20261101-031500.tar.age")
	b[len(b)-100] ^= 1
	g := filepath.Join(t.TempDir(), "tocada")
	os.WriteFile(g, b, 0o600)
	if c := Comprobar(ctx, g, "x", "", "testdata/clave-prueba.age", age); c.Resultado != PruebaFallo || !strings.Contains(c.Detalle, "cannot be decrypted") {
		t.Fatalf("%+v", c)
	}
}

// Lo que exige la prueba es lo que exige restaurar.sh.
func TestNecesariosComoRestaurar(t *testing.T) {
	b, err := os.ReadFile("../../../despliegue/nodo/restaurar.sh")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^for f in ([^;]+); do`).FindSubmatch(b)
	if m == nil || strings.Join(strings.Fields(string(m[1])), " ") != strings.Join(Necesarios, " ") {
		t.Fatalf("restaurar.sh pide %q; la prueba, %q", m, Necesarios)
	}
}
