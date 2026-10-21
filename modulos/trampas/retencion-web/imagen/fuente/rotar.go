// Código propio de SeguridadSI (no viene de go-pot) para la trampa
// retencion-web de Sugardaddy: el destino de zap donde escribe el registro de
// accesos. preparar.sh lo copia a protocol/http/logging/.
//
//	GOPOT__SERVER__ACCESS_LOG__PATH=rotar:///registros/go-pot.json?tope_mb=60
//
// go-pot escribe siempre en el mismo fichero y el sensor solo poda los
// rotados: sin esto el registro crecería sin tope en el disco del cliente.
//   - Rota una vez al día (UTC) por renombrado, a go-pot.json.AAAA_MM_DD. El
//     sensor reconoce el rotado por el prefijo, lo acaba de leer y lo borra a
//     la semana.
//   - No escribe más de tope_mb megas al día, contando todo.
//   - Reparto: cada IP de origen puede gastar como mucho 1/16 de lo del día.
//     Un solo atacante que no para ya no llena el registro ni deja la trampa
//     ciega para los demás hasta medianoche.
//   - Lo que se calla (por el cupo de su IP o porque el día está lleno) sale
//     en un resumen por minuto (phase "callados": cuántas líneas, de qué IP la
//     mayoría, cuántas IP), y las conexiones que cierra el limitador
//     (cupos.go) en otro (phase "rechazos"). Para esos resúmenes y para el
//     aviso de tope (phase "tope") se guarda 1/32 del día: se siguen
//     escribiendo aunque todo lo demás ya esté lleno.
//
// Si el fichero no se puede reabrir o renombrar, el honeypot sigue sirviendo:
// mejor perder líneas que caerse.
package logging

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/maphash"
	"net/url"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

const (
	// topePorDefecto: 60 MiB al día. Con los siete días que guarda el sensor
	// más el de hoy son 480 MiB, por debajo de su cuota de 512 MiB por trampa.
	topePorDefecto = 60 << 20
	// partesReserva: 1/32 del día es para los resúmenes y el aviso de tope.
	// Con 60 MiB son 1,9 MiB: dos resúmenes por minuto todo el día ocupan
	// menos de 1,2 MiB.
	partesReserva = 32
	// partesPorIP: una IP no gasta más de 1/16 de lo que queda (con 60 MiB,
	// 3,6 MiB: unas 12.000 líneas). Hacen falta 16 IP para llenar el día.
	partesPorIP = 16
	// cubetasIP: el gasto por IP se cuenta en una tabla fija (256 KiB), por
	// un hash con clave al azar: la memoria no crece con las IP distintas y
	// nadie puede elegir con quién comparte cubeta.
	cubetasIP = 1 << 16
	// maxIPsResumen: IP distintas que nombra un resumen; pasado eso solo suma.
	maxIPsResumen = 1024
	// periodoResumen: cada cuánto se escriben los resúmenes, si hay algo.
	periodoResumen = time.Minute
)

// Por qué se calla una línea (campos del resumen).
const (
	motivoCupoIP  = "cupo_ip"  // su IP ya ha gastado su parte de hoy
	motivoTopeDia = "tope_dia" // el día está lleno
)

// rotadorActivo es el registro en uso: el limitador de conexiones (cupos.go)
// escribe en él sus resúmenes.
var rotadorActivo atomic.Pointer[rotador]

func init() {
	if err := zap.RegisterSink("rotar", func(u *url.URL) (zap.Sink, error) {
		r, err := nuevoRotador(u.Path, topeDe(u.Query().Get("tope_mb")), time.Now)
		if err != nil {
			return nil, err
		}
		r.resumirCada(periodoResumen)
		rotadorActivo.Store(r)
		return r, nil
	}); err != nil {
		panic(err)
	}
}

// topeDe lee tope_mb (de 1 a 1024); si falta o no vale, el de por defecto.
func topeDe(s string) int64 {
	mb, err := strconv.Atoi(s)
	if err != nil || mb < 1 || mb > 1024 {
		return topePorDefecto
	}
	return int64(mb) << 20
}

type rotador struct {
	mu      sync.Mutex
	ruta    string
	tope    int64 // bytes por día, todo incluido
	reserva int64 // de ellos, para resúmenes y avisos
	cupoIP  int64 // bytes por día y cubeta de IP
	reloj   func() time.Time
	f       *os.File
	dia     string // AAAA_MM_DD (UTC) de lo que hay en el fichero activo
	// Gastado hoy: en líneas de peticiones y en la reserva.
	bytesDia, bytesReserva int64
	avisado                bool // ya se escribió hoy la línea de tope
	clave                  maphash.Seed
	porIP                  []uint32 // bytes de hoy por cubeta de IP
	callados               callados // del periodo en curso
	parar                  chan struct{}
}

// callados: lo que no se ha escrito en el periodo, para su resumen.
type callados struct {
	total, cupoIP, topeDia int
	ips                    map[string]int
	sinContar              int // de IP que ya no caben en ips
}

func nuevoRotador(ruta string, tope int64, reloj func() time.Time) (*rotador, error) {
	reserva := tope / partesReserva
	return nuevoRotadorCon(ruta, tope, reserva, (tope-reserva)/partesPorIP, reloj)
}

// nuevoRotadorCon: con la reserva y el cupo por IP a mano (las pruebas).
func nuevoRotadorCon(ruta string, tope, reserva, cupoIP int64, reloj func() time.Time) (*rotador, error) {
	if ruta == "" {
		return nil, errors.New("rotar: falta la ruta del registro")
	}
	r := &rotador{
		ruta: ruta, tope: tope, reserva: reserva, cupoIP: cupoIP,
		reloj: reloj, clave: maphash.MakeSeed(), porIP: make([]uint32, cubetasIP),
	}
	// Si no se puede abrir al arrancar, go-pot no arranca: así se ve el fallo.
	if err := r.abrir(); err != nil {
		return nil, err
	}
	return r, nil
}

// abrir abre (o crea) el registro activo para añadir. Si ya tenía algo (un
// reinicio), cuenta sus bytes (como líneas y, lo que pase de su parte, como
// reserva) y toma su día de la fecha del fichero: si es de ayer, la primera
// escritura de hoy lo rota. El gasto por IP no se guarda: tras un reinicio
// empieza de cero, pero el tope total sigue.
func (r *rotador) abrir() error {
	f, err := os.OpenFile(r.ruta, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.avisado = f, false
	clear(r.porIP)
	r.bytesDia, r.bytesReserva = 0, 0
	if fi.Size() > 0 {
		r.dia = diaDe(fi.ModTime())
		r.bytesDia = min(fi.Size(), r.tope-r.reserva)
		r.bytesReserva = fi.Size() - r.bytesDia
		r.avisado = r.bytesDia >= r.tope-r.reserva
	} else {
		r.dia = diaDe(r.reloj())
	}
	return nil
}

// linea: lo que el rotador mira de cada línea de zap.
type linea struct {
	Phase string `json:"phase"`
	SrcIP string `json:"src_ip"`
}

// Write recibe de zap una entrada entera (una línea JSON con su salto).
// Siempre dice que la ha escrito: a zap no le sirve de nada saber que no.
func (r *rotador) Write(p []byte) (int, error) {
	var l linea
	_ = json.Unmarshal(p, &l) // sin phase ni src_ip, cuenta como línea sin IP
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rotarSiToca()
	if r.f == nil {
		return len(p), nil
	}
	if esResumen(l.Phase) {
		r.escribirReserva(p)
		return len(p), nil
	}
	n := int64(len(p))
	c := r.cubeta(l.SrcIP)
	switch {
	case r.bytesDia+n > r.tope-r.reserva:
		if !r.avisado {
			r.avisado = true
			r.escribirReserva(r.lineaTope())
		}
		r.callar(l.SrcIP, motivoTopeDia)
	case int64(r.porIP[c])+n > r.cupoIP:
		r.callar(l.SrcIP, motivoCupoIP)
	default:
		r.porIP[c] += uint32(n)
		r.bytesDia += n
		_, _ = r.f.Write(p)
	}
	return len(p), nil
}

// esResumen: las líneas que no son de una petición y van a la reserva.
func esResumen(phase string) bool {
	return phase == "callados" || phase == "rechazos" || phase == "tope"
}

func (r *rotador) cubeta(ip string) int {
	return int(maphash.String(r.clave, ip) % cubetasIP)
}

// escribirReserva escribe un resumen o aviso si cabe en la reserva de hoy.
func (r *rotador) escribirReserva(p []byte) {
	if r.bytesReserva+int64(len(p)) > r.reserva {
		return
	}
	n, _ := r.f.Write(p)
	r.bytesReserva += int64(n)
}

func (r *rotador) callar(ip, motivo string) {
	c := &r.callados
	c.total++
	if motivo == motivoCupoIP {
		c.cupoIP++
	} else {
		c.topeDia++
	}
	if c.ips == nil {
		c.ips = map[string]int{}
	}
	if _, ok := c.ips[ip]; ok || len(c.ips) < maxIPsResumen {
		c.ips[ip]++
	} else {
		c.sinContar++
	}
}

// ahora: la hora de las líneas propias, en el mismo formato que las de go-pot
// (formato.go).
func (r *rotador) ahora() string { return r.reloj().UTC().Format(time.RFC3339Nano) }

// lineaTope tiene la forma de las de go-pot, con phase "tope" para que el
// manifiesto la traduzca a un aviso.
func (r *rotador) lineaTope() []byte {
	b, _ := json.Marshal(map[string]any{
		"level": "warn", "ts": r.ahora(), "msg": "", "id": uuid.NewString(), "phase": "tope",
		"tope_bytes": r.tope,
		"aviso":      "tope diario del registro alcanzado: hasta mañana (UTC) solo se apunta un resumen por minuto de lo que se calla",
	})
	return append(b, '\n')
}

// resumir escribe el resumen de lo callado en el periodo, si hubo algo. Va a
// nombre de la IP con más líneas calladas.
func (r *rotador) resumir(periodo time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.callados
	r.callados = callados{}
	if c.total == 0 {
		return
	}
	r.rotarSiToca()
	if r.f == nil {
		return
	}
	var ip string
	var deIP int
	for k, v := range c.ips {
		if v > deIP || v == deIP && k < ip {
			ip, deIP = k, v
		}
	}
	m := map[string]any{
		"level": "warn", "ts": r.ahora(), "msg": "", "id": uuid.NewString(), "phase": "callados",
		"src_ip": ip, "sin_apuntar": c.total, "de_su_ip": deIP, "por_cupo_ip": c.cupoIP,
		"por_tope_dia": c.topeDia, "ips_distintas": len(c.ips), "periodo_s": int(periodo / time.Second),
		"aviso": "líneas no apuntadas: su IP ha gastado su parte del registro de hoy, o el día está lleno",
	}
	if c.sinContar > 0 {
		m["ips_sin_contar"] = c.sinContar
	}
	b, _ := json.Marshal(m)
	r.escribirReserva(append(b, '\n'))
}

// resumirCada escribe los resúmenes cada periodo hasta que se cierra.
func (r *rotador) resumirCada(periodo time.Duration) {
	parar := make(chan struct{})
	r.mu.Lock()
	r.parar = parar
	r.mu.Unlock()
	go func() {
		t := time.NewTicker(periodo)
		defer t.Stop()
		for {
			select {
			case <-parar:
				return
			case <-t.C:
				r.resumir(periodo)
			}
		}
	}()
}

// rotarSiToca: si ha cambiado el día, renombra el activo a ruta.AAAA_MM_DD
// (el día que acaba; sin pisar uno que ya exista) y abre otro vacío, con el
// gasto de hoy (también el de cada IP) a cero.
func (r *rotador) rotarSiToca() {
	if r.f == nil {
		if r.abrir() != nil {
			return
		}
	}
	hoy := diaDe(r.reloj())
	if hoy == r.dia {
		return
	}
	r.f.Close()
	r.f = nil
	if err := os.Rename(r.ruta, libre(r.ruta+"."+r.dia)); err != nil {
		fmt.Fprintln(os.Stderr, "rotar: no se pudo renombrar el registro:", err)
	}
	if err := r.abrir(); err != nil {
		fmt.Fprintln(os.Stderr, "rotar: no se pudo abrir el registro:", err)
		return
	}
	// Si el renombrado falló, se sigue en el mismo fichero, pero sus bytes
	// cuentan para el tope de hoy: el disco sigue acotado.
	r.dia = hoy
}

func (r *rotador) Sync() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return nil
	}
	return r.f.Sync()
}

func (r *rotador) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.parar != nil {
		close(r.parar)
		r.parar = nil
	}
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

func diaDe(t time.Time) string { return t.UTC().Format("2006_01_02") }

// libre devuelve ruta, o ruta.N con el primer N libre (p. ej. tras cambiar la
// hora del sistema). El sensor lee todos los que empiezan por el nombre.
func libre(ruta string) string {
	if _, err := os.Lstat(ruta); errors.Is(err, os.ErrNotExist) {
		return ruta
	}
	for n := 1; n < 1000; n++ {
		c := ruta + "." + strconv.Itoa(n)
		if _, err := os.Lstat(c); errors.Is(err, os.ErrNotExist) {
			return c
		}
	}
	return ruta + "." + strconv.FormatInt(time.Now().UnixNano(), 10)
}
