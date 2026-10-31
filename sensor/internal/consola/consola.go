// Package consola es el lado del sensor de la API de la consola. Toda
// conexión la abre el sensor.
package consola

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/relevo"
)

type Cliente struct {
	Base  string
	Token string
	http  *http.Client
	// Registro: este sensor tiene credencial del registro privado. Se dice al
	// pedir el plan; si no, la consola le da la imagen pública de cada trampa.
	Registro bool
	// Version del sensor, que se dice al pedir el plan: la consola no le manda
	// trampas que piden un sensor más nuevo.
	Version string
}

func Nuevo(base, token string) *Cliente {
	return NuevoCon(base, token, &http.Client{Timeout: 30 * time.Second})
}

// NuevoCon usa un cliente HTTP ya armado (p. ej., con la CA de la consola).
func NuevoCon(base, token string, h *http.Client) *Cliente {
	return &Cliente{Base: base, Token: token, http: h}
}

func (c *Cliente) peticion(ctx context.Context, metodo, ruta, tipo string, cuerpo []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, metodo, c.Base+ruta, bytes.NewReader(cuerpo))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if tipo != "" {
		req.Header.Set("Content-Type", tipo)
	}
	return c.http.Do(req)
}

func (c *Cliente) Plan(ctx context.Context) (plan.Plan, error) {
	var p plan.Plan
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/api/sensor/plan", nil)
	if err != nil {
		return p, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if c.Registro {
		req.Header.Set("Sugardaddy-Registro", "si")
	}
	if c.Version != "" {
		req.Header.Set("Sugardaddy-Version", c.Version)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return p, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return p, fmt.Errorf("plan: %d %s", resp.StatusCode, b)
	}
	err = json.NewDecoder(resp.Body).Decode(&p)
	if p.Trampas == nil {
		p.Trampas = p.Senuelos
	}
	return p, err
}

// Informar dice a la consola cómo han quedado las trampas y, desde la
// 0.13.1, cómo es su motor de contenedores y lo que se sabe de la máquina
// (hechos con espacio de nombres, como red.ipOrigenReal). Una consola
// anterior solo lee las trampas.
func (c *Cliente) Informar(ctx context.Context, estados, motor any, hechos map[string]any) error {
	b, _ := json.Marshal(map[string]any{"trampas": estados, "motor": motor, "hechos": hechos})
	resp, err := c.peticion(ctx, http.MethodPost, "/api/sensor/estado", "application/json", b)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("estado: %d", resp.StatusCode)
	}
	return nil
}

// ErrDemasiadoGrande: la consola no admite una entrega de ese tamaño. Se
// reintenta con menos líneas, nunca con las mismas.
var ErrDemasiadoGrande = errors.New("entrega demasiado grande para la consola")

type Recepcion struct {
	OK         bool   `json:"ok"`
	Aceptadas  int    `json:"aceptadas"`
	UltimoHash string `json:"ultimoHash"`
	Linea      int    `json:"linea"`
	Motivo     string `json:"motivo"`
}

// Entregar manda líneas tal cual, en NDJSON. Devuelve cuántas aceptó la
// consola; si cortó la cadena, también por qué.
func (c *Cliente) Entregar(ctx context.Context, lineas [][]byte) (Recepcion, error) {
	var r Recepcion
	cuerpo := append(bytes.Join(lineas, []byte("\n")), '\n')
	resp, err := c.peticion(ctx, http.MethodPost, "/api/sensor/eventos", "application/x-ndjson", cuerpo)
	if err != nil {
		return r, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusRequestEntityTooLarge {
		return r, ErrDemasiadoGrande
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusConflict {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return r, fmt.Errorf("eventos: %d %s", resp.StatusCode, b)
	}
	return r, json.NewDecoder(resp.Body).Decode(&r)
}

// ErrArtefactoRechazado: la consola no quiere esta copia y NO hay que
// reintentar — la captura está apagada (403), es demasiado grande (413) o el
// contenido no cuadra (400). El sensor la descarta.
var ErrArtefactoRechazado = errors.New("la consola rechaza la copia del artefacto")

// ErrEventoNoVisto: la consola aún no conoce el evento del artefacto (404).
// Es transitorio: el evento llega en una entrega posterior; se reintenta.
var ErrEventoNoVisto = errors.New("la consola no conoce aún el evento del artefacto")

// SubirArtefacto sube la COPIA de un fichero que capturó una trampa (el binario
// que el atacante mandó traer o dejó). Los metadatos van en la query y el
// contenido en el cuerpo. Idempotente: la consola deduplica por sha256. Ver
// docs/diseno/captura-artefactos.md.
func (c *Cliente) SubirArtefacto(ctx context.Context, evento, tipo, sha256, nombre string, cuerpo []byte) error {
	q := url.Values{"evento": {evento}, "tipo": {tipo}, "sha256": {sha256}}
	if nombre != "" {
		q.Set("nombre", nombre)
	}
	resp, err := c.peticion(ctx, http.MethodPost, "/api/sensor/artefactos?"+q.Encode(), "application/octet-stream", cuerpo)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return ErrEventoNoVisto
	case http.StatusForbidden, http.StatusRequestEntityTooLarge, http.StatusBadRequest:
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("%w: %d %s", ErrArtefactoRechazado, resp.StatusCode, b)
	default:
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("artefactos: %d %s", resp.StatusCode, b)
	}
}

// Relevo pregunta a la consola si este sensor puede pasar ya su nodo a la
// configuración firmada. nil: todavía no.
func (c *Cliente) Relevo(ctx context.Context) (*relevo.Oferta, error) {
	resp, err := c.peticion(ctx, http.MethodGet, "/api/sensor/relevo", "", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("relevo: %d", resp.StatusCode)
	}
	var o *relevo.Oferta
	return o, json.NewDecoder(resp.Body).Decode(&o)
}

// InformarRelevo dice a la consola cómo va el relevo (aplicando o fallida).
func (c *Cliente) InformarRelevo(ctx context.Context, estado, detalle string) error {
	b, _ := json.Marshal(map[string]string{"estado": estado, "detalle": detalle})
	resp, err := c.peticion(ctx, http.MethodPost, "/api/sensor/relevo", "application/json", b)
	if err != nil {
		return err
	}
	resp.Body.Close()
	// 409: la consola no da el cerrojo (otro relevo en curso, o ya no toca).
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("relevo: %d", resp.StatusCode)
	}
	return nil
}
