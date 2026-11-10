// Package actualizador cambia las imágenes de los servicios del nodo a las de
// una versión firmada, y vuelve atrás si la nueva no arranca sana.
//
// Es el único proceso del nodo con el socket de Docker. La consola le dice
// qué versión toca, pero él no se fía: vuelve a verificar la firma con la
// clave de publicación que lleva fijada.
package actualizador

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

type Release struct {
	Version   string            `json:"version"`
	Publicada string            `json:"publicada"`
	Notas     string            `json:"notas"`
	Servicios map[string]string `json:"servicios"`
	// Imagen del actualizador, que también hace de auxiliar al aplicar la configuración.
	Actualizador string `json:"actualizador,omitempty"`
	// Configuración firmada del nodo y del sensor remoto (desde la 0.12).
	Nodo         *Configuracion `json:"nodo,omitempty"`
	SensorRemoto *Configuracion `json:"sensorRemoto,omitempty"`
	// Desde la 0.25 (docs/diseno/claves-y-catalogo.md): las claves en las que confiar,
	// lo único que el sensor puede arrancar (huellas de manifiesto por módulo) y de qué
	// commit sale.
	Confianza *ConfianzaNueva     `json:"confianza,omitempty"`
	Catalogo  map[string][]string `json:"catalogo,omitempty"`
	Commit    string              `json:"commit,omitempty"`
}

// ConfianzaNueva es la lista de claves que una versión deja en el .env, y si retira la de legado.
type ConfianzaNueva struct {
	Claves        string `json:"claves"`
	RetirarLegado bool   `json:"retirarLegado,omitempty"`
}

// Configuracion son los ficheros del compose (y el Caddyfile del nodo) y las
// variables nuevas de .env, firmados con la versión.
type Configuracion struct {
	Ficheros map[string]string `json:"ficheros"`
	Entorno  *struct {
		Nuevas  map[string]string `json:"nuevas,omitempty"`
		Generar []string          `json:"generar,omitempty"`
	} `json:"entorno,omitempty"`
}

// FicherosPermitidos dice qué ficheros puede traer cada sección. Ni uno más.
var FicherosPermitidos = map[string][]string{
	"nodo":         {"compose.yml", "Caddyfile"},
	"sensorRemoto": {"compose.yml"},
}

const maxFichero = 64 * 1024

var claveEntorno = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

func validarConfiguracion(seccion string, c *Configuracion) error {
	if c == nil {
		return nil
	}
	if len(c.Ficheros) == 0 {
		return fmt.Errorf("%s: no files", seccion)
	}
	for nombre, texto := range c.Ficheros {
		if !slices.Contains(FicherosPermitidos[seccion], nombre) {
			return fmt.Errorf("%s: file not allowed (%s)", seccion, nombre)
		}
		if len(texto) > maxFichero {
			return fmt.Errorf("%s: %s exceeds 64 KB", seccion, nombre)
		}
	}
	if _, ok := c.Ficheros["compose.yml"]; !ok {
		return fmt.Errorf("%s: compose.yml is missing", seccion)
	}
	if c.Entorno != nil {
		for k, v := range c.Entorno.Nuevas {
			if !claveEntorno.MatchString(k) || strings.ContainsAny(v, "\r\n") || len(v) > 1024 {
				return fmt.Errorf("%s: malformed environment variable (%s)", seccion, k)
			}
		}
		for _, k := range c.Entorno.Generar {
			if !claveEntorno.MatchString(k) {
				return fmt.Errorf("%s: variable a generar mal formada (%s)", seccion, k)
			}
		}
	}
	return nil
}

type ReleaseFirmada struct {
	Release string  `json:"release"`
	Firma   string  `json:"firma"`
	Firmas  []Firma `json:"firmas,omitempty"`
}

var (
	semver         = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	imagen         = regexp.MustCompile(`^([a-z0-9.-]+(:[0-9]+)?/)?[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$`)
	servicio       = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)
	moduloCatalogo = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	huellaCatalogo = regexp.MustCompile(`^[0-9a-f]{64}$`)
	commitRelease  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	huellaFirma    = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

// ClavePublica lee una clave Ed25519 en DER (spki) base64, como la genera paquetes/canal.
func ClavePublica(b64 string) (ed25519.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("the publishing key is not Ed25519")
	}
	return pub, nil
}

// Verificar comprueba la firma sobre el texto exacto, con una clave del uso de su
// edición (cloud o community) o con la de legado, y lo que la versión promete: número de
// versión válido, imágenes fijadas por digest y la forma de lo nuevo de la 0.25.
func Verificar(c Confianza, f ReleaseFirmada) (Release, error) {
	var r Release
	if err := json.Unmarshal([]byte(f.Release), &r); err != nil {
		return Release{}, errors.New("the version is not signed by SeguridadSI")
	}
	// encoding/json casa los campos sin mirar mayúsculas: «Catalogo» valdría aquí y no en
	// TypeScript. Una clave conocida escrita de otra forma no se acepta (paridad con TS).
	if err := clavesExactas(f.Release); err != nil {
		return Release{}, err
	}
	if len(f.Firmas) > 8 {
		return Release{}, errors.New("malformed signature list")
	}
	for _, x := range f.Firmas {
		if !huellaFirma.MatchString(x.Clave) || x.Firma == "" {
			return Release{}, errors.New("malformed signature list")
		}
	}
	uso := EdicionDeRelease(r)
	if !c.HayClave(uso) {
		return Release{}, errSinClave
	}
	if c.FirmadoPor(uso, f.Release, f.Firma, f.Firmas) == "" {
		return Release{}, errors.New("the version is not signed by SeguridadSI")
	}
	if !semver.MatchString(r.Version) {
		return r, errors.New("malformed version number")
	}
	if len(r.Servicios) == 0 {
		return r, errors.New("the version includes no services")
	}
	for s, img := range r.Servicios {
		if !servicio.MatchString(s) || !imagen.MatchString(img) {
			return r, fmt.Errorf("image for %s has no digest or is malformed", s)
		}
	}
	if r.Actualizador != "" && !imagen.MatchString(r.Actualizador) {
		return r, errors.New("updater image has no digest or is malformed")
	}
	for seccion, c := range map[string]*Configuracion{"nodo": r.Nodo, "sensorRemoto": r.SensorRemoto} {
		if err := validarConfiguracion(seccion, c); err != nil {
			return r, err
		}
		if c != nil && r.Actualizador == "" {
			return r, errors.New("a version with configuration must include the updater")
		}
	}
	if err := validarNovedades(r, uso); err != nil {
		return r, err
	}
	return r, nil
}

// validarNovedades comprueba la forma de la confianza, el catálogo y el commit.
func validarNovedades(r Release, uso string) error {
	if r.Confianza != nil {
		if m := MotivoClaves(r.Confianza.Claves); m != "" {
			return errors.New(m)
		}
		propia := false
		for _, k := range LeerConfianza(r.Confianza.Claves, "").Claves {
			if uso != "" && k.Uso == uso {
				propia = true
			}
		}
		// Sin una clave de su propio uso, el nodo no podría comprobar la versión siguiente.
		if !propia {
			return errors.New("the trusted keys leave this edition without a key")
		}
		// Sin legado, cada cosa que el nodo comprueba necesita su clave: las licencias en
		// Cloud y las delegaciones (MSP, registro) en las dos.
		if r.Confianza.RetirarLegado {
			usos := map[string]bool{}
			for _, k := range LeerConfianza(r.Confianza.Claves, "").Claves {
				usos[k.Uso] = true
			}
			if !usos["delegaciones"] || (uso == "cloud" && !usos["licencias"]) {
				return errors.New("retiring the legacy key would leave licenses or delegations without a key")
			}
		}
	}
	if len(r.Catalogo) > 500 {
		return errors.New("the decoy catalog is too large")
	}
	for m, hs := range r.Catalogo {
		if !moduloCatalogo.MatchString(m) || len(hs) == 0 || len(hs) > 8 {
			return fmt.Errorf("malformed decoy catalog entry (%.64s)", m)
		}
		for _, h := range hs {
			if !huellaCatalogo.MatchString(h) {
				return fmt.Errorf("malformed decoy catalog entry (%.64s)", m)
			}
		}
	}
	if r.Commit != "" && !commitRelease.MatchString(r.Commit) {
		return errors.New("malformed commit")
	}
	return nil
}

// clavesExactas rechaza una clave de primer nivel que coincide con un campo conocido salvo en
// mayúsculas («Servicios», «CATALOGO»): Go la leería y TypeScript no.
func clavesExactas(texto string) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(texto), &m); err != nil {
		return errors.New("the version is not signed by SeguridadSI")
	}
	conocidas := []string{"version", "publicada", "notas", "servicios", "actualizador", "nodo", "sensorRemoto", "confianza", "catalogo", "commit"}
	for k := range m {
		for _, c := range conocidas {
			if k != c && strings.EqualFold(k, c) {
				return fmt.Errorf("unexpected field %q in the version", k)
			}
		}
	}
	return nil
}
