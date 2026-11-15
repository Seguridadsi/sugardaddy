package discos

// El servicio de discos del anfitrión (docs/diseno/aislamiento-trampas.md §5).
//
// Antes, los discos los montaba un contenedor privilegiado con /dev del
// anfitrión. Ahora los monta una unidad systemd del anfitrión (sd-discos) con un
// único comando fijo. sd-motor, el único que la invoca, le deja la petición en
// una carpeta (el buzón) y la unidad .path la arranca; la unidad contesta en el
// mismo buzón. Nadie más escribe en él: está fuera de la carpeta del sensor y
// solo lo monta sd-motor.
//
// Lo que se pide se valida dos veces: en sd-motor y aquí, contra la carpeta del
// sensor fijada en la propia unidad (no la que diga la petición).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Ficheros del buzón.
const (
	FicheroPeticion  = "peticion.json"
	FicheroRespuesta = "respuesta.json"
	// FicheroInstalado: lo deja el instalador al poner la unidad. Sin él, la
	// máquina no tiene servicio de discos y se dice al momento (disco.sin-auxiliar).
	FicheroInstalado = "instalado"
)

// PeticionBuzon es lo que sd-motor deja en el buzón.
type PeticionBuzon struct {
	ID     string `json:"id"`
	Pedido Pedido `json:"pedido"`
}

// RespuestaBuzon es lo que contesta la unidad.
type RespuestaBuzon struct {
	ID        string    `json:"id"`
	Resultado Resultado `json:"resultado"`
}

// EsperaServicio: lo que puede tardar la unidad (con lo que tenga que formatear).
var EsperaServicio = esperaAuxiliar

// PedirAlServicio deja la petición en el buzón y espera la respuesta. Solo una a
// la vez: quien llama (sd-motor) lo serializa.
func PedirAlServicio(ctx context.Context, buzon string, p Pedido) (Resultado, error) {
	if _, err := os.Stat(filepath.Join(buzon, FicheroInstalado)); err != nil {
		return Resultado{Codigo: CodigoSinAuxiliar, Detalle: "the host disk service (sd-discos) is not installed on this machine"}, nil
	}
	// Ni los volúmenes de antes ni su contenido: el servicio no ve los volúmenes de
	// Docker. Lo que tenían (sesiones del atacante) se pierde al pasar al disco.
	for i := range p.Montar {
		p.Montar[i].Viejos, p.Montar[i].Volumenes = nil, nil
	}
	if err := p.Validar(); err != nil {
		return Resultado{Codigo: CodigoError, Detalle: err.Error()}, nil
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	pet := PeticionBuzon{ID: hex.EncodeToString(b[:]), Pedido: p}
	_ = os.Remove(filepath.Join(buzon, FicheroRespuesta))
	if err := escribirAtomico(filepath.Join(buzon, FicheroPeticion), pet); err != nil {
		return Resultado{}, fmt.Errorf("disk service mailbox: %w", err)
	}
	ctx, cancelar := context.WithTimeout(ctx, EsperaServicio)
	defer cancelar()
	for {
		var r RespuestaBuzon
		if b, err := os.ReadFile(filepath.Join(buzon, FicheroRespuesta)); err == nil && json.Unmarshal(b, &r) == nil && r.ID == pet.ID {
			_ = os.Remove(filepath.Join(buzon, FicheroRespuesta))
			return r.Resultado, nil
		}
		select {
		case <-ctx.Done():
			_ = os.Remove(filepath.Join(buzon, FicheroPeticion))
			return Resultado{}, errors.New("the host disk service (sd-discos) did not answer")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// AtenderBuzon es el comando fijo de la unidad: atiende la petición que haya en el
// buzón con la carpeta del sensor de la unidad, contesta y la borra.
func AtenderBuzon(ctx context.Context, buzon, datos string, a *Auxiliar) error {
	ruta := filepath.Join(buzon, FicheroPeticion)
	b, err := os.ReadFile(ruta)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	_ = os.Remove(ruta)
	var pet PeticionBuzon
	res := Resultado{}
	switch {
	case len(b) > 1<<20 || json.Unmarshal(b, &pet) != nil:
		res = Resultado{Codigo: CodigoError, Detalle: "the disk request is not readable"}
	case filepath.Clean(pet.Pedido.Datos) != filepath.Clean(datos):
		// La carpeta la fija la unidad: una petición no puede montar en otra parte.
		res = Resultado{Codigo: CodigoError, Detalle: "the disk request is for another folder"}
	default:
		for i := range pet.Pedido.Montar {
			pet.Pedido.Montar[i].Viejos = nil
		}
		res = a.Aplicar(ctx, pet.Pedido)
		if res.Codigo == CodigoSinAuxiliar {
			// Aquí no es la imagen del actualizador la que falta, es la máquina.
			res.Detalle = "the host lacks a tool for disks: " + res.Detalle
		}
	}
	return escribirAtomico(filepath.Join(buzon, FicheroRespuesta), RespuestaBuzon{ID: pet.ID, Resultado: res})
}

func escribirAtomico(ruta string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := ruta + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, ruta)
}

// MainServicio es el comando fijo de la unidad sd-discos.service:
// `sd-discos discos-anfitrion <buzón> <carpeta del sensor>`.
func MainServicio(args []string) int {
	if len(args) != 2 || !filepath.IsAbs(args[0]) || !filepath.IsAbs(args[1]) {
		fmt.Fprintln(os.Stderr, "usage: discos-anfitrion <mailbox> <sensor folder>")
		return 2
	}
	if err := AtenderBuzon(context.Background(), args[0], args[1], NuevoAuxiliar()); err != nil {
		fmt.Fprintln(os.Stderr, "sd-discos:", err)
		return 1
	}
	return 0
}
