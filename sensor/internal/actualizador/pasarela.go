package actualizador

// SEN-5: que una trampa tomada no llegue a los servicios de la máquina por la
// pasarela de su puente (cortafuegos.AplicarTrampas). El actualizador lanza el
// auxiliar «cortafuegos-trampas» al arrancar (también tras reiniciar la máquina, que
// vacía el cortafuegos) y lo repasa cada RepasoTrampas, en el nodo y en los sensores
// remotos.

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// RepasoTrampas: cada cuánto se vuelve a poner la regla aunque esté.
const RepasoTrampas = 10 * time.Minute

// NombreCortafuegosTrampas es el contenedor del auxiliar; su nombre hace de cerrojo.
const NombreCortafuegosTrampas = "sugardaddy-cortafuegos-trampas"

// PasarelaTrampas lleva la cuenta de cuándo se aplicó.
type PasarelaTrampas struct {
	Docker *docker.Cliente
	Local  string // la carpeta del nodo (o del sensor remoto) dentro del actualizador
	Log    func(string, ...any)
	// Lanzar corre el auxiliar. Por defecto, un contenedor; en las pruebas, un doble.
	Lanzar func(ctx context.Context, imagen string) cortafuegos.Resultado

	cuando     time.Time
	registrado string
}

// Vuelta aplica la regla si toca.
func (p *PasarelaTrampas) Vuelta(ctx context.Context) error {
	if !p.cuando.IsZero() && time.Since(p.cuando) < RepasoTrampas {
		return nil
	}
	// Quien no quiere que Sugardaddy toque su máquina (AISLAMIENTO_ANFITRION=no) pone él la regla.
	if env, _ := LeerEnv(filepath.Join(p.Local, ".env")); env["AISLAMIENTO_ANFITRION"] == "no" {
		p.cuando = time.Now()
		return nil
	}
	versiones, err := LeerEnv(filepath.Join(p.Local, "versiones.env"))
	imagen := versiones["ACTUALIZADOR_IMAGEN"]
	if err != nil || imagen == "" {
		return errors.New("versiones.env does not say which updater image to use for the decoy firewall helper")
	}
	lanzar := p.Lanzar
	if lanzar == nil {
		lanzar = p.lanzar
	}
	r := lanzar(ctx, imagen)
	p.cuando = time.Now()
	if p.Log != nil && r.Estado+r.Detalle != p.registrado {
		p.registrado = r.Estado + r.Detalle
		p.Log("decoy bridge firewall (SEN-5)", "estado", r.Estado, "detalle", r.Detalle)
	}
	if r.Estado != cortafuegos.Aplicada {
		return errors.New("decoy bridge firewall: " + r.Detalle)
	}
	return nil
}

func (p *PasarelaTrampas) lanzar(ctx context.Context, imagen string) cortafuegos.Resultado {
	codigo, salida, err := ejecutarUnInstante(ctx, p.Docker, NombreCortafuegosTrampas, ConfigCortafuegosTrampas(imagen), 2*time.Minute)
	if err != nil {
		return cortafuegos.Resultado{Estado: cortafuegos.ConError, Detalle: "decoy firewall helper: " + err.Error()}
	}
	return LeerResultadoCortafuegos(salida, codigo)
}

// ConfigCortafuegosTrampas es el auxiliar de SEN-5: como el del acceso a la consola,
// red del anfitrión, NET_ADMIN y NET_RAW, nada más.
func ConfigCortafuegosTrampas(imagen string) map[string]any {
	c := ConfigCortafuegos(imagen, cortafuegos.Pedido{})
	c["Cmd"] = []string{"cortafuegos-trampas"}
	c["Env"] = []string{}
	c["Labels"] = map[string]string{"sugardaddy.auxiliar": "cortafuegos-trampas"}
	return c
}
