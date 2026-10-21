package main

import (
	"sync"
	"time"
)

// Memoria efímera de lo que el atacante cambia en la web de configuración. La
// trampa no aplica nada de verdad, pero una impresora real sí muestra el último
// valor guardado al recargar la página. Si no lo hiciera, el atacante que
// recarga /config para confirmar su passback vería el valor por defecto y
// sospecharía. Se guarda por IP de origen, con pocas claves por IP, pocas IP en
// total y caducidad: no crece en memoria aunque la ataquen miles de clientes a
// la vez (regla de escala), y como mucho retiene cadenas ya acotadas por el
// parseo del formulario.
const (
	maxRecuerdos = 4096
	ttlRecuerdos = 30 * time.Minute
	maxCamposRec = 12
)

type recuerdo struct {
	vals   map[string]string
	cuando time.Time
}

type recuerdos struct {
	mu    sync.Mutex
	m     map[string]*recuerdo
	reloj func() time.Time
}

func nuevosRecuerdos(reloj func() time.Time) *recuerdos {
	if reloj == nil {
		reloj = time.Now
	}
	return &recuerdos{m: map[string]*recuerdo{}, reloj: reloj}
}

// guardar apunta, por IP de origen, los valores que el atacante acaba de enviar.
func (r *recuerdos) guardar(ip string, nuevos map[string]string) {
	if len(nuevos) == 0 {
		return
	}
	k := claveIP(ip)
	ahora := r.reloj()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.podar(ahora)
	e := r.m[k]
	if e == nil {
		if len(r.m) >= maxRecuerdos {
			r.expulsarViejo()
			if len(r.m) >= maxRecuerdos {
				return
			}
		}
		e = &recuerdo{vals: map[string]string{}}
		r.m[k] = e
	}
	for nk, nv := range nuevos {
		if _, ya := e.vals[nk]; !ya && len(e.vals) >= maxCamposRec {
			continue
		}
		e.vals[nk] = nv
	}
	e.cuando = ahora
}

// leer devuelve lo recordado de esa IP (copia), o nil si no hay o ha caducado.
func (r *recuerdos) leer(ip string) map[string]string {
	k := claveIP(ip)
	ahora := r.reloj()
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.m[k]
	if e == nil || ahora.Sub(e.cuando) > ttlRecuerdos {
		return nil
	}
	out := make(map[string]string, len(e.vals))
	for nk, nv := range e.vals {
		out[nk] = nv
	}
	return out
}

func (r *recuerdos) podar(ahora time.Time) {
	for k, e := range r.m {
		if ahora.Sub(e.cuando) > ttlRecuerdos {
			delete(r.m, k)
		}
	}
}

func (r *recuerdos) expulsarViejo() {
	var vk string
	var vt time.Time
	primero := true
	for k, e := range r.m {
		if primero || e.cuando.Before(vt) {
			vk, vt, primero = k, e.cuando, false
		}
	}
	if !primero {
		delete(r.m, vk)
	}
}
