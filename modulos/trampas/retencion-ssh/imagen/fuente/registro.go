package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"hash/maphash"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// campos de una línea del registro. Planos, para que el adaptador del sensor
// los lea por ruta simple.
type campos map[string]any

const (
	// partesReserva: 1/32 del tope del día es para los resúmenes (rechazos,
	// callados) y el aviso de tope: se siguen escribiendo aunque lo demás ya
	// esté lleno. Con 60 MiB, 1,9 MiB: dos resúmenes por minuto todo el día
	// ocupan menos de 1 MiB.
	partesReserva = 32
	// partesPorIP: una IP no gasta más de 1/16 de lo que queda (con 60 MiB,
	// 3,6 MiB: unas 7.000 conexiones). Hacen falta 16 IP para llenar el día.
	partesPorIP = 16
	// cubetasIP: el gasto por IP se cuenta en una tabla fija (256 KiB), por
	// un hash con clave al azar: la memoria no crece con las IP distintas y
	// nadie puede elegir con quién comparte cubeta.
	cubetasIP = 1 << 16
)

// Por qué no se apunta una línea (campos del resumen "callados").
const (
	motivoCupoIP  = "cupo_ip"  // su IP ya ha gastado su parte de hoy
	motivoTopeDia = "tope_dia" // el día está lleno
)

// registrador escribe el registro JSON por líneas (reten.json) y se encarga de
// que no crezca sin tope en el disco del cliente ni se lo coma un solo
// atacante: rota por renombrado al cambiar el día (UTC), a
// reten.json.AAAA_MM_DD, que el sensor sigue por el prefijo y borra a la
// semana; no pasa de su tope de bytes por día; y cada IP de origen puede
// gastar como mucho 1/16 de ese día. Lo que no se apunta (por el cupo de su
// IP o porque el día está lleno) sale en un resumen por periodo (evento
// "callados"), y al llenarse el día queda una línea de aviso (evento "tope");
// los dos, de una reserva del día: nunca se queda mudo hasta medianoche. Si
// el fichero no se puede escribir, la trampa sigue: mejor perder líneas que
// dejar de retener.
type registrador struct {
	mu      sync.Mutex
	ruta    string
	f       *os.File
	w       *bufio.Writer
	dia     string // AAAA_MM_DD (UTC) de lo que hay en el fichero activo
	topeDia int64  // 0: sin tope
	reserva int64
	cupoIP  int64
	// Gastado hoy: en líneas de conexiones y en la reserva.
	bytesDia, bytesReserva int64
	avisado                bool // ya se escribió hoy la línea de tope
	clave                  maphash.Seed
	porIP                  []uint32
	callados               callados
	reloj                  func() time.Time
}

// callados: lo que no se ha apuntado en el periodo, para su resumen.
type callados struct {
	total, cupoIP, topeDia int
	ips                    map[string]int
	sinContar              int // de IP que ya no caben en ips
}

func nuevoRegistrador(ruta string, topeDia int64, reloj func() time.Time) (*registrador, error) {
	reserva := topeDia / partesReserva
	return nuevoRegistradorCon(ruta, topeDia, reserva, (topeDia-reserva)/partesPorIP, reloj)
}

// nuevoRegistradorCon: con la reserva y el cupo por IP a mano (las pruebas).
func nuevoRegistradorCon(ruta string, topeDia, reserva, cupoIP int64, reloj func() time.Time) (*registrador, error) {
	if reloj == nil {
		reloj = time.Now
	}
	r := &registrador{
		ruta: ruta, topeDia: topeDia, reserva: reserva, cupoIP: cupoIP, reloj: reloj,
		clave: maphash.MakeSeed(), porIP: make([]uint32, cubetasIP),
	}
	// La carpeta la monta el sensor; si no está, se intenta crear igualmente.
	_ = os.MkdirAll(filepath.Dir(ruta), 0o755)
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
func (r *registrador) abrir() error {
	f, err := os.OpenFile(r.ruta, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.w, r.avisado = f, bufio.NewWriter(f), false
	clear(r.porIP)
	r.bytesDia, r.bytesReserva = 0, 0
	if fi.Size() > 0 {
		r.dia = diaDe(fi.ModTime())
		r.bytesDia = fi.Size()
		if r.topeDia > 0 {
			r.bytesDia = min(fi.Size(), r.topeDia-r.reserva)
			r.bytesReserva = fi.Size() - r.bytesDia
			r.avisado = r.bytesDia >= r.topeDia-r.reserva
		}
	} else {
		r.dia = diaDe(r.reloj())
	}
	return nil
}

// esResumen: los eventos que no son de una conexión y van a la reserva.
func esResumen(evento string) bool {
	return evento == "rechazos" || evento == "callados" || evento == "tope"
}

// escribir apunta un evento: la hora, su nombre y sus campos.
func (r *registrador) escribir(evento string, base, extra campos) {
	m := make(campos, len(base)+len(extra)+2)
	for k, v := range base {
		m[k] = v
	}
	for k, v := range extra {
		m[k] = v
	}
	m["evento"] = evento
	r.mu.Lock()
	defer r.mu.Unlock()
	m["ts"] = r.ahora()
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	r.rotarSiToca()
	if r.w == nil {
		return
	}
	n := int64(len(b)) + 1
	ip, _ := m["src_ip"].(string)
	switch {
	case r.topeDia <= 0:
		r.linea(b)
		r.bytesDia += n
	case esResumen(evento):
		r.lineaReserva(b)
	case r.bytesDia+n > r.topeDia-r.reserva:
		if !r.avisado {
			r.avisado = true
			aviso, _ := json.Marshal(campos{
				"ts":         m["ts"],
				"evento":     "tope",
				"tope_bytes": r.topeDia,
				"aviso":      "tope diario del registro alcanzado: hasta mañana (UTC) solo se apunta un resumen por periodo de lo que se calla",
			})
			r.lineaReserva(aviso)
		}
		r.callar(ip, motivoTopeDia)
	case int64(r.porIP[r.cubeta(ip)])+n > r.cupoIP:
		r.callar(ip, motivoCupoIP)
	default:
		r.porIP[r.cubeta(ip)] += uint32(n)
		r.bytesDia += n
		r.linea(b)
	}
}

func (r *registrador) ahora() string { return r.reloj().UTC().Format(time.RFC3339Nano) }

func (r *registrador) cubeta(ip string) int {
	return int(maphash.String(r.clave, ip) % cubetasIP)
}

// lineaReserva escribe un resumen o aviso si cabe en la reserva de hoy.
func (r *registrador) lineaReserva(b []byte) {
	if r.bytesReserva+int64(len(b))+1 > r.reserva {
		return
	}
	r.linea(b)
	r.bytesReserva += int64(len(b)) + 1
}

func (r *registrador) callar(ip, motivo string) {
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

// resumirCallados escribe el resumen de lo no apuntado en el periodo, si hubo
// algo, a nombre de la IP con más líneas calladas.
func (r *registrador) resumirCallados(modo string, periodo time.Duration) {
	r.mu.Lock()
	c := r.callados
	r.callados = callados{}
	r.mu.Unlock()
	if c.total == 0 {
		return
	}
	var ip string
	var deIP int
	for k, v := range c.ips {
		if v > deIP || v == deIP && k < ip {
			ip, deIP = k, v
		}
	}
	extra := campos{
		"id": nuevoID(), "modo": modo, "src_ip": ip, "sin_apuntar": c.total, "de_su_ip": deIP,
		"por_cupo_ip": c.cupoIP, "por_tope_dia": c.topeDia, "ips_distintas": len(c.ips),
		"periodo_s": int(periodo / time.Second),
		"aviso":     "líneas no apuntadas: su IP ha gastado su parte del registro de hoy, o el día está lleno",
	}
	if c.sinContar > 0 {
		extra["ips_sin_contar"] = c.sinContar
	}
	r.escribir("callados", nil, extra)
}

// linea escribe una línea ya serializada y la vuelca: si paran el
// contenedor, no se pierde lo ya apuntado.
func (r *registrador) linea(b []byte) {
	r.w.Write(b)
	r.w.WriteByte('\n')
	if err := r.w.Flush(); err != nil {
		// Disco lleno o similar: se descarta lo pendiente y se sigue.
		r.w.Reset(r.f)
	}
}

// rotarSiToca: si ha cambiado el día, renombra el activo a ruta.AAAA_MM_DD
// (el día que acaba; sin pisar uno que ya exista) y abre otro vacío, con el
// gasto de hoy (también el de cada IP) a cero.
func (r *registrador) rotarSiToca() {
	if r.f == nil {
		if r.abrir() != nil {
			return
		}
	}
	hoy := diaDe(r.reloj())
	if hoy == r.dia {
		return
	}
	r.w.Flush()
	r.f.Close()
	r.f, r.w = nil, nil
	if err := os.Rename(r.ruta, libre(r.ruta+"."+r.dia)); err != nil {
		fmt.Fprintln(os.Stderr, "reten: no se pudo rotar el registro:", err)
	}
	if err := r.abrir(); err != nil {
		fmt.Fprintln(os.Stderr, "reten: no se pudo abrir el registro:", err)
		return
	}
	// Si el renombrado falló, se sigue en el mismo fichero, pero sus bytes
	// cuentan para el tope de hoy: el disco sigue acotado.
	r.dia = hoy
}

func (r *registrador) cerrar() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.w != nil {
		r.w.Flush()
	}
	if r.f != nil {
		r.f.Close()
	}
	r.f, r.w = nil, nil
}

func diaDe(t time.Time) string { return t.UTC().Format("2006_01_02") }

// libre devuelve ruta, o ruta.N con el primer N libre (p. ej. si cambia la
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
