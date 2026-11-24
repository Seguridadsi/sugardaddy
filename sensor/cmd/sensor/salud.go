package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/consola"
	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	medirsalud "github.com/kinomakino/sugardaddy/sensor/internal/salud"
)

const (
	// Una muestra por minuto: lo bastante para ver una trampa caída a tiempo y
	// poco para la consola (1440 filas al día por sensor).
	cadaSalud = time.Minute
	// Una consola que no sabe recibirla se vuelve a probar cada hora (se
	// puede actualizar sin que el sensor se reinicie).
	cadaSaludSinConsola = time.Hour
)

// saludSensor: lo que el sensor guarda entre dos muestras de salud.
type saludSensor struct {
	medidor medirsalud.Medidor
	proxima time.Time
}

// informarSalud mide la máquina y las trampas y lo manda a la consola. Nunca
// para al sensor: lo que falla se intenta en la siguiente vuelta.
func (s *sensor) informarSalud(ctx context.Context, ahora time.Time) {
	s.muestras.proxima = ahora.Add(cadaSalud)
	s.muPlan.Lock()
	id := ""
	if s.plan != nil {
		id = s.plan.Sensor
	}
	s.muPlan.Unlock()
	if id == "" {
		// Sin plan no sabe qué trampas son suyas: espera al primero.
		return
	}
	s.muestras.medidor.Datos = s.opc.Datos
	m := medirsalud.Muestra{Trampas: []medirsalud.Trampa{}}
	s.muestras.medidor.Maquina(&m, ahora)
	c, cancelar := context.WithTimeout(ctx, 20*time.Second)
	defer cancelar()
	if t, err := despliegue.SaludTrampas(c, s.docker, id); err == nil {
		m.Trampas = t
	} else {
		slog.Debug("could not read the state of the decoys for health", "err", err)
	}
	err := s.consola.InformarSalud(c, m)
	switch {
	case err == nil:
	case errors.Is(err, consola.ErrSinSalud):
		s.muestras.proxima = ahora.Add(cadaSaludSinConsola)
	default:
		slog.Debug("could not report health", "err", err)
	}
}
