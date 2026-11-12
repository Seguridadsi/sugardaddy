package catalogo

// Trampas de partner (docs/diseno/trampas-de-partner.md). Un partner firma sus propias
// trampas y solo las arrancan los nodos de sus empresas. La cadena cuelga de SeguridadSI:
//
//  1. SeguridadSI firma, con una clave de uso «delegaciones», un certificado que dice qué
//     clave del partner puede firmar trampas, con qué prefijo y hasta cuándo.
//  2. El partner firma con esa clave su catálogo: las huellas de sus manifiestos.
//  3. Aquí se comprueba todo, además de que el partner sea el de este nodo, que la serie
//     no baje, que el id lleve el prefijo y que el manifiesto no pase del techo.
//
// Gemelo de paquetes/canal/src/catalogo-partner.ts y de herramientas/techo-partner.ts.
// Lo que no cuadra no arranca. El catálogo de SeguridadSI se mira siempre antes: un
// partner no puede pisar un módulo nuestro.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Los topes de un catálogo de partner y de cada una de sus trampas.
const (
	maxModulosPartner = 200
	maxHuellasModulo  = 8
	TechoCPU          = 1.0
	TechoMemoriaMb    = 512
	TechoPuertos      = 16
	TechoFicheros     = 32
	TechoEscribibles  = 8
)

var (
	idValido      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	prefijoValido = regexp.MustCompile(`^[a-z0-9]{3,20}$`)
	huellaValida  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	conDigest     = regexp.MustCompile(`@sha256:[0-9a-f]{64}$`)
)

type delegacionFirmada struct {
	Delegacion string               `json:"delegacion"`
	Firma      string               `json:"firma"`
	Firmas     []actualizador.Firma `json:"firmas"`
}

type delegacionCatalogo struct {
	Tipo         string `json:"tipo"`
	Version      int    `json:"version"`
	MSP          string `json:"msp"`
	ClavePublica string `json:"clavePublica"`
	Prefijo      string `json:"prefijo"`
	Emitida      string `json:"emitida"`
	Caduca       string `json:"caduca"`
}

type catalogoFirmado struct {
	Catalogo   string            `json:"catalogo"`
	Firma      string            `json:"firma"`
	Delegacion delegacionFirmada `json:"delegacion"`
}

type catalogoPartner struct {
	Tipo     string              `json:"tipo"`
	Version  int                 `json:"version"`
	MSP      string              `json:"msp"`
	Serie    int64               `json:"serie"`
	Emitida  string              `json:"emitida"`
	Catalogo map[string][]string `json:"catalogo"`
}

// Partner es el catálogo de partner vigente en este nodo, ya comprobado.
type Partner struct {
	MSP     string
	Prefijo string
	Serie   int64
	Caduca  time.Time
	Modulos map[string][]string
}

// VerificarPartner sigue la cadena de un catálogo de partner. `partner` es el de este
// nodo: un catálogo de otro, aunque esté bien firmado, no vale. No mira la serie.
func VerificarPartner(conf actualizador.Confianza, partner string, texto []byte, ahora time.Time) (*Partner, error) {
	if partner == "" {
		return nil, errors.New("this node has no partner")
	}
	var f catalogoFirmado
	if err := json.Unmarshal(texto, &f); err != nil || f.Catalogo == "" || f.Firma == "" || f.Delegacion.Delegacion == "" {
		return nil, errors.New("it does not have the form of a signed partner catalog")
	}
	if len(f.Delegacion.Firmas) > 8 {
		return nil, errors.New("malformed signature list")
	}
	// 1. El certificado: de SeguridadSI, del tipo que toca y vigente.
	if !conf.HayClave("delegaciones") {
		return nil, errors.New("there is no trusted key to check the partner certificate")
	}
	if conf.FirmadoPor("delegaciones", f.Delegacion.Delegacion, f.Delegacion.Firma, f.Delegacion.Firmas) == "" {
		return nil, errors.New("the partner certificate is not signed by SeguridadSI")
	}
	var d delegacionCatalogo
	if err := json.Unmarshal([]byte(f.Delegacion.Delegacion), &d); err != nil {
		return nil, errors.New("the partner certificate is not readable")
	}
	// El tipo separa este certificado del de licencias, que firma la misma clave.
	if d.Tipo != "delegacion-catalogo" || d.Version != 1 {
		return nil, errors.New("it is not a partner decoy certificate")
	}
	if !idValido.MatchString(d.MSP) || !prefijoValido.MatchString(d.Prefijo) {
		return nil, errors.New("malformed partner certificate")
	}
	caduca, err := time.Parse(time.RFC3339, d.Caduca)
	if err != nil {
		return nil, errors.New("malformed partner certificate expiry date")
	}
	if caduca.Before(ahora) {
		return nil, errors.New("the partner decoy certificate has expired")
	}
	// 2. Solo el partner de este nodo.
	if d.MSP != partner {
		return nil, fmt.Errorf("the partner catalog belongs to %q, not to the partner of this node", d.MSP)
	}
	// 3. El catálogo, firmado por la clave del certificado y por ninguna otra.
	clave, err := actualizador.ClaveVerificable(d.ClavePublica)
	if err != nil {
		return nil, errors.New("malformed partner key")
	}
	if !actualizador.FirmaVale(clave, f.Catalogo, f.Firma) {
		return nil, errors.New("the catalog is not signed by the partner key")
	}
	var c catalogoPartner
	if err := json.Unmarshal([]byte(f.Catalogo), &c); err != nil {
		return nil, errors.New("the partner catalog is not readable")
	}
	if c.Tipo != "catalogo-partner" || c.Version != 1 {
		return nil, errors.New("it is not a partner catalog")
	}
	if c.MSP != d.MSP {
		return nil, errors.New("the catalog and the certificate belong to different partners")
	}
	if c.Serie < 1 {
		return nil, errors.New("malformed serial number")
	}
	if len(c.Catalogo) > maxModulosPartner {
		return nil, errors.New("too many decoys in the partner catalog")
	}
	// 4. Cada trampa, con el prefijo del certificado.
	for id, huellas := range c.Catalogo {
		if !idValido.MatchString(id) || !strings.HasPrefix(id, d.Prefijo+"-") {
			return nil, fmt.Errorf("%q does not carry the partner prefix %q", id, d.Prefijo+"-")
		}
		if len(huellas) < 1 || len(huellas) > maxHuellasModulo {
			return nil, fmt.Errorf("malformed fingerprints for %q", id)
		}
		for _, h := range huellas {
			if !huellaValida.MatchString(h) {
				return nil, fmt.Errorf("malformed fingerprints for %q", id)
			}
		}
	}
	return &Partner{MSP: d.MSP, Prefijo: d.Prefijo, Serie: c.Serie, Caduca: caduca, Modulos: c.Catalogo}, nil
}

// MotivoTecho dice por qué ese manifiesto pasa del techo de una trampa de partner ("" si
// no pasa). El aislamiento lo pone el sensor, no quien firma: un partner no puede pedir
// salida a internet, la red del cliente con IP propia ni NET_RAW, ni más recursos que
// estos. Lo demás (sin capacidades, sin carpetas del anfitrión, tope de procesos) ya es
// igual para todas las trampas.
func MotivoTecho(m plan.Manifiesto) string {
	c := m.Contenedor
	if c == nil {
		return "a partner decoy must be a container"
	}
	if !conDigest.MatchString(c.Imagen) {
		return "the image must be pinned by its digest"
	}
	if m.Red != nil {
		return "partner decoys cannot use the own-IP network mode"
	}
	a := m.Aislamiento
	if a == nil {
		return "the isolation block is required"
	}
	if a.Salida {
		return "partner decoys may not reach the internet"
	}
	if !a.SoloLectura {
		return "the container file system must be read-only"
	}
	if !(a.CPU > 0) || a.CPU > TechoCPU {
		return fmt.Sprintf("the CPU limit must be above 0 and at most %g", TechoCPU)
	}
	if a.MemoriaMb < 1 || a.MemoriaMb > TechoMemoriaMb {
		return fmt.Sprintf("the memory limit must be between 1 and %d MB", TechoMemoriaMb)
	}
	if len(c.Puertos) > TechoPuertos {
		return fmt.Sprintf("at most %d ports", TechoPuertos)
	}
	if len(c.Ficheros) > TechoFicheros {
		return fmt.Sprintf("at most %d files", TechoFicheros)
	}
	if len(c.Escribibles) > TechoEscribibles {
		return fmt.Sprintf("at most %d writable folders", TechoEscribibles)
	}
	return ""
}

// Motivo dice por qué no se puede arrancar esa trampa de partner ("" si se puede).
func (p *Partner) Motivo(t plan.TrampaPlan, ahora time.Time) string {
	id := t.Manifiesto.ID
	// Se vuelve a mirar en cada vuelta: el fichero no cambia cuando el certificado caduca.
	if p.Caduca.Before(ahora) {
		return fmt.Sprintf("the decoy certificate of partner %s has expired: %q is not started", p.MSP, id)
	}
	permitidas, ok := p.Modulos[id]
	if !ok {
		return fmt.Sprintf("the catalog of partner %s (serial %d) does not include module %q", p.MSP, p.Serie, id)
	}
	if !slices.Contains(permitidas, Huella(t.Manifiesto)) {
		return fmt.Sprintf("the console sent a %q decoy that differs from the one signed by partner %s: it is not started", id, p.MSP)
	}
	if m := MotivoTecho(t.Manifiesto); m != "" {
		return fmt.Sprintf("partner decoy %q asks for more than a partner decoy may have (%s): it is not started", id, m)
	}
	return ""
}

// LectorPartner lee el catálogo de partner que deja el actualizador junto a la versión
// firmada, y lo vuelve a leer solo si el fichero cambia.
type LectorPartner struct {
	Ruta      string
	Confianza actualizador.Confianza
	// Partner es el de este nodo (PARTNER en su .env, que pone el instalador y la consola
	// no puede cambiar). Vacío: este nodo no arranca trampas de partner.
	Partner string
	// RutaSerie guarda la última serie aceptada, para no volver a un catálogo anterior.
	RutaSerie string
	Ahora     func() time.Time

	modifica time.Time
	tamano   int64
	ultimo   *Partner
	err      error
	leido    bool
}

func (l *LectorPartner) ahora() time.Time {
	if l.Ahora != nil {
		return l.Ahora()
	}
	return time.Now()
}

// Leer devuelve el catálogo de partner vigente: nil sin partner o sin fichero. Uno que
// no se puede leer, que no verifica o que es más viejo que el último da error, y entonces
// no arranca ninguna trampa de partner.
func (l *LectorPartner) Leer() (*Partner, error) {
	if l == nil || l.Ruta == "" || l.Partner == "" {
		return nil, nil
	}
	info, err := os.Stat(l.Ruta)
	if errors.Is(err, os.ErrNotExist) {
		l.leido = false
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !l.leido || !l.modifica.Equal(info.ModTime()) || l.tamano != info.Size() {
		l.leido, l.modifica, l.tamano = true, info.ModTime(), info.Size()
		l.ultimo, l.err = l.cargar()
	}
	return l.ultimo, l.err
}

func (l *LectorPartner) cargar() (*Partner, error) {
	b, err := os.ReadFile(l.Ruta)
	if err != nil {
		return nil, err
	}
	if len(b) > 1<<20 {
		return nil, errors.New("the partner catalog is too large")
	}
	p, err := VerificarPartner(l.Confianza, l.Partner, b, l.ahora())
	if err != nil {
		return nil, fmt.Errorf("the partner catalog does not verify: %w", err)
	}
	if l.RutaSerie == "" {
		return p, nil
	}
	ultima := l.serieGuardada(p.MSP)
	if p.Serie < ultima {
		return nil, fmt.Errorf("the partner catalog has serial %d and this sensor already accepted %d: an older catalog is not accepted", p.Serie, ultima)
	}
	if p.Serie > ultima {
		// Si no se puede apuntar, no se acepta: sin memoria de la serie se podría volver atrás.
		if err := escribirEntero(l.RutaSerie, p.MSP, p.Serie); err != nil {
			return nil, fmt.Errorf("cannot record the partner catalog serial: %w", err)
		}
	}
	return p, nil
}

// serieGuardada: la última serie aceptada de ese partner (0 si no hay, o si es de otro).
func (l *LectorPartner) serieGuardada(msp string) int64 {
	b, err := os.ReadFile(l.RutaSerie)
	if err != nil {
		return 0
	}
	quien, serie, ok := strings.Cut(strings.TrimSpace(string(b)), " ")
	if !ok || quien != msp {
		return 0
	}
	n, err := strconv.ParseInt(serie, 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func escribirEntero(ruta, msp string, n int64) error {
	tmp := ruta + ".tmp"
	if err := os.WriteFile(tmp, []byte(msp+" "+strconv.FormatInt(n, 10)+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, ruta)
}

// Regla junta los dos catálogos en lo que el despliegue pregunta por cada trampa. El de
// SeguridadSI va siempre primero: lo que está en él se decide con él y solo con él. El de
// partner solo se mira para un id que no es nuestro y lleva su prefijo. Con `c` nil (sin
// versión firmada con catálogo: un nodo montado a mano) no hay regla, como siempre.
func Regla(c *Catalogo, p *Partner, errPartner error, ahora func() time.Time) func(plan.TrampaPlan) string {
	if c == nil {
		return nil
	}
	if ahora == nil {
		ahora = time.Now
	}
	return func(t plan.TrampaPlan) string {
		id := t.Manifiesto.ID
		if _, nuestro := c.Modulos[id]; nuestro {
			return c.Motivo(t)
		}
		if errPartner != nil {
			return c.Motivo(t) + "; and the partner catalog on this machine is not valid (" + errPartner.Error() + ")"
		}
		if p == nil || !strings.HasPrefix(id, p.Prefijo+"-") {
			return c.Motivo(t)
		}
		return p.Motivo(t, ahora())
	}
}
