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

// evento: una línea del registro. Campos planos para que el adaptador del
// sensor los lea por ruta simple. "cuando" en RFC3339Nano UTC, como Cowrie.
type evento struct {
	Cuando   string `json:"cuando"`
	EventID  string `json:"eventid"`
	Session  string `json:"session,omitempty"`
	SrcIP    string `json:"src_ip,omitempty"`
	SrcPort  int    `json:"src_port,omitempty"`
	Comando  string `json:"comando,omitempty"`  // nombre del comando: GET, CONFIG... (recortado)
	Args     string `json:"args,omitempty"`     // argumentos, recortados
	Usuario  string `json:"usuario,omitempty"`  // en AUTH usuario contraseña y HELLO ... AUTH
	Password string `json:"password,omitempty"` // en AUTH y HELLO ... AUTH
	Grave    string `json:"grave,omitempty"`    // motivo si es ataque grave
	Duracion string `json:"duration,omitempty"` // en el cierre, segundos

	// Resúmenes de lo que se calla (rechazos y eventos omitidos) y avisos del
	// propio registro.
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

// Bolsas en las que se reparte el tope diario del registro. Lo grave y las
// contraseñas tienen cada uno la suya: una avalancha de órdenes normales no
// oculta la contraseña o el SLAVEOF de otro atacante, y los AUTH (gratis en
// modo abierto) no gastan el sitio de lo grave. Lo grave que no cabe en su
// bolsa de la hora se apunta en versión compacta, con unas pocas líneas por IP
// y día, para que nunca se pierda del todo quién hizo SLAVEOF ni hacia dónde.
// Los avisos (resúmenes de lo que se calla) tienen otra, para que la consola
// sepa siempre que se están perdiendo eventos.
type bolsa int

const (
	bolsaGeneral bolsa = iota
	bolsaGrave
	bolsaAuth
	bolsaCompacta
	bolsaAvisos
	numBolsas
)

// reparto del tope diario, en milésimas.
var reparto = [numBolsas]int64{600, 150, 100, 50, 100}

// partesIP: en las bolsas que se liberan por horas, una IP no gasta más de
// 1/partes de lo que lleva permitido. Hacen falta muchas IP para callar la
// trampa una hora, y ninguna la calla un día entero. Las contraseñas tienen
// una parte mucho menor (partesAuth): un AUTH no cuesta nada y no puede servir
// para gastar el cupo de las demás.
var partesIP = [numBolsas]int64{bolsaGeneral: 16, bolsaGrave: 16, bolsaAuth: partesAuthContrasena}

const (
	// Parte de la bolsa de contraseñas por IP: con contraseña, cada intento
	// es lo que se vigila; en modo abierto AUTH no sirve de nada y es solo
	// ruido gratis, así que la parte es aún menor.
	partesAuthContrasena = 64
	partesAuthAbierto    = 128
)

const (
	// maxCompactasIP: líneas compactas de lo grave por IP y día. La bolsa
	// compacta está entera desde el principio del día: para agotarla hacen
	// falta miles de IP, y lo de cada una queda apuntado.
	maxCompactasIP = 4
	// maxArgsCompacta: bytes (escapados) de los argumentos en la versión compacta.
	maxArgsCompacta = 128
	// margenTopeMax: lo más que se reserva del tope para la línea de tope y lo
	// que una bolsa se pase con su última línea. En topes diarios pequeños
	// (pruebas) se usa una fracción, no este máximo.
	margenTopeMax = 16 << 10
	// maxIPsDia: IP distintas que se llevan la cuenta de su gasto en un día.
	// Las demás comparten una sola cuenta: una avalancha desde miles de IP no
	// gasta memoria y sigue acotada.
	maxIPsDia = 8192
	// maxIPsResumen: IP distintas que cuenta el resumen de omitidos; las
	// demás solo suman al total.
	maxIPsResumen = 1024
	// maxLineasResumen: líneas por IP de cada resumen periódico para las IP
	// sin nada grave omitido; el resto va en una línea de conjunto.
	maxLineasResumen = 8
	// maxLineasGraves: líneas por IP de cada resumen para las IP con algo
	// grave omitido, aparte de las anteriores y antes que ellas.
	maxLineasGraves = 32
	// maxInmediatos: avisos inmediatos («se empieza a omitir a esta IP») por
	// periodo; los demás esperan al resumen.
	maxInmediatos = 16
	// maxInmediatosGraves: avisos inmediatos reservados a las IP a las que se
	// les calla algo grave: quien solo llena el registro no los gasta.
	maxInmediatosGraves = 32
	// reintentoApertura: cada cuánto se intenta reabrir un registro que no se
	// pudo abrir.
	reintentoApertura = time.Minute
	// avisoCompacta: marca la versión compacta de lo grave (y la distingue al
	// recontar el fichero tras un reinicio).
	avisoCompacta = "versión compacta: el cupo de lo grave de esta hora está lleno"
)

const (
	motivoCupoIP   = "cupo de su IP"
	motivoCupoHora = "cupo de la hora"
)

// bolsaDe dice de qué bolsa gasta cada tipo de evento.
func bolsaDe(id string) bolsa {
	switch id {
	case "redis.command.grave":
		return bolsaGrave
	case "redis.auth":
		return bolsaAuth
	case "redis.log.omitidos", "redis.log.tope", "redis.log.error",
		"redis.session.rechazada", "redis.session.rechazos":
		return bolsaAvisos
	}
	return bolsaGeneral
}

type omision struct {
	ip                   string // la primera IP vista con esta clave (IPv6: su /64)
	total, graves, auths int64
	motivo               string
	avisada              bool // ya tuvo su aviso inmediato en este periodo
	avisadaGrave         bool // ya tuvo su aviso inmediato por lo grave
}

// registrador escribe el registro y se encarga de que no crezca sin tope en el
// disco del cliente ni de que un atacante lo deje mudo para los demás:
//
//   - rota por renombrado al cambiar el día (redis.json.AAAA_MM_DD) y no pasa
//     del tope de bytes del día;
//   - reparte ese tope en bolsas (general, grave, contraseñas, grave compacto,
//     avisos); las de eventos se liberan por horas: lo que se gasta en una
//     ráfaga deja de entrar hasta la hora siguiente, no hasta mañana;
//   - ninguna IP gasta más de su parte de lo que lleva permitido su bolsa;
//   - lo que no entra se cuenta y se resume por IP cada cierto tiempo
//     (redis.log.omitidos), con lo grave y las contraseñas aparte y por
//     delante, y con un aviso inmediato la primera vez;
//   - tras un reinicio el mismo día, rehace lo gastado de cada bolsa leyendo
//     el fichero;
//   - si el disco falla, reintenta y, al recuperarse, deja una línea con lo
//     que se perdió (redis.log.error).
type registrador struct {
	mu        sync.Mutex
	ruta      string
	f         *os.File
	dia       string // AAAA_MM_DD (UTC) del fichero activo
	bytesDia  int64  // bytes que de verdad hay en el fichero activo
	topeDia   int64  // tope de bytes por día (0 = sin tope)
	margen    int64  // bytes reservados del tope (para la línea de tope y avisos)
	avisado   bool   // ya se escribió hoy la línea de tope: se calla hasta mañana
	sinAvisos bool   // la bolsa de avisos de hoy se agotó (ya se dijo)
	reloj     func() time.Time
	buf       bytes.Buffer
	enc       *json.Encoder

	gastado [numBolsas]int64
	ips     map[string]*[numBolsas]int64 // por IP: bytes (líneas, en la compacta)
	partes  [numBolsas]int64             // partesIP, con la de contraseñas según el modo

	periodo          time.Duration
	inicioPeriodo    time.Time
	omis             map[string]*omision
	sinContar        omision // omitidos de IP que no caben en omis
	ipsSinContar     int64
	inmediatos       int
	inmediatosGraves int

	fallo         string // primer error de escritura sin resolver
	desdeFallo    time.Time
	perdidos      int64 // eventos perdidos desde el fallo
	cortada       bool  // la última escritura quedó a medias
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
		ips: map[string]*[numBolsas]int64{}, omis: map[string]*omision{}, partes: partesIP}
	r.enc = json.NewEncoder(&r.buf)
	// Sin esto, cada < > & ocupa 6 bytes: un atacante multiplicaba por 6 lo
	// que escribe.
	r.enc.SetEscapeHTML(false)
	// La carpeta la monta el sensor; si no está, se intenta crear igualmente.
	_ = os.MkdirAll(filepath.Dir(ruta), 0o755)
	ahora := reloj()
	r.inicioPeriodo = ahora
	if err := r.abrir(ahora); err != nil {
		return nil, err
	}
	return r, nil
}

// modoAbierto ajusta la parte de las contraseñas por IP: sin contraseña
// configurada, AUTH es ruido gratis. Se llama antes de servir.
func (r *registrador) modoAbierto(abierto bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.partes[bolsaAuth] = partesAuthContrasena
	if abierto {
		r.partes[bolsaAuth] = partesAuthAbierto
	}
}

// abrir abre (o crea) el registro activo en modo añadir y fija el día y los
// bytes ya presentes. Tras un reinicio, el día se toma de la fecha del fichero:
// si es de ayer, la primera escritura de hoy lo rotará; si es de hoy, se rehace
// lo gastado de cada bolsa y de cada IP leyendo el fichero (antes todo contaba
// como gastado de la general, que quedaba cerrada horas mientras las demás
// volvían a estar enteras).
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
		// Un fichero no puede ser del futuro: si su fecha va por delante del
		// reloj (p. ej. relojes distintos en las pruebas), se toma la de hoy.
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

// recontar rehace lo gastado por bolsa y por IP leyendo el registro de hoy en
// flujo, con un búfer fijo (una vez al arrancar; como mucho el tope diario).
// De cada línea solo interesan eventid, src_ip y aviso. Una línea cortada, más
// larga que el búfer o ilegible cuenta para la general.
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
			if m.EventID == "redis.log.tope" {
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

// nuevoDia pone a cero lo gastado: empieza otro día del registro.
func (r *registrador) nuevoDia(dia string) {
	r.dia = dia
	r.bytesDia = 0
	r.avisado = false
	r.sinAvisos = false
	r.gastado = [numBolsas]int64{}
	r.ips = map[string]*[numBolsas]int64{}
}

// escribir apunta un evento, si cabe. Lo grave que no cabe en su bolsa se
// intenta en versión compacta; lo que no cabe de ninguna forma se cuenta para
// el resumen. Nunca serializa un evento que no va a escribir.
func (r *registrador) escribir(e evento) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ahora := r.reloj()
	r.mantener(ahora)
	if r.avisado {
		return // tope del día: no se apunta nada más hasta mañana
	}
	b := bolsaDe(e.EventID)
	if b == bolsaAvisos {
		r.emitir(&e, b, ahora)
		return
	}
	motivo := r.admite(e.SrcIP, b, ahora)
	if motivo == "" {
		r.emitir(&e, b, ahora)
		return
	}
	if b == bolsaGrave && r.admite(e.SrcIP, bolsaCompacta, ahora) == "" {
		c := versionCompacta(e)
		if r.emitir(&c, bolsaCompacta, ahora) {
			return
		}
	}
	r.omitir(e, b, motivo, ahora)
}

// versionCompacta: lo esencial de un evento grave (quién, desde dónde, qué
// comando y por qué, y el principio de los argumentos: hacia dónde va el
// SLAVEOF), en unos 400 bytes.
func versionCompacta(e evento) evento {
	return evento{
		Cuando:  e.Cuando,
		EventID: e.EventID,
		Session: e.Session,
		SrcIP:   e.SrcIP,
		SrcPort: e.SrcPort,
		Comando: e.Comando,
		Args:    recortarCodificado(e.Args, maxArgsCompacta),
		Grave:   e.Grave,
		Aviso:   avisoCompacta,
	}
}

// resumirAhora deja el resumen de lo omitido sin esperar al fin del periodo
// (al parar la trampa).
func (r *registrador) resumirAhora() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil && (len(r.omis) > 0 || r.sinContar.total > 0) {
		r.resumirOmitidos(r.reloj())
	}
}

// tic hace lo que toca aunque no lleguen eventos: rotar, reabrir y escribir
// el resumen del periodo.
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

// permitido: bytes que la bolsa b puede llevar gastados a esta hora. Las de
// eventos se liberan por horas (lo no gastado se acumula); la de avisos y la
// compacta están enteras desde el principio del día.
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

// admite dice si un evento cabe en su bolsa y en la parte de su IP. Si no,
// devuelve el motivo.
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

// emitir serializa y escribe una línea. Si no cabe en el tope del día (o en
// la bolsa de avisos), deja la línea de tope.
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
		// Sin sitio para más avisos hoy: se dice una vez y los eventos se
		// siguen apuntando (antes esto paraba el registro hasta mañana).
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

// avisosAgotados deja, una vez al día y dentro del margen reservado, la línea
// que dice que los resúmenes de lo que se calla se pierden hasta mañana.
func (r *registrador) avisosAgotados(ahora time.Time) {
	if r.sinAvisos {
		return
	}
	r.sinAvisos = true
	r.buf.Reset()
	_ = r.enc.Encode(evento{
		Cuando:  ahora.UTC().Format(time.RFC3339Nano),
		EventID: "redis.log.omitidos",
		Aviso:   "cupo de avisos de hoy agotado: los resúmenes de lo que se calla se pierden hasta mañana (UTC); los eventos se siguen apuntando",
	})
	if n := int64(r.buf.Len()); r.bytesDia+n <= r.topeDia-r.margen/4 && r.volcar(ahora) {
		r.gastado[bolsaAvisos] += n
	}
}

// avisarTope deja, una vez al día, la línea de tope (cabe en el margen
// reservado) y calla hasta la rotación.
func (r *registrador) avisarTope(ahora time.Time) {
	if r.avisado {
		return
	}
	r.avisado = true
	r.buf.Reset()
	_ = r.enc.Encode(evento{
		Cuando:    ahora.UTC().Format(time.RFC3339Nano),
		EventID:   "redis.log.tope",
		Aviso:     "tope diario del registro alcanzado; no se apunta nada más hasta mañana (UTC)",
		TopeBytes: r.topeDia,
	})
	if r.bytesDia+int64(r.buf.Len()) <= r.topeDia {
		r.volcar(ahora)
	}
}

// volcar escribe lo que hay en buf directamente en el fichero (una línea por
// escritura: un kill no pierde lo ya apuntado) y cuenta solo lo escrito de
// verdad.
func (r *registrador) volcar(ahora time.Time) bool {
	if r.cortada {
		// Una escritura anterior quedó a medias: se cierra esa línea para
		// que la siguiente no se pegue a ella.
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

// recuperar intenta, tras un fallo de escritura, dejar la línea que dice
// cuántos eventos se han perdido. Si entra, el registro vuelve a funcionar.
func (r *registrador) recuperar(ahora time.Time) bool {
	if r.f == nil {
		return false
	}
	r.buf.Reset()
	_ = r.enc.Encode(evento{
		Cuando:   ahora.UTC().Format(time.RFC3339Nano),
		EventID:  "redis.log.error",
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

// omitir cuenta un evento que no cabe. La primera vez que se calla a una IP
// en el periodo se avisa en el momento (hasta maxInmediatos IP por periodo), y
// aparte, la primera vez que se le calla algo grave (hasta
// maxInmediatosGraves IP): quien solo llena el registro no gasta los avisos de
// quien hace algo grave. El resto va en el resumen.
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

// avisarOmision deja el aviso inmediato de una IP. Lo que cuenta ya no sale en
// el resumen.
func (r *registrador) avisarOmision(o *omision, ahora time.Time) {
	if r.emitir(&evento{
		EventID:        "redis.log.omitidos",
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

// resumirOmitidos escribe lo omitido en el periodo: primero una línea por IP
// con algo grave omitido (las que más, hasta maxLineasGraves), luego una por
// IP del resto (hasta maxLineasResumen) y una de conjunto con lo que quede.
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
			EventID:        "redis.log.omitidos",
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
			EventID:        "redis.log.omitidos",
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

// rotarSiToca, si ha cambiado el día, cierra el registro activo, lo renombra a
// redis.json.AAAA_MM_DD (el día que acaba) y abre uno nuevo con el nombre fijo.
// El sensor sigue el renombrado por su inodo y huella.
func (r *registrador) rotarSiToca(ahora time.Time) {
	hoy := diaDe(ahora)
	if hoy == r.dia {
		return
	}
	// Lo que se calló ayer se resume en el fichero de ayer, antes de cerrarlo.
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
	// Si el renombrado falló, se sigue en el mismo fichero: sus bytes cuentan
	// para el tope de hoy y el disco sigue acotado.
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

// diaDe da la fecha AAAA_MM_DD (UTC) con la que se nombra un rotado.
func diaDe(t time.Time) string { return t.UTC().Format("2006_01_02") }

// libre devuelve ruta, o ruta.N con el primer N libre, para no pisar un rotado
// que ya exista (por ejemplo tras un reinicio el mismo día). El sensor lee
// todos los rotados de la carpeta, así que varios no son problema.
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
