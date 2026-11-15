package actualizador

// La marca de tiempo (docs/diseno/firmas-raiz.md §3): gemelo de paquetes/canal/src/marca.ts.
// Un documento firmado que dice la última versión de cada edición y caduca en pocos días. El
// actualizador la trae del panel (por la consola) y de una URL estática que el panel no
// controla, se queda con la más nueva y avisa en la consola (que lo sube al panel en el
// latido) si caduca sin que nadie le dé otra o si hay una versión más nueva que no le llega.
// Solo avisa: no para ni aplica nada, y no pide aprobación a nadie.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// URLMarcaEstatica es dónde está la copia que no controla el panel: el repo público. Se
// puede cambiar con MARCA_URL (la carpeta, sin la barra final).
const URLMarcaEstatica = "https://raw.githubusercontent.com/Seguridadsi/sugardaddy/main/transparencia"

// FicheroMarca es donde el actualizador guarda la más nueva que ha visto, en la carpeta del nodo.
const FicheroMarca = "marca.json"

const (
	vigenciaMaximaMarca = 14 * 24 * time.Hour
	margenFuturoMarca   = time.Hour
	plazoMaximoHoras    = 60 * 24
)

type UltimaVersion struct {
	Version   string `json:"version"`
	Publicada string `json:"publicada"`
	// La prueba de que está en el registro de transparencia, contra la cabeza de esta marca.
	Prueba *PruebaRegistro `json:"prueba,omitempty"`
}

type Marca struct {
	Tipo       string                   `json:"tipo"`
	Version    int                      `json:"version"`
	Emitida    string                   `json:"emitida"`
	Caduca     string                   `json:"caduca"`
	PlazoHoras int                      `json:"plazoHoras"`
	Ultimas    map[string]UltimaVersion `json:"ultimas"`
	// La cabeza del registro de transparencia (§4). Sin ella, aún no hay registro.
	Registro *CabezaRegistro `json:"registro,omitempty"`
}

type MarcaFirmada struct {
	Marca  string  `json:"marca"`
	Firma  string  `json:"firma"`
	Firmas []Firma `json:"firmas,omitempty"`
}

var semverMarca = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func (m Marca) fechas() (time.Time, time.Time, error) {
	e, err1 := time.Parse(time.RFC3339, m.Emitida)
	c, err2 := time.Parse(time.RFC3339, m.Caduca)
	if err1 != nil || err2 != nil || !c.After(e) {
		return e, c, errors.New("malformed timestamp dates")
	}
	return e, c, nil
}

func (m Marca) motivo() error {
	if m.Tipo != "marca" || m.Version != 1 {
		return errors.New("it is not a timestamp")
	}
	e, c, err := m.fechas()
	if err != nil {
		return err
	}
	if c.Sub(e) > vigenciaMaximaMarca {
		return errors.New("the timestamp lasts too long")
	}
	if m.PlazoHoras < 1 || m.PlazoHoras > plazoMaximoHoras {
		return errors.New("malformed timestamp grace period")
	}
	if m.Registro != nil && !m.Registro.valida() {
		return errors.New("malformed log head")
	}
	for ed, u := range m.Ultimas {
		if ed != "cloud" && ed != "community" {
			return errors.New("unknown edition")
		}
		if !semverMarca.MatchString(u.Version) {
			return errors.New("malformed latest version")
		}
		if _, err := time.Parse(time.RFC3339, u.Publicada); err != nil {
			return errors.New("malformed latest version date")
		}
		if u.Prueba != nil {
			if _, err := u.Prueba.entrada(); err != nil {
				return err
			}
			if m.Registro == nil || u.Prueba.Tamano != m.Registro.Tamano {
				return errors.New("the inclusion proof is not for this log head")
			}
		}
	}
	return nil
}

// MarcaVista es una marca comprobada: su contenido, quién la firmó, si caducó y de dónde vino.
type MarcaVista struct {
	Marca      Marca
	Firmada    MarcaFirmada
	FirmadaCon string
	Caducada   bool
	Origen     string
}

// clavesDeMarca: las de las marcas, la de legado y las de la edición del nodo (sin edición,
// las de las dos). Ninguna de licencias ni de delegaciones.
func clavesDeMarca(c Confianza, marcas []string, edicion string) []string {
	var r []string
	r = append(r, LeerClavesMarca(strings.Join(marcas, ","))...)
	if c.Legado != nil {
		if b, err := marshalPublica(c.Legado); err == nil {
			r = append(r, b)
		}
	}
	for _, k := range c.Claves {
		if (edicion == "" && (k.Uso == "cloud" || k.Uso == "community")) || k.Uso == edicion {
			if b, err := marshalPublica(k.Publica); err == nil {
				r = append(r, b)
			}
		}
	}
	return r
}

// VerificarMarca comprueba firma y forma. Una caducada se devuelve con Caducada: quien la
// recibe tiene que saber que existe para avisar. Una del futuro no vale.
func VerificarMarca(c Confianza, marcas []string, edicion string, f MarcaFirmada, ahora time.Time) (MarcaVista, error) {
	if len(f.Marca) > 64*1024 || len(f.Firmas) > 8 {
		return MarcaVista{}, errors.New("does not have the form of a signed timestamp")
	}
	cand := clavesDeMarca(c, marcas, edicion)
	firmada := ""
	for _, p := range cand {
		pub, err := ClaveVerificable(p)
		if err != nil {
			continue
		}
		if f.Firma != "" && firmaBuena(pub, f.Marca, f.Firma) {
			firmada = Huella(pub)
			break
		}
		for _, x := range f.Firmas {
			if x.Clave == Huella(pub) && firmaBuena(pub, f.Marca, x.Firma) {
				firmada = x.Clave
				break
			}
		}
		if firmada != "" {
			break
		}
	}
	if firmada == "" {
		return MarcaVista{}, errors.New("the timestamp is not signed by SeguridadSI")
	}
	var m Marca
	if err := json.Unmarshal([]byte(f.Marca), &m); err != nil {
		return MarcaVista{}, errors.New("it is not a timestamp")
	}
	if err := m.motivo(); err != nil {
		return MarcaVista{}, err
	}
	e, cad, _ := m.fechas()
	if e.After(ahora.Add(margenFuturoMarca)) {
		return MarcaVista{}, errors.New("the timestamp comes from the future")
	}
	return MarcaVista{Marca: m, Firmada: f, FirmadaCon: firmada, Caducada: !cad.After(ahora)}, nil
}

// MasNueva devuelve la más nueva por emitida (nil si no hay ninguna).
func MasNueva(xs ...*MarcaVista) *MarcaVista {
	var r *MarcaVista
	for _, x := range xs {
		if x == nil {
			continue
		}
		if r == nil {
			r = x
			continue
		}
		a, _, _ := r.Marca.fechas()
		b, _, _ := x.Marca.fechas()
		if b.After(a) {
			r = x
		}
	}
	return r
}

// EstadoMarca es lo que el actualizador dice a la consola (y la consola al panel).
type EstadoMarca struct {
	// al-dia, sin-marca (nunca ha visto una: aún no se publican), caducada o retenida.
	Estado  string `json:"estado"`
	Detalle string `json:"detalle"`
	// La última versión de su edición según la marca, y hasta cuándo vale la marca.
	Ultima  string `json:"ultima,omitempty"`
	Caduca  string `json:"caduca,omitempty"`
	Emitida string `json:"emitida,omitempty"`
	// De dónde vino la marca más nueva: estatica (el repo público) o panel.
	Origen string `json:"origen,omitempty"`
	// Si la última versión ofrecida no estaba en el registro de transparencia, o no se pudo
	// comprobar: por qué. Vacío si todo bien.
	Registro string `json:"registro,omitempty"`
}

// EvaluarMarca decide qué decir con la marca más nueva, la edición y la versión instalada.
func EvaluarMarca(v *MarcaVista, edicion, instalada string, ahora time.Time) EstadoMarca {
	if v == nil {
		return EstadoMarca{Estado: "sin-marca", Detalle: "no signed timestamp seen yet"}
	}
	e := EstadoMarca{Estado: "al-dia", Caduca: v.Marca.Caduca, Emitida: v.Marca.Emitida, Origen: v.Origen}
	u, hay := v.Marca.Ultimas[edicion]
	if hay {
		e.Ultima = u.Version
	}
	if v.Caducada {
		e.Estado = "caducada"
		e.Detalle = fmt.Sprintf("the newest signed timestamp expired on %s: neither Central nor the public copy gives a fresh one, so this node cannot tell whether it is being held on an old version", v.Marca.Caduca)
		return e
	}
	if hay && instalada != "" && docker.CompararVersiones(instalada, u.Version) < 0 {
		publicada, _ := time.Parse(time.RFC3339, u.Publicada)
		plazo := time.Duration(v.Marca.PlazoHoras) * time.Hour
		if ahora.Sub(publicada) > plazo {
			e.Estado = "retenida"
			e.Detalle = fmt.Sprintf("version %s was published on %s and this node is still on %s: Central has not offered it within %d hours", u.Version, u.Publicada, instalada, v.Marca.PlazoHoras)
		}
	}
	return e
}

// Vigia trae la marca, se queda con la más nueva y dice a la consola cómo está el nodo.
type Vigia struct {
	Estatica  string       // carpeta de la copia estática (MARCA_URL o URLMarcaEstatica)
	Consola   string       // ruta completa de /api/actualizador/marca
	Token     string       // el del actualizador
	HTTP      *http.Client // el de la consola (con su CA)
	Fuera     *http.Client // para la copia estática (raíces del sistema)
	Dir       string       // carpeta del nodo, donde se guarda marca.json
	Confianza Confianza
	Marcas    []string // PUBLICACION_MARCAS
	Edicion   string
	Versiones string // versiones.env, de donde sale la versión instalada
	Log       func(string, ...any)
	// Si está, da la confianza y las claves de marcas de ahora en cada vuelta (el .env cambia
	// cuando una versión trae claves nuevas).
	Claves func() (Confianza, []string)

	actual  *MarcaVista
	cargada bool
	// La última marca bajada de la copia estática, y cuándo: la que manda para el registro.
	estatica      *MarcaVista
	estaticaVista time.Time
	registro      string
	// La última versión mirada en el registro y qué salió.
	regHuella, regEstado, regDetalle string
	regCuando                        time.Time
}

func (v *Vigia) log(m string, args ...any) {
	if v.Log != nil {
		v.Log(m, args...)
	}
}

// traer pide una marca firmada a una dirección; nil si no hay o no se entiende.
func traer(ctx context.Context, c *http.Client, url, token string, envuelta bool) (*MarcaFirmada, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 128<<10))
	if err != nil {
		return nil, err
	}
	if envuelta {
		var p struct {
			Marca *MarcaFirmada `json:"marca"`
		}
		if err := json.Unmarshal(b, &p); err != nil {
			return nil, err
		}
		return p.Marca, nil
	}
	var f MarcaFirmada
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

func (v *Vigia) comprobar(f *MarcaFirmada, origen string, ahora time.Time) *MarcaVista {
	if f == nil {
		return nil
	}
	m, err := VerificarMarca(v.Confianza, v.Marcas, v.Edicion, *f, ahora)
	if err != nil {
		v.log("timestamp rejected", "origen", origen, "err", err)
		return nil
	}
	m.Origen = origen
	return &m
}

// Vuelta trae las dos copias, guarda la más nueva y dice el estado a la consola.
func (v *Vigia) Vuelta(ctx context.Context, ahora time.Time) (EstadoMarca, error) {
	if v.Claves != nil {
		v.Confianza, v.Marcas = v.Claves()
	}
	// El aviso de una versión instalada sin prueba se queda un día; el de una ausente, mientras se ofrezca.
	if v.regEstado != RegistroAusente && ahora.Sub(v.regCuando) > 24*time.Hour {
		v.registro = ""
	}
	if !v.cargada {
		v.cargada = true
		if b, err := os.ReadFile(filepath.Join(v.Dir, FicheroMarca)); err == nil {
			var f MarcaFirmada
			if json.Unmarshal(b, &f) == nil {
				v.actual = v.comprobar(&f, "guardada", ahora)
			}
		}
	}
	var deFuera, delPanel *MarcaVista
	if v.Estatica != "" && v.Fuera != nil {
		f, err := traer(ctx, v.Fuera, v.Estatica+"/marca.json", "", false)
		if err != nil {
			v.log("public timestamp copy not reachable", "err", err)
		}
		deFuera = v.comprobar(f, "estatica", ahora)
		if deFuera != nil {
			v.estatica, v.estaticaVista = deFuera, ahora
		}
	}
	if v.Consola != "" {
		f, err := traer(ctx, v.HTTP, v.Consola, v.Token, true)
		if err != nil {
			v.log("timestamp from the console not available", "err", err)
		}
		delPanel = v.comprobar(f, "panel", ahora)
	}
	if v.actual != nil {
		// La guardada se vuelve a mirar con el reloj de ahora: puede haber caducado.
		v.actual = v.comprobar(&v.actual.Firmada, v.actual.Origen, ahora)
	}
	nueva := MasNueva(v.actual, deFuera, delPanel)
	if nueva != nil && nueva != v.actual {
		if b, err := json.Marshal(nueva.Firmada); err == nil && v.Dir != "" {
			if err := escribirAtomico(filepath.Join(v.Dir, FicheroMarca), b, 0o644); err != nil {
				v.log("could not save the timestamp", "err", err)
			}
		}
	}
	v.actual = nueva
	estado := EvaluarMarca(nueva, v.Edicion, VersionInstalada(v.Versiones), ahora)
	estado.Registro = v.registro
	return estado, v.informar(ctx, estado)
}

// Actual es la marca más nueva comprobada (nil si ninguna).
func (v *Vigia) Actual() *MarcaVista { return v.actual }

// Informar dice a la consola el estado de ahora (tras comprobar el registro de una versión).
func (v *Vigia) Informar(ctx context.Context, ahora time.Time) error {
	e := EvaluarMarca(v.actual, v.Edicion, VersionInstalada(v.Versiones), ahora)
	e.Registro = v.registro
	return v.informar(ctx, e)
}

func (v *Vigia) informar(ctx context.Context, e EstadoMarca) error {
	if v.Consola == "" {
		return nil
	}
	b, _ := json.Marshal(e)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.Consola, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+v.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := v.HTTP.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("console: %s", resp.Status)
	}
	return nil
}

// marshalPublica: una clave pública en spki DER base64, como se escriben en el .env.
func marshalPublica(pub crypto.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(der), nil
}
