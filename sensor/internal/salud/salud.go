// Package salud mide la máquina del sensor y el estado de sus trampas para la
// pestaña «Health» de la consola y sus avisos (docs/diseno/salud.md).
//
// Solo números y estados: ni nombres de procesos, ni rutas, ni usuarios. Lo de
// la máquina sale de /proc y de statfs, que dentro del contenedor del sensor
// ven la máquina entera (sin lxcfs). Fuera de Linux no se mide la máquina.
package salud

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"
	"time"
)

// Version del formato de la muestra: la consola descarta lo que no conoce.
const Version = 1

// Muestra es lo que el sensor manda a la consola cada minuto.
type Muestra struct {
	V      int    `json:"v"`
	Cuando string `json:"cuando"`
	// Uso de CPU de la máquina en %, desde la muestra anterior. Sin muestra
	// anterior (la primera tras arrancar) no va.
	CPU *float64 `json:"cpu,omitempty"`
	// Carga media de un minuto y número de procesadores que ve el sensor.
	Carga1 *float64 `json:"carga1,omitempty"`
	CPUs   int      `json:"cpus,omitempty"`
	// Bytes. Disponible es MemAvailable: lo que se puede usar sin tirar de swap.
	Memoria *Capacidad `json:"memoria,omitempty"`
	// El disco donde el sensor guarda sus datos (cola, registros de las trampas
	// sin disco propio): el mismo sistema de ficheros que el de Docker en un
	// nodo normal. Libre: lo que puede usar cualquiera, sin la reserva de root.
	Disco   *Capacidad `json:"disco,omitempty"`
	Trampas []Trampa   `json:"trampas"`
	// La cola de salida hacia la consola (la tubería): lo que falta por
	// entregar y desde cuándo. Cuando lo trae, la consola compara además
	// Cuando con su reloj.
	Cola *Cola `json:"cola,omitempty"`
}

// Cola: bytes por entregar, su tope, segundos que lleva sin quedar al día
// (0 si lo está) y si está descartando eventos porque no caben.
type Cola struct {
	Pendiente   int64 `json:"pendiente"`
	Tope        int64 `json:"tope"`
	SinEntregar int64 `json:"sinEntregar"`
	Descartando bool  `json:"descartando"`
}

// Capacidad: total y lo que queda, en bytes.
type Capacidad struct {
	Total int64 `json:"total"`
	Libre int64 `json:"libre"`
}

// Trampa: cómo están los contenedores de una trampa (la suya y sus
// acompañantes). EnMarcha solo si todos corren; Reinicios es la suma de los
// que cuenta el motor desde que se creó cada uno.
type Trampa struct {
	ID        string `json:"id"`
	EnMarcha  bool   `json:"enMarcha"`
	Estado    string `json:"estado"`
	Reinicios int    `json:"reinicios"`
	// Desde cuándo corre el contenedor principal (RFC 3339), si corre.
	Desde string `json:"desde,omitempty"`
}

// TiemposCPU: los contadores de la línea «cpu» de /proc/stat.
type TiemposCPU struct {
	Ocupado, Total uint64
}

// LeerStat saca los tiempos de la línea «cpu» de /proc/stat. Ocupado es todo
// menos idle e iowait.
func LeerStat(b []byte) (TiemposCPU, bool) {
	s := bufio.NewScanner(bytes.NewReader(b))
	for s.Scan() {
		campos := strings.Fields(s.Text())
		if len(campos) < 5 || campos[0] != "cpu" {
			continue
		}
		var t TiemposCPU
		for i, c := range campos[1:] {
			// guest y guest_nice ya cuentan en user y nice.
			if i >= 8 {
				break
			}
			n, err := strconv.ParseUint(c, 10, 64)
			if err != nil {
				return TiemposCPU{}, false
			}
			t.Total += n
			if i != 3 && i != 4 { // idle, iowait
				t.Ocupado += n
			}
		}
		return t, t.Total > 0
	}
	return TiemposCPU{}, false
}

// UsoCPU: el % de CPU entre dos lecturas, o false si no se puede calcular
// (contadores que vuelven atrás tras un reinicio, o sin tiempo entre medias).
func UsoCPU(antes, ahora TiemposCPU) (float64, bool) {
	if ahora.Total <= antes.Total || ahora.Ocupado < antes.Ocupado {
		return 0, false
	}
	u := float64(ahora.Ocupado-antes.Ocupado) / float64(ahora.Total-antes.Total) * 100
	if u > 100 {
		u = 100
	}
	return redondear(u), true
}

// LeerMeminfo: MemTotal y MemAvailable de /proc/meminfo, en bytes.
func LeerMeminfo(b []byte) (*Capacidad, bool) {
	var total, disponible int64 = -1, -1
	s := bufio.NewScanner(bytes.NewReader(b))
	for s.Scan() {
		campos := strings.Fields(s.Text())
		if len(campos) < 2 {
			continue
		}
		n, err := strconv.ParseInt(campos[1], 10, 64)
		if err != nil || n < 0 {
			continue
		}
		switch campos[0] {
		case "MemTotal:":
			total = n * 1024
		case "MemAvailable:":
			disponible = n * 1024
		}
	}
	if total <= 0 || disponible < 0 {
		return nil, false
	}
	if disponible > total {
		disponible = total
	}
	return &Capacidad{Total: total, Libre: disponible}, true
}

// LeerCarga: la carga media de un minuto de /proc/loadavg.
func LeerCarga(b []byte) (float64, bool) {
	campos := strings.Fields(string(b))
	if len(campos) == 0 {
		return 0, false
	}
	n, err := strconv.ParseFloat(campos[0], 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return redondear(n), true
}

// ContarCPUs: los procesadores de /proc/stat (líneas cpu0, cpu1…).
func ContarCPUs(b []byte) int {
	n := 0
	s := bufio.NewScanner(bytes.NewReader(b))
	for s.Scan() {
		l := s.Text()
		if strings.HasPrefix(l, "cpu") && len(l) > 3 && l[3] >= '0' && l[3] <= '9' {
			n++
		}
	}
	return n
}

// Contenedor: lo que hace falta de un contenedor para el estado de su trampa.
type Contenedor struct {
	Trampa    string
	Principal bool
	Estado    string // running, restarting, exited, dead, created, paused
	Reinicios int
	Desde     time.Time
	Saludable string // healthy, unhealthy, starting o vacío si no tiene comprobación
}

// Agrupar junta los contenedores por trampa, en orden de id.
func Agrupar(cs []Contenedor) []Trampa {
	por := map[string]*Trampa{}
	var orden []string
	for _, c := range cs {
		if c.Trampa == "" {
			continue
		}
		t, ok := por[c.Trampa]
		if !ok {
			t = &Trampa{ID: c.Trampa, EnMarcha: true, Estado: "running"}
			por[c.Trampa] = t
			orden = append(orden, c.Trampa)
		}
		t.Reinicios += c.Reinicios
		estado := c.Estado
		if estado == "running" && c.Saludable == "unhealthy" {
			estado = "unhealthy"
		}
		if estado != "running" {
			t.EnMarcha = false
			// El peor de sus contenedores.
			if peor(estado) > peor(t.Estado) {
				t.Estado = estado
			}
		}
		if c.Principal && c.Estado == "running" && !c.Desde.IsZero() {
			t.Desde = c.Desde.UTC().Format(time.RFC3339)
		}
	}
	ordenar(orden)
	r := make([]Trampa, 0, len(orden))
	for _, id := range orden {
		r = append(r, *por[id])
	}
	return r
}

func peor(estado string) int {
	switch estado {
	case "running":
		return 0
	case "created", "paused":
		return 1
	case "unhealthy":
		return 2
	case "restarting":
		return 3
	default: // exited, dead, lo que no se conoce
		return 4
	}
}

func ordenar(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func redondear(f float64) float64 {
	return float64(int64(f*10+0.5)) / 10
}
