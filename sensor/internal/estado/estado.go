// Package estado guarda lo poco que el sensor tiene que recordar entre
// arranques: por dónde va leyendo cada registro, el último hash de su cadena
// y hasta dónde ha entregado. Si se pierde, la cadena se rompe y la consola
// lo ve: es preferible a que el sensor invente una continuidad.
package estado

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type Estado struct {
	// Offsets de lectura de cada registro nativo, por trampa.
	Leido map[string]int64 `json:"leido"`
	// Inodo del registro que se estaba leyendo, por trampa: así se nota que el
	// honeypot lo ha rotado y se acaba de leer el anterior antes de seguir.
	// Puede ser el de un rotado que aún no se ha acabado.
	Inodos map[string]uint64 `json:"inodos,omitempty"`
	// Huella del principio de ese registro, por trampa: lo reconoce aunque
	// cambie de inodo (carpeta copiada o restaurada) o lo vacíen.
	Huellas map[string]string `json:"huellas,omitempty"`
	// Fecha de modificación (UnixNano) del registro cuando se leyó, por
	// trampa: si desaparece, los rotados posteriores son los que faltan.
	Modifs map[string]int64 `json:"modifs,omitempty"`
	// Eventos omitidos por los topes del sensor que aún no se han resumido
	// (ver ritmo.go en cmd/sensor): un reinicio no los pierde.
	Ritmo json.RawMessage `json:"ritmo,omitempty"`
	// Trampas paradas por el sensor porque sus registros pasaban de su cuota
	// y no se podía liberar lo ya leído, con el aviso para el cliente: siguen
	// paradas tras un reinicio hasta que su carpeta vuelve a caber.
	Paradas map[string]string `json:"paradas,omitempty"`
	// Eventos descartados con la cola de salida llena que aún no se han
	// resumido, por trampa (ver cola.go en cmd/sensor): un reinicio no los pierde.
	Descartados json.RawMessage `json:"descartados,omitempty"`
	// Hash de la última línea emitida a la cola de salida.
	UltimoHash string `json:"ultimoHash"`
	// Bytes de la cola de salida ya aceptados por la consola.
	Entregado int64 `json:"entregado"`
	// Hora del último evento con una IP de atacante de verdad y del último
	// con la IP del propio motor: deciden red.ipOrigenReal (ver motor.HechoOrigen).
	OrigenReal   time.Time `json:"origenReal,omitzero"`
	OrigenOculto time.Time `json:"origenOculto,omitzero"`
}

func Cargar(dir string) (*Estado, error) {
	e := &Estado{Leido: map[string]int64{}, Inodos: map[string]uint64{}, Huellas: map[string]string{}, Modifs: map[string]int64{}, Paradas: map[string]string{}}
	b, err := os.ReadFile(filepath.Join(dir, "estado.json"))
	if errors.Is(err, os.ErrNotExist) {
		return e, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, e); err != nil {
		return nil, err
	}
	if e.Leido == nil {
		e.Leido = map[string]int64{}
	}
	if e.Inodos == nil {
		e.Inodos = map[string]uint64{}
	}
	if e.Modifs == nil {
		e.Modifs = map[string]int64{}
	}
	if e.Huellas == nil {
		e.Huellas = map[string]string{}
	}
	if e.Paradas == nil {
		e.Paradas = map[string]string{}
	}
	return e, nil
}

// Guardar escribe en un temporal y lo renombra: un corte de luz deja el
// estado anterior o el nuevo, nunca medio fichero.
func (e *Estado) Guardar(dir string) error {
	b, err := json.MarshalIndent(e, "", "\t")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "estado.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "estado.json"))
}
