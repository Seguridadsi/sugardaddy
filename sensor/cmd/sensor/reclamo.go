package main

import (
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/adaptador"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
)

// Tope de eventos de IP reclamada esperando a la siguiente lectura: un vecino
// que reclama IP sin parar no hace crecer la memoria del sensor.
const maxReclamadas = 64

// apuntarReclamo deja el evento de una IP propia reclamada para la siguiente
// lectura, que lo encadena en la cola como cualquier otro: la goroutina del
// vigilante no puede tocar la cadena. Sin esto, un ARP falso desde la LAN
// apagaba la trampa sin dejar rastro en la consola (auditoría del 2026-11-14).
func (s *sensor) apuntarReclamo(trampa, ip, mac string, cuando time.Time) {
	s.muPlan.Lock()
	p := s.plan
	s.muPlan.Unlock()
	if p == nil {
		return
	}
	for _, sp := range p.Trampas {
		if sp.ID != trampa {
			continue
		}
		e := adaptador.IPReclamada(p.Sensor, sp, ip, mac, cuando)
		s.muReclamadas.Lock()
		if len(s.reclamadas) < maxReclamadas {
			s.reclamadas = append(s.reclamadas, e)
		}
		s.muReclamadas.Unlock()
		return
	}
}

// tomarReclamos devuelve los eventos de IP reclamada pendientes y los quita.
func (s *sensor) tomarReclamos() []evento.Evento {
	s.muReclamadas.Lock()
	defer s.muReclamadas.Unlock()
	r := s.reclamadas
	s.reclamadas = nil
	return r
}
