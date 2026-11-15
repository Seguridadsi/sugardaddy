package actualizador

// La raíz de firma fuera de línea (docs/diseno/firmas-raiz.md, R4-A): gemelo de
// paquetes/canal/src/raiz.ts. Formato listo, sin usar todavía: el nodo aún no lo exige.
//
// Unas pocas llaves raíz (dos llaves físicas) firman, con umbral, un documento con caducidad
// que dice cuáles son las claves de trabajo. Rotar la raíz pide el umbral de la vieja y el de
// la nueva; nunca se acepta una versión menor que la conocida ni una caducada.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type Raiz struct {
	Tipo    string `json:"tipo"`
	Version int64  `json:"version"`
	Emitida string `json:"emitida"`
	Caduca  string `json:"caduca"`
	Raiz    struct {
		Claves []string `json:"claves"`
		Umbral int      `json:"umbral"`
	} `json:"raiz"`
	Claves string `json:"claves"`
	Marcas string `json:"marcas"`
}

type RaizFirmada struct {
	Raiz   string  `json:"raiz"`
	Firmas []Firma `json:"firmas"`
}

// RaizDeConfianza: las llaves raíz en las que se confía, cuántas hacen falta y la versión vista.
type RaizDeConfianza struct {
	Claves  []string
	Umbral  int
	Version int64
}

const maxRaices = 8

// LeerRaizDeConfianza lee PUBLICACION_RAIZ: "<umbral>:<pública>,<pública>,…".
func LeerRaizDeConfianza(texto string, version int64) (RaizDeConfianza, error) {
	u, lista, ok := strings.Cut(strings.TrimSpace(texto), ":")
	n, err := strconv.Atoi(strings.TrimSpace(u))
	if !ok || err != nil {
		return RaizDeConfianza{}, errors.New("malformed root")
	}
	claves := LeerClavesMarca(lista)
	if n < 1 || n > len(claves) {
		return RaizDeConfianza{}, errors.New("malformed root threshold")
	}
	return RaizDeConfianza{Claves: claves, Umbral: n, Version: version}, nil
}

// cuantasFirman: cuántas claves distintas de la lista firmaron el texto.
func cuantasFirman(claves []string, texto string, firmas []Firma) int {
	vistas := map[string]bool{}
	for i, f := range firmas {
		if i >= 16 {
			break
		}
		for _, c := range claves {
			pub, err := ClaveVerificable(c)
			if err != nil || vistas[f.Clave] || Huella(pub) != f.Clave {
				continue
			}
			if firmaBuena(pub, texto, f.Firma) {
				vistas[f.Clave] = true
			}
		}
	}
	return len(vistas)
}

func (r Raiz) motivo() error {
	if r.Tipo != "raiz" {
		return errors.New("it is not a root document")
	}
	if r.Version < 1 {
		return errors.New("malformed root version")
	}
	if _, err := time.Parse(time.RFC3339, r.Emitida); err != nil {
		return errors.New("malformed root dates")
	}
	if _, err := time.Parse(time.RFC3339, r.Caduca); err != nil {
		return errors.New("malformed root dates")
	}
	k := r.Raiz.Claves
	if len(k) == 0 || len(k) > maxRaices {
		return errors.New("malformed root keys")
	}
	vistas := map[string]bool{}
	for _, c := range k {
		if _, err := ClaveVerificable(c); err != nil || vistas[c] {
			return errors.New("malformed root keys")
		}
		vistas[c] = true
	}
	if r.Raiz.Umbral < 1 || r.Raiz.Umbral > len(k) {
		return errors.New("malformed root threshold")
	}
	if m := MotivoClaves(r.Claves); m != "" {
		return errors.New(m)
	}
	if m := MotivoClavesMarca(r.Marcas); m != "" {
		return errors.New(m)
	}
	return nil
}

// VerificarRaiz comprueba una raíz contra la de confianza y devuelve la nueva confianza.
func VerificarRaiz(c RaizDeConfianza, f RaizFirmada, ahora time.Time) (Raiz, RaizDeConfianza, error) {
	var r Raiz
	if err := json.Unmarshal([]byte(f.Raiz), &r); err != nil {
		return Raiz{}, c, errors.New("it is not a root document")
	}
	if err := r.motivo(); err != nil {
		return Raiz{}, c, err
	}
	if r.Version < c.Version {
		return Raiz{}, c, fmt.Errorf("root version %d is older than %d", r.Version, c.Version)
	}
	if cuantasFirman(c.Claves, f.Raiz, f.Firmas) < c.Umbral {
		return Raiz{}, c, errors.New("not enough signatures from the trusted root")
	}
	if r.Version > c.Version && cuantasFirman(r.Raiz.Claves, f.Raiz, f.Firmas) < r.Raiz.Umbral {
		return Raiz{}, c, errors.New("the new root is not signed by its own keys")
	}
	caduca, _ := time.Parse(time.RFC3339, r.Caduca)
	if !caduca.After(ahora) {
		return Raiz{}, c, errors.New("the root has expired")
	}
	return r, RaizDeConfianza{Claves: r.Raiz.Claves, Umbral: r.Raiz.Umbral, Version: r.Version}, nil
}
