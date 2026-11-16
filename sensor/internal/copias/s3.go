package copias

// Un bucket compatible con S3 (AWS, MinIO, Wasabi, Ceph, Cloudflare R2…), con
// la firma SigV4 hecha a mano: PUT, GET, DELETE y ListObjectsV2, nada más.
//
// Con Object Lock (Inmutable), cada copia sube con su modo y su fecha de fin
// (x-amz-object-lock-mode, x-amz-object-lock-retain-until-date) y la suma
// SHA-256 que S3 exige en ese caso (x-amz-checksum-sha256). El bucket tiene que
// haberse creado con Object Lock. Borrar en un bucket así no destruye nada: deja
// un marcador de borrado y la versión bloqueada sigue ahí hasta su fecha.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

// S3Config: el bucket y la credencial (una clave de acceso con permiso solo para él).
type S3Config struct {
	// Endpoint: https://s3.eu-west-1.amazonaws.com, https://minio.empresa.local:9000…
	// Vacío: el de AWS para la región.
	Endpoint string `json:"endpoint"`
	Region   string `json:"region"`
	Bucket   string `json:"bucket"`
	Prefijo  string `json:"prefijo"`
	// EstiloRuta: https://servidor/bucket/clave en vez de https://bucket.servidor/clave.
	// Lo que usan MinIO y casi todos los compatibles.
	EstiloRuta   bool   `json:"estiloRuta"`
	ClaveID      string `json:"claveId"`
	ClaveSecreta string `json:"claveSecreta"`
}

var (
	bucketValido = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	regionValida = regexp.MustCompile(`^[a-z0-9-]{2,40}$`)
)

func (c *S3Config) validar() error {
	if !bucketValido.MatchString(c.Bucket) {
		return errors.New("s3: invalid bucket name")
	}
	if !regionValida.MatchString(c.Region) {
		return errors.New("s3: invalid region (for MinIO and most compatible services, us-east-1)")
	}
	if c.ClaveID == "" || c.ClaveSecreta == "" {
		return errors.New("s3: missing access key")
	}
	if _, err := Prefijo(c.Prefijo); err != nil {
		return err
	}
	if c.Endpoint != "" {
		u, err := url.Parse(c.Endpoint)
		if err != nil || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
			return errors.New("s3: the endpoint must be just https://server[:port]")
		}
		if u.Scheme != "https" && u.Scheme != "http" {
			return errors.New("s3: the endpoint must start with https://")
		}
	}
	return nil
}

// S3 es el destino S3.
type S3 struct {
	C         S3Config
	Inmutable *Inmutable
	HTTP      *http.Client
	// Ahora, para las pruebas (la firma lleva la hora).
	Ahora func() time.Time
}

func (s *S3) ahora() time.Time {
	if s.Ahora != nil {
		return s.Ahora().UTC()
	}
	return time.Now().UTC()
}

// base es la URL del bucket, sin barra final.
func (s *S3) base() *url.URL {
	ep := strings.TrimRight(s.C.Endpoint, "/")
	if ep == "" {
		ep = "https://s3." + s.C.Region + ".amazonaws.com"
	}
	u, _ := url.Parse(ep)
	if s.C.EstiloRuta {
		u.Path = "/" + s.C.Bucket
	} else {
		u.Host = s.C.Bucket + "." + u.Host
		u.Path = ""
	}
	return u
}

func (s *S3) prefijo() string { p, _ := Prefijo(s.C.Prefijo); return p }

func (s *S3) urlObjeto(nombre string) *url.URL {
	u := s.base()
	u.Path = u.Path + "/" + s.prefijo() + nombre
	return u
}

const sinCuerpo = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// firmar añade la firma SigV4 a la petición. carga: el SHA-256 en hexadecimal del cuerpo.
func (s *S3) firmar(req *http.Request, carga string) {
	t := s.ahora()
	fecha := t.Format("20060102T150405Z")
	dia := fecha[:8]
	req.Header.Set("X-Amz-Date", fecha)
	req.Header.Set("X-Amz-Content-Sha256", carga)

	// Cabeceras firmadas: host y todas las x-amz-* y content-*, en minúsculas y ordenadas.
	cab := map[string]string{"host": req.URL.Host}
	for k, v := range req.Header {
		l := strings.ToLower(k)
		if strings.HasPrefix(l, "x-amz-") || l == "content-type" || l == "content-md5" {
			cab[l] = strings.Join(v, ",")
		}
	}
	nombres := make([]string, 0, len(cab))
	for k := range cab {
		nombres = append(nombres, k)
	}
	sort.Strings(nombres)
	var canon strings.Builder
	for _, k := range nombres {
		canon.WriteString(k + ":" + strings.TrimSpace(cab[k]) + "\n")
	}
	firmadas := strings.Join(nombres, ";")
	peticion := strings.Join([]string{
		req.Method,
		rutaCanonica(req.URL.Path),
		consultaCanonica(req.URL.Query()),
		canon.String(),
		firmadas,
		carga,
	}, "\n")
	ambito := dia + "/" + s.C.Region + "/s3/aws4_request"
	h := sha256.Sum256([]byte(peticion))
	aFirmar := "AWS4-HMAC-SHA256\n" + fecha + "\n" + ambito + "\n" + hex.EncodeToString(h[:])
	k := hmacDe([]byte("AWS4"+s.C.ClaveSecreta), dia)
	k = hmacDe(k, s.C.Region)
	k = hmacDe(k, "s3")
	k = hmacDe(k, "aws4_request")
	firma := hex.EncodeToString(hmacDe(k, aFirmar))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+s.C.ClaveID+"/"+ambito+
		", SignedHeaders="+firmadas+", Signature="+firma)
}

func hmacDe(clave []byte, dato string) []byte {
	m := hmac.New(sha256.New, clave)
	m.Write([]byte(dato))
	return m.Sum(nil)
}

// codificar como pide SigV4: todo menos A-Z a-z 0-9 - _ . ~ en %XX.
func codificar(s string, barra bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !barra:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func rutaCanonica(p string) string {
	if p == "" {
		return "/"
	}
	return codificar(p, false)
}

func consultaCanonica(q url.Values) string {
	claves := make([]string, 0, len(q))
	for k := range q {
		claves = append(claves, k)
	}
	sort.Strings(claves)
	var partes []string
	for _, k := range claves {
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			partes = append(partes, codificar(k, true)+"="+codificar(v, true))
		}
	}
	return strings.Join(partes, "&")
}

// pedir hace la petición firmada; el cuerpo, si lo hay, es un fichero o bytes.
func (s *S3) pedir(ctx context.Context, metodo string, u *url.URL, cuerpo io.Reader, largo int64, carga string, cab map[string]string) (*http.Response, error) {
	// La consulta se escribe ya codificada como la firma, para que lo que se
	// firma y lo que se manda sean lo mismo.
	u.RawQuery = consultaCanonica(u.Query())
	u.RawPath = rutaCanonica(u.Path)
	req, err := http.NewRequestWithContext(ctx, metodo, u.String(), cuerpo)
	if err != nil {
		return nil, err
	}
	if cuerpo != nil {
		req.ContentLength = largo
	}
	for k, v := range cab {
		req.Header.Set(k, v)
	}
	s.firmar(req, carga)
	return s.HTTP.Do(req)
}

// errorS3 lee el error XML de S3 (Code, Message), sin repetir nada de la petición.
func errorS3(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	var e struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	_ = xml.Unmarshal(b, &e)
	if e.Code != "" {
		return fmt.Errorf("s3: %s %s: %s", resp.Status, e.Code, recortar(e.Message, 200))
	}
	return fmt.Errorf("s3: %s", resp.Status)
}

func recortar(t string, n int) string {
	if len(t) > n {
		return t[:n] + "…"
	}
	return t
}

// Subir: un PUT del fichero entero (S3 admite hasta 5 GB así; una copia del nodo
// es mucho menor).
func (s *S3) Subir(ctx context.Context, nombre, ruta, suma string, largo int64) error {
	f, err := os.Open(ruta)
	if err != nil {
		return err
	}
	defer f.Close()
	cab := map[string]string{
		"Content-Type":      "application/octet-stream",
		"X-Amz-Meta-Sha256": suma,
	}
	if s.Inmutable.activa() {
		bin, _ := hex.DecodeString(suma)
		cab["X-Amz-Checksum-Sha256"] = base64.StdEncoding.EncodeToString(bin)
		cab["X-Amz-Sdk-Checksum-Algorithm"] = "SHA256"
		cab["X-Amz-Object-Lock-Mode"] = strings.ToUpper(s.Inmutable.Modo)
		cab["X-Amz-Object-Lock-Retain-Until-Date"] = s.Inmutable.Hasta(s.ahora()).Format(time.RFC3339)
	}
	resp, err := s.pedir(ctx, http.MethodPut, s.urlObjeto(nombre), f, largo, suma, cab)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errorS3(resp)
	}
	return nil
}

// Listar: ListObjectsV2 con el prefijo, página a página.
func (s *S3) Listar(ctx context.Context) ([]Remota, error) {
	var out []Remota
	token := ""
	for pagina := 0; pagina < 100; pagina++ {
		u := s.base()
		if u.Path == "" {
			u.Path = "/"
		}
		q := url.Values{"list-type": {"2"}, "prefix": {s.prefijo()}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		u.RawQuery = q.Encode()
		resp, err := s.pedir(ctx, http.MethodGet, u, nil, 0, sinCuerpo, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			err := errorS3(resp)
			resp.Body.Close()
			return nil, err
		}
		var r struct {
			Contents []struct {
				Key  string `xml:"Key"`
				Size int64  `xml:"Size"`
			} `xml:"Contents"`
			IsTruncated           bool   `xml:"IsTruncated"`
			NextContinuationToken string `xml:"NextContinuationToken"`
		}
		err = xml.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&r)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("s3: list: %w", err)
		}
		for _, c := range r.Contents {
			n := strings.TrimPrefix(c.Key, s.prefijo())
			if NombreCopia.MatchString(n) {
				out = append(out, Remota{Nombre: n, Bytes: c.Size})
			}
		}
		if !r.IsTruncated || r.NextContinuationToken == "" {
			Ordenar(out)
			return out, nil
		}
		token = r.NextContinuationToken
	}
	return nil, errors.New("s3: too many pages")
}

// Borrar: un DELETE. En un bucket con Object Lock deja un marcador de borrado
// (la versión bloqueada sigue); si aun así S3 se niega, ErrBloqueada.
func (s *S3) Borrar(ctx context.Context, nombre string) error {
	resp, err := s.pedir(ctx, http.MethodDelete, s.urlObjeto(nombre), nil, 0, sinCuerpo, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	e := errorS3(resp)
	if resp.StatusCode == http.StatusForbidden && strings.Contains(e.Error(), "AccessDenied") && s.Inmutable.activa() {
		return fmt.Errorf("%w (%v)", ErrBloqueada, e)
	}
	return e
}

// Bajar: un GET.
func (s *S3) Bajar(ctx context.Context, nombre string, w io.Writer) error {
	resp, err := s.pedir(ctx, http.MethodGet, s.urlObjeto(nombre), nil, 0, sinCuerpo, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errorS3(resp)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}
