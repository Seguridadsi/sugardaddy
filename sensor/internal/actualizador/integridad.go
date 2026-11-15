package actualizador

// Integridad del nodo (docs/diseno/auditoria-inmutable.md, «integridad.desviacion»):
// cada pocos minutos, el actualizador compara la máquina con la versión firmada que
// tiene instalada (firmado/version.json) y le cuenta a la consola lo que no casa. La
// consola lo apunta en su auditoría y de ahí sale al SIEM del cliente como crítico.
//
// Lo que mira, solo si puede compararlo con algo firmado:
//
//   - los ficheros de la configuración firmada (compose.yml, Caddyfile), si esa
//     configuración es la aplicada (SUGARDADDY_CONFIGURACION en versiones.env);
//   - versiones.env: las imágenes de cada servicio, las de la versión;
//   - el .env: PUBLICACION_CLAVES igual a la de la versión (una clave de más sería
//     una puerta para firmar versiones falsas) y que no aparezcan ni desaparezcan
//     variables desde la última versión aplicada (sus nombres, nunca sus valores);
//   - los contenedores en marcha de cada servicio: la imagen que piden y la que
//     corren de verdad (su id) tienen que ser las de la versión.
//
// Nunca toca nada: solo mira y cuenta. Si la máquina no tiene versión firmada (una
// instalación de antes de la 0.25 que aún no la ha recibido), no hay con qué
// comparar y no dice nada.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Desviacion es algo de la máquina que no casa con la versión firmada.
type Desviacion struct {
	Tipo    string `json:"tipo"` // firma, fichero, versiones, env, imagen
	Detalle string `json:"detalle"`
}

// motorIntegridad es lo que necesita de Docker (docker.Cliente lo cumple).
type motorIntegridad interface {
	ListarConEtiqueta(ctx context.Context, etiqueta string) ([]docker.Contenedor, error)
	Inspeccionar(ctx context.Context, id string) (map[string]any, error)
	InspeccionarImagen(ctx context.Context, ref string) (map[string]any, error)
}

// FicheroBaseEnv guarda los nombres de las variables del .env de la última versión
// aplicada, para ver si luego aparece o desaparece alguna.
const FicheroBaseEnv = ".integridad-env.json"

// gestionadasEnv son variables que el propio actualizador pone o quita fuera de una
// versión (ca.go): no cuentan como desviación.
var gestionadasEnv = []string{"CA_NODO"}

// Integridad compara la máquina del nodo con su versión firmada y lo cuenta.
type Integridad struct {
	Docker    motorIntegridad
	Local     string // la carpeta del nodo, montada en este contenedor
	Confianza Confianza
	Edicion   string
	Consola   string
	Token     string
	HTTP      *http.Client
	Cada      time.Duration // 10 minutos si no se dice
	Log       func(m string, args ...any)

	ultima time.Time
}

type baseEnv struct {
	Version string   `json:"version"`
	Huella  string   `json:"huella"` // de versiones.env: cambia con cada versión aplicada
	Claves  []string `json:"claves"`
}

// Vuelta comprueba si toca y, si ha podido comparar, se lo cuenta a la consola.
func (i *Integridad) Vuelta(ctx context.Context) error {
	cada := i.Cada
	if cada == 0 {
		cada = 10 * time.Minute
	}
	if time.Since(i.ultima) < cada {
		return nil
	}
	i.ultima = time.Now()
	version, ds, ok := i.Comprobar(ctx)
	if !ok {
		return nil
	}
	if len(ds) > 0 && i.Log != nil {
		i.Log("the node does not match its signed version", "version", version, "desviaciones", len(ds))
	}
	return i.informar(ctx, version, ds)
}

// Comprobar devuelve la versión comparada y lo que no casa. ok es false si no hay
// con qué comparar.
func (i *Integridad) Comprobar(ctx context.Context) (version string, ds []Desviacion, ok bool) {
	b, err := os.ReadFile(filepath.Join(i.Local, FicheroFirmada))
	if err != nil {
		return "", nil, false
	}
	var f ReleaseFirmada
	if err := json.Unmarshal(b, &f); err != nil {
		return "", []Desviacion{{"firma", "the signed version on the machine cannot be read"}}, true
	}
	r, err := VerificarEnNodo(i.Confianza, i.Edicion, f)
	if err != nil {
		return "", []Desviacion{{"firma", "the signed version on the machine does not verify: " + err.Error()}}, true
	}
	versiones := filepath.Join(i.Local, "versiones.env")
	inst := VersionInstalada(versiones)
	if inst != r.Version {
		// Otra versión instalada (una solo de imágenes no deja la suya): no hay con qué comparar.
		return inst, nil, false
	}

	ds = append(ds, i.ficheros(r, versiones)...)
	ds = append(ds, i.versiones(r, versiones)...)
	ds = append(ds, i.entorno(r, versiones)...)
	ds = append(ds, i.imagenes(ctx, r)...)
	return r.Version, ds, true
}

func (i *Integridad) ficheros(r Release, versiones string) []Desviacion {
	if r.Nodo == nil || ConfiguracionAplicada(versiones) != r.Version {
		return nil
	}
	var ds []Desviacion
	nombres := make([]string, 0, len(r.Nodo.Ficheros))
	for n := range r.Nodo.Ficheros {
		nombres = append(nombres, n)
	}
	sort.Strings(nombres)
	for _, n := range nombres {
		actual, err := os.ReadFile(filepath.Join(i.Local, n))
		switch {
		case errors.Is(err, os.ErrNotExist):
			ds = append(ds, Desviacion{"fichero", n + " is missing"})
		case err != nil:
			ds = append(ds, Desviacion{"fichero", n + " cannot be read: " + err.Error()})
		case string(actual) != r.Nodo.Ficheros[n]:
			ds = append(ds, Desviacion{"fichero", n + " differs from the signed version"})
		}
	}
	return ds
}

func (i *Integridad) versiones(r Release, versiones string) []Desviacion {
	env, err := LeerEnv(versiones)
	if err != nil {
		return []Desviacion{{"versiones", "versiones.env cannot be read"}}
	}
	var ds []Desviacion
	for _, s := range serviciosOrdenados(r) {
		k := strings.ToUpper(strings.ReplaceAll(s, "-", "_")) + "_IMAGEN"
		if env[k] != r.Servicios[s] {
			ds = append(ds, Desviacion{"versiones", fmt.Sprintf("%s in versiones.env is not the image of the signed version", k)})
		}
	}
	if r.Actualizador != "" && env["ACTUALIZADOR_IMAGEN"] != "" && env["ACTUALIZADOR_IMAGEN"] != r.Actualizador {
		ds = append(ds, Desviacion{"versiones", "ACTUALIZADOR_IMAGEN in versiones.env is not the image of the signed version"})
	}
	return ds
}

func (i *Integridad) entorno(r Release, versiones string) []Desviacion {
	env, err := LeerEnv(filepath.Join(i.Local, ".env"))
	if err != nil {
		return []Desviacion{{"env", ".env cannot be read"}}
	}
	var ds []Desviacion
	if r.Confianza != nil && strings.TrimSpace(env["PUBLICACION_CLAVES"]) != strings.TrimSpace(r.Confianza.Claves) {
		ds = append(ds, Desviacion{"env", "PUBLICACION_CLAVES in .env is not the list of the signed version"})
	}
	claves := make([]string, 0, len(env))
	for k := range env {
		if !slices.Contains(gestionadasEnv, k) {
			claves = append(claves, k)
		}
	}
	sort.Strings(claves)
	huella := huellaFichero(versiones)
	ruta := filepath.Join(i.Local, FicheroBaseEnv)
	var base baseEnv
	b, err := os.ReadFile(ruta)
	if err != nil || json.Unmarshal(b, &base) != nil || base.Version != r.Version || base.Huella != huella {
		// Primera vez, o una versión recién aplicada (que puede traer variables nuevas):
		// lo de ahora es la referencia.
		nb, _ := json.Marshal(baseEnv{Version: r.Version, Huella: huella, Claves: claves})
		_ = escribirAtomico(ruta, nb, 0o600)
		return ds
	}
	var nuevas, quitadas []string
	for _, k := range claves {
		if !slices.Contains(base.Claves, k) {
			nuevas = append(nuevas, k)
		}
	}
	for _, k := range base.Claves {
		if !slices.Contains(claves, k) {
			quitadas = append(quitadas, k)
		}
	}
	if len(nuevas) > 0 {
		ds = append(ds, Desviacion{"env", "variables added to .env since the last version: " + strings.Join(nuevas, ", ")})
	}
	if len(quitadas) > 0 {
		ds = append(ds, Desviacion{"env", "variables removed from .env since the last version: " + strings.Join(quitadas, ", ")})
	}
	return ds
}

func (i *Integridad) imagenes(ctx context.Context, r Release) []Desviacion {
	if i.Docker == nil {
		return nil
	}
	var ds []Desviacion
	for _, s := range serviciosOrdenados(r) {
		lista, err := i.Docker.ListarConEtiqueta(ctx, EtiquetaServicio+"="+s)
		if err != nil {
			continue
		}
		var esperada string
		for _, c := range lista {
			if c.State != "running" {
				continue
			}
			inspeccion, err := i.Docker.Inspeccionar(ctx, c.ID)
			if err != nil {
				continue
			}
			config, _ := inspeccion["Config"].(map[string]any)
			if fmt.Sprint(config["Image"]) != r.Servicios[s] {
				ds = append(ds, Desviacion{"imagen", fmt.Sprintf("service %s runs an image that is not the one of the signed version", s)})
				continue
			}
			if esperada == "" {
				img, err := i.Docker.InspeccionarImagen(ctx, r.Servicios[s])
				if err != nil {
					ds = append(ds, Desviacion{"imagen", fmt.Sprintf("the image of service %s is not on the machine", s)})
					continue
				}
				esperada = fmt.Sprint(img["Id"])
			}
			if fmt.Sprint(inspeccion["Image"]) != esperada {
				ds = append(ds, Desviacion{"imagen", fmt.Sprintf("service %s runs an image whose content is not the one of the signed version", s)})
			}
		}
	}
	return ds
}

func serviciosOrdenados(r Release) []string {
	s := make([]string, 0, len(r.Servicios))
	for k := range r.Servicios {
		s = append(s, k)
	}
	sort.Strings(s)
	return s
}

func huellaFichero(ruta string) string {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

func (i *Integridad) informar(ctx context.Context, version string, ds []Desviacion) error {
	if ds == nil {
		ds = []Desviacion{}
	}
	b, _ := json.Marshal(map[string]any{"version": version, "desviaciones": ds})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, i.Consola+"/api/actualizador/integridad", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+i.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := i.HTTP.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	// Una consola anterior no tiene la ruta: no es un error del nodo.
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	return nil
}
