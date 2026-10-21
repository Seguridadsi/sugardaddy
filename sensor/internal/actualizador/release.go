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
		return fmt.Errorf("%s: sin ficheros", seccion)
	}
	for nombre, texto := range c.Ficheros {
		if !slices.Contains(FicherosPermitidos[seccion], nombre) {
			return fmt.Errorf("%s: fichero no permitido (%s)", seccion, nombre)
		}
		if len(texto) > maxFichero {
			return fmt.Errorf("%s: %s pasa de 64 KB", seccion, nombre)
		}
	}
	if _, ok := c.Ficheros["compose.yml"]; !ok {
		return fmt.Errorf("%s: falta compose.yml", seccion)
	}
	if c.Entorno != nil {
		for k, v := range c.Entorno.Nuevas {
			if !claveEntorno.MatchString(k) || strings.ContainsAny(v, "\r\n") || len(v) > 1024 {
				return fmt.Errorf("%s: variable de entorno mal formada (%s)", seccion, k)
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
	Release string `json:"release"`
	Firma   string `json:"firma"`
}

var (
	semver   = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	imagen   = regexp.MustCompile(`^([a-z0-9.-]+(:[0-9]+)?/)?[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$`)
	servicio = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)
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
		return nil, errors.New("la clave de publicación no es Ed25519")
	}
	return pub, nil
}

// Verificar comprueba la firma sobre el texto exacto y lo que la versión
// promete: número de versión válido e imágenes fijadas por digest.
func Verificar(clave ed25519.PublicKey, f ReleaseFirmada) (Release, error) {
	var r Release
	firma, err := base64.StdEncoding.DecodeString(f.Firma)
	if err != nil || !ed25519.Verify(clave, []byte(f.Release), firma) {
		return r, errors.New("la versión no está firmada por SeguridadSI")
	}
	if err := json.Unmarshal([]byte(f.Release), &r); err != nil {
		return r, err
	}
	if !semver.MatchString(r.Version) {
		return r, errors.New("número de versión mal formado")
	}
	if len(r.Servicios) == 0 {
		return r, errors.New("la versión no trae servicios")
	}
	for s, img := range r.Servicios {
		if !servicio.MatchString(s) || !imagen.MatchString(img) {
			return r, fmt.Errorf("imagen de %s sin digest o mal formada", s)
		}
	}
	if r.Actualizador != "" && !imagen.MatchString(r.Actualizador) {
		return r, errors.New("imagen del actualizador sin digest o mal formada")
	}
	for seccion, c := range map[string]*Configuracion{"nodo": r.Nodo, "sensorRemoto": r.SensorRemoto} {
		if err := validarConfiguracion(seccion, c); err != nil {
			return r, err
		}
		if c != nil && r.Actualizador == "" {
			return r, errors.New("una versión con configuración tiene que traer el actualizador")
		}
	}
	return r, nil
}
