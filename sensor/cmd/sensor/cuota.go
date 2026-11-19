package main

import (
	"errors"
	"fmt"
	"github.com/kinomakino/sugardaddy/sensor/internal/registro"
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/seguidor"
)

// Cuando los registros de una trampa pasan de su cuota y el sensor no puede
// liberar lo ya leído de su registro activo (el sistema de ficheros no deja
// perforar, como NFS anterior a 4.2, CIFS o exFAT, o el sensor no tiene
// permiso para escribirlo), la trampa se para con el aviso «cuota superada»
// en vez de llenar el disco del cliente. Vuelve sola cuando su carpeta cabe
// otra vez (ver reanudar).

// Códigos estables (fase.causa) de por qué se ha parado una trampa por su cuota.
const (
	causaSinPerforar = "registros.sin-perforar"
	causaSinPermiso  = "registros.sin-permiso"
	causaNoLiberado  = "registros.no-liberado"
	causaAjenos      = "registros.ajenos"
)

// La carpeta de registros es de la trampa: una trampa tomada puede escribir en
// ella lo que quiera, también en subcarpetas que la cuota de siempre no miraba
// (SEN-4). Con su disco de tamaño fijo (docs/diseno/discos-trampa.md) no pasa
// de él; sin él (una máquina que no puede), esto es lo único que la frena. Lo que no es su registro (ni sus rotados) tiene un tope aparte, en
// bytes y en entradas (ficheros vacíos que agotan los inodos y frenan cada
// lectura de la carpeta). Las trampas de verdad solo dejan ahí ficheros
// pequeños (su semilla, su certificado). Variables para las pruebas.
var (
	cuotaAjenos          int64 = 64 << 20
	maxEntradasRegistros       = 10_000
)

// errAjenos: la carpeta de registros tiene más de lo que cabe que no es el registro.
var errAjenos = errors.New("the logs folder holds files that are not the decoy's log")

// medirRegistros recorre la carpeta de registros entera, sin seguir enlaces:
// lo que ocupa y cuántas entradas tiene. Deja de contar pasado el tope de
// entradas (con eso ya basta para pararla, y no tarda con millones).
func medirRegistros(dir string) (bytes int64, entradas int) {
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		entradas++
		if entradas > maxEntradasRegistros {
			return filepath.SkipAll
		}
		if fi, err := d.Info(); err == nil {
			bytes += ocupado(fi)
		}
		return nil
	})
	return bytes, entradas
}

// perforar libera lo ya leído del registro activo (variable para las pruebas).
var perforar = liberarLeido

// errSinPerforar: en esta plataforma el sensor no sabe perforar ficheros.
var errSinPerforar = registro.ErrSinPerforar

// causaCuota clasifica el fallo al liberar lo leído del registro activo.
func causaCuota(err error) string {
	switch {
	case errors.Is(err, errSinPerforar), errors.Is(err, syscall.EOPNOTSUPP), errors.Is(err, syscall.ENOTSUP),
		errors.Is(err, syscall.ENOSYS):
		return causaSinPerforar
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EROFS):
		return causaSinPermiso
	case errors.Is(err, errAjenos):
		return causaAjenos
	}
	return causaNoLiberado
}

// avisoCuota es lo que ve el cliente en el estado de la trampa parada (la
// consola guarda 200 caracteres de él).
func avisoCuota(causa string) string {
	if causa == causaAjenos {
		return fmt.Sprintf("quota exceeded (%s): its logs folder holds more than %d MB or %d files that are not its log; remove them from the sensor's folder and it resumes",
			causa, cuotaAjenos>>20, maxEntradasRegistros)
	}
	porque := map[string]string{
		causaSinPerforar: "this disk cannot free read data without stopping the decoy",
		causaSinPermiso:  "the sensor lacks permission to free read data",
	}[causa]
	if porque == "" {
		porque = "could not free read data"
	}
	return fmt.Sprintf("quota exceeded (%s): its logs exceed %d MB and %s; it resumes once the sensor has read everything",
		causa, cuotaRegistros>>20, porque)
}

// pararPorCuota para la trampa y apunta por qué, para que el despliegue no
// la vuelva a arrancar (también tras un reinicio del sensor).
func (s *sensor) pararPorCuota(sp plan.TrampaPlan, err error) {
	causa := causaCuota(err)
	if s.estado.Paradas == nil {
		s.estado.Paradas = map[string]string{}
	}
	if _, ya := s.estado.Paradas[sp.ID]; !ya {
		slog.Warn("decoy stopped: its logs exceed its quota and what has been read cannot be freed",
			"trampa", sp.ID, "codigo", causa, "err", err)
	}
	s.estado.Paradas[sp.ID] = avisoCuota(causa)
	s.opc.Paradas = s.estado.Paradas
	s.guardar()
	if s.pararTrampa == nil {
		return
	}
	// Si no se puede ahora, la para el siguiente despliegue o el siguiente intento de reanudar.
	if err := s.pararTrampa(sp.ID); err != nil {
		slog.Warn("could not stop the decoy; retrying", "trampa", sp.ID, "err", err)
	}
}

// reanudar deja volver una trampa parada por su cuota cuando su carpeta cabe
// otra vez. Parada, nadie escribe en su registro activo: cuando el sensor lo
// ha leído entero, lo quita sin perforar. Eso vale en cualquier sistema de
// ficheros y sin permiso de escritura sobre el fichero (la carpeta es del
// sensor), y lo leído ya está en la cola de salida.
func (s *sensor) reanudar(sp plan.TrampaPlan, ahora time.Time) {
	// Antes de tocar su registro, que esté parada de verdad: pararla otra vez
	// no hace nada si ya lo está.
	if s.pararTrampa != nil {
		if err := s.pararTrampa(sp.ID); err != nil {
			slog.Warn("could not confirm that the decoy is stopped; retrying", "trampa", sp.ID, "err", err)
			return
		}
	}
	// Lo que no es su registro no se va solo: las carpetas que haya creado se borran
	// (F16) y, si aun así sigue, sigue parada (SEN-4).
	if s.conAjenos(sp) && (s.quitarCarpetasAjenas(sp) == 0 || s.conAjenos(sp)) {
		return
	}
	total := s.podarTrampa(sp, ahora)
	if total > cuotaRegistros {
		total -= s.quitarLeido(sp)
	}
	if total > cuotaRegistros {
		return
	}
	delete(s.estado.Paradas, sp.ID)
	s.guardar()
	slog.Info("decoy resumed: its logs fit in its quota again", "trampa", sp.ID)
}

// borrarDeRegistros borra una ruta (con lo de dentro) de la carpeta de registros de
// una trampa. Lo que ha creado el honeypot es de su usuario: un sensor sin root no
// puede borrar lo de dentro, y con sd-motor se lo pide a él (F16). Variable para las pruebas.
var borrarDeRegistros = os.RemoveAll

// quitarCarpetasAjenas borra las carpetas que ha creado la trampa en su carpeta de
// registros, que tiene más de lo que cabe (SEN-4): una trampa de verdad solo deja ahí
// su registro y ficheros pequeños. Cada una se apunta en el registro del sensor con
// la trampa. Devuelve cuántas ha borrado.
func (s *sensor) quitarCarpetasAjenas(sp plan.TrampaPlan) int {
	dir := despliegue.Registros(s.opc, sp.ID)
	entradas, _ := os.ReadDir(dir)
	n := 0
	for _, e := range entradas {
		// ReadDir no sigue enlaces: un enlace a una carpeta no es una carpeta.
		if !e.IsDir() {
			continue
		}
		ruta := filepath.Join(dir, e.Name())
		b, entradas := medirRegistros(ruta)
		if err := borrarDeRegistros(ruta); err != nil {
			slog.Warn("could not remove a folder the decoy created in its logs folder", "trampa", sp.ID, "carpeta", e.Name(), "err", err)
			continue
		}
		n++
		slog.Warn("folder created by the decoy in its logs folder removed: the folder exceeded its quota",
			"trampa", sp.ID, "carpeta", e.Name(), "bytes", b, "entradas", entradas)
	}
	return n
}

// conAjenos dice si la carpeta de registros de la trampa tiene, aparte de su
// registro y sus rotados, más de lo que cabe (SEN-4).
func (s *sensor) conAjenos(sp plan.TrampaPlan) bool {
	dir := despliegue.Registros(s.opc, sp.ID)
	b, n := medirRegistros(dir)
	return n > maxEntradasRegistros || b-delRegistro(dir, filepath.Base(sp.Manifiesto.Eventos.Fuente.Ruta)) > cuotaAjenos
}

// quitarLeido borra el registro activo de una trampa parada si el sensor lo
// ha leído entero, y deja su posición vacía: el registro que abra al volver se
// lee desde el principio. Devuelve lo que ocupaba.
func (s *sensor) quitarLeido(sp plan.TrampaPlan) int64 {
	activo := filepath.Join(despliegue.Registros(s.opc, sp.ID), filepath.Base(sp.Manifiesto.Eventos.Fuente.Ruta))
	fi, err := os.Lstat(activo)
	if err != nil || !fi.Mode().IsRegular() || seguidor.InodoDe(fi) != s.estado.Inodos[sp.ID] {
		return 0
	}
	// Lo que quede detrás del último salto de línea no se acabará de escribir
	// nunca (la trampa está parada): no cuenta como pendiente.
	if pendientes, _, err := seguidor.Leer(activo, s.estado.Leido[sp.ID]); err != nil || len(pendientes) > 0 {
		return 0
	}
	if err := os.Remove(activo); err != nil {
		slog.Warn("could not remove the already-read log of the stopped decoy", "trampa", sp.ID, "err", err)
		return 0
	}
	delete(s.estado.Leido, sp.ID)
	delete(s.estado.Inodos, sp.ID)
	delete(s.estado.Huellas, sp.ID)
	delete(s.estado.Modifs, sp.ID)
	s.guardar()
	slog.Info("log of the stopped decoy removed: it had been read completely", "trampa", sp.ID, "bytes", ocupado(fi))
	return ocupado(fi)
}
