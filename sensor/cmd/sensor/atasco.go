package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
)

// Una línea de la cola que la consola no sabe procesar (C01 de la auditoría de
// 2026-11-14: un token con NUL que Postgres rechazaba) no puede dejar al sensor
// reintentando el mismo lote para siempre: lo de detrás no llegaría nunca. Si la
// consola falla al procesar una entrega (consola.ErrFalloConsola), el lote se
// parte a la mitad hasta dejar sola la línea que falla. Si esa línea, sola,
// sigue fallando varias veces mientras la consola atiende lo demás (ha dado un
// plan después del primer fallo), se aparta: se guarda en apartadas.jsonl, la
// entrega sigue con la siguiente y queda el hecho entrega.apartadas. La consola
// ve además la cadena rota en ese punto (rupturas), que sale en sus sensores.
// Con la consola caída de verdad no da planes, así que no se aparta nada.

const (
	// Fallos seguidos de la línea sola antes de apartarla.
	intentosLinea = 5
	// Tope del fichero de apartadas: pasado, se cuentan pero no se guardan.
	maxApartadas = 1 << 20
	// Código estable del aviso y del hecho.
	codigoLineaApartada = "entrega.linea-apartada"
)

type atasco struct {
	activo bool
	// Lo entregado cuando la consola empezó a fallar con esta cabeza.
	entregado int64
	// Fallos seguidos con la línea sola en el lote, y el primero.
	fallos int
	desde  time.Time
}

// atascada: la consola ha fallado al procesar estas líneas.
func (s *sensor) atascada(lineas [][]byte, err error) {
	s.consolaRecoge = false
	s.pausa = time.Now().Add(5 * time.Second)
	a := &s.atasco
	if !a.activo || a.entregado != s.estado.Entregado {
		*a = atasco{activo: true, entregado: s.estado.Entregado}
	}
	if len(lineas) > 1 {
		s.lote = len(lineas) / 2
		slog.Warn("the console fails to process this delivery; splitting it to find the line it cannot process",
			"lineas", s.lote, "err", err)
		return
	}
	s.lote = 1
	a.fallos++
	if a.fallos == 1 {
		a.desde = time.Now()
	}
	if a.fallos < intentosLinea || s.ultimoPlan.Load() <= a.desde.Unix() {
		slog.Warn("the console fails to process the line at the head of the queue; retrying",
			"fallos", a.fallos, "err", err)
		return
	}
	s.apartar(lineas[0], err)
}

// loteTrasEntrega: el tope de la siguiente entrega tras una que ha salido bien.
// Mientras se aísla una línea crece poco a poco, para no volver de golpe a un
// lote que la incluya entera.
func (s *sensor) loteTrasEntrega() int {
	if !s.atasco.activo {
		return porEntrega
	}
	n := min(max(s.lote, 1)*2, porEntrega)
	if n == porEntrega {
		s.atasco = atasco{}
	}
	return n
}

// apartar saca de la entrega la línea que la consola no sabe procesar.
func (s *sensor) apartar(l []byte, err error) {
	ruta := filepath.Join(s.opc.Datos, "apartadas.jsonl")
	guardada := false
	if fi, e := os.Stat(ruta); e != nil || fi.Size()+int64(len(l))+1 <= maxApartadas {
		if f, e := os.OpenFile(ruta, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); e == nil {
			_, e = f.Write(append(append([]byte(nil), l...), '\n'))
			guardada = f.Close() == nil && e == nil
		}
	}
	s.estado.Entregado += int64(len(l)) + 1
	s.estado.Apartadas++
	s.estado.UltimaApartada = time.Now().UTC()
	s.atasco = atasco{}
	s.lote = porEntrega
	s.pausa = time.Time{}
	s.guardar()
	slog.Error("the console cannot process a line of the outgoing queue; it is set aside so the rest is delivered",
		"codigo", codigoLineaApartada, "hash", evento.Hash(l), "guardadaEn", map[bool]string{true: ruta}[guardada], "err", err)
}

// hechoApartadas: el hecho entrega.apartadas, si alguna vez se apartó una línea.
func (s *sensor) hechoApartadas() map[string]any {
	if s.estado.Apartadas == 0 {
		return nil
	}
	return map[string]any{"valor": s.estado.Apartadas, "motivo": codigoLineaApartada}
}
