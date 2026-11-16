package copias

// Un contenedor de Azure Blob con una URL SAS (la del contenedor, con permisos
// de crear, escribir, leer, listar y borrar; sin la clave de la cuenta). Put
// Blob, Get Blob, Delete Blob y List Blobs, nada más.
//
// Inmutable: con la inmutabilidad por versión activada en el contenedor (y el
// permiso «i» en la SAS), cada copia sube con su política
// (x-ms-immutability-policy-until-date y -mode: Locked para «compliance»,
// Unlocked para «governance»). También vale una política de retención del
// contenedor entero, que pone el cliente en Azure: entonces Azure no deja
// borrar y se avisa (ErrBloqueada).

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// AzConfig: la URL SAS del contenedor y la carpeta dentro de él.
type AzConfig struct {
	URL     string `json:"url"`
	Prefijo string `json:"prefijo"`
}

// La versión del servicio: admite Put Blob de hasta 5000 MiB y la inmutabilidad por versión.
const versionAzure = "2021-12-02"

func (c *AzConfig) partes() (*url.URL, url.Values, error) {
	u, err := url.Parse(strings.TrimSpace(c.URL))
	if err != nil || u.Host == "" {
		return nil, nil, errors.New("azure: the SAS URL is not a URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && esLocal(u.Hostname())) {
		return nil, nil, errors.New("azure: the SAS URL must start with https://")
	}
	q := u.Query()
	if q.Get("sig") == "" || q.Get("sv") == "" {
		return nil, nil, errors.New("azure: the URL has no SAS (sv=…&sig=…): generate one for the container")
	}
	// La ruta es la del contenedor: /contenedor (o /cuenta/contenedor en Azurite).
	p := strings.Trim(u.Path, "/")
	if p == "" {
		return nil, nil, errors.New("azure: the SAS URL must point to a container, not to the account")
	}
	return u, q, nil
}

// esLocal: solo para probar con Azurite en la propia máquina; fuera, siempre https.
func esLocal(h string) bool { return h == "localhost" || h == "127.0.0.1" }

func (c *AzConfig) validar() error {
	if _, _, err := c.partes(); err != nil {
		return err
	}
	_, err := Prefijo(c.Prefijo)
	return err
}

// sasDe: la firma y la SAS entera, para taparlas en los errores.
func sasDe(u string) []string {
	p, err := url.Parse(strings.TrimSpace(u))
	if err != nil {
		return []string{u}
	}
	q := p.Query()
	out := []string{p.RawQuery, q.Get("sig"), url.QueryEscape(q.Get("sig"))}
	return out
}

// Azure es el destino Azure Blob.
type Azure struct {
	C         AzConfig
	Inmutable *Inmutable
	HTTP      *http.Client
	Ahora     func() time.Time
}

func (a *Azure) ahora() time.Time {
	if a.Ahora != nil {
		return a.Ahora().UTC()
	}
	return time.Now().UTC()
}

func (a *Azure) urlBlob(nombre string) (string, error) {
	u, _, err := a.C.partes()
	if err != nil {
		return "", err
	}
	p, _ := Prefijo(a.C.Prefijo)
	u.Path = strings.TrimRight(u.Path, "/") + "/" + p + nombre
	return u.String(), nil
}

func (a *Azure) pedir(ctx context.Context, metodo, destino string, cuerpo io.Reader, largo int64, cab map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, metodo, destino, cuerpo)
	if err != nil {
		return nil, err
	}
	if cuerpo != nil {
		req.ContentLength = largo
	}
	req.Header.Set("x-ms-version", versionAzure)
	req.Header.Set("x-ms-date", a.ahora().Format(http.TimeFormat))
	for k, v := range cab {
		req.Header.Set(k, v)
	}
	resp, err := a.HTTP.Do(req)
	if err != nil {
		// El error de net/http repite la URL, con la SAS.
		return nil, errors.New(Tapar(err.Error(), sasDe(a.C.URL)))
	}
	return resp, nil
}

func errorAzure(resp *http.Response) (string, error) {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	var e struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	_ = xml.Unmarshal(b, &e)
	codigo := e.Code
	if codigo == "" {
		codigo = resp.Header.Get("x-ms-error-code")
	}
	msg := strings.SplitN(e.Message, "\n", 2)[0]
	if codigo != "" {
		return codigo, fmt.Errorf("azure: %s %s: %s", resp.Status, codigo, recortar(msg, 200))
	}
	return "", fmt.Errorf("azure: %s", resp.Status)
}

// Subir: un Put Blob del fichero entero (hasta 5000 MiB).
func (a *Azure) Subir(ctx context.Context, nombre, ruta, suma string, largo int64) error {
	destino, err := a.urlBlob(nombre)
	if err != nil {
		return err
	}
	f, err := os.Open(ruta)
	if err != nil {
		return err
	}
	defer f.Close()
	cab := map[string]string{
		"x-ms-blob-type":   "BlockBlob",
		"Content-Type":     "application/octet-stream",
		"x-ms-meta-sha256": suma,
	}
	if a.Inmutable.activa() {
		modo := "Locked"
		if a.Inmutable.Modo == "governance" {
			modo = "Unlocked"
		}
		cab["x-ms-immutability-policy-until-date"] = a.Inmutable.Hasta(a.ahora()).Format(http.TimeFormat)
		cab["x-ms-immutability-policy-mode"] = modo
	}
	resp, err := a.pedir(ctx, http.MethodPut, destino, f, largo, cab)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		_, e := errorAzure(resp)
		return e
	}
	return nil
}

// Listar: List Blobs con el prefijo, página a página.
func (a *Azure) Listar(ctx context.Context) ([]Remota, error) {
	u, q, err := a.C.partes()
	if err != nil {
		return nil, err
	}
	p, _ := Prefijo(a.C.Prefijo)
	var out []Remota
	marcador := ""
	for pagina := 0; pagina < 100; pagina++ {
		q2 := url.Values{}
		for k, v := range q {
			q2[k] = v
		}
		q2.Set("restype", "container")
		q2.Set("comp", "list")
		if p != "" {
			q2.Set("prefix", p)
		}
		if marcador != "" {
			q2.Set("marker", marcador)
		}
		u2 := *u
		u2.RawQuery = q2.Encode()
		resp, err := a.pedir(ctx, http.MethodGet, u2.String(), nil, 0, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			_, e := errorAzure(resp)
			resp.Body.Close()
			return nil, e
		}
		var r struct {
			Blobs []struct {
				Name  string `xml:"Name"`
				Props struct {
					Largo int64 `xml:"Content-Length"`
				} `xml:"Properties"`
			} `xml:"Blobs>Blob"`
			NextMarker string `xml:"NextMarker"`
		}
		err = xml.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&r)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("azure: list: %w", err)
		}
		for _, b := range r.Blobs {
			n := strings.TrimPrefix(b.Name, p)
			if NombreCopia.MatchString(n) {
				out = append(out, Remota{Nombre: n, Bytes: b.Props.Largo})
			}
		}
		if r.NextMarker == "" {
			Ordenar(out)
			return out, nil
		}
		marcador = r.NextMarker
	}
	return nil, errors.New("azure: too many pages")
}

// Borrar: Delete Blob. Si la inmutabilidad no lo deja, ErrBloqueada.
func (a *Azure) Borrar(ctx context.Context, nombre string) error {
	destino, err := a.urlBlob(nombre)
	if err != nil {
		return err
	}
	resp, err := a.pedir(ctx, http.MethodDelete, destino, nil, 0, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	codigo, e := errorAzure(resp)
	if resp.StatusCode == http.StatusConflict && strings.Contains(codigo, "Immutab") {
		return fmt.Errorf("%w (%v)", ErrBloqueada, e)
	}
	return e
}

// Bajar: Get Blob.
func (a *Azure) Bajar(ctx context.Context, nombre string, w io.Writer) error {
	destino, err := a.urlBlob(nombre)
	if err != nil {
		return err
	}
	resp, err := a.pedir(ctx, http.MethodGet, destino, nil, 0, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, e := errorAzure(resp)
		return e
	}
	_, err = io.Copy(w, resp.Body)
	return err
}
