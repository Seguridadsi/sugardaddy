package actualizador

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Política de cambios del cliente (docs/diseno/politica-cambios.md, DORA B-16).
//
// La consola y el panel solo informan: quien decide si una versión firmada se instala ya
// es este actualizador, en la máquina del cliente. Así un panel comprometido no puede
// forzar una instalación inmediata en un nodo que pide aprobación o retardo.
//
// La política que se aplica es la más estricta de dos:
//
//   - el suelo local, en el .env del nodo (ACTUALIZACION_POLITICA y
//     ACTUALIZACION_RETARDO_HORAS). Lo pone el cliente al instalar o a mano, y una versión
//     firmada nunca cambia una variable que ya existe (completarEnv);
//   - la que el cliente eligió en su consola, que llega con la versión pendiente. El panel
//     no puede escribirla: el estado deseado no trae ajustes de la consola.
//
// El retardo se cuenta desde «publicada», que va dentro de lo firmado: el panel no puede
// adelantarlo. Una versión marcada «urgente» en lo firmado (un arreglo de seguridad) se salta
// el retardo, pero no la aprobación.

const (
	PoliticaAutomatica = "automatica"
	PoliticaManual     = "manual"
	// RetardoMaximoHoras: un retardo mayor (30 días) se toma como este, para que un valor
	// absurdo no deje el nodo sin actualizar para siempre.
	RetardoMaximoHoras = 720
)

// Politica es lo que decide cuándo se instala una versión.
type Politica struct {
	Modo         string `json:"modo"`
	RetardoHoras int    `json:"retardoHoras"`
}

// Aprobacion es la de una persona de la consola para una versión concreta.
type Aprobacion struct {
	Version string `json:"version"`
	Quien   string `json:"quien"`
	Cuando  string `json:"cuando"`
}

// PoliticaDelEntorno lee el suelo local. Lo que no se entiende cuenta como lo más estricto
// que se puede leer de ahí: un «manul» mal escrito no deja el nodo en automático.
func PoliticaDelEntorno(get func(string) string) Politica {
	p := Politica{Modo: PoliticaAutomatica}
	switch m := strings.ToLower(strings.TrimSpace(get("ACTUALIZACION_POLITICA"))); m {
	case "", PoliticaAutomatica:
	default:
		p.Modo = PoliticaManual
	}
	if h := strings.TrimSpace(get("ACTUALIZACION_RETARDO_HORAS")); h != "" {
		n, err := strconv.Atoi(h)
		if err != nil || n > RetardoMaximoHoras {
			n = RetardoMaximoHoras
		}
		if n > 0 {
			p.RetardoHoras = n
		}
	}
	return p
}

// MasEstricta combina dos políticas: manual si una lo es, y el retardo mayor.
func MasEstricta(a, b Politica) Politica {
	p := Politica{Modo: PoliticaAutomatica, RetardoHoras: max(a.RetardoHoras, b.RetardoHoras, 0)}
	if a.Modo == PoliticaManual || b.Modo == PoliticaManual {
		p.Modo = PoliticaManual
	}
	if p.RetardoHoras > RetardoMaximoHoras {
		p.RetardoHoras = RetardoMaximoHoras
	}
	return p
}

// Espera explica por qué una versión aún no se instala. Vacía: se puede instalar.
type Espera struct {
	Motivo string    // "aprobacion" o "retardo"
	Hasta  time.Time // con "retardo": desde cuándo se puede
}

func (e Espera) String() string {
	switch e.Motivo {
	case "aprobacion":
		return "waiting for approval in the console (manual update policy)"
	case "retardo":
		return fmt.Sprintf("waiting for the minimum delay of the update policy (until %s)", e.Hasta.UTC().Format(time.RFC3339))
	}
	return ""
}

// ComprobarPolitica dice si la versión r se puede instalar ahora con la política p y la
// aprobación a (o nil). exigirAprobacion es falso en un sensor remoto: allí la versión ya la
// aprobó (o no lo necesitaba) el nodo, que es quien se la ofrece.
func ComprobarPolitica(r Release, p Politica, a *Aprobacion, exigirAprobacion bool, ahora time.Time) Espera {
	if exigirAprobacion && p.Modo == PoliticaManual && (a == nil || a.Version != r.Version || strings.TrimSpace(a.Quien) == "") {
		return Espera{Motivo: "aprobacion"}
	}
	if p.RetardoHoras > 0 && !r.Urgente {
		pub, err := time.Parse(time.RFC3339, r.Publicada)
		if err != nil {
			// Sin una fecha firmada legible no hay desde dónde contar: no se instala.
			return Espera{Motivo: "retardo"}
		}
		if hasta := pub.Add(time.Duration(p.RetardoHoras) * time.Hour); ahora.Before(hasta) {
			return Espera{Motivo: "retardo", Hasta: hasta}
		}
	}
	return Espera{}
}
