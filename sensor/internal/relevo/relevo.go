// Package relevo pasa un nodo (o un sensor remoto) de la 0.11 a la
// configuración firmada, una sola vez y sin que nadie reinstale.
//
// Un nodo 0.11 tiene un actualizador que solo sabe cambiar imágenes: instala
// la consola y el sensor nuevos, pero no su propia imagen ni el compose. El
// sensor nuevo es el único código nuevo con el socket de Docker que llega a
// esa máquina, así que es él quien lanza, una vez, el auxiliar que aplica la
// configuración de su versión. A partir de ahí el actualizador nuevo hace el
// resto. Antes de tocar nada pide permiso a la consola, que es quien sabe si
// el actualizador viejo está a mitad de un cambio.
package relevo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Oferta es lo que contesta la consola cuando da permiso.
type Oferta struct {
	Version string                      `json:"version"`
	Release actualizador.ReleaseFirmada `json:"release"`
}

// Consola es lo que el relevo necesita de ella.
type Consola interface {
	Relevo(ctx context.Context) (*Oferta, error)
	InformarRelevo(ctx context.Context, estado, detalle string) error
}

type Relevo struct {
	Docker  *docker.Cliente
	Consola Consola
	Version string // la del propio sensor
	Datos   string // carpeta del sensor, donde se apuntan los intentos
	Log     func(msg string, args ...any)
	// Para las pruebas.
	Ahora     func() time.Time
	Hostname  func() (string, error)
	Mountinfo func() ([]byte, error)
	Socket    string
}

// Esperas entre intentos fallidos: 10 min, 30 min, 2 h y después cada 6 h.
var esperas = []time.Duration{10 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour}

// Nada que hacer: no es un error, solo no toca (todavía). Lleva el motivo.
var errNoToca = errors.New("no toca")

func noToca(motivo string) error { return fmt.Errorf("%w: %s", errNoToca, motivo) }

var idEnMontajes = regexp.MustCompile(`/containers/([0-9a-f]{64})/`)

// idPropio dice qué contenedor es este. No vale el hostname: un actualizador
// 0.11 que recrea el contenedor le copia el del contenedor anterior. Docker
// monta /etc/hostname desde /var/lib/docker/containers/<id>/, así que el id
// está en los montajes del propio proceso.
func (r *Relevo) idPropio() string {
	leer := func() ([]byte, error) { return os.ReadFile("/proc/self/mountinfo") }
	if r.Mountinfo != nil {
		leer = r.Mountinfo
	}
	if b, err := leer(); err == nil {
		if m := idEnMontajes.FindSubmatch(b); m != nil {
			return string(m[1])
		}
	}
	host := os.Hostname
	if r.Hostname != nil {
		host = r.Hostname
	}
	h, _ := host()
	return h
}

type intentos struct {
	Version   string `json:"version"`
	Intentos  int    `json:"intentos"`
	Siguiente string `json:"siguiente"`
	Ultimo    string `json:"ultimo"`
}

func (r *Relevo) ahora() time.Time {
	if r.Ahora != nil {
		return r.Ahora()
	}
	return time.Now()
}

// Intentar hace el relevo si toca. Devuelve nil también cuando no toca.
func (r *Relevo) Intentar(ctx context.Context) error {
	reg := r.leer()
	if reg.Version == r.Version && reg.Siguiente != "" {
		if t, err := time.Parse(time.RFC3339, reg.Siguiente); err == nil && r.ahora().Before(t) {
			return nil
		}
	}
	err := r.intentar(ctx)
	if errors.Is(err, errNoToca) {
		// Se dice por qué: un relevo que no llega nunca no puede quedar mudo.
		if r.Log != nil {
			r.Log("relevo: todavía no", "motivo", strings.TrimPrefix(err.Error(), errNoToca.Error()+": "))
		}
		return nil
	}
	if reg.Version != r.Version {
		reg = intentos{Version: r.Version}
	}
	reg.Intentos++
	reg.Ultimo = "lanzado"
	espera := esperas[min(reg.Intentos-1, len(esperas)-1)]
	if err != nil {
		reg.Ultimo = err.Error()
	}
	// Lanzado o no, no se repite enseguida: si el auxiliar acaba bien, el
	// actualizador ya será el nuevo y no volverá a tocar.
	reg.Siguiente = r.ahora().Add(espera).UTC().Format(time.RFC3339)
	r.guardar(reg)
	return err
}

func (r *Relevo) intentar(ctx context.Context) error {
	yo := r.idPropio()
	propio, err := r.Docker.Inspeccionar(ctx, yo)
	if err != nil {
		return noToca("no encuentro mi propio contenedor (" + yo + ")")
	}
	proyecto := etiquetas(propio)["com.docker.compose.project"]
	if proyecto == "" {
		return noToca("no estoy en un proyecto de compose")
	}
	lista, err := r.Docker.ListarConEtiqueta(ctx, "com.docker.compose.project="+proyecto)
	if err != nil {
		return err
	}
	var viejo *docker.Contenedor
	modo := actualizador.ModoSensorRemoto
	for i, c := range lista {
		for _, n := range c.Names {
			// Un actualizador 0.11 a mitad de un cambio: ni se intenta.
			if strings.HasSuffix(n, "-anterior") {
				return noToca("el actualizador viejo está a mitad de un cambio")
			}
		}
		switch c.Labels["com.docker.compose.service"] {
		case "actualizador":
			viejo = &lista[i]
		case "consola":
			modo = actualizador.ModoNodo
		}
	}
	// Sin actualizador, o ya con la etiqueta que pone el compose firmado: nada que hacer.
	if viejo == nil || viejo.Labels[actualizador.EtiquetaServicio] == "actualizador" {
		return errNoToca // ya hecho, o no hay actualizador: nada que contar
	}
	if desde, err := time.Parse(time.RFC3339Nano, estadoDe(propio)["StartedAt"].(string)); err != nil || r.ahora().Sub(desde) < 2*time.Minute {
		return noToca("acabo de arrancar")
	}

	of, err := r.Consola.Relevo(ctx)
	if err != nil {
		return noToca("la consola no contesta: " + err.Error())
	}
	if of == nil {
		return noToca("la consola aún no da permiso")
	}
	vi, err := r.Docker.Inspeccionar(ctx, viejo.ID)
	if err != nil {
		return err
	}
	env := entornoDe(vi)
	clave, err := actualizador.ClavePublica(env["PUBLICACION_CLAVE_PUBLICA"])
	if err != nil {
		return fmt.Errorf("el actualizador viejo no tiene una clave de publicación válida: %w", err)
	}
	rel, err := actualizador.Verificar(clave, of.Release)
	if err != nil {
		return fmt.Errorf("versión del relevo: %w", err)
	}
	conf := rel.Nodo
	if modo == actualizador.ModoSensorRemoto {
		conf = rel.SensorRemoto
	}
	if rel.Version != r.Version || conf == nil || rel.Actualizador == "" {
		return fmt.Errorf("la versión del relevo (%s) no es la de este sensor (%s) o no trae configuración", rel.Version, r.Version)
	}
	destino := "/nodo"
	red := proyecto + "_nodo"
	if modo == actualizador.ModoSensorRemoto {
		destino, red = "/sensor", proyecto+"_sensor"
	}
	dir := origenDe(vi, destino)
	if dir == "" {
		return fmt.Errorf("el actualizador viejo no monta %s: no sé dónde está la carpeta", destino)
	}

	// El permiso de antes no reserva nada: el cerrojo se toma aquí, y si la
	// consola no lo da (otro sensor se adelantó), no se toca nada.
	if err := r.Consola.InformarRelevo(ctx, "aplicando", ""); err != nil {
		return noToca("la consola no da el cerrojo: " + err.Error())
	}
	if err := r.Docker.Parar(ctx, viejo.ID); err != nil {
		_ = r.Consola.InformarRelevo(ctx, "fallida", err.Error())
		return fmt.Errorf("no se pudo parar el actualizador viejo: %w", err)
	}
	// Y otra vez: que no haya empezado un cambio justo antes de pararlo.
	if l, err := r.Docker.ListarConEtiqueta(ctx, "com.docker.compose.project="+proyecto); err == nil {
		for _, c := range l {
			for _, n := range c.Names {
				if strings.HasSuffix(n, "-anterior") {
					_ = r.Docker.Arrancar(ctx, viejo.ID)
					_ = r.Consola.InformarRelevo(ctx, "cancelado", "")
					return noToca("el actualizador viejo empezó un cambio justo antes de pararlo")
				}
			}
		}
	}
	d := r.Docker
	if t := env["REGISTRO_TOKEN"]; t != "" {
		socket := r.Socket
		if socket == "" {
			socket = "/var/run/docker.sock"
		}
		d = docker.Nuevo(socket).ConCredencial(env["REGISTRO"], docker.Credencial{Usuario: env["REGISTRO_USUARIO"], Token: t})
	}
	if _, err := actualizador.Lanzar(ctx, d, actualizador.Pedido{
		Imagen: rel.Actualizador, Dir: dir, Modo: modo, Proyecto: proyecto, Red: red, Firmada: of.Release,
	}); err != nil {
		_ = r.Docker.Arrancar(ctx, viejo.ID)
		_ = r.Consola.InformarRelevo(ctx, "fallida", err.Error())
		return fmt.Errorf("no se pudo lanzar el auxiliar: %w", err)
	}
	r.Log("relevo lanzado: el auxiliar aplica la configuración de la versión", "version", rel.Version, "modo", modo)
	return nil
}

func (r *Relevo) ruta() string { return filepath.Join(r.Datos, "relevo.json") }

func (r *Relevo) leer() intentos {
	var i intentos
	if b, err := os.ReadFile(r.ruta()); err == nil {
		_ = json.Unmarshal(b, &i)
	}
	return i
}

func (r *Relevo) guardar(i intentos) {
	b, _ := json.Marshal(i)
	_ = os.WriteFile(r.ruta(), b, 0o600)
}

func etiquetas(c map[string]any) map[string]string {
	cfg, _ := c["Config"].(map[string]any)
	m := map[string]string{}
	if l, ok := cfg["Labels"].(map[string]any); ok {
		for k, v := range l {
			m[k] = fmt.Sprint(v)
		}
	}
	return m
}

func estadoDe(c map[string]any) map[string]any {
	e, _ := c["State"].(map[string]any)
	if e == nil {
		return map[string]any{"StartedAt": ""}
	}
	if _, ok := e["StartedAt"].(string); !ok {
		e["StartedAt"] = ""
	}
	return e
}

func entornoDe(c map[string]any) map[string]string {
	cfg, _ := c["Config"].(map[string]any)
	m := map[string]string{}
	l, _ := cfg["Env"].([]any)
	for _, v := range l {
		if k, val, ok := strings.Cut(fmt.Sprint(v), "="); ok {
			m[k] = val
		}
	}
	return m
}

func origenDe(c map[string]any, destino string) string {
	l, _ := c["Mounts"].([]any)
	for _, m := range l {
		mm, _ := m.(map[string]any)
		if mm["Destination"] == destino {
			s, _ := mm["Source"].(string)
			return s
		}
	}
	return ""
}
