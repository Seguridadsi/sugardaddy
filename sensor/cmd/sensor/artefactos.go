package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/consola"
	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

/*
 * Captura de artefactos: cuando la trampa registra que el atacante descargó o
 * subió un fichero, el sensor saca su COPIA del contenedor y la sube a la
 * consola, que la guarda de forma inerte. SOLO si el nodo activó la captura
 * (el plan anuncia "artefactos"; opt-in por defecto NO). Sin eso, aquí no se
 * toca nada: ni se saca el binario del contenedor ni se sube.
 *
 * Es un mejor-esfuerzo, en memoria: el metadato de cada copia pendiente se
 * guarda aquí (no el binario), y al subirla se saca del contenedor, se
 * comprueba el sha256 y se entrega. Si el sensor se reinicia, lo pendiente se
 * pierde y queda el metadato+hash del evento (como cuando la captura está
 * apagada). El binario vive en el /tmp del contenedor (tmpfs) o en su volumen
 * aislado, que el anfitrión no ve: se lee por la API de archivo de Docker.
 * Ver docs/diseno/captura-artefactos.md.
 */

const (
	// Copias pendientes de subir a la vez: acota la memoria (el metadato es
	// pequeño, pero no se deja crecer sin fin si la consola no las recoge).
	maxArtefactosPendientes = 32
	// El binario no se tiene nunca en memoria más de lo que dura una subida; el
	// tope por fichero es el mismo que acepta la consola (TOPE_ARTEFACTO).
	topeArtefacto = 64 << 20
	// Espera entre barridos de la cola de copias pendientes.
	cadaArtefacto = 2 * time.Second
	// Reintento con espera creciente (el evento tarda en llegar a la consola;
	// el contenedor puede estar rehaciéndose). Tras tantos intentos se deja.
	artefactoBase        = 3 * time.Second
	artefactoTope        = 2 * time.Minute
	artefactoMaxIntentos = 8
)

// artefactoPendiente es una copia por subir: solo metadatos. El binario se saca
// del contenedor al intentarlo, no se guarda aquí.
type artefactoPendiente struct {
	sensor, evento, trampa, tipo, sha256, nombre, outfile string
	intentos                                              int
	proxima                                               time.Time
}

var reSha256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func esSha256(s string) bool { return reSha256.MatchString(s) }

// encolarArtefacto apunta, si procede, la copia de un fichero capturado para
// subirla luego. Barato: solo guarda el metadato (sacar el binario del
// contenedor es cosa de subirArtefactos). Lo llama leer() con un evento que SÍ
// se entrega (no un resumen ni uno recortado por los topes): la consola exige
// que el evento exista para aceptar su copia.
func (s *sensor) encolarArtefacto(e evento.Evento) {
	if !s.plan.Acepta(plan.Artefactos) {
		return
	}
	if e.Accion != "descarga" && e.Accion != "escritura" {
		return
	}
	sha, _ := e.Detalle["shasum"].(string)
	sha = strings.ToLower(strings.TrimSpace(sha))
	outfile, _ := e.Detalle["outfile"].(string)
	if !esSha256(sha) || outfile == "" {
		return
	}
	nombre, _ := e.Detalle["filename"].(string)
	s.muArtefactos.Lock()
	defer s.muArtefactos.Unlock()
	for _, p := range s.artefactos {
		if p.evento == e.ID && p.sha256 == sha {
			return // ya apuntado
		}
	}
	if len(s.artefactos) >= maxArtefactosPendientes {
		slog.Warn("captura: demasiadas copias pendientes de subir; esta se omite",
			"trampa", e.Trampa.ID, "sha256", sha)
		return
	}
	s.artefactos = append(s.artefactos, artefactoPendiente{
		sensor: e.Sensor, evento: e.ID, trampa: e.Trampa.ID, tipo: e.Accion,
		sha256: sha, nombre: nombre, outfile: outfile,
		proxima: time.Now().Add(artefactoBase),
	})
}

// subirArtefactos corre en su propia goroutine (no frena la lectura ni la
// entrega de eventos) y sube las copias pendientes cuyo momento ha llegado.
func (s *sensor) subirArtefactos(ctx context.Context) {
	reloj := time.NewTicker(cadaArtefacto)
	defer reloj.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-reloj.C:
		}
		for _, p := range s.artefactosVencidos() {
			s.intentarArtefacto(ctx, p)
		}
	}
}

func (s *sensor) artefactosVencidos() []artefactoPendiente {
	s.muArtefactos.Lock()
	defer s.muArtefactos.Unlock()
	ahora := time.Now()
	var v []artefactoPendiente
	for _, p := range s.artefactos {
		if !ahora.Before(p.proxima) {
			v = append(v, p)
		}
	}
	return v
}

// errArtefactoIncoherente: lo que se sacó del contenedor no cuadra con el
// sha256 que la trampa apuntó en el evento. No se sube (no se fía) y se
// descarta: reintentarlo daría lo mismo.
var errArtefactoIncoherente = errors.New("el contenido del contenedor no cuadra con el sha256 del evento")

func (s *sensor) intentarArtefacto(ctx context.Context, p artefactoPendiente) {
	err := s.entregarArtefacto(ctx, p)
	switch {
	case err == nil:
		s.quitarArtefacto(p.evento, p.sha256)
		slog.Info("captura: copia subida a la consola", "trampa", p.trampa, "tipo", p.tipo, "sha256", p.sha256)
	case errors.Is(err, consola.ErrArtefactoRechazado), errors.Is(err, errArtefactoIncoherente):
		s.quitarArtefacto(p.evento, p.sha256)
		slog.Warn("captura: la copia no se sube; se descarta", "trampa", p.trampa, "sha256", p.sha256, "err", err)
	default:
		// Transitorio: el evento aún no llegó a la consola, el contenedor no
		// está en marcha o la red falló. Se reintenta con espera creciente.
		if !s.reintentarArtefacto(p.evento, p.sha256) {
			slog.Warn("captura: se deja de intentar subir la copia", "trampa", p.trampa, "sha256", p.sha256, "err", err)
		}
	}
}

// entregarArtefacto saca el binario del contenedor de su trampa, comprueba el
// sha256 y lo sube a la consola.
func (s *sensor) entregarArtefacto(ctx context.Context, p artefactoPendiente) error {
	ctx, cancelar := context.WithTimeout(ctx, time.Minute)
	defer cancelar()
	id, err := despliegue.ContenedorDeTrampa(ctx, s.docker, p.sensor, p.trampa)
	if err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("la trampa %s no tiene contenedor en marcha", p.trampa)
	}
	b, err := s.docker.LeerDeContenedor(ctx, id, p.outfile, topeArtefacto)
	if err != nil {
		return err
	}
	if evento.Hash(b) != p.sha256 {
		return errArtefactoIncoherente
	}
	return s.consola.SubirArtefacto(ctx, p.evento, p.tipo, p.sha256, p.nombre, b)
}

func (s *sensor) quitarArtefacto(ev, sha string) {
	s.muArtefactos.Lock()
	defer s.muArtefactos.Unlock()
	s.artefactos = slices.DeleteFunc(s.artefactos, func(p artefactoPendiente) bool {
		return p.evento == ev && p.sha256 == sha
	})
}

// reintentarArtefacto apunta un intento fallido y programa el siguiente con
// espera creciente. Devuelve false (y quita la copia) si ya se agotaron.
func (s *sensor) reintentarArtefacto(ev, sha string) bool {
	s.muArtefactos.Lock()
	defer s.muArtefactos.Unlock()
	for i := range s.artefactos {
		if s.artefactos[i].evento != ev || s.artefactos[i].sha256 != sha {
			continue
		}
		s.artefactos[i].intentos++
		if s.artefactos[i].intentos >= artefactoMaxIntentos {
			s.artefactos = slices.Delete(s.artefactos, i, i+1)
			return false
		}
		espera := artefactoBase << min(s.artefactos[i].intentos, 6)
		if espera > artefactoTope {
			espera = artefactoTope
		}
		s.artefactos[i].proxima = time.Now().Add(espera)
		return true
	}
	return false
}
