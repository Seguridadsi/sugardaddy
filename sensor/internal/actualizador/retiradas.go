package actualizador

// Imágenes retiradas (respuesta a incidentes, manual 3; herramientas/retirar-imagen.ts): gemelo
// de paquetes/canal/src/retiradas.ts. Una lista firmada con la clave de publicación de la
// edición de digests que el nodo no arranca aunque los tenga en caché: el actualizador no
// instala una versión que lleve alguno y el sensor no arranca (ni deja en marcha) una trampa
// con uno. La reparte el repo público (transparencia/retiradas-<edición>.json), que el panel no
// controla. El nodo guarda las listas que ve (RetiradasGuardadas) y junta sus digests: una lista
// vieja no devuelve a la vida un digest retirado.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// FicheroRetiradas es donde el actualizador deja las listas comprobadas, junto a la versión firmada.
const FicheroRetiradas = "retiradas.json"

const (
	maxDigestsRetirados = 1024
	maxListasGuardadas  = 16
	maxTextoRetiradas   = 128 << 10
)

var digestRetirado = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var digestEnImagen = regexp.MustCompile(`@(sha256:[0-9a-f]{64})$`)

type Retiradas struct {
	Tipo    string   `json:"tipo"`
	Version int      `json:"version"`
	Edicion string   `json:"edicion"`
	Digests []string `json:"digests"`
	Emitida string   `json:"emitida"`
}

type RetiradasFirmadas struct {
	Retiradas string  `json:"retiradas"`
	Firma     string  `json:"firma"`
	Firmas    []Firma `json:"firmas,omitempty"`
}

// DigestDeImagen da el digest de una imagen fijada (…@sha256:…), o "".
func DigestDeImagen(imagen string) string {
	m := digestEnImagen.FindStringSubmatch(strings.TrimSpace(imagen))
	if m == nil {
		return ""
	}
	return m[1]
}

func (r Retiradas) motivo() error {
	if r.Tipo != "retiradas" || r.Version != 1 {
		return errors.New("not a retired image list")
	}
	if r.Edicion != "cloud" && r.Edicion != "community" {
		return errors.New("unknown edition")
	}
	if len(r.Digests) > maxDigestsRetirados {
		return errors.New("malformed retired digests")
	}
	vistos := map[string]bool{}
	for _, d := range r.Digests {
		if !digestRetirado.MatchString(d) {
			return errors.New("malformed retired digest")
		}
		if vistos[d] {
			return errors.New("repeated retired digest")
		}
		vistos[d] = true
	}
	if _, err := time.Parse(time.RFC3339, r.Emitida); err != nil {
		return errors.New("malformed issue date")
	}
	return nil
}

// VerificarRetiradas comprueba firma (de la clave de esa edición o la de legado), forma y edición.
func VerificarRetiradas(c Confianza, edicion string, f RetiradasFirmadas) (Retiradas, error) {
	if edicion != "cloud" && edicion != "community" {
		return Retiradas{}, errors.New("this node has no edition: retired image lists do not apply")
	}
	if len(f.Retiradas) > maxTextoRetiradas || f.Firma == "" && len(f.Firmas) == 0 || len(f.Firmas) > 8 {
		return Retiradas{}, errors.New("does not have the form of a signed retired image list")
	}
	if !c.HayClave(edicion) {
		return Retiradas{}, errors.New("there is no trusted key to check the list")
	}
	if c.FirmadoPor(edicion, f.Retiradas, f.Firma, f.Firmas) == "" {
		return Retiradas{}, fmt.Errorf("not signed with a SeguridadSI %s key", edicion)
	}
	var r Retiradas
	if err := json.Unmarshal([]byte(f.Retiradas), &r); err != nil {
		return Retiradas{}, errors.New("the signed content is not JSON")
	}
	if err := r.motivo(); err != nil {
		return Retiradas{}, err
	}
	if r.Edicion != edicion {
		return Retiradas{}, fmt.Errorf("not for %s", edicion)
	}
	return r, nil
}

// ConjuntoRetiradas son los digests retirados que este nodo ha comprobado.
type ConjuntoRetiradas map[string]bool

// Retirada dice si la imagen (fijada por digest) está retirada.
func (c ConjuntoRetiradas) Retirada(imagen string) bool {
	d := DigestDeImagen(imagen)
	return d != "" && c[d]
}

// EnRelease da la primera imagen de la versión que está retirada, o "".
func (c ConjuntoRetiradas) EnRelease(r Release) string {
	imgs := []string{r.Actualizador}
	nombres := make([]string, 0, len(r.Servicios))
	for s := range r.Servicios {
		nombres = append(nombres, s)
	}
	sort.Strings(nombres)
	for _, s := range nombres {
		imgs = append(imgs, r.Servicios[s])
	}
	for _, i := range imgs {
		if c.Retirada(i) {
			return i
		}
	}
	return ""
}

// leerGuardadas lee las listas firmadas guardadas en dir (sin comprobar).
func leerGuardadas(dir string) ([]RetiradasFirmadas, error) {
	b, err := os.ReadFile(filepath.Join(dir, FicheroRetiradas))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var l []RetiradasFirmadas
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, err
	}
	return l, nil
}

// RetiradasGuardadas junta los digests de las listas guardadas en dir que se comprueban con
// estas claves. Las que no se comprueban se ignoran; un fichero ilegible es un error: quien
// pregunta decide (el sensor no arranca nada nuevo, como con el catálogo).
func RetiradasGuardadas(dir string, c Confianza, edicion string) (ConjuntoRetiradas, error) {
	l, err := leerGuardadas(dir)
	if err != nil {
		return nil, err
	}
	r := ConjuntoRetiradas{}
	for _, f := range l {
		v, err := VerificarRetiradas(c, edicion, f)
		if err != nil {
			continue
		}
		for _, d := range v.Digests {
			r[d] = true
		}
	}
	return r, nil
}

// GuardarRetiradas añade una lista comprobada a las guardadas (si no estaba), y se queda con
// las más nuevas. Devuelve si cambió algo.
func GuardarRetiradas(dir string, c Confianza, edicion string, f RetiradasFirmadas) (bool, error) {
	nueva, err := VerificarRetiradas(c, edicion, f)
	if err != nil {
		return false, err
	}
	l, err := leerGuardadas(dir)
	if err != nil {
		// Un fichero roto se rehace con lo que se comprueba ahora.
		l = nil
	}
	type vista struct {
		f RetiradasFirmadas
		e time.Time
	}
	var buenas []vista
	for _, x := range l {
		if x.Retiradas == f.Retiradas {
			return false, nil
		}
		if v, err := VerificarRetiradas(c, edicion, x); err == nil {
			e, _ := time.Parse(time.RFC3339, v.Emitida)
			buenas = append(buenas, vista{x, e})
		}
	}
	e, _ := time.Parse(time.RFC3339, nueva.Emitida)
	buenas = append(buenas, vista{f, e})
	sort.SliceStable(buenas, func(i, j int) bool { return buenas[i].e.After(buenas[j].e) })
	if len(buenas) > maxListasGuardadas {
		buenas = buenas[:maxListasGuardadas]
	}
	salida := make([]RetiradasFirmadas, len(buenas))
	for i, x := range buenas {
		salida[i] = x.f
	}
	b, err := json.Marshal(salida)
	if err != nil {
		return false, err
	}
	return true, escribirAtomico(filepath.Join(dir, FicheroRetiradas), b, 0o644)
}

// TraerRetiradas baja la lista de la edición de la copia estática (la carpeta de MARCA_URL) y
// la guarda si es buena y nueva. Sin fichero (404) no hay nada retirado: no es un error.
func TraerRetiradas(ctx context.Context, c *http.Client, estatica, dir string, conf Confianza, edicion string) (bool, error) {
	if edicion != "cloud" && edicion != "community" || estatica == "" || dir == "" {
		return false, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, estatica+"/retiradas-"+edicion+".json", nil)
	if err != nil {
		return false, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("retired image list: %s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxTextoRetiradas+64<<10))
	if err != nil {
		return false, err
	}
	var f RetiradasFirmadas
	if err := json.Unmarshal(b, &f); err != nil {
		return false, errors.New("the retired image list is not JSON")
	}
	return GuardarRetiradas(dir, conf, edicion, f)
}
