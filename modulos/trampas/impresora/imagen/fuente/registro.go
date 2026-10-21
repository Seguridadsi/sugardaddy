package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"
)

// evento: una línea del registro. Campos planos y con clave sin punto para que
// el adaptador del sensor los lea por ruta simple y los entienda también un
// sensor 0.12. "cuando" en RFC3339Nano UTC, como Cowrie y redis.
type evento struct {
	Cuando    string `json:"cuando"`
	EventID   string `json:"eventid"`
	Session   string `json:"session,omitempty"`
	SrcIP     string `json:"src_ip,omitempty"`
	SrcPort   int    `json:"src_port,omitempty"`
	Servicio  string `json:"servicio,omitempty"`  // raw, ipp o web
	Comando   string `json:"comando,omitempty"`   // orden PJL (recortada)
	Args      string `json:"args,omitempty"`      // argumentos de la orden PJL (recortados)
	Ruta      string `json:"ruta,omitempty"`      // ruta de fichero (PJL FS, HTTP) recortada
	Operacion string `json:"operacion,omitempty"` // operación IPP
	Recurso   string `json:"recurso,omitempty"`   // recurso HTTP/IPP (printer-uri)
	Metodo    string `json:"metodo,omitempty"`    // método HTTP
	Agente    string `json:"agente,omitempty"`    // User-Agent recortado
	Usuario   string `json:"usuario,omitempty"`
	Password  string `json:"password,omitempty"`
	Texto     string `json:"texto,omitempty"`    // texto que pone el atacante (RDYMSG, etc.)
	Campo     string `json:"campo,omitempty"`    // campo de la web que cambia
	Valor     string `json:"valor,omitempty"`    // valor nuevo
	Servidor  string `json:"servidor,omitempty"` // servidor que mete el atacante (passback LDAP/SMTP)
	Huella    string `json:"huella,omitempty"`   // sha256 del trabajo (nunca su contenido)
	Tam       int64  `json:"tam,omitempty"`      // bytes del trabajo/documento
	Grave     string `json:"grave,omitempty"`    // motivo si es ataque grave
	Duracion  string `json:"duration,omitempty"` // en el cierre, segundos

	// Resúmenes de lo que se calla y avisos del propio registro.
	Motivo         string `json:"motivo,omitempty"`
	Omitidos       int64  `json:"omitidos,omitempty"`
	OmitidosGraves int64  `json:"omitidos_graves,omitempty"`
	OmitidosAuth   int64  `json:"omitidos_auth,omitempty"`
	Rechazadas     int64  `json:"rechazadas,omitempty"`
	DeSuIP         int64  `json:"de_su_ip,omitempty"`
	PorTopeIP      int64  `json:"por_tope_ip,omitempty"`
	PorTopeGlobal  int64  `json:"por_tope_global,omitempty"`
	IPsDistintas   int    `json:"ips_distintas,omitempty"`
	IPsSinContar   int64  `json:"ips_sin_contar,omitempty"`
	Activas        int    `json:"activas,omitempty"`
	PeriodoS       int    `json:"periodo_s,omitempty"`
	Perdidos       int64  `json:"perdidos,omitempty"`
	Error          string `json:"error,omitempty"`
	Aviso          string `json:"aviso,omitempty"`
	TopeBytes      int64  `json:"tope_bytes,omitempty"`
}

// Bolsas en las que se reparte el tope diario del registro. Lo grave (robo de
// ficheros por PRET, passback de credenciales) y las contraseñas de la web
// tienen cada uno la suya: una avalancha de peticiones IPP o de @PJL INFO no
// oculta el FSUPLOAD con recorrido de rutas ni el cambio de servidor LDAP de
// otro atacante. Lo grave que no cabe en su bolsa de la hora se apunta en
// versión compacta, con unas pocas líneas por IP y día, para que nunca se
// pierda del todo. Los avisos (resúmenes de lo que se calla) tienen otra.
type bolsa int

const (
	bolsaGeneral bolsa = iota
	bolsaGrave
	bolsaAuth
	bolsaCompacta
	bolsaAvisos
	numBolsas
)

// reparto del tope diario, en milésimas. Suman 900: la décima parte que queda
// es la reserva de los primeros de cada tipo (partePrimeros), que pueden pasar
// de su bolsa.
var reparto = [numBolsas]int64{540, 135, 90, 45, 90}

// partesIP: en las bolsas que se liberan por horas, una IP no gasta más de
// 1/partes de lo que lleva permitido. Hacen falta muchas IP para callar la
// trampa una hora, y ninguna la calla un día entero.
var partesIP = [numBolsas]int64{bolsaGeneral: 16, bolsaGrave: 16, bolsaAuth: 64}

const (
	// primerosPorTipo: los primeros eventos de cada tipo (eventid) de cada IP
	// en el día entran aunque su bolsa o la parte de su IP estén llenas
	// (siempre dentro del tope diario): quien llega tarde a una trampa muy
	// atacada deja al menos su primer @PJL INFO, su primer FSUPLOAD con
	// recorrido de rutas y su primer passback. maxPrimeros acota la memoria de
	// esa cuenta; pasado, ya no hay excepción hasta el día siguiente.
	primerosPorTipo = 2
	maxPrimeros     = 16384
	// partePrimeros: milésimas del tope diario que pueden gastar, entre todos,
	// los primeros que pasan de su bolsa: ni con miles de IP llenan el registro
	// por esta vía.
	partePrimeros = 100
)

const (
	maxCompactasIP      = 4
	maxArgsCompacta     = 128
	margenTopeMax       = 16 << 10
	maxIPsDia           = 8192
	maxIPsResumen       = 1024
	maxLineasResumen    = 8
	maxLineasGraves     = 32
	maxInmediatos       = 16
	maxInmediatosGraves = 32
	reintentoApertura   = time.Minute
	avisoCompacta       = "versión compacta: el cupo de lo grave de esta hora está lleno"
)

const (
	motivoCupoIP   = "cupo de su IP"
	motivoCupoHora = "cupo de la hora"
)

// bolsaDe dice de qué bolsa gasta cada tipo de evento. Lo grave son los
// eventos que la consola no se puede permitir perder: robo/escritura de
// ficheros, control del panel y passback de credenciales.
func bolsaDe(id string) bolsa {
	switch id {
	case "impresora.pjl.traversal", "impresora.pjl.escritura", "impresora.pjl.control",
		"impresora.ps.peligroso", "impresora.web.passback", "impresora.web.config":
		return bolsaGrave
	case "impresora.web.login":
		return bolsaAuth
	case "impresora.log.omitidos", "impresora.log.tope", "impresora.log.error",
		"impresora.session.rechazos", "impresora.session.tope":
		return bolsaAvisos
	}
	return bolsaGeneral
}

type omision struct {
	ip                   string
	total, graves, auths int64
	motivo               string
	avisada              bool
	avisadaGrave         bool
}

// registrador escribe el registro y se encarga de que no crezca sin tope en el
// disco del cliente ni de que un atacante lo deje mudo para los demás. Es el
// mismo mecanismo que la trampa redis: rota por renombrado al cambiar el día
// (impresora.json.AAAA_MM_DD), reparte el tope diario en bolsas liberadas por
// horas, con cupo por IP, deja pasar siempre los primeros de cada tipo y
// resume por IP lo que se calla.
type registrador struct {
	mu        sync.Mutex
	ruta      string
	f         *os.File
	dia       string
	bytesDia  int64
	topeDia   int64
	margen    int64
	avisado   bool
	sinAvisos bool
	reloj     func() time.Time
	buf       bytes.Buffer
	enc       *json.Encoder

	gastado [numBolsas]int64
	ips     map[string]*[numBolsas]int64
	partes  [numBolsas]int64

	primeros      map[string]int // por IP y tipo: eventos apuntados hoy
	gastoPrimeros int64          // bytes de los primeros que pasaron de su bolsa

	periodo          time.Duration
	inicioPeriodo    time.Time
	omis             map[string]*omision
	sinContar        omision
	ipsSinContar     int64
	inmediatos       int
	inmediatosGraves int

	fallo         string
	desdeFallo    time.Time
	perdidos      int64
	cortada       bool
	ultimoIntento time.Time
}

func nuevoRegistrador(ruta string, topeDia int64, periodo time.Duration, reloj func() time.Time) (*registrador, error) {
	if reloj == nil {
		reloj = time.Now
	}
	if periodo <= 0 {
		periodo = 5 * time.Minute
	}
	margen := int64(margenTopeMax)
	if topeDia > 0 && topeDia/8 < margen {
		margen = topeDia / 8
	}
	r := &registrador{ruta: ruta, topeDia: topeDia, margen: margen, periodo: periodo, reloj: reloj,
		ips: map[string]*[numBolsas]int64{}, omis: map[string]*omision{}, partes: partesIP,
		primeros: map[string]int{}}
	r.enc = json.NewEncoder(&r.buf)
	r.enc.SetEscapeHTML(false)
	_ = os.MkdirAll(filepath.Dir(ruta), 0o755)
	ahora := reloj()
	r.inicioPeriodo = ahora
	if err := r.abrir(ahora); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *registrador) abrir(ahora time.Time) error {
	f, err := os.OpenFile(r.ruta, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f = f
	if fi.Size() > 0 {
		dia := diaDe(fi.ModTime())
		hoy := diaDe(ahora)
		if dia > hoy {
			dia = hoy
		}
		if dia != r.dia {
			r.nuevoDia(dia)
			if dia == hoy {
				r.recontar(fi.Size())
			}
		}
		r.bytesDia = fi.Size()
	} else {
		if d := diaDe(ahora); d != r.dia {
			r.nuevoDia(d)
		}
		r.bytesDia = 0
	}
	return nil
}

func (r *registrador) recontar(tam int64) {
	f, err := os.Open(r.ruta)
	if err != nil {
		r.gastado[bolsaGeneral] = tam
		return
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 64<<10)
	for {
		linea, err := br.ReadSlice('\n')
		n := int64(len(linea))
		if err == bufio.ErrBufferFull {
			for err == bufio.ErrBufferFull {
				linea, err = br.ReadSlice('\n')
				n += int64(len(linea))
			}
			r.gastado[bolsaGeneral] += n
			if err != nil {
				return
			}
			continue
		}
		if n == 0 {
			return
		}
		var m struct {
			EventID string `json:"eventid"`
			SrcIP   string `json:"src_ip"`
			Aviso   string `json:"aviso"`
		}
		b := bolsaGeneral
		if err == nil && json.Unmarshal(linea, &m) == nil {
			b = bolsaDe(m.EventID)
			if b == bolsaGrave && m.Aviso == avisoCompacta {
				b = bolsaCompacta
			}
			if m.EventID == "impresora.log.tope" {
				r.avisado = true
			}
		}
		r.gastado[b] += n
		if m.SrcIP != "" && b != bolsaAvisos {
			if b == bolsaCompacta {
				r.gastoIP(m.SrcIP)[b]++
			} else {
				r.gastoIP(m.SrcIP)[b] += n
			}
		}
		if err != nil {
			return
		}
	}
}

func (r *registrador) nuevoDia(dia string) {
	r.dia = dia
	r.bytesDia = 0
	r.avisado = false
	r.sinAvisos = false
	r.gastado = [numBolsas]int64{}
	r.ips = map[string]*[numBolsas]int64{}
	r.primeros = map[string]int{}
	r.gastoPrimeros = 0
}

// escribir apunta un evento, si cabe.
func (r *registrador) escribir(e evento) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ahora := r.reloj()
	r.mantener(ahora)
	if r.avisado {
		return
	}
	b := bolsaDe(e.EventID)
	if b == bolsaAvisos {
		r.emitir(&e, b, ahora)
		return
	}
	pk := claveIP(e.SrcIP) + "|" + e.EventID
	vistos, contado := r.primeros[pk]
	if !contado && len(r.primeros) < maxPrimeros {
		contado = true
	}
	anotar := func() {
		if contado {
			r.primeros[pk] = vistos + 1
		}
	}
	motivo := r.admite(e.SrcIP, b, ahora)
	if motivo == "" {
		if r.emitir(&e, b, ahora) {
			anotar()
		}
		return
	}
	// De los primeros de su tipo para esta IP hoy: entra con la reserva, aunque
	// su bolsa o la parte de su IP estén llenas (siempre dentro del tope diario).
	if contado && vistos < primerosPorTipo && r.gastoPrimeros < r.topeDia*partePrimeros/1000 {
		antes := r.bytesDia
		if r.emitir(&e, b, ahora) {
			anotar()
			r.gastoPrimeros += r.bytesDia - antes
			return
		}
	}
	if b == bolsaGrave && r.admite(e.SrcIP, bolsaCompacta, ahora) == "" {
		c := versionCompacta(e)
		if r.emitir(&c, bolsaCompacta, ahora) {
			return
		}
	}
	r.omitir(e, b, motivo, ahora)
}

// versionCompacta: lo esencial de un evento grave (quién, desde dónde, qué y
// por qué), en unos cientos de bytes.
func versionCompacta(e evento) evento {
	return evento{
		Cuando:   e.Cuando,
		EventID:  e.EventID,
		Session:  e.Session,
		SrcIP:    e.SrcIP,
		SrcPort:  e.SrcPort,
		Servicio: e.Servicio,
		Comando:  e.Comando,
		Ruta:     recortarCodificado(e.Ruta, maxArgsCompacta),
		Campo:    e.Campo,
		Servidor: recortarCodificado(e.Servidor, maxArgsCompacta),
		Grave:    e.Grave,
		Aviso:    avisoCompacta,
	}
}

func (r *registrador) resumirAhora() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil && (len(r.omis) > 0 || r.sinContar.total > 0) {
		r.resumirOmitidos(r.reloj())
	}
}

func (r *registrador) tic() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.mantener(r.reloj())
}

func (r *registrador) mantener(ahora time.Time) {
	if r.f == nil && ahora.Sub(r.ultimoIntento) >= reintentoApertura {
		r.ultimoIntento = ahora
		if err := r.abrir(ahora); err != nil {
			r.anotarFallo(err, ahora)
		}
	}
	r.rotarSiToca(ahora)
	if ahora.Sub(r.inicioPeriodo) >= r.periodo {
		r.resumirOmitidos(ahora)
	}
}

func (r *registrador) permitido(b bolsa, ahora time.Time) int64 {
	efectivo := r.topeDia - r.margen
	if efectivo < 0 {
		efectivo = 0
	}
	dia := efectivo * reparto[b] / 1000
	if b == bolsaAvisos || b == bolsaCompacta {
		return dia
	}
	return dia * int64(ahora.UTC().Hour()+1) / 24
}

func (r *registrador) gastoIP(ip string) *[numBolsas]int64 {
	k := claveIP(ip)
	g := r.ips[k]
	if g == nil {
		if len(r.ips) >= maxIPsDia {
			k = "*"
			if g = r.ips[k]; g != nil {
				return g
			}
		}
		g = new([numBolsas]int64)
		r.ips[k] = g
	}
	return g
}

func (r *registrador) admite(ip string, b bolsa, ahora time.Time) string {
	if r.topeDia <= 0 {
		return ""
	}
	p := r.permitido(b, ahora)
	if r.gastado[b] >= p {
		return motivoCupoHora
	}
	g := r.gastoIP(ip)[b]
	if b == bolsaCompacta {
		if g >= maxCompactasIP {
			return motivoCupoIP
		}
	} else if g >= p/r.partes[b] {
		return motivoCupoIP
	}
	return ""
}

func (r *registrador) emitir(e *evento, b bolsa, ahora time.Time) bool {
	if r.avisado {
		return false
	}
	if r.fallo != "" && !r.recuperar(ahora) {
		r.perdidos++
		return false
	}
	if r.f == nil {
		r.perdidos++
		return false
	}
	if e.Cuando == "" {
		e.Cuando = ahora.UTC().Format(time.RFC3339Nano)
	}
	r.buf.Reset()
	if err := r.enc.Encode(e); err != nil {
		return false
	}
	n := int64(r.buf.Len())
	if r.topeDia > 0 && r.bytesDia+n > r.topeDia-r.margen/2 {
		r.avisarTope(ahora)
		return false
	}
	if r.topeDia > 0 && b == bolsaAvisos && r.gastado[bolsaAvisos]+n > r.permitido(bolsaAvisos, ahora) {
		r.avisosAgotados(ahora)
		return false
	}
	if !r.volcar(ahora) {
		if b != bolsaAvisos {
			r.perdidos++
		}
		return false
	}
	r.gastado[b] += n
	switch b {
	case bolsaAvisos:
	case bolsaCompacta:
		r.gastoIP(e.SrcIP)[b]++
	default:
		r.gastoIP(e.SrcIP)[b] += n
	}
	return true
}

func (r *registrador) avisosAgotados(ahora time.Time) {
	if r.sinAvisos {
		return
	}
	r.sinAvisos = true
	r.buf.Reset()
	_ = r.enc.Encode(evento{
		Cuando:  ahora.UTC().Format(time.RFC3339Nano),
		EventID: "impresora.log.omitidos",
		Aviso:   "cupo de avisos de hoy agotado: los resúmenes de lo que se calla se pierden hasta mañana (UTC); los eventos se siguen apuntando",
	})
	if n := int64(r.buf.Len()); r.bytesDia+n <= r.topeDia-r.margen/4 && r.volcar(ahora) {
		r.gastado[bolsaAvisos] += n
	}
}

func (r *registrador) avisarTope(ahora time.Time) {
	if r.avisado {
		return
	}
	r.avisado = true
	r.buf.Reset()
	_ = r.enc.Encode(evento{
		Cuando:    ahora.UTC().Format(time.RFC3339Nano),
		EventID:   "impresora.log.tope",
		Aviso:     "tope diario del registro alcanzado; no se apunta nada más hasta mañana (UTC)",
		TopeBytes: r.topeDia,
	})
	if r.bytesDia+int64(r.buf.Len()) <= r.topeDia {
		r.volcar(ahora)
	}
}

func (r *registrador) volcar(ahora time.Time) bool {
	if r.cortada {
		if _, err := r.f.Write([]byte{'\n'}); err != nil {
			r.anotarFallo(err, ahora)
			return false
		}
		r.bytesDia++
		r.cortada = false
	}
	datos := r.buf.Bytes()
	n, err := r.f.Write(datos)
	r.bytesDia += int64(n)
	if err != nil {
		if n > 0 {
			r.cortada = true
		}
		r.anotarFallo(err, ahora)
		return false
	}
	return true
}

func (r *registrador) anotarFallo(err error, ahora time.Time) {
	if r.fallo == "" {
		r.fallo = err.Error()
		r.desdeFallo = ahora
		fmt.Fprintln(os.Stderr, "no se pudo escribir el registro:", err)
	}
}

func (r *registrador) recuperar(ahora time.Time) bool {
	if r.f == nil {
		return false
	}
	r.buf.Reset()
	_ = r.enc.Encode(evento{
		Cuando:   ahora.UTC().Format(time.RFC3339Nano),
		EventID:  "impresora.log.error",
		Perdidos: r.perdidos,
		Error:    recortarCodificado(r.fallo, 256),
		Aviso: "el registro no se pudo escribir desde " + r.desdeFallo.UTC().Format(time.RFC3339) +
			"; faltan los eventos perdidos",
	})
	n := int64(r.buf.Len())
	if !r.volcar(ahora) {
		return false
	}
	r.gastado[bolsaAvisos] += n
	r.fallo, r.perdidos = "", 0
	return true
}

func (r *registrador) omitir(e evento, b bolsa, motivo string, ahora time.Time) {
	var grave, auth int64
	switch b {
	case bolsaGrave:
		grave = 1
	case bolsaAuth:
		auth = 1
	}
	k := claveIP(e.SrcIP)
	o := r.omis[k]
	if o == nil {
		if len(r.omis) >= maxIPsResumen {
			r.sinContar.total++
			r.sinContar.graves += grave
			r.sinContar.auths += auth
			r.ipsSinContar++
			return
		}
		o = &omision{ip: e.SrcIP}
		r.omis[k] = o
	}
	o.total++
	o.graves += grave
	o.auths += auth
	o.motivo = motivo
	switch {
	case grave > 0 && !o.avisadaGrave && r.inmediatosGraves < maxInmediatosGraves:
		o.avisadaGrave, o.avisada = true, true
		r.inmediatosGraves++
		r.avisarOmision(o, ahora)
	case !o.avisada && r.inmediatos < maxInmediatos:
		o.avisada = true
		r.inmediatos++
		r.avisarOmision(o, ahora)
	}
}

func (r *registrador) avisarOmision(o *omision, ahora time.Time) {
	if r.emitir(&evento{
		EventID:        "impresora.log.omitidos",
		SrcIP:          o.ip,
		Motivo:         o.motivo,
		Omitidos:       o.total,
		OmitidosGraves: o.graves,
		OmitidosAuth:   o.auths,
		Aviso:          "se empiezan a omitir eventos de esta IP; el resumen dirá cuántos",
	}, bolsaAvisos, ahora) {
		o.total, o.graves, o.auths = 0, 0, 0
	}
}

func (r *registrador) resumirOmitidos(ahora time.Time) {
	periodo := int(ahora.Sub(r.inicioPeriodo) / time.Second)
	var graves, otras []*omision
	for _, o := range r.omis {
		switch {
		case o.total == 0:
		case o.graves > 0:
			graves = append(graves, o)
		default:
			otras = append(otras, o)
		}
	}
	orden := func(l []*omision) {
		sort.Slice(l, func(i, j int) bool {
			a, b := l[i], l[j]
			if a.graves != b.graves {
				return a.graves > b.graves
			}
			if a.auths != b.auths {
				return a.auths > b.auths
			}
			if a.total != b.total {
				return a.total > b.total
			}
			return a.ip < b.ip
		})
	}
	orden(graves)
	orden(otras)
	resto := r.sinContar
	restoIPs := 0
	linea := func(o *omision) {
		r.emitir(&evento{
			EventID:        "impresora.log.omitidos",
			SrcIP:          o.ip,
			Motivo:         o.motivo,
			Omitidos:       o.total,
			OmitidosGraves: o.graves,
			OmitidosAuth:   o.auths,
			PeriodoS:       periodo,
		}, bolsaAvisos, ahora)
	}
	for _, l := range []struct {
		lista []*omision
		max   int
	}{{graves, maxLineasGraves}, {otras, maxLineasResumen}} {
		for i, o := range l.lista {
			if i >= l.max {
				resto.total += o.total
				resto.graves += o.graves
				resto.auths += o.auths
				restoIPs++
				continue
			}
			linea(o)
		}
	}
	if resto.total > 0 {
		r.emitir(&evento{
			EventID:        "impresora.log.omitidos",
			Omitidos:       resto.total,
			OmitidosGraves: resto.graves,
			OmitidosAuth:   resto.auths,
			IPsDistintas:   restoIPs,
			IPsSinContar:   r.ipsSinContar,
			PeriodoS:       periodo,
			Aviso:          "eventos omitidos de otras IP en este periodo",
		}, bolsaAvisos, ahora)
	}
	r.omis = map[string]*omision{}
	r.sinContar = omision{}
	r.ipsSinContar = 0
	r.inmediatos = 0
	r.inmediatosGraves = 0
	r.inicioPeriodo = ahora
}

func (r *registrador) rotarSiToca(ahora time.Time) {
	hoy := diaDe(ahora)
	if hoy == r.dia {
		return
	}
	if r.f != nil && (len(r.omis) > 0 || r.sinContar.total > 0) {
		r.resumirOmitidos(ahora)
	}
	if r.f != nil {
		r.f.Close()
		r.f = nil
	}
	if _, err := os.Lstat(r.ruta); err == nil {
		if err := os.Rename(r.ruta, libre(r.ruta+"."+r.dia)); err != nil {
			fmt.Fprintln(os.Stderr, "no se pudo rotar el registro:", err)
		}
	}
	r.nuevoDia(hoy)
	r.cortada = false
	if err := r.abrir(ahora); err != nil {
		r.ultimoIntento = ahora
		r.anotarFallo(err, ahora)
		return
	}
	r.dia = hoy
}

func (r *registrador) cerrar() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil {
		r.f.Close()
		r.f = nil
	}
}

func diaDe(t time.Time) string { return t.UTC().Format("2006_01_02") }

func libre(ruta string) string {
	if _, err := os.Lstat(ruta); errors.Is(err, os.ErrNotExist) {
		return ruta
	}
	for i := 1; i < 1000; i++ {
		c := ruta + "." + strconv.Itoa(i)
		if _, err := os.Lstat(c); errors.Is(err, os.ErrNotExist) {
			return c
		}
	}
	return ruta + "." + strconv.FormatInt(time.Now().UnixNano(), 10)
}
