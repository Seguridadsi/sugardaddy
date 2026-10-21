// Package requisitos es el lado Go del comparador de requisitos
// (docs/diseno/modulo-despliegue.md §3): lenguaje cerrado, cada requisito
// nombra un hecho y lleva un solo operador (igual, en, contiene, minimo o
// presente). Es el mismo comparador que paquetes/contrato/src/requisitos.ts y
// los dos pasan los mismos vectores (paquetes/contrato/vectores/requisitos.jsonl):
// si divergen, falla la CI de uno de los dos lados.
//
// En la primera fase la consola decide sola y nadie lo llama aquí: está para
// que el agente pueda revalidar antes de colocar (escala.md) con el mismo
// lenguaje y sin traducir nada.
//
// Nunca entra en pánico ni devuelve error: un tipo que no cuadra, o un
// requisito fuera del lenguaje (sin operador, con dos, presente que no es
// booleano), no se cumple.
package requisitos

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
)

// Resultado de comparar un requisito con los hechos de un destino.
type Resultado string

const (
	Cumple   Resultado = "cumple"
	NoCumple Resultado = "no-cumple"
	// SinDato: el hecho no está (o vale null). Presente nunca lo da.
	SinDato Resultado = "sin-dato"
)

// Efecto es lo que hace el elector con el resultado (§3.2).
type Efecto string

const (
	Nada     Efecto = "nada"
	Avisa    Efecto = "avisa"
	Descarta Efecto = "descarta"
)

// Operadores del lenguaje.
const (
	Igual    = "igual"
	En       = "en"
	Contiene = "contiene"
	Minimo   = "minimo"
	Presente = "presente"
)

var operadores = []string{Igual, En, Contiene, Minimo, Presente}

// Hecho es un dato de un destino con su motivo: la forma del contrato
// ({valor, motivo}). El valor es un texto, un número, un booleano o una lista
// de textos; lo que no es nada de eso no cumple ningún operador salvo
// presente.
type Hecho struct {
	Valor  any    `json:"valor"`
	Motivo string `json:"motivo,omitempty"`
}

// Hechos de un destino por clave (motor.modo, plataforma.so…).
type Hechos map[string]Hecho

// UnmarshalJSON lee las claves tal cual, como JSON.parse: encoding/json
// casaría «VALOR» con Valor sin distinguir mayúsculas. Lo que no es un objeto
// es un hecho sin valor.
func (h *Hecho) UnmarshalJSON(b []byte) error {
	*h = Hecho{}
	var campos map[string]json.RawMessage
	if json.Unmarshal(b, &campos) != nil {
		return nil
	}
	if v, ok := campos["valor"]; ok {
		_ = json.Unmarshal(v, &h.Valor)
	}
	if v, ok := campos["motivo"]; ok {
		_ = json.Unmarshal(v, &h.Motivo)
	}
	return nil
}

// Requisito: un hecho, un solo operador con su valor y qué hacer si no se
// cumple. En JSON, el operador es una clave más: {"hecho": "motor.modo",
// "en": ["rootful"], "motivo": "…"}.
type Requisito struct {
	Hecho string
	// Operador es uno de los cinco; vacío si el JSON no traía ninguno o traía
	// más de uno (fuera del lenguaje: no se cumple).
	Operador string
	// Valor del operador, como lo da encoding/json (string, float64, bool,
	// []any…). En Go también vale un int o un []string.
	Valor any
	// Nivel: exige (por defecto) o avisa.
	Nivel string
	// SiFalta: descarta, avisa o ignora. Por defecto, descarta con exige e
	// ignora con avisa.
	SiFalta string
	Motivo  string
	Remedio string
}

// UnmarshalJSON lee las claves tal cual y cuenta los operadores. Un campo
// de texto que no es texto se queda vacío, como lo ve el lado TS.
func (r *Requisito) UnmarshalJSON(b []byte) error {
	*r = Requisito{}
	var campos map[string]json.RawMessage
	if json.Unmarshal(b, &campos) != nil {
		return nil
	}
	texto := func(k string) string {
		var s string
		_ = json.Unmarshal(campos[k], &s)
		return s
	}
	r.Hecho, r.Nivel, r.SiFalta = texto("hecho"), texto("nivel"), texto("siFalta")
	r.Motivo, r.Remedio = texto("motivo"), texto("remedio")
	n := 0
	for _, op := range operadores {
		if v, ok := campos[op]; ok {
			n++
			r.Operador = op
			_ = json.Unmarshal(v, &r.Valor)
		}
	}
	if n != 1 {
		r.Operador, r.Valor = "", nil
	}
	return nil
}

// MarshalJSON escribe la misma forma que lee.
func (r Requisito) MarshalJSON() ([]byte, error) {
	m := map[string]any{"hecho": r.Hecho, "motivo": r.Motivo}
	for k, v := range map[string]string{"nivel": r.Nivel, "siFalta": r.SiFalta, "remedio": r.Remedio} {
		if v != "" {
			m[k] = v
		}
	}
	if r.Operador != "" {
		m[r.Operador] = r.Valor
	}
	return json.Marshal(m)
}

// Evaluar compara un requisito con los hechos de un destino.
func Evaluar(r Requisito, hechos Hechos) Resultado {
	if !slices.Contains(operadores, r.Operador) {
		return NoCumple
	}
	h, ok := hechos[r.Hecho]
	hay := ok && h.Valor != nil
	if r.Operador == Presente {
		x, ok := r.Valor.(bool)
		return resultado(ok && hay == x)
	}
	if !hay {
		return SinDato
	}
	return resultado(cumple(r.Operador, h.Valor, r.Valor))
}

func resultado(si bool) Resultado {
	if si {
		return Cumple
	}
	return NoCumple
}

func cumple(op string, valor, x any) bool {
	switch op {
	case Igual:
		return igual(valor, x)
	case En:
		l, ok := lista(x)
		return ok && slices.ContainsFunc(l, func(e any) bool { return igual(valor, e) })
	case Contiene:
		l, ok := lista(valor)
		return ok && slices.ContainsFunc(l, func(e any) bool { return igual(e, x) })
	case Minimo:
		return alMenos(valor, x)
	}
	return false
}

// EfectoDe aplica la tabla de §3.2. Un requisito que solo avisa nunca
// descarta, aunque diga siFalta: descarta (la validación del manifiesto lo
// rechaza).
func EfectoDe(r Requisito, res Resultado) Efecto {
	avisa := r.Nivel == "avisa"
	switch res {
	case Cumple:
		return Nada
	case NoCumple:
		if avisa {
			return Avisa
		}
		return Descarta
	}
	siFalta := r.SiFalta
	if siFalta != "descarta" && siFalta != "avisa" && siFalta != "ignora" {
		siFalta = "descarta"
		if avisa {
			siFalta = "ignora"
		}
	}
	switch {
	case siFalta == "ignora":
		return Nada
	case siFalta == "descarta" && !avisa:
		return Descarta
	}
	return Avisa
}

// numero: los de encoding/json son float64; en Go también valen los enteros.
func numero(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int8:
		return float64(n), true
	case int16:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint8:
		return float64(n), true
	case uint16:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	}
	return 0, false
}

func lista(v any) ([]any, bool) {
	switch l := v.(type) {
	case []any:
		return l, true
	case []string:
		r := make([]any, len(l))
		for i, s := range l {
			r[i] = s
		}
		return r, true
	}
	return nil, false
}

// igual: mismo tipo y mismo valor. Una lista u otra cosa no es igual a nada.
func igual(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	}
	x, ok := numero(a)
	y, ok2 := numero(b)
	return ok && ok2 && x == y
}

// alMenos: número contra número, o versión contra versión; mezclarlos no
// cumple.
func alMenos(valor, minimo any) bool {
	if m, ok := numero(minimo); ok {
		v, ok := numero(valor)
		return ok && v >= m
	}
	m, ok := minimo.(string)
	v, ok2 := valor.(string)
	if !ok || !ok2 {
		return false
	}
	a, b := partes(v), partes(m)
	return a != nil && b != nil && compararVersiones(a, b) >= 0
}

var version = regexp.MustCompile(`^[0-9]+(\.[0-9]+)*`)

// partes de una versión con puntos, sin ceros a la izquierda: «7.4.6-preview»
// da [7 4 6]. Lo que sigue a la última parte se ignora. Sin una cifra al
// principio no es una versión (nil).
func partes(v string) []string {
	m := version.FindString(v)
	if m == "" {
		return nil
	}
	ps := strings.Split(m, ".")
	for i, p := range ps {
		if p = strings.TrimLeft(p, "0"); p == "" {
			p = "0"
		}
		ps[i] = p
	}
	return ps
}

// compararCifras compara dos números en decimal sin ceros a la izquierda sin
// convertirlos: sin tope de cifras, igual que el lado TS.
func compararCifras(a, b string) int {
	if len(a) != len(b) {
		return len(a) - len(b)
	}
	return strings.Compare(a, b)
}

// compararVersiones parte a parte como números; la que falta cuenta como 0
// (0.13 = 0.13.0).
func compararVersiones(a, b []string) int {
	for i := range max(len(a), len(b)) {
		x, y := "0", "0"
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if c := compararCifras(x, y); c != 0 {
			return c
		}
	}
	return 0
}
