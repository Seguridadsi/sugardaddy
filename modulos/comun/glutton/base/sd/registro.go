package sd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Registro escribe eventos JSON, una línea por evento, en <dir>/<modulo>.json.
// Protege el disco con topes por día (total y por IP de origen) y deja pasar
// siempre los primeros de cada tipo de eventid, para que una sola IP ruidosa no
// pueda cegar la trampa para las demás. Además, los eventos marcados como
// prioritarios (p. ej. exploit o inicio de sesión) tienen una bolsa aparte, con
// cupo garantizado POR IP, para que una IP nueva no quede muda aunque otras
// hayan llenado el día. Lo que no cabe se cuenta y se resume cada cierto tiempo
// en una línea <modulo>.log.omitidos, también por temporizador (sin esperar al
// siguiente evento). Rota a diario por renombrado. Es seguro para uso concurrente.
type Registro struct {
	ruta       string
	modulo     string
	maxBytes   int64
	libresTipo int
	resumenSeg int
	maxIPs     int

	// Bolsa prioritaria: eventids que nunca deben silenciarse del todo.
	prioritarios map[string]bool
	libresPrio   int   // eventos garantizados por (IP, eventid prioritario) y día
	maxPrioBytes int64 // tope diario de la bolsa prioritaria (aparte del día)

	mu       sync.Mutex
	f        *os.File
	dia      string
	bytesHoy int64
	prioHoy  int64            // bytes de hoy escritos solo gracias a la bolsa prioritaria
	porIP    map[string]int64 // bytes de hoy por IP de origen
	vistos   map[string]int   // nº de eventos de hoy por eventid (para el pase libre)
	vistosP  map[string]int   // nº por (IP, eventid prioritario) y día

	// Lo que se ha callado desde el último resumen.
	omit       int64
	omitTipo   map[string]int64
	omitIP     map[string]int64
	ultResumen time.Time
	reloj      func() time.Time // para pruebas

	// Temporizador del resumen (solo en producción; lo arranca main con
	// IniciarResumenPeriodico). cerrado protege de un doble cierre.
	parar   chan struct{}
	cerrado bool
}

// NuevoRegistro abre (o crea) el registro del módulo en dir.
func NuevoRegistro(c Config) (*Registro, error) {
	if err := os.MkdirAll(c.LogDir, 0o755); err != nil {
		return nil, err
	}
	prio := map[string]bool{}
	for _, p := range c.Prioritarios {
		if p != "" {
			prio[p] = true
		}
	}
	r := &Registro{
		ruta:         filepath.Join(c.LogDir, c.Modulo+".json"),
		modulo:       c.Modulo,
		maxBytes:     c.MaxLogBytes,
		libresTipo:   c.LibresPorTipo,
		resumenSeg:   c.ResumenSeg,
		maxIPs:       c.MaxIPs,
		prioritarios: prio,
		libresPrio:   c.LibresPrioritarios,
		maxPrioBytes: c.MaxLogBytes, // una bolsa igual al día: el disco va, como mucho, al doble
		porIP:        map[string]int64{},
		vistos:       map[string]int{},
		vistosP:      map[string]int{},
		omitTipo:     map[string]int64{},
		omitIP:       map[string]int64{},
		reloj:        time.Now,
		parar:        make(chan struct{}),
	}
	r.ultResumen = r.reloj()
	if err := r.abrir(); err != nil {
		return nil, err
	}
	return r, nil
}

// IniciarResumenPeriodico arranca un temporizador que emite el resumen de
// omitidos cada ResumenSeg aunque no llegue otro evento. Lo llama main tras
// crear el registro (las pruebas con reloj falso no lo arrancan). Se para en
// Cierra.
func (r *Registro) IniciarResumenPeriodico() {
	if r.resumenSeg <= 0 {
		return
	}
	go func() {
		t := time.NewTicker(time.Duration(r.resumenSeg) * time.Second)
		defer t.Stop()
		for {
			select {
			case <-r.parar:
				return
			case <-t.C:
				r.mu.Lock()
				if r.omit > 0 {
					r.resumenLocked()
				}
				r.mu.Unlock()
			}
		}
	}()
}

func (r *Registro) abrir() error {
	f, err := os.OpenFile(r.ruta, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	r.f = f
	r.dia = r.reloj().UTC().Format("2006-01-02")
	return nil
}

// rotarSiToca renombra el registro a <ruta>.AAAA-MM-DD cuando cambia el día y
// reinicia los contadores diarios. Debe llamarse con el candado cogido.
func (r *Registro) rotarSiToca() {
	hoy := r.reloj().UTC().Format("2006-01-02")
	if hoy == r.dia {
		return
	}
	if r.f != nil {
		_ = r.f.Close()
		_ = os.Rename(r.ruta, r.ruta+"."+r.dia)
	}
	r.bytesHoy = 0
	r.prioHoy = 0
	r.porIP = map[string]int64{}
	r.vistos = map[string]int{}
	r.vistosP = map[string]int{}
	_ = r.abrir()
}

// escribir serializa y vuelca una línea; devuelve los bytes escritos.
func (r *Registro) escribir(e *Evento) int64 {
	b, err := json.Marshal(e)
	if err != nil {
		return 0
	}
	b = append(b, '\n')
	if r.f == nil {
		return 0
	}
	n, _ := r.f.Write(b)
	return int64(n)
}

// Apunta escribe un evento si cabe en los topes; si no, lo cuenta para el
// resumen. Rellena cuando/eventid si faltan. Siempre deja pasar los primeros
// LibresPorTipo de cada eventid del día y, para los eventids prioritarios, los
// primeros LibresPrioritarios de cada IP (bolsa aparte).
func (r *Registro) Apunta(e Evento) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.rotarSiToca()
	if e.Cuando == "" {
		e.Cuando = r.reloj().UTC().Format(time.RFC3339Nano)
	}

	// Tamaño aproximado del evento para contabilizar antes de decidir.
	b, _ := json.Marshal(&e)
	tam := int64(len(b) + 1)

	tipo := e.EventID
	paseLibre := r.vistos[tipo] < r.libresTipo
	maxIP := r.maxBytes / 8
	cabe := r.bytesHoy+tam <= r.maxBytes && (e.SrcIP == "" || r.porIP[e.SrcIP]+tam <= maxIP)

	// Bolsa prioritaria: cupo garantizado por (IP, eventid) con su propio tope
	// de disco, para que un gusano desde una IP nueva no quede mudo aunque otras
	// IP hayan llenado el día.
	pasePrio := false
	var claveP string
	if r.libresPrio > 0 && r.prioritarios[tipo] {
		claveP = e.SrcIP + "\x00" + tipo
		_, ya := r.vistosP[claveP]
		if (ya || len(r.vistosP) < r.maxIPs*2) && r.vistosP[claveP] < r.libresPrio && r.prioHoy+tam <= r.maxPrioBytes {
			pasePrio = true
		}
	}

	if paseLibre || cabe || pasePrio {
		escrito := r.escribir(&e)
		r.bytesHoy += escrito
		r.vistos[tipo]++
		if e.SrcIP != "" {
			if _, ya := r.porIP[e.SrcIP]; ya || len(r.porIP) < r.maxIPs {
				r.porIP[e.SrcIP] += escrito
			}
		}
		if pasePrio {
			r.vistosP[claveP]++
			if !paseLibre && !cabe {
				r.prioHoy += escrito
			}
		}
	} else {
		r.omit++
		r.omitTipo[tipo]++
		if e.SrcIP != "" {
			if _, ya := r.omitIP[e.SrcIP]; ya || len(r.omitIP) < r.maxIPs {
				r.omitIP[e.SrcIP]++
			}
		}
	}

	if r.omit > 0 && r.reloj().Sub(r.ultResumen) >= time.Duration(r.resumenSeg)*time.Second {
		r.resumenLocked()
	}
}

// resumenLocked emite la línea <modulo>.log.omitidos y reinicia el conteo. Debe
// llamarse con el candado cogido.
func (r *Registro) resumenLocked() {
	periodo := int(r.reloj().Sub(r.ultResumen) / time.Second)
	type par struct {
		ip string
		n  int64
	}
	var ips []par
	for k, v := range r.omitIP {
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
	porTipo := map[string]int64{}
	for k, v := range r.omitTipo {
		porTipo[k] = v
	}
	e := Evento{
		Cuando:       r.reloj().UTC().Format(time.RFC3339Nano),
		EventID:      r.modulo + ".log.omitidos",
		Omitidos:     r.omit,
		PorTipo:      porTipo,
		IPsRuidosas:  ruidosas,
		IPsDistintas: len(r.omitIP),
		PeriodoS:     periodo,
		TopeBytes:    r.maxBytes,
		Motivo:       "tope del registro (día o IP)",
	}
	// El resumen siempre se escribe, aunque el día esté lleno: su bolsa es su
	// propio pase libre por tipo.
	r.escribir(&e)
	r.omit = 0
	r.omitTipo = map[string]int64{}
	r.omitIP = map[string]int64{}
	r.ultResumen = r.reloj()
}

// Cierra vacía el resumen pendiente, para el temporizador y cierra el fichero.
func (r *Registro) Cierra() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.cerrado {
		close(r.parar)
		r.cerrado = true
	}
	if r.omit > 0 {
		r.resumenLocked()
	}
	if r.f != nil {
		return r.f.Close()
	}
	return nil
}
