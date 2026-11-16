package actualizador

// La CA de sensores en el HTTPS de la consola (docs/diseno/mtls-sensores.md).
//
// La consola crea la CA que firma los certificados de cliente de los sensores
// remotos; Caddy tiene que pedir certificado de cliente con su raíz. Caddy la
// lee de CA_SENSORES en .env (el DER en base64), así nunca falta un fichero que
// le impida arrancar: sin la variable, no pide certificado. El actualizador
// pregunta a la consola por la raíz y, si no es la de .env, lanza el auxiliar
// de la CA, que la pone y recrea https. Si https no aguanta con ella, vuelve a
// la de antes.

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// RaizSensoresDER valida la raíz que da la consola y la devuelve como la
// quiere Caddy (trust_der): el DER en base64. Solo un certificado de CA.
func RaizSensoresDER(raiz string) (string, error) {
	b, resto := pem.Decode([]byte(raiz))
	if b == nil || b.Type != "CERTIFICATE" || len(bytes.TrimSpace(resto)) > 0 {
		return "", errors.New("not a certificate")
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		return "", err
	}
	if !c.IsCA {
		return "", errors.New("not a CA certificate")
	}
	return base64.StdEncoding.EncodeToString(b.Bytes), nil
}

// AplicarSensores es el trabajo del auxiliar: poner CA_SENSORES en .env y
// recrear https. Siempre devuelve un resultado.
func (c *CambioCA) AplicarSensores(ctx context.Context, nueva string) ResultadoCA {
	var nada ResultadoCopias
	env, err := LeerEnv(c.ruta(".env"))
	if err != nil {
		return c.resultado(CAFallida, "cannot read .env: "+err.Error(), "", nada)
	}
	anterior := env["CA_SENSORES"]
	if anterior == nueva {
		return c.resultado(CAAplicada, "the console HTTPS already asks remote sensors for this CA", "", nada)
	}
	if err := fijarEnv(c.ruta(".env"), "CA_SENSORES", nueva); err != nil {
		return c.resultado(CAFallida, ".env: "+err.Error(), "", nada)
	}
	c.log("console HTTPS: asking remote sensors for a client certificate")
	if out, err := c.recrearHttps(ctx); err != nil {
		detalle := fmt.Sprintf("%v\n%s", err, cola(out, 10))
		if err := fijarEnv(c.ruta(".env"), "CA_SENSORES", anterior); err != nil {
			detalle += "\n.env could not be restored: " + err.Error()
		} else if out, err := c.recrearHttps(context.WithoutCancel(ctx)); err != nil {
			detalle += "\nhttps did not come up as before either: " + err.Error() + "\n" + cola(out, 5)
		}
		return c.resultado(CAFallida, detalle, "", nada)
	}
	return c.resultado(CAAplicada, "the console HTTPS asks remote sensors for a client certificate", "", nada)
}

// CASensores es la parte del actualizador del nodo.
type CASensores struct {
	Docker    *docker.Cliente
	Consola   string
	Token     string
	HTTP      *http.Client
	Local     string // la carpeta del nodo dentro del contenedor
	Anfitrion string // la misma, en el anfitrión (NODO_DIR)
	Proyecto  string
	Log       func(string, ...any)
	// Lanzar corre el auxiliar y espera su resultado; en las pruebas, un doble.
	Lanzar func(ctx context.Context, imagen, nueva string) ResultadoCA
	Ahora  func() time.Time

	espera    time.Duration
	reintento time.Time
}

func (c *CASensores) ahora() time.Time {
	if c.Ahora != nil {
		return c.Ahora()
	}
	return time.Now()
}

// Vuelta pone en .env la raíz de la consola si no es la que hay.
func (c *CASensores) Vuelta(ctx context.Context) error {
	if c.Docker != nil && (AuxiliarEnMarcha(ctx, c.Docker, c.Proyecto) || AuxiliarCAEnMarcha(ctx, c.Docker, c.Proyecto)) {
		return nil
	}
	if c.ahora().Before(c.reintento) {
		return nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Consola+"/api/actualizador/ca-sensores", nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil // una consola anterior
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	var r struct {
		Raiz *string `json:"raiz"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, topeRespuestaConsola)).Decode(&r); err != nil {
		return err
	}
	// Sin CA (el nodo no tiene CLAVE_SECRETOS): no se toca lo que haya.
	if r.Raiz == nil || *r.Raiz == "" {
		return nil
	}
	nueva, err := RaizSensoresDER(*r.Raiz)
	if err != nil {
		return fmt.Errorf("remote sensor CA from the console: %w", err)
	}
	env, err := LeerEnv(filepath.Join(c.Local, ".env"))
	if err != nil {
		return err
	}
	if env["CA_SENSORES"] == nueva {
		return nil
	}
	versiones, err := LeerEnv(filepath.Join(c.Local, "versiones.env"))
	if err != nil || versiones["ACTUALIZADOR_IMAGEN"] == "" {
		return errors.New("versiones.env does not say which updater image to use for the CA helper")
	}
	lanzar := c.Lanzar
	if lanzar == nil {
		lanzar = c.lanzarContenedor
	}
	res := lanzar(ctx, versiones["ACTUALIZADOR_IMAGEN"], nueva)
	if res.Estado != CAAplicada {
		c.espera = min(max(2*c.espera, time.Minute), time.Hour)
		c.reintento = c.ahora().Add(c.espera)
		return errors.New(res.Detalle)
	}
	c.espera, c.reintento = 0, time.Time{}
	if c.Log != nil {
		c.Log("console HTTPS asks remote sensors for a client certificate")
	}
	return nil
}

// lanzarContenedor corre el auxiliar de la CA con la orden ca-sensores: el
// socket (para compose) y la carpeta del nodo en su ruta. Con su propio
// nombre: el resultado de uno que se quedó sin leer no se confunde con el de
// un cambio de la CA del nodo.
func (c *CASensores) lanzarContenedor(ctx context.Context, imagen, nueva string) ResultadoCA {
	fallo := func(m string, err error) ResultadoCA {
		return ResultadoCA{Estado: CAFallida, Detalle: m + ": " + err.Error(), Cuando: c.ahora().UTC().Format(time.RFC3339)}
	}
	if c.Anfitrion == "" {
		return fallo("CA helper", errors.New("NODO_DIR is not set"))
	}
	nombre := NombreAuxiliarCA(c.Proyecto) + "-sensores"
	if err := c.Docker.Borrar(ctx, nombre); err != nil && !docker.NoExiste(err) {
		return fallo("previous CA helper", err)
	}
	if err := c.Docker.AsegurarImagen(ctx, imagen); err != nil {
		return fallo("updater image", err)
	}
	id, err := c.Docker.Crear(ctx, nombre, map[string]any{
		"Image":  imagen,
		"Cmd":    []string{"ca-sensores"},
		"Env":    []string{"CA_DIR=" + c.Anfitrion, "CA_PROYECTO=" + c.Proyecto, "CA_SENSORES_NUEVA=" + nueva},
		"Labels": map[string]string{"sugardaddy.auxiliar": "ca-sensores"},
		"HostConfig": map[string]any{
			"Binds":          []string{"/var/run/docker.sock:/var/run/docker.sock", c.Anfitrion + ":" + c.Anfitrion},
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges"},
			"Tmpfs":          map[string]string{"/tmp": "rw,nosuid,size=64m"},
			"NetworkMode":    "bridge",
			"RestartPolicy":  map[string]string{"Name": "no"},
			"LogConfig":      docker.RegistrosAcotados(),
		},
	})
	if err != nil {
		return fallo("CA helper", err)
	}
	if err := c.Docker.Arrancar(ctx, id); err != nil {
		_ = c.Docker.Borrar(context.WithoutCancel(ctx), id)
		return fallo("CA helper", err)
	}
	espera, cancelar := context.WithTimeout(ctx, EsperaCambioCA+time.Minute)
	defer cancelar()
	codigo, err := c.Docker.Esperar(espera, id)
	if err != nil {
		return fallo("CA helper", err)
	}
	salida, _ := c.Docker.Salida(ctx, id, 30)
	_ = c.Docker.Borrar(context.WithoutCancel(ctx), id)
	return LeerResultadoCA(salida, codigo)
}
