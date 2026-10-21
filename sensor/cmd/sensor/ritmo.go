package main

import (
	"sort"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/adaptador"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Topes de eventos por trampa y minuto (de la hora del propio evento: ponerse
// al día tras estar parado no cuenta). Una trampa atacada sin parar no inunda
// la consola, y el ruido no tapa lo importante:
//   - cada IP de origen tiene su cupo, de leves y de graves, así que un
//     barrido o una sola IP no se comen el de las demás;
//   - lo de severidad alta o crítica tiene un cupo propio que no gasta el ruido;
//   - los dos primeros de cada tipo de evento del honeypot (su valor nativo:
//     cowrie.login.success, cowrie.session.file_download…) de cada IP pasan
//     aunque los cupos estén gastados, de una reserva propia: el acceso, el
//     primer comando o la descarga de un atacante llegan aunque haya ruido;
//   - y nunca se pasa de un techo por trampa.
//
// Lo que no pasa se resume en un evento «omitidos» con su desglose, y sigue
// en el registro del honeypot.
const (
	porMinuto      = 600  // baja y media, por trampa
	porIPMinuto    = 100  // baja y media, por IP de origen
	gravesMinuto   = 600  // alta y crítica, por trampa
	gravesIPMinuto = 150  // alta y crítica, por IP de origen
	primerosTipo   = 2    // de cada IP y tipo nativo pasan siempre los primeros...
	reservaNuevas  = 400  // ...hasta esta reserva por trampa y minuto
	tiposContados  = 4096 // pares IP y tipo que se cuentan por minuto
	techoMinuto    = 1200 // todo junto, sin contar la reserva, por trampa
	ipsContadas    = 1024 // IP distintas que se cuentan por minuto
	muestraOmitida = 5    // eventos graves omitidos que van de muestra en el resumen
)

var rangoSeveridad = map[string]int{"baja": 0, "media": 1, "alta": 2, "critica": 3}

type ventana struct {
	Trampa   string            `json:"trampa"`
	Modulo   string            `json:"modulo"`
	Tipo     string            `json:"tipo"`
	Minuto   time.Time         `json:"minuto"`
	N        int               `json:"n"`
	Leves    int               `json:"leves"`
	Graves   int               `json:"graves"`
	Nuevas   int               `json:"nuevas"`
	Omitidos adaptador.Resumen `json:"omitidos"`
	porIP    map[string]*porOrigen
	porTipo  map[string]int
	trampa   plan.TrampaPlan
}

type porOrigen struct{ leves, graves int }

type ritmo map[string]*ventana

// copia para trabajar sobre ella: solo se queda si la cola de salida se
// escribe (si no, esas líneas se vuelven a leer y no hay que contarlas dos veces).
func (r ritmo) copia() ritmo {
	c := ritmo{}
	for k, v := range r {
		x := *v
		x.porTipo = make(map[string]int, len(v.porTipo))
		for k, n := range v.porTipo {
			x.porTipo[k] = n
		}
		x.porIP = make(map[string]*porOrigen, len(v.porIP))
		for ip, n := range v.porIP {
			c := *n
			x.porIP[ip] = &c
		}
		x.Omitidos = v.Omitidos.Copia()
		c[k] = &x
	}
	return c
}

// pasa dice si el evento se manda. Si cambia de minuto y en el anterior se
// omitió algo, devuelve también su resumen, que va antes.
func (r ritmo) pasa(sensor string, t plan.TrampaPlan, e evento.Evento) (bool, *evento.Evento) {
	cuando, err := time.Parse(time.RFC3339Nano, e.Cuando)
	if err != nil {
		return true, nil
	}
	m := cuando.UTC().Truncate(time.Minute)
	v := r[t.ID]
	var resumen *evento.Evento
	if v == nil || !v.Minuto.Equal(m) {
		if v != nil && v.Omitidos.N > 0 {
			o := adaptador.Omitidos(sensor, t, v.Minuto, v.Omitidos)
			resumen = &o
		}
		v = &ventana{Trampa: t.ID, Minuto: m}
		r[t.ID] = v
	}
	if v.porIP == nil {
		v.porIP, v.porTipo = map[string]*porOrigen{}, map[string]int{}
	}
	v.trampa, v.Modulo, v.Tipo = t, t.Manifiesto.ID, t.Manifiesto.Tipo
	grave := rangoSeveridad[e.Severidad] >= 2
	ip := e.Origen.IP
	o := v.porIP[ip]
	if o == nil {
		o = &porOrigen{}
		if len(v.porIP) < ipsContadas {
			v.porIP[ip] = o
		}
	}
	// Los primeros de cada IP y tipo salen de su propia reserva y no gastan
	// los cupos de la trampa; el resto, de los cupos.
	clave := ip + "|" + e.Nativa
	n, contado := v.porTipo[clave]
	deReserva := n < primerosTipo && v.Nuevas < reservaNuevas && (contado || len(v.porTipo) < tiposContados)
	ok := deReserva
	if !deReserva && v.N < techoMinuto {
		if grave {
			ok = v.Graves < gravesMinuto && o.graves < gravesIPMinuto
		} else {
			ok = v.Leves < porMinuto && o.leves < porIPMinuto
		}
	}
	if !ok {
		v.Omitidos.Apuntar(e, muestraOmitida)
		return false, resumen
	}
	if grave {
		o.graves++
	} else {
		o.leves++
	}
	if deReserva {
		v.porTipo[clave]++
		v.Nuevas++
		return true, resumen
	}
	v.N++
	if grave {
		v.Graves++
	} else {
		v.Leves++
	}
	return true, resumen
}

// vencidos devuelve los resúmenes de los minutos ya cerrados. Un minuto se
// cierra cuando su trampa ya no está leyendo (en esta vuelta no ha dado
// líneas: si se está poniendo al día, lo cerrará su siguiente evento) y han
// pasado dos minutos desde él.
func (r ritmo) vencidos(sensor string, ahora time.Time, leyendo map[string]bool) []evento.Evento {
	ids := make([]string, 0, len(r))
	for id := range r {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var res []evento.Evento
	for _, id := range ids {
		v := r[id]
		if v.Omitidos.N > 0 && !leyendo[id] && ahora.Sub(v.Minuto) > 2*time.Minute {
			t := v.trampa
			if t.ID == "" {
				// Recuperada del estado: la trampa puede no estar ya en el plan.
				t.ID, t.Manifiesto.ID, t.Manifiesto.Tipo = v.Trampa, v.Modulo, v.Tipo
			}
			res = append(res, adaptador.Omitidos(sensor, t, v.Minuto, v.Omitidos))
			delete(r, id)
		}
	}
	return res
}

// pendientes son las ventanas con omitidos aún sin resumir: se guardan en el
// estado para que un reinicio no las pierda.
func (r ritmo) pendientes() []ventana {
	var p []ventana
	for _, v := range r {
		if v.Omitidos.N > 0 {
			p = append(p, *v)
		}
	}
	sort.Slice(p, func(i, j int) bool { return p[i].Trampa < p[j].Trampa })
	return p
}

// ritmoDe recupera las ventanas guardadas en el estado.
func ritmoDe(guardadas []ventana) ritmo {
	r := ritmo{}
	for _, v := range guardadas {
		x := v
		r[v.Trampa] = &x
	}
	return r
}
