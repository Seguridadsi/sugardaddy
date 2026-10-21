package actualizador

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

const (
	// EtiquetaServicio marca qué servicio del nodo es cada contenedor.
	EtiquetaServicio = "sugardaddy.servicio"
	// EtiquetaSalud es la URL que tiene que responder 200 tras el cambio.
	EtiquetaSalud = "sugardaddy.salud"
)

// Paso es un servicio ya cambiado: lo necesario para deshacerlo.
type paso struct {
	servicio, nombre, anterior, nuevo string
}

type Aplicador struct {
	Docker *docker.Cliente
	// Cuánto se espera a que el servicio nuevo responda sano.
	EsperaSalud time.Duration
	Log         func(msg string, args ...any)
	// Solo, si no está vacío, limita los servicios que se tocan: un sensor en
	// otra máquina tiene sensor y actualizador, no consola.
	Solo map[string]bool
}

// Aplicar lleva cada servicio a la imagen de la versión, de uno en uno. Si
// uno no arranca sano, deshace todos los cambiados hasta ahí, en orden
// inverso, y devuelve el error: el nodo queda como estaba.
func (a *Aplicador) Aplicar(ctx context.Context, r Release) error {
	nombres := make([]string, 0, len(r.Servicios))
	for s := range r.Servicios {
		if len(a.Solo) == 0 || a.Solo[s] {
			nombres = append(nombres, s)
		}
	}
	sort.Strings(nombres)

	var hechos []paso
	for _, s := range nombres {
		p, err := a.cambiar(ctx, s, r.Servicios[s])
		if err != nil {
			a.Log("fallo; vuelvo atrás", "servicio", s, "err", err)
			for i := len(hechos) - 1; i >= 0; i-- {
				if e := a.deshacer(ctx, hechos[i]); e != nil {
					a.Log("no se pudo deshacer", "servicio", hechos[i].servicio, "err", e)
				}
			}
			return fmt.Errorf("%s: %w", s, err)
		}
		if p != nil {
			hechos = append(hechos, *p)
		}
	}
	// Todo sano: se retiran los contenedores anteriores. Sus imágenes se quedan,
	// por si hay que volver a mano.
	for _, h := range hechos {
		_ = a.Docker.Borrar(ctx, h.anterior)
	}
	return nil
}

func (a *Aplicador) cambiar(ctx context.Context, servicio, imagen string) (*paso, error) {
	lista, err := a.Docker.ListarConEtiqueta(ctx, EtiquetaServicio+"="+servicio)
	if err != nil {
		return nil, err
	}
	if len(lista) != 1 {
		return nil, fmt.Errorf("se esperaba un contenedor del servicio y hay %d", len(lista))
	}
	viejo, err := a.Docker.Inspeccionar(ctx, lista[0].ID)
	if err != nil {
		return nil, err
	}
	config, _ := viejo["Config"].(map[string]any)
	if config["Image"] == imagen {
		return nil, nil
	}
	nombre := trimBarra(fmt.Sprint(viejo["Name"]))
	salud, _ := config["Labels"].(map[string]any)[EtiquetaSalud].(string)
	if salud == "" {
		return nil, fmt.Errorf("el contenedor no declara %s: no se puede comprobar que el cambio funciona", EtiquetaSalud)
	}

	if err := a.Docker.AsegurarImagen(ctx, imagen); err != nil {
		return nil, fmt.Errorf("imagen: %w", err)
	}
	p := paso{servicio: servicio, nombre: nombre, anterior: lista[0].ID}
	if err := a.Docker.Renombrar(ctx, p.anterior, nombre+"-anterior"); err != nil {
		return nil, err
	}
	if err := a.Docker.Parar(ctx, p.anterior); err != nil {
		_ = a.Docker.Renombrar(ctx, p.anterior, nombre)
		return nil, err
	}

	// El nuevo es el viejo con otra imagen: misma configuración, mismos
	// montajes, mismas redes y mismos puertos. Pero lo que el viejo heredó de
	// su imagen (variables, comando, usuario, etiquetas) se quita, para que
	// mande la imagen nueva: si no, la versión vieja se colaría en la nueva.
	if img, err := a.Docker.InspeccionarImagen(ctx, fmt.Sprint(viejo["Image"])); err == nil {
		if cfgImg, ok := img["Config"].(map[string]any); ok {
			config = SinHerencia(config, cfgImg)
		}
	}
	config["Image"] = imagen
	pedido := map[string]any{}
	for k, v := range config {
		pedido[k] = v
	}
	pedido["HostConfig"] = viejo["HostConfig"]
	// Hasta la API 1.44 un contenedor se crea en una sola red: las demás se
	// conectan antes de arrancarlo, que vale con cualquier versión. De cada
	// red solo se conservan los alias: direcciones e identificadores los
	// vuelve a asignar Docker.
	redes := redesDe(viejo)
	if len(redes) > 0 {
		pedido["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{redes[0].nombre: redes[0].endpoint}}
	}
	id, err := a.Docker.Crear(ctx, nombre, pedido)
	if err == nil {
		p.nuevo = id
		for _, r := range redes[min(1, len(redes)):] {
			if err = a.Docker.Conectar(ctx, r.nombre, id, r.endpoint); err != nil {
				break
			}
		}
	}
	if err == nil {
		err = a.Docker.Arrancar(ctx, id)
	}
	if err == nil {
		err = a.esperarSalud(ctx, salud)
	}
	if err != nil {
		if e := a.deshacer(ctx, p); e != nil {
			a.Log("no se pudo deshacer", "servicio", servicio, "err", e)
		}
		return nil, err
	}
	a.Log("servicio cambiado", "servicio", servicio, "imagen", imagen)
	return &p, nil
}

// deshacer retira el contenedor nuevo y devuelve el anterior a su nombre y a marcha.
func (a *Aplicador) deshacer(ctx context.Context, p paso) error {
	if p.nuevo != "" {
		_ = a.Docker.Borrar(ctx, p.nuevo)
	}
	if err := a.Docker.Renombrar(ctx, p.anterior, p.nombre); err != nil {
		return err
	}
	return a.Docker.Arrancar(ctx, p.anterior)
}

func (a *Aplicador) esperarSalud(ctx context.Context, u string) error {
	limite := time.Now().Add(a.EsperaSalud)
	cliente := &http.Client{Timeout: 3 * time.Second}
	ultimo := "sin respuesta"
	for time.Now().Before(limite) {
		resp, err := cliente.Get(u)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			ultimo = resp.Status
		} else {
			ultimo = err.Error()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("no responde sano en %s (%s)", a.EsperaSalud, ultimo)
}

// SinHerencia quita de la configuración de un contenedor lo que vino de su
// imagen y no del despliegue: cada variable de entorno igual a la de la
// imagen, cada etiqueta igual a la de la imagen, y los campos (comando,
// usuario, directorio…) idénticos a los de la imagen.
func SinHerencia(contenedor, imagen map[string]any) map[string]any {
	r := map[string]any{}
	for k, v := range contenedor {
		r[k] = v
	}
	if env, ok := contenedor["Env"].([]any); ok {
		deImagen := map[string]bool{}
		if ie, ok := imagen["Env"].([]any); ok {
			for _, e := range ie {
				deImagen[fmt.Sprint(e)] = true
			}
		}
		var propias []any
		for _, e := range env {
			if !deImagen[fmt.Sprint(e)] {
				propias = append(propias, e)
			}
		}
		r["Env"] = propias
	}
	if et, ok := contenedor["Labels"].(map[string]any); ok {
		ie, _ := imagen["Labels"].(map[string]any)
		propias := map[string]any{}
		for k, v := range et {
			if iv, hay := ie[k]; !hay || iv != v {
				propias[k] = v
			}
		}
		r["Labels"] = propias
	}
	for _, campo := range []string{"Cmd", "Entrypoint", "WorkingDir", "User", "ExposedPorts", "Healthcheck", "StopSignal", "Volumes", "OnBuild", "Shell"} {
		if fmt.Sprint(contenedor[campo]) == fmt.Sprint(imagen[campo]) {
			delete(r, campo)
		}
	}
	return r
}

type red struct {
	nombre   string
	endpoint map[string]any
}

// redesDe saca las redes del contenedor en orden estable, con sus alias.
func redesDe(inspeccion map[string]any) []red {
	nets, _ := inspeccion["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)
	nombres := make([]string, 0, len(nets))
	for n := range nets {
		nombres = append(nombres, n)
	}
	sort.Strings(nombres)
	var r []red
	for _, n := range nombres {
		e := map[string]any{}
		if v, ok := nets[n].(map[string]any); ok && v["Aliases"] != nil {
			e["Aliases"] = v["Aliases"]
		}
		r = append(r, red{nombre: n, endpoint: e})
	}
	return r
}

func trimBarra(s string) string {
	if len(s) > 0 && s[0] == '/' {
		return s[1:]
	}
	return s
}
