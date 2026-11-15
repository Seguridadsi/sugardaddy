package actualizador

// El registro de transparencia (docs/diseno/firmas-raiz.md §4): gemelo de
// paquetes/canal/src/transparencia.ts. Un registro solo de añadir, público y estático
// (transparencia/registro.jsonl en el repo público), con su raíz de Merkle (RFC 6962) firmada
// dentro de la marca de tiempo. El actualizador no instala una versión que no esté en él.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"
)

type CabezaRegistro struct {
	Tamano int64  `json:"tamano"`
	Raiz   string `json:"raiz"`
}

type PruebaRegistro struct {
	Entrada string   `json:"entrada"`
	Indice  int64    `json:"indice"`
	Tamano  int64    `json:"tamano"`
	Ruta    []string `json:"ruta"`
}

type EntradaRegistro struct {
	N        int64  `json:"n"`
	Tipo     string `json:"tipo"`
	Huella   string `json:"huella"`
	Clave    string `json:"clave"`
	Etiqueta string `json:"etiqueta,omitempty"`
	Cuando   string `json:"cuando"`
}

var (
	hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hex16 = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

const maxRuta = 64

func hojaDe(linea string) []byte {
	h := sha256.Sum256(append([]byte{0}, linea...))
	return h[:]
}

func nodoMerkle(a, b []byte) []byte {
	h := sha256.New()
	h.Write([]byte{1})
	h.Write(a)
	h.Write(b)
	return h.Sum(nil)
}

// Incluida comprueba una ruta de auditoría (RFC 9162 §2.1.3.2).
func Incluida(hoja []byte, indice, tamano int64, ruta [][]byte, raiz []byte) bool {
	if indice < 0 || indice >= tamano {
		return false
	}
	fn, sn := indice, tamano-1
	r := hoja
	for _, p := range ruta {
		if sn == 0 {
			return false
		}
		if fn%2 == 1 || fn == sn {
			r = nodoMerkle(p, r)
			for fn%2 == 0 && fn != 0 {
				fn >>= 1
				sn >>= 1
			}
		} else {
			r = nodoMerkle(r, p)
		}
		fn >>= 1
		sn >>= 1
	}
	return sn == 0 && bytes.Equal(r, raiz)
}

// RaizDe es el MTH de RFC 6962 de unas líneas (para las pruebas y para quien vigila el registro).
func RaizDe(lineas []string) []byte {
	hojas := make([][]byte, len(lineas))
	for i, l := range lineas {
		hojas[i] = hojaDe(l)
	}
	return raizHojas(hojas)
}

func raizHojas(h [][]byte) []byte {
	switch len(h) {
	case 0:
		v := sha256.Sum256(nil)
		return v[:]
	case 1:
		return h[0]
	}
	k := 1
	for k*2 < len(h) {
		k *= 2
	}
	return nodoMerkle(raizHojas(h[:k]), raizHojas(h[k:]))
}

func (c CabezaRegistro) valida() bool { return c.Tamano >= 0 && hex64.MatchString(c.Raiz) }

func (p PruebaRegistro) entrada() (EntradaRegistro, error) {
	var e EntradaRegistro
	if len(p.Entrada) > 1024 || len(p.Ruta) > maxRuta {
		return e, errors.New("malformed inclusion proof")
	}
	for _, h := range p.Ruta {
		if !hex64.MatchString(h) {
			return e, errors.New("malformed inclusion proof")
		}
	}
	if err := json.Unmarshal([]byte(p.Entrada), &e); err != nil {
		return e, errors.New("the log entry is not JSON")
	}
	switch e.Tipo {
	case "version", "licencia", "delegacion", "catalogo-partner":
	default:
		return e, errors.New("unknown log entry type")
	}
	if !hex64.MatchString(e.Huella) || !hex16.MatchString(e.Clave) || len(e.Etiqueta) > 80 {
		return e, errors.New("malformed log entry")
	}
	if _, err := time.Parse(time.RFC3339, e.Cuando); err != nil {
		return e, errors.New("malformed log entry date")
	}
	return e, nil
}

// VersionEnRegistro: la entrada de la prueba es la de esta versión (el texto firmado) y su
// ruta lleva a la raíz de la cabeza.
func VersionEnRegistro(textoVersion string, c CabezaRegistro, p PruebaRegistro) bool {
	if !c.valida() || p.Tamano != c.Tamano {
		return false
	}
	e, err := p.entrada()
	if err != nil || e.Tipo != "version" || e.N != p.Indice {
		return false
	}
	h := sha256.Sum256([]byte(textoVersion))
	if e.Huella != hex.EncodeToString(h[:]) {
		return false
	}
	ruta := make([][]byte, len(p.Ruta))
	for i, x := range p.Ruta {
		ruta[i], _ = hex.DecodeString(x)
	}
	raiz, _ := hex.DecodeString(c.Raiz)
	return Incluida(hojaDe(p.Entrada), p.Indice, p.Tamano, ruta, raiz)
}

// Lo que sale de mirar si una versión está en el registro.
const (
	RegistroSinRegistro = "sin-registro" // aún no hay registro (ninguna marca con cabeza): se instala
	RegistroIncluida    = "incluida"     // está: se instala
	RegistroAusente     = "ausente"      // la copia pública responde y no está: no se instala
	RegistroSinPrueba   = "sin-prueba"   // no se ha podido saber (sin red): según REGISTRO_EXIGIR
)

// ComprobarRegistro mira si la versión (su texto firmado) está en el registro. La cabeza que
// cuenta es la de la marca de la copia estática si se ha podido bajar; la del panel o la
// guardada solo si no: así un panel tomado no puede enseñar un registro distinto a quien
// llega a la copia pública. La prueba sale de la propia marca (la de la última versión) o de
// <copia estática>/pruebas/<huella>.json.
func (v *Vigia) ComprobarRegistro(ctx context.Context, edicion, textoVersion string, ahora time.Time) (string, string) {
	h := sha256.Sum256([]byte(textoVersion))
	huella := hex.EncodeToString(h[:])
	// La misma versión, mirada hace poco y sin éxito: no se vuelve a preguntar en cada vuelta
	// de 30 s (miles de nodos contra la copia pública).
	if v.regHuella == huella && v.regEstado != RegistroIncluida && ahora.Sub(v.regCuando) < 10*time.Minute {
		return v.regEstado, v.regDetalle
	}
	estado, detalle := v.comprobarRegistro(ctx, edicion, textoVersion, huella, ahora)
	v.regHuella, v.regEstado, v.regDetalle, v.regCuando = huella, estado, detalle, ahora
	return estado, detalle
}

func (v *Vigia) comprobarRegistro(ctx context.Context, edicion, textoVersion, huella string, ahora time.Time) (string, string) {
	if v.estatica == nil || ahora.Sub(v.estaticaVista) > 10*time.Minute {
		_, _ = v.Vuelta(ctx, ahora)
	}
	m := v.estatica
	if m == nil {
		m = v.actual
	}
	if m == nil || m.Marca.Registro == nil {
		v.registro = ""
		return RegistroSinRegistro, ""
	}
	cabeza := *m.Marca.Registro
	if u, ok := m.Marca.Ultimas[edicion]; ok && u.Prueba != nil && VersionEnRegistro(textoVersion, cabeza, *u.Prueba) {
		v.registro = ""
		return RegistroIncluida, ""
	}
	if v.Estatica == "" || v.Fuera == nil {
		return v.sinPrueba("no public copy of the transparency log is configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.Estatica+"/pruebas/"+huella+".json", nil)
	if err != nil {
		return v.sinPrueba(err.Error())
	}
	resp, err := v.Fuera.Do(req)
	if err != nil {
		return v.sinPrueba("the public transparency log is not reachable: " + err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound && m.Origen == "estatica" {
		return v.ausente(huella)
	}
	if resp.StatusCode != http.StatusOK {
		return v.sinPrueba(fmt.Sprintf("the public transparency log responded %s", resp.Status))
	}
	var p PruebaRegistro
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if json.Unmarshal(b, &p) != nil {
		return v.sinPrueba("the inclusion proof is not JSON")
	}
	if p.Tamano != cabeza.Tamano {
		// La copia pública va por delante o por detrás de la marca que se tiene: aún no se sabe.
		return v.sinPrueba(fmt.Sprintf("the inclusion proof is for a log of %d entries and the timestamp says %d", p.Tamano, cabeza.Tamano))
	}
	if !VersionEnRegistro(textoVersion, cabeza, p) {
		return v.ausente(huella)
	}
	v.registro = ""
	return RegistroIncluida, ""
}

func (v *Vigia) sinPrueba(motivo string) (string, string) {
	v.registro = "could not check the transparency log: " + motivo
	return RegistroSinPrueba, v.registro
}

func (v *Vigia) ausente(huella string) (string, string) {
	v.registro = "a version offered to this node (" + huella[:16] + ") is not in the public transparency log: it was not installed"
	return RegistroAusente, v.registro
}
