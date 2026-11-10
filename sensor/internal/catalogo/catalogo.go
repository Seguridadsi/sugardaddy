// Package catalogo es lo único que el sensor puede arrancar (SEN-3,
// docs/diseno/claves-y-catalogo.md): las huellas de los manifiestos de cada módulo que
// trae la versión firmada instalada. El actualizador deja esa versión tal cual en la
// carpeta del nodo; el sensor la lee de solo lectura, comprueba su firma con sus propias
// claves de confianza y no arranca una trampa cuyo manifiesto no esté en ella. Así, una
// consola tomada solo puede mover trampas de verdad, no meter contenedores suyos.
package catalogo

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Codigo es el código estable con que el sensor dice que una trampa no está en el catálogo.
const Codigo = "catalogo.fuera"

// Huella es el sha256 del manifiesto tal como lo entiende el sensor: decodificado en sus
// estructuras y vuelto a serializar (encoding/json es determinista con structs y ordena
// las claves de los mapas). Lo que el sensor no entiende no cuenta, y el publicador la
// calcula con este mismo código (cmd/catalogo).
func Huella(m plan.Manifiesto) string {
	b, err := json.Marshal(m)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// HuellaDeTexto decodifica un manifiesto en JSON y da su Huella.
func HuellaDeTexto(texto []byte) (string, error) {
	var m plan.Manifiesto
	if err := json.Unmarshal(texto, &m); err != nil {
		return "", err
	}
	return Huella(m), nil
}

// Catalogo son las huellas permitidas por módulo y la versión de la que salen.
type Catalogo struct {
	Version  string
	Modulos  map[string][]string
	leido    time.Time
	modifica time.Time
	tamano   int64
	err      error
}

// Lector lee la versión firmada de una ruta y la vuelve a leer solo si el fichero cambia.
type Lector struct {
	Ruta      string
	Confianza actualizador.Confianza
	// Edicion del nodo (actualizador.EdicionDelNodo): una versión de la otra no vale.
	Edicion string
	// Marca: desde que existe ese fichero, el catálogo es obligatorio (sin versión firmada,
	// o con una sin catálogo, no se arranca nada nuevo). La dejan el instalador y el
	// actualizador; la consola no puede escribir ni borrar en la máquina.
	Marca  string
	ultimo *Catalogo
}

func (l *Lector) exigido() bool {
	if l.Marca == "" {
		return false
	}
	_, err := os.Stat(l.Marca)
	return err == nil
}

// Leer devuelve el catálogo vigente: nil sin fichero o si la versión no trae catálogo (un
// nodo montado a mano, o de antes: el sensor se comporta como siempre). Un fichero que no
// se puede leer o cuya firma no vale da error: entonces no se arranca nada nuevo.
func (l *Lector) Leer() (*Catalogo, error) {
	if l == nil || l.Ruta == "" {
		return nil, nil
	}
	info, err := os.Stat(l.Ruta)
	if errors.Is(err, os.ErrNotExist) {
		l.ultimo = nil
		if l.exigido() {
			return nil, errors.New("the signed version with the decoy catalog is missing on this machine")
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if u := l.ultimo; u == nil || !u.modifica.Equal(info.ModTime()) || u.tamano != info.Size() {
		c := &Catalogo{modifica: info.ModTime(), tamano: info.Size(), leido: time.Now()}
		c.err = c.cargar(l.Ruta, l.Confianza, l.Edicion)
		l.ultimo = c
	}
	return l.ultimo.resultado(l.exigido())
}

func (c *Catalogo) resultado(exigido bool) (*Catalogo, error) {
	if c.err != nil {
		return nil, c.err
	}
	if c.Modulos == nil {
		if exigido {
			return nil, errors.New("the signed version on this machine has no decoy catalog")
		}
		return nil, nil
	}
	return c, nil
}

func (c *Catalogo) cargar(ruta string, conf actualizador.Confianza, edicion string) error {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	if len(b) > 4<<20 {
		return errors.New("the signed version is too large")
	}
	var f actualizador.ReleaseFirmada
	if err := json.Unmarshal(b, &f); err != nil {
		return errors.New("the signed version is not readable")
	}
	r, err := actualizador.VerificarEnNodo(conf, edicion, f)
	if err != nil {
		return fmt.Errorf("the signed version does not verify: %w", err)
	}
	c.Version, c.Modulos = r.Version, r.Catalogo
	return nil
}

// Motivo dice por qué no se puede arrancar esa trampa ("" si se puede). Con el catálogo
// nil (sin versión firmada con catálogo) todo vale, como antes.
func (c *Catalogo) Motivo(t plan.TrampaPlan) string {
	if c == nil {
		return ""
	}
	permitidas, ok := c.Modulos[t.Manifiesto.ID]
	if !ok {
		return fmt.Sprintf("the signed catalog of version %s does not include module %q: update this sensor or check the console", c.Version, t.Manifiesto.ID)
	}
	if !slices.Contains(permitidas, Huella(t.Manifiesto)) {
		return fmt.Sprintf("the console sent a %q decoy that differs from the one signed in version %s: it is not started", t.Manifiesto.ID, c.Version)
	}
	return ""
}
