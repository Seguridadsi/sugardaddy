// Package discos da a cada trampa de contenedor un disco de tamaño fijo para
// sus registros y sus carpetas escribibles (SEN-4, docs/diseno/discos-trampa.md):
// un fichero ext4 disperso, montado en loop. Haga lo que haga una trampa tomada,
// no escribe más que lo que cabe en su disco, y no llena la máquina.
//
// Montar necesita privilegios que el sensor no tiene. Lo hace un auxiliar de un
// solo uso con la imagen del actualizador (orden «disco»), que el sensor lanza
// por la API de Docker. El montaje llega a la máquina por propagación (la carpeta
// del sensor entra en el auxiliar con rshared) y de la máquina al sensor (que la
// monta con rslave, SENSOR_PROPAGACION en los compose).
//
// Donde no se puede (sin dispositivos loop, sin propagación, sin permiso para un
// contenedor privilegiado o sin el auxiliar), cada trampa sigue como antes, con
// el vigilante de 10 s del sensor, y se dice con un código estable.
package discos

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// Códigos estables (fase.causa). CodigoFijo es el motivo del hecho disco.trampas
// en verdadero; los demás dicen por qué no.
const (
	CodigoFijo           = "disco.fijo"
	CodigoSinAuxiliar    = "disco.sin-auxiliar"
	CodigoSinPropagacion = "disco.sin-propagacion"
	CodigoSinLoop        = "disco.sin-loop"
	CodigoSinPermiso     = "disco.sin-permiso"
	CodigoSinEspacio     = "disco.sin-espacio"
	CodigoError          = "disco.error"
)

// DeLaMaquina dice si un código es de la máquina (vale para todas sus trampas y
// no cambia mientras el sensor siga en marcha) y no solo de un disco.
func DeLaMaquina(codigo string) bool {
	switch codigo {
	case CodigoSinAuxiliar, CodigoSinPropagacion, CodigoSinLoop, CodigoSinPermiso:
		return true
	}
	return false
}

// TamPorDefecto: lo que mide el disco de cada trampa, en MiB. Por encima de lo que
// el sensor deja en su carpeta de registros (512 MB de registro y 64 MB de lo
// demás), para que el vigilante actúe antes de que el disco se llene. Es disperso:
// en la máquina solo ocupa lo que la trampa escribe.
const TamPorDefecto = 1024

// Límites de lo que acepta el auxiliar.
const (
	tamMinimo      = 64
	tamMaximo      = 64 << 10
	maxEscribibles = 16
)

// Carpeta de los discos dentro de la del sensor: <id>.img es el fichero y <id>/,
// su punto de montaje. Nada fuera del auxiliar crea nada dentro de <id>/: sin el
// disco montado, ni sus registros ni sus escribibles existen, y Docker no puede
// arrancar la trampa (sus montajes no tienen origen).
const Carpeta = "discos"

// Dir es el punto de montaje del disco de una trampa.
func Dir(datos, id string) string { return filepath.Join(datos, Carpeta, id) }

// Fichero es el fichero del disco de una trampa.
func Fichero(datos, id string) string { return Dir(datos, id) + ".img" }

// Registros es la carpeta de registros de la trampa dentro de su disco.
func Registros(datos, id string) string { return filepath.Join(Dir(datos, id), "registros") }

// Escribible es la carpeta escribible i de la trampa dentro de su disco.
func Escribible(datos, id string, i int) string {
	return filepath.Join(Dir(datos, id), fmt.Sprintf("escribible-%d", i))
}

// CarpetaImagen es el nombre de la carpeta del disco para un VOLUME que declara la
// imagen de la trampa y que ella no monta: sin ella, Docker le pondría un volumen
// anónimo en el disco de la máquina, sin tope (en Cowrie, /cowrie/cowrie-git/var y
// /cowrie/cowrie-git/etc). Sale de la ruta, así que no cambia mientras la imagen
// declare la misma.
func CarpetaImagen(ruta string) string {
	h := sha256.Sum256([]byte(filepath.Clean(ruta)))
	return "imagen-" + hex.EncodeToString(h[:8])
}

var carpetaImagenValida = regexp.MustCompile(`^imagen-[0-9a-f]{16}$`)

// ViejoEn: dónde ve el auxiliar, de solo lectura, el volumen de Docker que hacía de
// carpeta escribible i antes del disco, para pasar su contenido al disco nuevo
// (las claves SSH de Cowrie, por ejemplo).
func ViejoEn(id string, i int) string { return filepath.Join(raizViejos, id, fmt.Sprint(i)) }

// raizViejos, variable para las pruebas.
var raizViejos = "/viejos"

// Pedido es lo que el sensor le pide al auxiliar.
type Pedido struct {
	// Datos es la carpeta del sensor, en la misma ruta en la máquina y en el auxiliar.
	Datos string `json:"datos"`
	// TamMb, lo que mide cada disco nuevo.
	TamMb int `json:"tamMb"`
	// Probar: comprobar con un disco de prueba que esta máquina puede, sin tocar ninguna trampa.
	Probar bool `json:"probar,omitempty"`
	// Montar: los discos que tienen que quedar montados (se crean si no existen).
	Montar []Montaje `json:"montar,omitempty"`
	// Retirar: los de las trampas que ya no están (se desmontan y se borran).
	Retirar []string `json:"retirar,omitempty"`
}

// Montaje es el disco de una trampa.
type Montaje struct {
	ID          string `json:"id"`
	Escribibles int    `json:"escribibles"`
	// Viejos son los escribibles que tienen volumen de antes del disco (en ViejoEn):
	// si el disco es nuevo, su contenido pasa a él.
	Viejos []int `json:"viejos,omitempty"`
	// Volumenes: el nombre de esos volúmenes, para montarlos en el auxiliar. Solo en el sensor.
	Volumenes map[int]string `json:"-"`
	// Carpetas para los VOLUME de la imagen que la trampa no monta (CarpetaImagen).
	// Vacías: Docker las llena con lo que trae la imagen la primera vez.
	Carpetas []string `json:"carpetas,omitempty"`
}

// Resultado es lo que contesta el auxiliar, en una línea JSON.
type Resultado struct {
	// Codigo de la máquina, si no se pudo nada (disco.sin-loop…): vale para todos.
	Codigo  string `json:"codigo,omitempty"`
	Detalle string `json:"detalle,omitempty"`
	// Discos: cómo ha quedado cada uno de los pedidos (montados y retirados).
	Discos map[string]Estado `json:"discos,omitempty"`
}

// Estado de un disco tras el auxiliar.
type Estado struct {
	// Codigo vacío: montado (o retirado). Si no, por qué no.
	Codigo  string `json:"codigo,omitempty"`
	Detalle string `json:"detalle,omitempty"`
	// Nuevo: el disco se creó en esta vuelta (y se le pasó lo que había antes).
	Nuevo bool `json:"nuevo,omitempty"`
}

// idValido: lo mismo que admite el despliegue. El id acaba en rutas de la máquina.
var idValido = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// IDValido dice si un id de trampa sirve para el nombre de su disco.
func IDValido(id string) bool { return idValido.MatchString(id) && !strings.Contains(id, "..") }

// Validar comprueba un pedido antes de tocar nada: el auxiliar es privilegiado.
func (p Pedido) Validar() error {
	if !filepath.IsAbs(p.Datos) || filepath.Clean(p.Datos) != p.Datos || p.Datos == "/" {
		return fmt.Errorf("invalid sensor folder %q", p.Datos)
	}
	if (len(p.Montar) > 0 || p.Probar) && (p.TamMb < tamMinimo || p.TamMb > tamMaximo) {
		return fmt.Errorf("invalid disk size %d MiB", p.TamMb)
	}
	vistos := map[string]bool{}
	for _, m := range p.Montar {
		if !IDValido(m.ID) || vistos[m.ID] {
			return fmt.Errorf("invalid or repeated decoy identifier %q", m.ID)
		}
		vistos[m.ID] = true
		if m.Escribibles < 0 || m.Escribibles > maxEscribibles {
			return fmt.Errorf("decoy %s: invalid number of writable folders", m.ID)
		}
		for _, i := range m.Viejos {
			if i < 0 || i >= m.Escribibles {
				return fmt.Errorf("decoy %s: invalid previous writable folder %d", m.ID, i)
			}
		}
		if len(m.Carpetas) > maxEscribibles {
			return fmt.Errorf("decoy %s: too many image volumes", m.ID)
		}
		for _, c := range m.Carpetas {
			if !carpetaImagenValida.MatchString(c) {
				return fmt.Errorf("decoy %s: invalid image volume folder %q", m.ID, c)
			}
		}
	}
	for _, id := range p.Retirar {
		if !IDValido(id) || vistos[id] {
			return fmt.Errorf("invalid or repeated decoy identifier %q", id)
		}
		vistos[id] = true
	}
	return nil
}
