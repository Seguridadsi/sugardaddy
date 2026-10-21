// Package evento es el lado Go del contrato del evento normalizado.
// El esquema que manda está en paquetes/contrato/src/esquemas/evento.schema.json;
// este struct lo sigue campo a campo.
package evento

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// Genesis es el hashAnterior del primer evento de un sensor.
const Genesis = "0000000000000000000000000000000000000000000000000000000000000000"

type Trampa struct {
	ID     string `json:"id"`
	Modulo string `json:"modulo"`
	Tipo   string `json:"tipo"`
}

// Origen lo escribe el atacante: son datos hostiles. Salvo Oculta, que la
// pone el sensor.
type Origen struct {
	IP      string `json:"ip,omitempty"`
	Puerto  int    `json:"puerto,omitempty"`
	Usuario string `json:"usuario,omitempty"`
	Equipo  string `json:"equipo,omitempty"`
	// Oculta: la IP es la del propio motor de contenedores (su pasarela o su
	// proxy), no la del atacante. Solo va si la consola lo admite (ver
	// plan.OrigenOculta).
	Oculta bool `json:"oculta,omitempty"`
}

type Evento struct {
	Version             int            `json:"version"`
	ID                  string         `json:"id"`
	Cuando              string         `json:"cuando"`
	Trampa              Trampa         `json:"trampa"`
	Sensor              string         `json:"sensor"`
	Origen              Origen         `json:"origen"`
	Accion              string         `json:"accion"`
	Severidad           string         `json:"severidad"`
	ConexionEstablecida bool           `json:"conexionEstablecida"`
	Detalle             map[string]any `json:"detalle,omitempty"`
	Crudo               string         `json:"crudo,omitempty"`
	HashAnterior        string         `json:"hashAnterior"`
	// Nativa: el valor nativo del campo de acción (p. ej. cowrie.login.success).
	// No viaja: solo lo usa el sensor para repartir sus topes.
	Nativa string `json:"-"`
}

// Hash es el sha256 de los bytes exactos de una línea. No se canonicaliza
// nada: el nodo guarda la línea tal como la emitió el sensor y hashea esos bytes.
func Hash(linea []byte) string {
	h := sha256.Sum256(linea)
	return hex.EncodeToString(h[:])
}

// Cadena encadena los eventos de un sensor: cada uno lleva el hash de la
// línea anterior.
type Cadena struct {
	anterior string
}

func NuevaCadena(ultimo string) *Cadena {
	if ultimo == "" {
		ultimo = Genesis
	}
	return &Cadena{anterior: ultimo}
}

// Ultimo es el hash de la última línea emitida: lo que hay que guardar para
// seguir la cadena tras un reinicio.
func (c *Cadena) Ultimo() string { return c.anterior }

// Emitir rellena hashAnterior, serializa el evento a una línea y avanza la
// cadena. Sin escapado HTML: lo que se hashea es lo que se envía, sin más.
func (c *Cadena) Emitir(e Evento) ([]byte, error) {
	e.HashAnterior = c.anterior
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(e); err != nil {
		return nil, err
	}
	linea := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	c.anterior = Hash(linea)
	return linea, nil
}

// Verificar devuelve el índice de la primera línea que rompe la cadena, o -1
// si está intacta.
func Verificar(lineas [][]byte) int {
	anterior := Genesis
	for i, l := range lineas {
		var e struct {
			HashAnterior string `json:"hashAnterior"`
		}
		if json.Unmarshal(l, &e) != nil || e.HashAnterior != anterior {
			return i
		}
		anterior = Hash(l)
	}
	return -1
}
