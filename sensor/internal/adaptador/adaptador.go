// Package adaptador traduce una línea del registro nativo de un honeypot al
// evento normalizado, siguiendo solo lo que declara su manifiesto. No hay
// código por honeypot: si un módulo necesita algo que esto no sabe hacer, se
// amplía el formato del manifiesto.
package adaptador

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// ErrIgnorada es una línea que no es un evento (arranque, estadísticas).
var ErrIgnorada = errors.New("línea ignorada")

const (
	maxTexto = 256
	maxCrudo = 65536
)

// Adaptar convierte una línea. Todo lo que viene de la línea lo escribió el
// atacante: se recorta y se comprueba antes de meterlo en el evento.
func Adaptar(sensor string, s plan.TrampaPlan, linea []byte) (evento.Evento, error) {
	var nativo map[string]any
	if err := json.Unmarshal(linea, &nativo); err != nil {
		return evento.Evento{}, fmt.Errorf("no es JSON: %w", err)
	}
	ev := s.Manifiesto.Eventos

	valorAccion := texto(buscar(nativo, ev.Accion.Campo))
	for _, ig := range ev.Accion.Ignorar {
		if valorAccion == ig {
			return evento.Evento{}, ErrIgnorada
		}
	}
	accion, ok := ev.Accion.Valores[valorAccion]
	if !ok {
		accion = ev.Accion.PorDefecto
	}
	severidad := ev.Severidad.PorDefecto
	if sv, ok := ev.Severidad.PorAccion[accion]; ok {
		severidad = sv
	}
	if sv, ok := ev.Severidad.PorValor[valorAccion]; ok {
		severidad = sv
	}
	if pc := ev.Severidad.PorCampo; pc != nil {
		if sv, ok := pc.Valores[escalar(buscar(nativo, pc.Campo))]; ok {
			severidad = sv
		}
	}
	conexion := ev.ConexionEstablecida
	if pc := ev.ConexionPorCampo; pc != nil {
		if c, ok := pc.Valores[escalar(buscar(nativo, pc.Campo))]; ok {
			conexion = c
		}
	}

	cuando, err := fecha(buscar(nativo, ev.Campos.Cuando))
	if err != nil {
		return evento.Evento{}, err
	}

	origen := evento.Origen{
		Usuario: recortar(texto(buscar(nativo, ev.Campos.Usuario)), maxTexto),
		Equipo:  recortar(texto(buscar(nativo, ev.Campos.Equipo)), maxTexto),
	}
	if ip := net.ParseIP(texto(buscar(nativo, ev.Campos.IP))); ip != nil {
		origen.IP = ip.String()
	}
	if p, ok := numero(buscar(nativo, ev.Campos.Puerto)); ok && p >= 0 && p <= 65535 && p == float64(int(p)) {
		origen.Puerto = int(p)
	}

	var detalle map[string]any
	for _, campo := range ev.Detalle {
		if v := buscar(nativo, campo); v != nil {
			if detalle == nil {
				detalle = map[string]any{}
			}
			if t, ok := v.(string); ok {
				v = recortar(t, 4096)
			}
			detalle[campo] = v
		}
	}

	return evento.Evento{
		Version:             2,
		ID:                  idDe(sensor, s.ID, linea),
		Cuando:              cuando.UTC().Format(time.RFC3339Nano),
		Trampa:              evento.Trampa{ID: s.ID, Modulo: s.Manifiesto.ID, Tipo: s.Manifiesto.Tipo},
		Sensor:              sensor,
		Origen:              origen,
		Accion:              accion,
		Severidad:           severidad,
		ConexionEstablecida: conexion,
		Detalle:             detalle,
		Crudo:               recortar(string(linea), maxCrudo),
		Nativa:              recortar(valorAccion, maxTexto),
	}, nil
}

// buscar sigue una ruta con puntos ("a.b.c") dentro del registro nativo. Si
// la clave existe tal cual, con sus puntos (Mailoney escribe "smtp.from"),
// gana esa.
func buscar(m map[string]any, ruta string) any {
	if ruta == "" {
		return nil
	}
	if v, ok := m[ruta]; ok {
		return v
	}
	return buscarRuta(m, ruta)
}

// buscarRuta sigue la ruta solo por partes, como el adaptador de la 0.12.
func buscarRuta(m map[string]any, ruta string) any {
	if ruta == "" {
		return nil
	}
	var actual any = m
	for _, parte := range strings.Split(ruta, ".") {
		obj, ok := actual.(map[string]any)
		if !ok {
			return nil
		}
		actual = obj[parte]
	}
	return actual
}

func texto(v any) string {
	s, _ := v.(string)
	return s
}

// escalar pasa a texto un valor simple (texto, número o booleano), para
// compararlo con las claves de una tabla del manifiesto.
func escalar(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return ""
}

// numero acepta un número o un texto con un número ("51234"): algunos
// honeypots escriben los puertos entre comillas.
func numero(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return n, err == nil
	}
	return 0, false
}

// Formatos de fecha que escriben los honeypots. Sin zona, la fecha es UTC.
var formatosFecha = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999Z0700",
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04:05.999999999Z07:00",
	"2006-01-02 15:04:05.999999999Z0700",
	"2006-01-02 15:04:05.999999999",
}

// fecha lee la fecha de un evento: RFC 3339 con o sin zona, con espacio en
// vez de T, o en segundos o milisegundos desde 1970 (número o texto).
func fecha(v any) (time.Time, error) {
	if n, ok := numero(v); ok && n > 0 {
		if n > 1e12 { // milisegundos
			return time.UnixMilli(int64(n)).UTC(), nil
		}
		s := int64(n)
		return time.Unix(s, int64((n-float64(s))*1e9)).UTC(), nil
	}
	t := strings.TrimSpace(texto(v))
	for _, f := range formatosFecha {
		if d, err := time.Parse(f, t); err == nil {
			return d, nil
		}
	}
	return time.Time{}, fmt.Errorf("fecha ilegible: %q", recortar(t, 64))
}

// recortar deja como mucho n bytes sin partir un carácter por la mitad.
func recortar(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// idDe da a cada evento un identificador fijo, sacado de su sensor, su trampa
// y la línea nativa (que lleva su propia marca de tiempo). Si el sensor vuelve
// a leer la misma línea (p. ej. tras apagarse entre escribir la cola y guardar
// el estado), el evento repetido trae el mismo id y la consola lo reconoce.
// Formato UUID versión 8 (contenido propio).
func idDe(sensor, trampa string, linea []byte) string {
	h := sha256.New()
	h.Write([]byte(sensor))
	h.Write([]byte{0})
	h.Write([]byte(trampa))
	h.Write([]byte{0})
	h.Write(linea)
	b := h.Sum(nil)[:16]
	b[6] = b[6]&0x0f | 0x80
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// Resumen junta lo que el sensor no ha mandado de una trampa en un minuto
// porque pasaba de sus topes (siguen en su registro nativo).
type Resumen struct {
	N            int              `json:"n"`
	PorSeveridad map[string]int   `json:"porSeveridad,omitempty"`
	PorAccion    map[string]int   `json:"porAccion,omitempty"`
	PorIP        map[string]int   `json:"porIP,omitempty"`
	Muestra      []map[string]any `json:"muestra,omitempty"`
}

// ipsResumen: IP distintas que se cuentan en un resumen.
const ipsResumen = 1024

// Apuntar cuenta un evento omitido; de los graves guarda una muestra.
func (r *Resumen) Apuntar(e evento.Evento, muestra int) {
	if r.PorSeveridad == nil {
		r.PorSeveridad, r.PorAccion, r.PorIP = map[string]int{}, map[string]int{}, map[string]int{}
	}
	r.N++
	r.PorSeveridad[e.Severidad]++
	r.PorAccion[e.Accion]++
	if _, ya := r.PorIP[e.Origen.IP]; ya || len(r.PorIP) < ipsResumen {
		r.PorIP[e.Origen.IP]++
	}
	if e.Severidad != "alta" && e.Severidad != "critica" {
		return
	}
	// La muestra, un evento por tipo distinto (lo repetido no tapa una
	// descarga o una escritura), con lo crítico por delante de lo alto.
	tipo := e.Accion + "|" + e.Nativa
	for _, m := range r.Muestra {
		if m["tipo"] == tipo {
			return
		}
	}
	nuevo := map[string]any{"tipo": tipo, "cuando": e.Cuando, "ip": e.Origen.IP, "accion": e.Accion, "severidad": e.Severidad, "detalle": e.Detalle}
	if len(r.Muestra) < muestra {
		r.Muestra = append(r.Muestra, nuevo)
		return
	}
	for i, m := range r.Muestra {
		if m["severidad"] == "alta" && e.Severidad == "critica" {
			r.Muestra[i] = nuevo
			return
		}
	}
}

func (r Resumen) Copia() Resumen {
	c := Resumen{N: r.N, Muestra: append([]map[string]any(nil), r.Muestra...)}
	for _, par := range []struct {
		de   map[string]int
		para *map[string]int
	}{{r.PorSeveridad, &c.PorSeveridad}, {r.PorAccion, &c.PorAccion}, {r.PorIP, &c.PorIP}} {
		if par.de != nil {
			*par.para = make(map[string]int, len(par.de))
			for k, v := range par.de {
				(*par.para)[k] = v
			}
		}
	}
	return c
}

type ipRuidosa struct {
	IP string `json:"ip"`
	N  int    `json:"n"`
}

// ipsMasRuidosas: las 5 IP con más eventos del resumen.
func (r Resumen) ipsMasRuidosas() []ipRuidosa {
	var ips []ipRuidosa
	for k, v := range r.PorIP {
		ips = append(ips, ipRuidosa{k, v})
	}
	sort.Slice(ips, func(i, j int) bool {
		if ips[i].N != ips[j].N {
			return ips[i].N > ips[j].N
		}
		return ips[i].IP < ips[j].IP
	})
	if len(ips) > 5 {
		ips = ips[:5]
	}
	return ips
}

// severidad: la más alta de lo resumido; como poco, media.
func (r Resumen) severidad() string {
	for _, sv := range []string{"critica", "alta"} {
		if r.PorSeveridad[sv] > 0 {
			return sv
		}
	}
	return "media"
}

// Omitidos es el evento que resume lo que el sensor no ha mandado de una
// trampa en un minuto: cuántos, de qué severidad y acción, las IP más ruidosas
// y una muestra de los graves. Su severidad es la más alta de lo omitido (como
// poco, media: alguien está dando sin parar).
func Omitidos(sensor string, s plan.TrampaPlan, minuto time.Time, r Resumen) evento.Evento {
	severidad := r.severidad()
	detalle := map[string]any{
		"omitidos": r.N, "minuto": minuto.UTC().Format(time.RFC3339),
		"porSeveridad": r.PorSeveridad, "porAccion": r.PorAccion, "ipsMasRuidosas": r.ipsMasRuidosas(),
	}
	if len(r.Muestra) > 0 {
		detalle["muestra"] = r.Muestra
	}
	linea, _ := json.Marshal(map[string]any{"sugardaddy": "omitidos", "trampa": s.ID, "minuto": minuto.UTC().Format(time.RFC3339), "omitidos": r.N, "porSeveridad": r.PorSeveridad})
	return evento.Evento{
		Version:   2,
		ID:        idDe(sensor, s.ID, linea),
		Cuando:    minuto.UTC().Add(time.Minute - time.Millisecond).Format(time.RFC3339Nano),
		Trampa:    evento.Trampa{ID: s.ID, Modulo: s.Manifiesto.ID, Tipo: s.Manifiesto.Tipo},
		Sensor:    sensor,
		Accion:    "otra",
		Severidad: severidad,
		Detalle:   detalle,
		Crudo:     recortar(string(linea), maxCrudo),
	}
}

// OmitidosDe dice si e es un resumen de Omitidos y, si lo es, cuántos eventos
// resume y de qué severidad. Lo que sale de una línea nativa nunca trae un
// entero en el detalle (JSON da float64), así que no se puede hacer pasar por uno.
func OmitidosDe(e evento.Evento) (int, map[string]int, bool) {
	n, ok := e.Detalle["omitidos"].(int)
	if !ok {
		return 0, nil, false
	}
	porSeveridad, _ := e.Detalle["porSeveridad"].(map[string]int)
	return n, porSeveridad, true
}

// Descarte junta lo que el sensor no ha podido guardar de una trampa porque su
// cola de salida estaba llena (la consola no recogía los eventos, o el tope era
// pequeño por el poco disco libre) o porque no quedaba disco para escribirla.
type Descarte struct {
	Desde time.Time `json:"desde"` // fecha del evento descartado más antiguo
	Hasta time.Time `json:"hasta"` // y del más reciente
	Bytes int64     `json:"bytes"` // lo que ocupaban en la cola
	Tope  int64     `json:"tope"`  // tope de la cola cuando se descartaron
	// SinDisco: alguno se descartó porque el disco se quedó sin sitio, no por
	// el tope de la cola.
	SinDisco bool `json:"sinDisco,omitempty"`
	// PocoDisco: alguno no cupo porque el tope de la cola era pequeño por el
	// poco disco libre, aunque la consola recogía los eventos.
	PocoDisco bool `json:"pocoDisco,omitempty"`
	// Omitidos: eventos que ya venían resumidos por los topes por minuto y
	// cuyo resumen tampoco cupo, y su severidad.
	Omitidos             int            `json:"omitidos,omitempty"`
	PorSeveridadOmitidos map[string]int `json:"porSeveridadOmitidos,omitempty"`
	Resumen              Resumen        `json:"resumen"`
}

// Apuntar cuenta un evento descartado que ocupaba n bytes en la cola; de los
// graves guarda una muestra.
func (d *Descarte) Apuntar(e evento.Evento, n int, muestra int) {
	cuando, err := time.Parse(time.RFC3339Nano, e.Cuando)
	if err != nil {
		cuando = time.Now().UTC()
	}
	if d.Desde.IsZero() || cuando.Before(d.Desde) {
		d.Desde = cuando
	}
	if cuando.After(d.Hasta) {
		d.Hasta = cuando
	}
	d.Bytes += int64(n)
	if omitidos, porSeveridad, ok := OmitidosDe(e); ok {
		d.Omitidos += omitidos
		if d.PorSeveridadOmitidos == nil {
			d.PorSeveridadOmitidos = map[string]int{}
		}
		for sv, k := range porSeveridad {
			d.PorSeveridadOmitidos[sv] += k
		}
		return
	}
	d.Resumen.Apuntar(e, muestra)
}

// Copia, para trabajar sobre ella sin tocar el original.
func (d Descarte) Copia() Descarte {
	c := d
	c.Resumen = d.Resumen.Copia()
	if d.PorSeveridadOmitidos != nil {
		c.PorSeveridadOmitidos = make(map[string]int, len(d.PorSeveridadOmitidos))
		for k, v := range d.PorSeveridadOmitidos {
			c.PorSeveridadOmitidos[k] = v
		}
	}
	return c
}

var rangoSeveridad = map[string]int{"media": 1, "alta": 2, "critica": 3}

// Códigos estables (fase.causa) del resumen de Descartados: la cola llegó a
// su tope porque la consola no recogía los eventos, o porque el tope era
// pequeño por el poco disco libre (con la consola recogiendo), o el disco se
// quedó sin sitio para escribirla.
const (
	CodigoColaLlena     = "cola.llena"
	CodigoColaPocoDisco = "cola.poco-disco"
	CodigoColaSinDisco  = "cola.sin-disco"
)

// Codigo es el código del resumen: si alguno se descartó por el disco, manda
// el disco, que es lo que el cliente tiene que arreglar.
func (d Descarte) Codigo() string {
	switch {
	case d.SinDisco:
		return CodigoColaSinDisco
	case d.PocoDisco:
		return CodigoColaPocoDisco
	}
	return CodigoColaLlena
}

// Descartados es el evento que resume lo que el sensor ha descartado de una
// trampa con la cola de salida llena: cuántos, cuándo, de qué severidad y
// acción, las IP más ruidosas y una muestra de los graves. Llega a la consola
// en cuanto la cola tiene sitio, antes que lo nuevo.
func Descartados(sensor string, s plan.TrampaPlan, d Descarte) evento.Evento {
	r := d.Resumen
	codigo, mb := d.Codigo(), max(d.Tope>>20, 1)
	var aviso string
	switch codigo {
	case CodigoColaSinDisco:
		aviso = "El disco de la máquina del sensor se quedó sin sitio: estos eventos no se pudieron guardar. " +
			"Conviene liberar espacio en esa máquina."
	case CodigoColaPocoDisco:
		aviso = fmt.Sprintf("Queda poco disco libre en la máquina del sensor, así que solo podía guardar %d MB de "+
			"eventos pendientes de enviar a la consola: estos no cupieron. Conviene liberar espacio en esa máquina.", mb)
	default:
		aviso = fmt.Sprintf("La consola no recogió los eventos a tiempo y el sensor llegó al tope de lo que guarda "+
			"para ella (%d MB): estos eventos no se pudieron guardar. Conviene comprobar que el sensor llega a la consola.", mb)
	}
	detalle := map[string]any{
		"codigo": codigo, "aviso": aviso,
		"descartados": r.N, "bytes": d.Bytes, "topeCola": d.Tope,
		"desde": d.Desde.UTC().Format(time.RFC3339Nano), "hasta": d.Hasta.UTC().Format(time.RFC3339Nano),
		"porSeveridad": r.PorSeveridad, "porAccion": r.PorAccion, "ipsMasRuidosas": r.ipsMasRuidosas(),
	}
	severidad := r.severidad()
	if d.Omitidos > 0 {
		detalle["omitidosEnResumenes"] = d.Omitidos
		detalle["porSeveridadOmitidos"] = d.PorSeveridadOmitidos
		if o := (Resumen{PorSeveridad: d.PorSeveridadOmitidos}).severidad(); rangoSeveridad[o] > rangoSeveridad[severidad] {
			severidad = o
		}
	}
	if len(r.Muestra) > 0 {
		detalle["muestra"] = r.Muestra
	}
	linea, _ := json.Marshal(map[string]any{
		"sugardaddy": "descartados", "trampa": s.ID, "desde": detalle["desde"], "hasta": detalle["hasta"],
		"descartados": r.N, "omitidos": d.Omitidos, "bytes": d.Bytes,
	})
	return evento.Evento{
		Version:   2,
		ID:        idDe(sensor, s.ID, linea),
		Cuando:    d.Hasta.UTC().Format(time.RFC3339Nano),
		Trampa:    evento.Trampa{ID: s.ID, Modulo: s.Manifiesto.ID, Tipo: s.Manifiesto.Tipo},
		Sensor:    sensor,
		Accion:    "otra",
		Severidad: severidad,
		Detalle:   detalle,
		Crudo:     recortar(string(linea), maxCrudo),
	}
}

// Compatible012 dice si el adaptador de los sensores 0.12 entendería esta
// línea igual: fecha RFC 3339 en texto, puerto numérico, rutas sin claves con
// punto literal y sin las reglas por campo. El banco de pruebas lo usa para
// exigir sensorMinimo a las trampas que no lo cumplen (si no, en un sensor
// viejo se despliegan y no dan ni un evento).
func Compatible012(s plan.TrampaPlan, linea []byte) error {
	ev := s.Manifiesto.Eventos
	if ev.Severidad.PorCampo != nil || ev.ConexionPorCampo != nil {
		return errors.New("usa severidad.porCampo o conexionPorCampo")
	}
	var nativo map[string]any
	if err := json.Unmarshal(linea, &nativo); err != nil {
		return err
	}
	for _, ig := range ev.Accion.Ignorar {
		if texto(buscarRuta(nativo, ev.Accion.Campo)) == ig {
			return nil
		}
	}
	rutas := append([]string{ev.Campos.Cuando, ev.Campos.IP, ev.Campos.Puerto, ev.Campos.Usuario, ev.Campos.Equipo, ev.Accion.Campo}, ev.Detalle...)
	for _, r := range rutas {
		if _, literal := nativo[r]; literal && strings.Contains(r, ".") {
			return fmt.Errorf("la clave %q lleva puntos", r)
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, texto(buscarRuta(nativo, ev.Campos.Cuando))); err != nil {
		return errors.New("la fecha no es RFC 3339 en texto")
	}
	if v := buscarRuta(nativo, ev.Campos.Puerto); v != nil {
		if _, ok := v.(float64); !ok {
			return errors.New("el puerto no es un número")
		}
	}
	return nil
}
