package catalogo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
)

// FicheroPartner es donde queda el catálogo de partner, junto a la versión firmada: el
// sensor lo lee de solo lectura (docs/diseno/trampas-de-partner.md).
const FicheroPartner = "firmado/catalogo-partner.json"

// Traedor es la parte del actualizador que trae el catálogo de partner de la consola y lo
// deja para el sensor. La consola solo entrega: aquí se vuelve a comprobar la cadena
// entera con las claves de esta máquina y con su PARTNER, y no se acepta uno más viejo
// que el que ya hay. Sin PARTNER no hace nada.
type Traedor struct {
	// URL del catálogo en la consola (…/api/actualizador/catalogo-partner o la del sensor).
	URL       string
	Token     string
	HTTP      *http.Client
	Dir       string
	Partner   string
	Confianza actualizador.Confianza
	Log       func(string, ...any)
	Ahora     func() time.Time
}

func (t *Traedor) ahora() time.Time {
	if t.Ahora != nil {
		return t.Ahora()
	}
	return time.Now()
}

// Vuelta pide el catálogo y lo guarda si es auténtico, de este partner y no es más viejo.
// Que la consola no tenga ninguno (404) no borra el que haya: quitar una trampa es
// publicar un catálogo nuevo sin ella, no dejar de entregarlo.
func (t *Traedor) Vuelta(ctx context.Context) error {
	if t == nil || t.Partner == "" || t.Dir == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.Token)
	resp, err := t.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("console: %s", resp.Status)
	}
	var p *struct {
		Catalogo json.RawMessage `json:"catalogo"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&p); err != nil || p == nil || len(p.Catalogo) == 0 {
		return errors.New("the console did not deliver a partner catalog")
	}
	nuevo, err := VerificarPartner(t.Confianza, t.Partner, p.Catalogo, t.ahora())
	if err != nil {
		return fmt.Errorf("partner catalog rejected: %w", err)
	}
	ruta := filepath.Join(t.Dir, FicheroPartner)
	previo, err := os.ReadFile(ruta)
	if err == nil {
		if bytes.Equal(previo, p.Catalogo) {
			return nil
		}
		// El que ya hay puede haber caducado: su serie cuenta igual, así que se lee sin reloj.
		if viejo, err := VerificarPartner(t.Confianza, t.Partner, previo, time.Time{}); err == nil && nuevo.Serie < viejo.Serie {
			return fmt.Errorf("partner catalog rejected: serial %d is older than the installed %d", nuevo.Serie, viejo.Serie)
		}
	}
	if err := os.MkdirAll(filepath.Dir(ruta), 0o755); err != nil {
		return err
	}
	tmp := ruta + ".tmp"
	if err := os.WriteFile(tmp, p.Catalogo, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, ruta); err != nil {
		return err
	}
	if t.Log != nil {
		t.Log("partner catalog left for the sensor", "partner", nuevo.MSP, "serial", nuevo.Serie, "decoys", len(nuevo.Modulos))
	}
	return nil
}
