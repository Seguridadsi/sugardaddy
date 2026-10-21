package main

import (
	"errors"
	"fmt"
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
)

// perforar libera lo ya leído del registro activo (variable para las pruebas).
var perforar = liberarLeido

// errSinPerforar: en esta plataforma el sensor no sabe perforar ficheros.
var errSinPerforar = errors.New("perforar ficheros solo se hace en Linux")

// causaCuota clasifica el fallo al liberar lo leído del registro activo.
func causaCuota(err error) string {
	switch {
	case errors.Is(err, errSinPerforar), errors.Is(err, syscall.EOPNOTSUPP), errors.Is(err, syscall.ENOTSUP),
		errors.Is(err, syscall.ENOSYS):
		return causaSinPerforar
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EROFS):
		return causaSinPermiso
	}
	return causaNoLiberado
}

// avisoCuota es lo que ve el cliente en el estado de la trampa parada (la
// consola guarda 200 caracteres de él).
func avisoCuota(causa string) string {
	porque := map[string]string{
		causaSinPerforar: "este disco no deja liberar lo ya leído sin pararla",
		causaSinPermiso:  "el sensor no tiene permiso para liberar lo ya leído",
	}[causa]
	if porque == "" {
		porque = "no se pudo liberar lo ya leído"
	}
	return fmt.Sprintf("cuota superada (%s): sus registros pasan de %d MB y %s; vuelve sola cuando el sensor lo haya leído todo",
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
		slog.Warn("trampa parada: sus registros pasan de su cuota y no se puede liberar lo ya leído",
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
		slog.Warn("no se pudo parar la trampa; se reintenta", "trampa", sp.ID, "err", err)
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
			slog.Warn("no se pudo confirmar que la trampa está parada; se reintenta", "trampa", sp.ID, "err", err)
			return
		}
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
	slog.Info("la trampa vuelve: sus registros caben otra vez en su cuota", "trampa", sp.ID)
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
		slog.Warn("no se pudo quitar el registro ya leído de la trampa parada", "trampa", sp.ID, "err", err)
		return 0
	}
	delete(s.estado.Leido, sp.ID)
	delete(s.estado.Inodos, sp.ID)
	delete(s.estado.Huellas, sp.ID)
	delete(s.estado.Modifs, sp.ID)
	s.guardar()
	slog.Info("registro de la trampa parada quitado: ya estaba leído entero", "trampa", sp.ID, "bytes", ocupado(fi))
	return ocupado(fi)
}
