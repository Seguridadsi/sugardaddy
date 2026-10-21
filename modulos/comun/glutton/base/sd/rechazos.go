package sd

import (
	"sort"
	"sync"
	"time"
)

// Rechazos resume las conexiones que se cierran sin atender por haber alcanzado
// un tope (el global de conexiones o el de conexiones por IP). Sin esto, un
// atacante que ocupe todos los huecos con unas pocas IP deja la trampa muda
// para las demás y en el registro no queda ni rastro. Se emite un resumen
// periódico <modulo>.session.rechazos (alta), como hace redis, con cuántos se
// cortaron por cada tope y qué IP eran las más ruidosas. Seguro para uso
// concurrente.
type Rechazos struct {
	reg    *Registro
	modulo string
	maxIPs int
	reloj  func() time.Time

	mu       sync.Mutex
	global   int64
	porIP    int64
	ips      map[string]int64
	ultVolca time.Time
}

// NuevosRechazos crea el resumidor de rechazos para el módulo dado.
func NuevosRechazos(reg *Registro, modulo string, maxIPs int) *Rechazos {
	if maxIPs <= 0 {
		maxIPs = 4096
	}
	x := &Rechazos{reg: reg, modulo: modulo, maxIPs: maxIPs, ips: map[string]int64{}, reloj: time.Now}
	x.ultVolca = x.reloj()
	return x
}

// Global cuenta un rechazo por el tope global de conexiones.
func (x *Rechazos) Global(ip string) { x.cuenta(ip, true) }

// PorIP cuenta un rechazo por el tope de conexiones de esa IP.
func (x *Rechazos) PorIP(ip string) { x.cuenta(ip, false) }

func (x *Rechazos) cuenta(ip string, global bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if global {
		x.global++
	} else {
		x.porIP++
	}
	if ip != "" {
		if _, ya := x.ips[ip]; ya || len(x.ips) < x.maxIPs {
			x.ips[ip]++
		}
	}
}

// Volcar emite el resumen si hay algo que contar y reinicia los contadores.
func (x *Rechazos) Volcar() {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.global == 0 && x.porIP == 0 {
		x.ultVolca = x.reloj()
		return
	}
	type par struct {
		ip string
		n  int64
	}
	var ips []par
	for k, v := range x.ips {
		ips = append(ips, par{k, v})
	}
	sort.Slice(ips, func(i, j int) bool {
		if ips[i].n != ips[j].n {
			return ips[i].n > ips[j].n
		}
		return ips[i].ip < ips[j].ip
	})
	var ruidosas []string
	for i := 0; i < len(ips) && i < 5; i++ {
		ruidosas = append(ruidosas, ips[i].ip)
	}
	e := Evento{
		EventID:      x.modulo + ".session.rechazos",
		PorTipo:      map[string]int64{"por_tope_global": x.global, "por_tope_ip": x.porIP},
		IPsRuidosas:  ruidosas,
		IPsDistintas: len(x.ips),
		PeriodoS:     int(x.reloj().Sub(x.ultVolca) / time.Second),
		Motivo:       "tope de conexiones (global o por IP)",
	}
	if x.reg != nil {
		x.reg.Apunta(e)
	}
	x.global = 0
	x.porIP = 0
	x.ips = map[string]int64{}
	x.ultVolca = x.reloj()
}
