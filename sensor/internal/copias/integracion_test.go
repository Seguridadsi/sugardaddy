//go:build integracion

package copias

// Pruebas contra almacenes de verdad: MinIO (S3, también con Object Lock) y Samba
// (SMB, montado por Docker con un auxiliar de verdad). Las lanza
// herramientas/probar-copias-fuera.sh, que levanta los contenedores y pasa por
// entorno dónde están; sin él, `go test` ni las compila (etiqueta «integracion»).

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

func entorno(t *testing.T, claves ...string) []string {
	t.Helper()
	var v []string
	for _, k := range claves {
		x := os.Getenv(k)
		if x == "" {
			t.Skip("falta " + k + " (herramientas/probar-copias-fuera.sh)")
		}
		v = append(v, x)
	}
	return v
}

func copiaDePrueba(t *testing.T, dir, nombre string) (string, string, int64) {
	t.Helper()
	b, err := os.ReadFile("testdata/sugardaddy-20261101-031500.tar.age")
	if err != nil {
		t.Fatal(err)
	}
	ruta := filepath.Join(dir, nombre)
	if err := os.WriteFile(ruta, b, 0o644); err != nil {
		t.Fatal(err)
	}
	suma, n, _ := HuellaFichero(ruta)
	return ruta, suma, n
}

func TestIntegracionS3(t *testing.T) {
	v := entorno(t, "SD_PRUEBA_S3", "SD_PRUEBA_S3_CLAVE", "SD_PRUEBA_S3_SECRETO")
	ctx := context.Background()
	dir := t.TempDir()
	for _, bucket := range []string{"copias", "copias-bloqueadas"} {
		// El bucket, con Object Lock el segundo (solo se puede al crearlo).
		admin := &S3{C: S3Config{Endpoint: v[0], Region: "us-east-1", Bucket: bucket, EstiloRuta: true, ClaveID: v[1], ClaveSecreta: v[2]}, HTTP: http.DefaultClient}
		cab := map[string]string{}
		if bucket == "copias-bloqueadas" {
			cab["X-Amz-Bucket-Object-Lock-Enabled"] = "true"
		}
		if resp, err := admin.pedir(ctx, http.MethodPut, admin.base(), nil, 0, sinCuerpo, cab); err != nil || resp.StatusCode != 200 {
			t.Fatalf("crear %s: %v %v", bucket, err, resp)
		}
		t.Run(bucket, func(t *testing.T) {
			s := &S3{C: S3Config{Endpoint: v[0], Region: "us-east-1", Bucket: bucket, Prefijo: "nodo/madrid", EstiloRuta: true,
				ClaveID: v[1], ClaveSecreta: v[2]}, HTTP: http.DefaultClient}
			if bucket == "copias-bloqueadas" {
				s.Inmutable = &Inmutable{Dias: 1, Modo: "compliance"}
			}
			nombres := []string{"sugardaddy-20261101-031500.tar.age", "sugardaddy-20261102-031500.tar.age", "sugardaddy-20261103-031500.tar.age"}
			var suma string
			for _, n := range nombres {
				ruta, sm, largo := copiaDePrueba(t, dir, n)
				suma = sm
				if err := s.Subir(ctx, n, ruta, sm, largo); err != nil {
					t.Fatal(err)
				}
			}
			r, err := s.Listar(ctx)
			if err != nil || len(r) != 3 || r[0].Nombre != nombres[2] {
				t.Fatalf("listar: %v %v", r, err)
			}
			var b bytes.Buffer
			if err := s.Bajar(ctx, nombres[2], &b); err != nil {
				t.Fatal(err)
			}
			if f := filepath.Join(dir, "bajada"); os.WriteFile(f, b.Bytes(), 0o600) == nil {
				if c := Comprobar(ctx, f, nombres[2], suma, "", ""); c.Resultado != PruebaSinClave || c.Huella != "coincide" {
					t.Fatalf("%+v", c)
				}
			}
			for _, x := range Sobrantes(r, 1) {
				if err := s.Borrar(ctx, x.Nombre); err != nil {
					t.Fatalf("borrar %s: %v", x.Nombre, err)
				}
			}
			if r, _ := s.Listar(ctx); len(r) != 1 {
				t.Fatalf("tras la retención: %v", r)
			}
			if s.Inmutable != nil {
				// Lo «borrado» sigue en el bucket como versión bloqueada: su retención es la pedida.
				u := s.urlObjeto(nombres[2])
				u.RawQuery = url.Values{"retention": {""}}.Encode()
				resp, err := s.pedir(ctx, http.MethodGet, u, nil, 0, sinCuerpo, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				var ret struct {
					Mode            string `xml:"Mode"`
					RetainUntilDate string `xml:"RetainUntilDate"`
				}
				body, _ := io.ReadAll(resp.Body)
				if xml.Unmarshal(body, &ret) != nil || ret.Mode != "COMPLIANCE" || ret.RetainUntilDate == "" {
					t.Fatalf("retención: %s %s", resp.Status, body)
				}
			}
			// Una clave mala: el error lo dice sin repetir el secreto.
			mala := *s
			mala.C.ClaveSecreta = "clave-mala-de-prueba-123"
			if _, err := mala.Listar(ctx); err == nil || !strings.Contains(err.Error(), "SignatureDoesNotMatch") || strings.Contains(err.Error(), "clave-mala") {
				t.Fatalf("clave mala: %v", err)
			}
		})
	}
}

func TestIntegracionSMB(t *testing.T) {
	v := entorno(t, "SD_PRUEBA_SMB", "SD_PRUEBA_SMB_CLAVE", "SD_PRUEBA_IMAGEN", "SD_PRUEBA_COPIAS")
	ctx, cancelar := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancelar()
	d := docker.Nuevo(envO("DOCKER_SOCK", "/var/run/docker.sock"))
	copias := v[3]
	for _, cifrado := range []bool{true, false} {
		s := &SMB{C: SMBCfg{Servidor: v[0], Recurso: "copias", Carpeta: "nodo/madrid", Usuario: "sugardaddy", Clave: v[1], Cifrado: cifrado},
			Motor: d, Imagen: v[2], CopiasAnfitrion: copias, CopiasLocal: copias}
		n := "sugardaddy-20261105-031500.tar.age"
		_, suma, largo := copiaDePrueba(t, copias, n)
		if err := s.Subir(ctx, n, "", suma, largo); err != nil {
			t.Fatalf("subir (cifrado %v): %v", cifrado, err)
		}
		r, err := s.Listar(ctx)
		if err != nil || len(r) == 0 || r[0].Nombre != n || r[0].Bytes != largo {
			t.Fatalf("listar: %v %v", r, err)
		}
		f := filepath.Join(t.TempDir(), "bajada")
		out, _ := os.Create(f)
		if err := s.Bajar(ctx, n, out); err != nil {
			t.Fatal(err)
		}
		out.Close()
		if c := Comprobar(ctx, f, n, suma, "", ""); c.Huella != "coincide" || c.Resultado != PruebaSinClave {
			t.Fatalf("%+v", c)
		}
		if err := s.Borrar(ctx, n); err != nil {
			t.Fatal(err)
		}
		if r, _ := s.Listar(ctx); len(r) != 0 {
			t.Fatalf("tras borrar: %v", r)
		}
	}
	// Una contraseña mala: falla al montar y el error no la repite.
	s := &SMB{C: SMBCfg{Servidor: v[0], Recurso: "copias", Usuario: "sugardaddy", Clave: "Mala,Clave-Prueba"},
		Motor: d, Imagen: v[2], CopiasAnfitrion: copias, CopiasLocal: copias}
	_, err := s.Listar(ctx)
	if err == nil || strings.Contains(err.Error(), "Mala") || strings.Contains(err.Error(), "Clave-Prueba") {
		t.Fatalf("contraseña mala: %v", err)
	}
	t.Logf("contraseña mala: %v", err)
	if vols, _ := d.Volumenes(ctx, map[string][]string{"label": {"sugardaddy.auxiliar=copias"}}); len(vols) != 0 {
		t.Fatalf("quedan volúmenes con la contraseña: %v", vols)
	}
	_ = errors.New
}

func envO(k, porDefecto string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return porDefecto
}
