package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
)

// Un evento que ya entró en la cola de salida no vuelve a entrar nunca, aunque el
// sensor vuelva a leer su línea del registro de la trampa.
//
// El id de un evento sale de su sensor, su trampa y su línea nativa (adaptador.idDe):
// leer otra vez la misma línea da el mismo id. Pero esa segunda vez la línea se
// encadena en otro sitio (otro hashAnterior), así que sus bytes ya no son los de la
// primera: la consola no la puede dar por un reenvío (eso solo lo hace con los mismos
// bytes) y la aparta a la cuarentena como «repeats an event already received». El
// sensor queda degradado por algo que no es un ataque ni una avería.
//
// Volver a leer lo ya leído pasa en más sitios de los que parece: un estado que se
// quedó por detrás de la cola (retomarCadena), un estado perdido (la cadena sigue
// desde lo que la consola aceptó, y los registros se leen desde el principio), un
// registro que el seguidor ya no reconoce (otro inodo y otro principio: lo lee
// entero) o una trampa que cambia de carpeta de registros entre su disco y la del
// anfitrión. Cada uno se puede arreglar en su sitio, pero la garantía tiene que estar
// en un solo punto: aquí, antes de encadenar.
//
// Se guardan los ids de lo encolado (un resumen de 16 bytes de cada uno), los últimos
// maxEmitidos, en emitidos.bin: se añaden detrás y, cuando el fichero dobla el tope,
// se reescribe con los que quedan. Al arrancar se suman los de la cola de salida: si
// el sensor se cortó entre escribir la cola y apuntar sus ids, lo que está en la cola
// también cuenta.

const (
	// Unos días de un sensor de internet muy atacado: más que lo que un registro activo
	// y sus rotados de una semana pueden devolver de golpe en una máquina normal.
	maxEmitidos     = 1 << 19
	ficheroEmitidos = "emitidos.bin"
)

type clave [16]byte

func claveDe(id string) clave {
	h := sha256.Sum256([]byte(id))
	var c clave
	copy(c[:], h[:16])
	return c
}

type emitidos struct {
	ruta   string
	tope   int
	vistos map[clave]struct{}
	// Anillo con el orden de llegada: al llenarse, sale el más antiguo.
	orden  []clave
	inicio int
	// Registros que hay en el fichero (para saber cuándo reescribirlo).
	enFichero int
}

func nuevosEmitidos(ruta string, tope int) *emitidos {
	return &emitidos{ruta: ruta, tope: tope, vistos: map[clave]struct{}{}}
}

// cargarEmitidos lee lo apuntado y suma los ids de la cola de salida. Lo que no se
// pueda leer se pierde (y lo vuelto a leer iría a la cuarentena), pero el sensor sigue.
func cargarEmitidos(datos, salida string) *emitidos {
	x := nuevosEmitidos(filepath.Join(datos, ficheroEmitidos), maxEmitidos)
	b, err := os.ReadFile(x.ruta)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("cannot read the ids of the events already queued; a log read again may repeat them", "err", err)
	}
	// Un corte a mitad de un registro deja la cola del fichero a medias: se quita, o
	// lo que se añada detrás quedaría descolocado.
	n := len(b) / len(clave{})
	if len(b)%len(clave{}) != 0 {
		if err := os.Truncate(x.ruta, int64(n*len(clave{}))); err != nil {
			slog.Warn("cannot trim the ids of the events already queued", "err", err)
		}
	}
	x.enFichero = n
	desde := max(0, n-x.tope)
	for i := desde; i < n; i++ {
		var c clave
		copy(c[:], b[i*len(c):])
		x.anadir(c)
	}
	if f, err := os.Open(salida); err == nil {
		defer f.Close()
		lector := bufio.NewReaderSize(f, 64<<10)
		for {
			linea, err := lector.ReadBytes('\n')
			if len(bytes.TrimSpace(linea)) > 0 {
				var e struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(linea, &e) == nil && e.ID != "" {
					x.anadir(claveDe(e.ID))
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					slog.Warn("cannot read the outgoing queue for the ids already queued", "err", err)
				}
				break
			}
		}
	}
	return x
}

func (x *emitidos) visto(id string) bool {
	_, ok := x.vistos[claveDe(id)]
	return ok
}

func (x *emitidos) anadir(c clave) bool {
	if _, ok := x.vistos[c]; ok {
		return false
	}
	if len(x.orden) < x.tope {
		x.orden = append(x.orden, c)
	} else {
		delete(x.vistos, x.orden[x.inicio])
		x.orden[x.inicio] = c
		x.inicio = (x.inicio + 1) % x.tope
	}
	x.vistos[c] = struct{}{}
	return true
}

// apuntar suma los ids de lo que acaba de entrar en la cola y los deja en el disco.
// En memoria quedan aunque falle el disco: mientras el sensor siga en marcha, no se
// repiten.
func (x *emitidos) apuntar(ids []string) error {
	var nuevas []byte
	for _, id := range ids {
		c := claveDe(id)
		if x.anadir(c) {
			nuevas = append(nuevas, c[:]...)
		}
	}
	if len(nuevas) == 0 {
		return nil
	}
	if x.enFichero+len(nuevas)/len(clave{}) > 2*x.tope {
		return x.reescribir()
	}
	f, err := os.OpenFile(x.ruta, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(nuevas)
	if err == nil {
		err = f.Sync()
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err == nil {
		x.enFichero += len(nuevas) / len(clave{})
	}
	return err
}

// reescribir deja en el fichero solo los que quedan, en orden, con un renombrado:
// un corte deja el de antes o el nuevo, nunca medio.
func (x *emitidos) reescribir() error {
	b := make([]byte, 0, len(x.orden)*len(clave{}))
	for i := range x.orden {
		c := x.orden[(x.inicio+i)%len(x.orden)]
		b = append(b, c[:]...)
	}
	tmp := x.ruta + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = os.Rename(tmp, x.ruta)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	x.enFichero = len(x.orden)
	return nil
}

// losEmitidos: los de este sensor, cargados la primera vez que hacen falta.
func (s *sensor) losEmitidos() *emitidos {
	if s.emitidos == nil {
		s.emitidos = cargarEmitidos(s.opc.Datos, s.salida)
	}
	return s.emitidos
}
