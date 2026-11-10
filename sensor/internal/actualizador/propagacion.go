package actualizador

// La propagación de la carpeta del sensor (docs/diseno/discos-trampa.md): el
// sensor ve los discos de sus trampas, que monta su auxiliar después de que el
// sensor arranque, solo si su carpeta le llega con propagación desde la máquina
// (rslave). Los compose la piden con SENSOR_PROPAGACION, que se pone en .env solo
// si la máquina la admite: en una que no (un contenedor LXC con la raíz privada,
// por ejemplo), Docker no arrancaría el sensor con ella.

import (
	"context"
	"path/filepath"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// NombrePruebaPropagacion: el contenedor de la prueba; su nombre hace de cerrojo.
const NombrePruebaPropagacion = "sugardaddy-prueba-propagacion"

// PruebaPropagacion dice si Docker monta dir en un contenedor con propagación
// rslave. Lo prueba un contenedor de un instante con la imagen del sensor (su orden
// «version»), sin red, sin capacidades y con la carpeta de solo lectura.
func PruebaPropagacion(ctx context.Context, d *docker.Cliente, imagen, dir string) bool {
	_ = d.Borrar(ctx, NombrePruebaPropagacion)
	id, err := d.Crear(ctx, NombrePruebaPropagacion, map[string]any{
		"Image": imagen,
		"Cmd":   []string{"version"},
		"HostConfig": map[string]any{
			"NetworkMode":    "none",
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges"},
			"Mounts": []map[string]any{{
				"Type": "bind", "Source": dir, "Target": "/sd", "ReadOnly": true,
				"BindOptions": map[string]any{"Propagation": "rslave"},
			}},
			"LogConfig": docker.RegistrosAcotados(),
		},
	})
	if err != nil {
		return false
	}
	defer func() { _ = d.Borrar(context.WithoutCancel(ctx), id) }()
	if err := d.Arrancar(ctx, id); err != nil {
		return false
	}
	espera, cancelar := context.WithTimeout(ctx, time.Minute)
	defer cancelar()
	codigo, err := d.Esperar(espera, id)
	return err == nil && codigo == 0
}

// asegurarPropagacion deja SENSOR_PROPAGACION=rslave en .env si la máquina la
// admite y aún no está. Si la prueba no sale, no cambia nada: compose monta como
// siempre y el sensor sigue, con el vigilante de 10 s y el aviso disco.sin-propagacion.
func (a *Aplicacion) asegurarPropagacion(ctx context.Context) {
	env, err := LeerEnv(a.ruta(".env"))
	if err != nil || env["SENSOR_PROPAGACION"] == "rslave" || env["DATOS"] == "" {
		return
	}
	dir := env["DATOS"]
	if a.Modo == ModoNodo {
		dir = filepath.Join(dir, "sensor")
	}
	versiones, _ := LeerEnv(a.ruta("versiones.env"))
	imagen := versiones["SENSOR_IMAGEN"]
	if imagen == "" {
		return
	}
	if !PruebaPropagacion(ctx, a.Docker, imagen, dir) {
		a.Log("this machine does not allow mount propagation for the sensor folder: decoys keep the 10-second watch instead of their own disk")
		return
	}
	if err := fijarVariables(a.ruta(".env"), map[string]string{"SENSOR_PROPAGACION": "rslave"}); err != nil {
		a.Log("could not write SENSOR_PROPAGACION in .env", "err", err)
		return
	}
	a.Log("the sensor folder is mounted with propagation: each decoy gets its own disk")
}
