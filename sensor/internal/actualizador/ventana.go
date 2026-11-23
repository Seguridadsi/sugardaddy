package actualizador

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	// La base de zonas horarias va dentro del binario: la imagen del actualizador es «scratch»
	// y no trae /usr/share/zoneinfo. Sin esto, «Europe/Madrid» no se podría leer.
	_ "time/tzdata"
)

// Ventana horaria de la política de cambios (docs/diseno/politica-cambios.md, escala.md §4):
// los días y las horas, en una zona horaria, en que el nodo puede empezar a instalar una
// versión. Se mira solo al empezar: una instalación que empieza dentro no se corta al cerrar.
//
// Días ISO: 1 lunes … 7 domingo. Si «hasta» no es mayor que «desde», la ventana cruza la
// medianoche y el día es el de su comienzo («5 22:00-02:00» es la noche del viernes al
// sábado); «desde» igual a «hasta» son 24 horas desde «desde». Sin zona, UTC.
type Ventana struct {
	Dias  []int  `json:"dias"`
	Desde string `json:"desde"`
	Hasta string `json:"hasta"`
	Zona  string `json:"zona,omitempty"`
}

var horaVentana = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// MaxVentanas por política: de sobra para «laborables de 2 a 5 y fines de semana todo el día».
const MaxVentanas = 8

// ValidarVentana dice qué falla en una ventana (nil si vale).
func ValidarVentana(v Ventana) error {
	if len(v.Dias) == 0 || len(v.Dias) > 7 {
		return errors.New("the window has no days")
	}
	vistos := map[int]bool{}
	for _, d := range v.Dias {
		if d < 1 || d > 7 || vistos[d] {
			return errors.New("the window days must be 1 (Monday) to 7 (Sunday), each once")
		}
		vistos[d] = true
	}
	if !horaVentana.MatchString(v.Desde) || !horaVentana.MatchString(v.Hasta) {
		return errors.New("the window times must be HH:MM")
	}
	if _, err := zonaDe(v.Zona); err != nil {
		return fmt.Errorf("unknown time zone %q", v.Zona)
	}
	return nil
}

func zonaDe(z string) (*time.Location, error) {
	z = strings.TrimSpace(z)
	if z == "" || z == "UTC" {
		return time.UTC, nil
	}
	// LoadLocation acepta rutas («../»): solo nombres IANA.
	if strings.Contains(z, "..") || strings.HasPrefix(z, "/") || len(z) > 64 {
		return nil, errors.New("zona")
	}
	return time.LoadLocation(z)
}

func minutos(hhmm string) int {
	h, _ := strconv.Atoi(hhmm[:2])
	m, _ := strconv.Atoi(hhmm[3:])
	return h*60 + m
}

// diaISO: 1 lunes … 7 domingo.
func diaISO(t time.Time) int {
	d := int(t.Weekday())
	if d == 0 {
		return 7
	}
	return d
}

// Abierta dice si la ventana está abierta en ese instante. Una ventana inválida, nunca.
func (v Ventana) Abierta(t time.Time) bool {
	if ValidarVentana(v) != nil {
		return false
	}
	loc, _ := zonaDe(v.Zona)
	lt := t.In(loc)
	m := lt.Hour()*60 + lt.Minute()
	d := diaISO(lt)
	ayer := d - 1
	if ayer == 0 {
		ayer = 7
	}
	desde, hasta := minutos(v.Desde), minutos(v.Hasta)
	hoy, deAyer := slices.Contains(v.Dias, d), slices.Contains(v.Dias, ayer)
	if desde < hasta {
		return hoy && m >= desde && m < hasta
	}
	// Cruza la medianoche (o dura 24 h): lo que queda de hoy, o la cola de la que empezó ayer.
	return (hoy && m >= desde) || (deAyer && m < hasta)
}

// grupoAbierto: una lista de ventanas está abierta si lo está alguna.
func grupoAbierto(g []Ventana, t time.Time) bool {
	for _, v := range g {
		if v.Abierta(t) {
			return true
		}
	}
	return false
}

// LeerVentanas lee ACTUALIZACION_VENTANA: ventanas separadas por «;», cada una
// «días horas [zona]», p. ej. «1-5 02:00-05:00 Europe/Madrid; 6,7 00:00-00:00 Europe/Madrid».
// Los días, números sueltos o rangos separados por comas. Vacío: sin ventana (nil, nil).
func LeerVentanas(texto string) ([]Ventana, error) {
	texto = strings.TrimSpace(texto)
	if texto == "" {
		return nil, nil
	}
	var r []Ventana
	for _, parte := range strings.Split(texto, ";") {
		campos := strings.Fields(parte)
		if len(campos) == 0 {
			continue
		}
		if len(campos) < 2 || len(campos) > 3 || len(r) >= MaxVentanas {
			return nil, fmt.Errorf("cannot read the window %q", strings.TrimSpace(parte))
		}
		dias, err := leerDias(campos[0])
		if err != nil {
			return nil, err
		}
		desde, hasta, ok := strings.Cut(campos[1], "-")
		if !ok {
			return nil, fmt.Errorf("cannot read the window times %q", campos[1])
		}
		v := Ventana{Dias: dias, Desde: desde, Hasta: hasta}
		if len(campos) == 3 {
			v.Zona = campos[2]
		}
		if err := ValidarVentana(v); err != nil {
			return nil, err
		}
		r = append(r, v)
	}
	if len(r) == 0 {
		return nil, nil
	}
	return r, nil
}

func leerDias(s string) ([]int, error) {
	var dias []int
	for _, p := range strings.Split(s, ",") {
		a, b, rango := strings.Cut(p, "-")
		i, err1 := strconv.Atoi(a)
		j := i
		var err2 error
		if rango {
			j, err2 = strconv.Atoi(b)
		}
		if err1 != nil || err2 != nil || i < 1 || j > 7 || i > j {
			return nil, fmt.Errorf("cannot read the window days %q (1 Monday … 7 Sunday)", s)
		}
		for d := i; d <= j; d++ {
			if !slices.Contains(dias, d) {
				dias = append(dias, d)
			}
		}
	}
	return dias, nil
}

// TextoVentanas es lo contrario de LeerVentanas (para mensajes y para el .env).
func TextoVentanas(vs []Ventana) string {
	partes := make([]string, 0, len(vs))
	for _, v := range vs {
		ds := make([]string, 0, len(v.Dias))
		for _, d := range v.Dias {
			ds = append(ds, strconv.Itoa(d))
		}
		p := strings.Join(ds, ",") + " " + v.Desde + "-" + v.Hasta
		if v.Zona != "" {
			p += " " + v.Zona
		}
		partes = append(partes, p)
	}
	return strings.Join(partes, "; ")
}

// siguienteApertura: el primer minuto, desde t, en que todos los grupos están abiertos a la
// vez. Se busca hasta 8 días: si no hay ninguno (ventanas que no se cruzan), cero.
func siguienteApertura(grupos [][]Ventana, t time.Time) time.Time {
	m := t.Truncate(time.Minute)
	for i := 0; i <= 8*24*60; i++ {
		c := m.Add(time.Duration(i) * time.Minute)
		if c.Before(t) {
			continue
		}
		todos := true
		for _, g := range grupos {
			if !grupoAbierto(g, c) {
				todos = false
				break
			}
		}
		if todos {
			return c
		}
	}
	return time.Time{}
}
