// Package copias saca las copias de seguridad del nodo de la máquina, al
// almacén del cliente (docs/diseno/copias-fuera.md; plan de fortificación §8.2).
//
// copia.sh las crea cada noche en copias/sugardaddy-<fecha>.tar.age, cifradas
// con age a la clave pública del cliente. El actualizador las sube al destino
// que se elige en la consola (Ajustes → Backups): una carpeta compartida SMB,
// un bucket compatible con S3 o un contenedor de Azure Blob con una URL SAS.
// Conserva allí las últimas N y, una vez al mes, baja la última y la comprueba.
//
// Sin dependencias nuevas: S3 (firma SigV4) y Azure son HTTP de la biblioteca
// estándar; SMB lo monta Docker en el anfitrión (un volumen «local» de tipo
// cifs) para un auxiliar de un instante sin red (smb.go).
package copias

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Tipos de destino.
const (
	TipoS3    = "s3"
	TipoAzure = "azure"
	TipoSMB   = "smb"
)

// Config es el destino tal como lo da la consola (GET /api/actualizador/copias),
// con los secretos ya descifrados. Nunca se escribe en disco ni en el registro.
type Config struct {
	Tipo  string    `json:"tipo"`
	S3    *S3Config `json:"s3,omitempty"`
	Azure *AzConfig `json:"azure,omitempty"`
	SMB   *SMBCfg   `json:"smb,omitempty"`
	// Inmutable: si el destino lo admite, cada copia sube bloqueada (S3 Object
	// Lock o la inmutabilidad por versión de Azure) durante estos días.
	Inmutable *Inmutable `json:"inmutable,omitempty"`
}

// Inmutable: el bloqueo con que sube cada copia.
type Inmutable struct {
	Dias int `json:"dias"`
	// Modo: «compliance» (nadie la borra antes de tiempo, ni el dueño de la
	// cuenta) o «governance» (quien tenga el permiso especial puede quitarlo).
	Modo string `json:"modo"`
}

// Remota es una copia que ya está en el destino.
type Remota struct {
	Nombre string `json:"nombre"`
	Bytes  int64  `json:"bytes"`
}

// Destino es lo que saben hacer los tres almacenes.
type Destino interface {
	// Subir deja el fichero local con ese nombre en el destino. sha256 es su
	// huella en hexadecimal, ya calculada (S3 la firma; todos la guardan como
	// metadato).
	Subir(ctx context.Context, nombre, ruta, sha256 string, bytes int64) error
	// Listar devuelve las copias del destino (solo las que parecen de copia.sh).
	Listar(ctx context.Context) ([]Remota, error)
	// Borrar quita una copia. ErrBloqueada si la inmutabilidad no lo deja.
	Borrar(ctx context.Context, nombre string) error
	// Bajar escribe la copia en w.
	Bajar(ctx context.Context, nombre string, w io.Writer) error
}

// ErrBloqueada: el destino no deja borrar la copia porque aún está bloqueada.
var ErrBloqueada = errors.New("the backup is still locked by the storage's immutability")

// NombreCopia: el nombre que da copia.sh. Solo esos se suben, se cuentan y se borran:
// nada más del destino se toca nunca.
var NombreCopia = regexp.MustCompile(`^sugardaddy-[0-9]{8}-[0-9]{6}\.tar\.age$`)

// Prefijo normaliza la carpeta dentro del destino: sin barras al principio, con
// una al final, sin «..» ni caracteres raros.
func Prefijo(p string) (string, error) {
	p = strings.Trim(strings.TrimSpace(p), "/")
	if p == "" {
		return "", nil
	}
	for _, trozo := range strings.Split(p, "/") {
		if trozo == "" || trozo == "." || trozo == ".." || !trozoValido.MatchString(trozo) {
			return "", fmt.Errorf("folder %q: use letters, digits, «-», «_» and «.» separated by «/»", p)
		}
	}
	return p + "/", nil
}

var trozoValido = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

// Ordenar deja las copias de la más nueva a la más vieja (el nombre lleva la fecha).
func Ordenar(r []Remota) {
	sort.Slice(r, func(i, j int) bool { return r[i].Nombre > r[j].Nombre })
}

// Sobrantes son las que hay que borrar para quedarse con las últimas `conservar`.
func Sobrantes(r []Remota, conservar int) []Remota {
	if conservar < 1 {
		conservar = 1
	}
	c := append([]Remota(nil), r...)
	Ordenar(c)
	if len(c) <= conservar {
		return nil
	}
	return c[conservar:]
}

// Hasta: hasta cuándo queda bloqueada una copia que sube ahora.
func (i *Inmutable) Hasta(ahora time.Time) time.Time {
	return ahora.UTC().Add(time.Duration(i.Dias) * 24 * time.Hour).Truncate(time.Second)
}

func (i *Inmutable) activa() bool { return i != nil && i.Dias > 0 }

// Validar comprueba lo que no depende de la red.
func (c Config) Validar() error {
	if c.Inmutable.activa() {
		if c.Inmutable.Dias > 3650 {
			return errors.New("immutability: at most 3650 days")
		}
		if c.Inmutable.Modo != "compliance" && c.Inmutable.Modo != "governance" {
			return errors.New("immutability: mode must be compliance or governance")
		}
	}
	switch c.Tipo {
	case TipoS3:
		if c.S3 == nil {
			return errors.New("s3: missing settings")
		}
		return c.S3.validar()
	case TipoAzure:
		if c.Azure == nil {
			return errors.New("azure: missing settings")
		}
		return c.Azure.validar()
	case TipoSMB:
		if c.SMB == nil {
			return errors.New("smb: missing settings")
		}
		if c.Inmutable.activa() {
			return errors.New("smb: a shared folder cannot lock backups; use the snapshots or WORM features of your file server")
		}
		return c.SMB.validar()
	}
	return fmt.Errorf("unknown destination type %q", c.Tipo)
}

// Secretos: lo que nunca debe salir en un error ni en el registro.
func (c Config) Secretos() []string {
	var s []string
	if c.S3 != nil {
		s = append(s, c.S3.ClaveSecreta)
	}
	if c.Azure != nil {
		s = append(s, sasDe(c.Azure.URL)...)
	}
	if c.SMB != nil {
		s = append(s, c.SMB.Clave)
	}
	return s
}

// Tapar quita los secretos de un texto (un error del destino que los repita).
func Tapar(texto string, secretos []string) string {
	for _, x := range secretos {
		if len(x) >= 4 {
			texto = strings.ReplaceAll(texto, x, "••••")
		}
	}
	return texto
}
