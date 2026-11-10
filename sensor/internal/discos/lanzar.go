package discos

// Lanzar el auxiliar desde el sensor, por la API de Docker, y leer lo que dice.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// VersionResultado marca la línea del auxiliar con su resultado: si no está, la
// imagen es de un actualizador anterior, que no sabe de discos.
const VersionResultado = 1

// LineaResultado es lo que imprime el auxiliar al acabar, en una línea.
type LineaResultado struct {
	V int `json:"v"`
	Resultado
}

// esperaAuxiliar: lo que puede tardar, con lo que tenga que copiar al disco nuevo.
const esperaAuxiliar = 10 * time.Minute

// Lanzar corre el auxiliar con la imagen del actualizador y devuelve su resultado.
// Un error es algo pasajero (la imagen no baja, Docker no contesta): se reintenta
// más tarde. Lo que dice algo de la máquina va en el Resultado.
//
// Es privilegiado porque montar un fichero lo es: no da nada nuevo, el sensor ya
// tiene el socket de Docker, que equivale a root en la máquina. Sin red, con la
// raíz de solo lectura y solo con la carpeta del sensor (rshared, para que lo que
// monte llegue a la máquina), /dev (los dispositivos loop que se crean al montar)
// y, de solo lectura, los volúmenes de antes que pasan al disco.
func Lanzar(ctx context.Context, d *docker.Cliente, imagen, nombre string, p Pedido) (Resultado, error) {
	if i, err := d.Inspeccionar(ctx, nombre); err == nil {
		if st, _ := i["State"].(map[string]any); st["Running"] == true {
			return Resultado{}, errors.New("another disk helper is still running")
		}
	}
	if err := d.Borrar(ctx, nombre); err != nil && !docker.NoExiste(err) {
		return Resultado{}, fmt.Errorf("previous disk helper: %w", err)
	}
	if err := d.AsegurarImagen(ctx, imagen); err != nil {
		return Resultado{}, fmt.Errorf("updater image: %w", err)
	}
	b, _ := json.Marshal(p)
	montajes := []map[string]any{
		{"Type": "bind", "Source": p.Datos, "Target": p.Datos, "BindOptions": map[string]any{"Propagation": "rshared"}},
		{"Type": "bind", "Source": "/dev", "Target": "/dev"},
	}
	for _, m := range p.Montar {
		for _, i := range m.Viejos {
			if v := m.Volumenes[i]; v != "" {
				montajes = append(montajes, map[string]any{"Type": "volume", "Source": v, "Target": ViejoEn(m.ID, i), "ReadOnly": true})
			}
		}
	}
	id, err := d.Crear(ctx, nombre, map[string]any{
		"Image":  imagen,
		"Cmd":    []string{"disco"},
		"Env":    []string{"DISCO_PEDIDO=" + base64.StdEncoding.EncodeToString(b)},
		"Labels": map[string]string{"sugardaddy.auxiliar": "disco"},
		"HostConfig": map[string]any{
			"Privileged":     true,
			"UsernsMode":     "host",
			"NetworkMode":    "none",
			"ReadonlyRootfs": true,
			"Mounts":         montajes,
			"Tmpfs":          map[string]string{"/tmp": "rw,nosuid,size=16m", "/run": "rw,nosuid,size=1m"},
			"RestartPolicy":  map[string]string{"Name": "no"},
			"LogConfig":      docker.RegistrosAcotados(),
		},
	})
	if err != nil {
		return deLaMaquina(err)
	}
	defer func() { _ = d.Borrar(context.WithoutCancel(ctx), id) }()
	if err := d.Arrancar(ctx, id); err != nil {
		return deLaMaquina(err)
	}
	espera, cancelar := context.WithTimeout(ctx, esperaAuxiliar)
	defer cancelar()
	codigo, err := d.Esperar(espera, id)
	if err != nil {
		return Resultado{}, fmt.Errorf("disk helper: %w", err)
	}
	salida, _ := d.Salida(ctx, id, 50)
	return LeerResultado(salida, codigo), nil
}

// deLaMaquina: Docker no deja crear o arrancar el auxiliar. Si es por la máquina
// (la carpeta del sensor no admite propagación, o no deja contenedores
// privilegiados), se dice con su código; si no, es pasajero.
func deLaMaquina(err error) (Resultado, error) {
	m := strings.ToLower(err.Error())
	switch {
	case strings.Contains(m, "shared mount") || strings.Contains(m, "not a shared"):
		return Resultado{Codigo: CodigoSinPropagacion, Detalle: err.Error()}, nil
	case strings.Contains(m, "privileged"):
		return Resultado{Codigo: CodigoSinPermiso, Detalle: err.Error()}, nil
	}
	return Resultado{}, fmt.Errorf("disk helper: %w", err)
}

// LeerResultado saca el resultado de la última línea marcada del auxiliar. Sin
// ella, la imagen no sabe de discos (sale con 2, como un actualizador sin token)
// o algo ha fallado antes de acabar.
func LeerResultado(salida string, codigo int) Resultado {
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	for i := len(lineas) - 1; i >= 0; i-- {
		var l LineaResultado
		if json.Unmarshal([]byte(strings.TrimSpace(lineas[i])), &l) == nil && l.V == VersionResultado {
			return l.Resultado
		}
	}
	if codigo == 2 {
		return Resultado{Codigo: CodigoSinAuxiliar, Detalle: "the updater image does not know the disk helper"}
	}
	cola := strings.TrimSpace(salida)
	if len(cola) > 300 {
		cola = "…" + cola[len(cola)-300:]
	}
	return Resultado{Codigo: CodigoError, Detalle: fmt.Sprintf("the disk helper ended with code %d: %s", codigo, cola)}
}
