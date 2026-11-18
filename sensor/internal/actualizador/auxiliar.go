package actualizador

// Lanzar el auxiliar que aplica la configuración, e informar de su resultado.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// ErrAuxiliarEnMarcha: ya hay una aplicación de configuración en curso.
var ErrAuxiliarEnMarcha = errors.New("a helper is already applying the configuration")

// Pedido es lo que necesita el auxiliar para aplicar una versión.
type Pedido struct {
	Imagen   string // imagen del actualizador de la versión (lleva docker-compose)
	Dir      string // carpeta del nodo EN EL ANFITRIÓN
	Modo     string // ModoNodo o ModoSensorRemoto
	Proyecto string // proyecto de compose
	Red      string // red desde la que el auxiliar llega a la consola
	// Hosts: resoluciones fijas («nombre:IP») que el auxiliar necesita para
	// informar a la consola, las mismas que compose da al sensor (HostsFijos).
	Hosts   []string
	Firmada ReleaseFirmada
}

// VariableConsolaFija es la variable de .env con la que el instalador de un
// sensor remoto fija en qué IP está la consola («nombre:IP») cuando su máquina
// no resuelve el nombre: compose la pone en /etc/hosts del sensor y del
// actualizador (extra_hosts), sin tocar la máquina.
const VariableConsolaFija = "CONSOLA_FIJA"

// HostsFijos devuelve esa resolución, si .env la trae y está bien formada. El
// auxiliar no es del proyecto de compose: sin ella no resolvería el nombre de
// la consola y cada versión aplicada quedaría sin informar.
func HostsFijos(env map[string]string) []string {
	v := strings.TrimSpace(env[VariableConsolaFija])
	nombre, ip, ok := strings.Cut(v, ":")
	if !ok || nombre == "" || strings.ContainsAny(nombre, " \t/") || net.ParseIP(ip) == nil {
		return nil
	}
	return []string{nombre + ":" + ip}
}

// NombreAuxiliar: el nombre del contenedor hace de cerrojo, solo puede haber uno.
func NombreAuxiliar(proyecto string) string { return proyecto + "-aplicar" }

// AuxiliarEnMarcha dice si hay un auxiliar trabajando para ese proyecto.
func AuxiliarEnMarcha(ctx context.Context, d *docker.Cliente, proyecto string) bool {
	c, err := d.Inspeccionar(ctx, NombreAuxiliar(proyecto))
	if err != nil {
		return false
	}
	estado, _ := c["State"].(map[string]any)
	corriendo, _ := estado["Running"].(bool)
	return corriendo
}

// Lanzar crea y arranca el auxiliar. Queda fuera del proyecto de compose, así
// que sigue vivo aunque compose recree al actualizador que lo lanzó.
func Lanzar(ctx context.Context, d *docker.Cliente, p Pedido) (string, error) {
	nombre := NombreAuxiliar(p.Proyecto)
	if AuxiliarEnMarcha(ctx, d, p.Proyecto) {
		return "", ErrAuxiliarEnMarcha
	}
	if err := d.Borrar(ctx, nombre); err != nil && !docker.NoExiste(err) {
		return "", fmt.Errorf("auxiliar anterior: %w", err)
	}
	if err := d.AsegurarImagen(ctx, p.Imagen); err != nil {
		return "", err
	}
	id, err := d.Crear(ctx, nombre, ConfigAuxiliar(p))
	if err != nil {
		return "", err
	}
	return id, d.Arrancar(ctx, id)
}

// ConfigAuxiliar es el contenedor que aplica una versión: el actualizador de la
// versión con el socket de Docker y la carpeta del nodo, sin capacidades.
func ConfigAuxiliar(p Pedido) map[string]any {
	version, _ := json.Marshal(p.Firmada)
	return map[string]any{
		"Image": p.Imagen,
		"Cmd":   []string{"aplicar"},
		"Env": append([]string{
			"APLICAR_DIR=" + p.Dir,
			"APLICAR_MODO=" + p.Modo,
			"APLICAR_PROYECTO=" + p.Proyecto,
			"APLICAR_RED=" + p.Red,
		}, VariablesVersion(base64.StdEncoding.EncodeToString(version))...),
		"Labels": map[string]string{"sugardaddy.auxiliar": p.Proyecto},
		"HostConfig": map[string]any{
			// El socket y la carpeta del nodo, en la misma ruta que en el
			// anfitrión: así las rutas del compose valen igual dentro y fuera.
			"Binds":          []string{"/var/run/docker.sock:/var/run/docker.sock", p.Dir + ":" + p.Dir},
			"ExtraHosts":     p.Hosts,
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges"},
			"Tmpfs":          map[string]string{"/tmp": "rw,nosuid,size=64m"},
			// No en la red del proyecto: compose no podría recrearla con un
			// contenedor ajeno dentro. Se une a ella solo para informar, al final.
			"NetworkMode":   "bridge",
			"RestartPolicy": map[string]string{"Name": "no"},
			"LogConfig":     docker.RegistrosAcotados(),
		},
	}
}

// TrozoVersion es lo más que lleva cada variable con la versión firmada. Linux no deja
// pasar una variable de más de 128 KB (MAX_ARG_STRLEN): el contenedor no arranca
// («argument list too long»). Una versión con su instalador ya pasa de eso.
const TrozoVersion = 96 * 1024

// VariablesVersion reparte la versión firmada (en base64) en variables que caben. Si
// cabe en una, va en APLICAR_VERSION como siempre, que es lo único que leen los
// auxiliares de antes de la 0.32.1 (al volver a una versión vieja). Si no, en
// APLICAR_VERSION_0, APLICAR_VERSION_1… y APLICAR_VERSION_TROZOS con cuántas son.
func VariablesVersion(b64 string) []string {
	if len(b64) <= TrozoVersion {
		return []string{"APLICAR_VERSION=" + b64}
	}
	var vars []string
	for i := 0; len(b64) > 0; i++ {
		n := min(TrozoVersion, len(b64))
		vars = append(vars, fmt.Sprintf("APLICAR_VERSION_%d=%s", i, b64[:n]))
		b64 = b64[n:]
	}
	return append(vars, fmt.Sprintf("APLICAR_VERSION_TROZOS=%d", len(vars)))
}

// LeerVariablesVersion junta lo que reparte VariablesVersion.
func LeerVariablesVersion(getenv func(string) string) (string, error) {
	if v := getenv("APLICAR_VERSION"); v != "" {
		return v, nil
	}
	n, err := strconv.Atoi(getenv("APLICAR_VERSION_TROZOS"))
	if err != nil || n < 1 || n > 256 {
		return "", errors.New("missing APLICAR_VERSION")
	}
	var b strings.Builder
	for i := 0; i < n; i++ {
		t := getenv(fmt.Sprintf("APLICAR_VERSION_%d", i))
		if t == "" {
			return "", fmt.Errorf("missing APLICAR_VERSION_%d", i)
		}
		b.WriteString(t)
	}
	return b.String(), nil
}

// Informe es a quién y cómo informa el auxiliar del resultado.
type Informe struct {
	URL   string // /api/actualizador/resultado (nodo) o /api/sensor/version (sensor remoto)
	Token string
	HTTP  *http.Client
}

// UnirseARed conecta el auxiliar a la red del proyecto, ya levantado, para
// llegar a la consola. Si ya estaba conectado no es un error.
func UnirseARed(ctx context.Context, d *docker.Cliente, proyecto, red string) error {
	if red == "" {
		return nil
	}
	err := d.Conectar(ctx, red, NombreAuxiliar(proyecto), nil)
	var e *docker.ErrAPI
	if errors.As(err, &e) && e.Codigo == http.StatusForbidden {
		return nil // ya conectado
	}
	return err
}

// Informar manda el resultado a la consola, con reintentos: mientras compose
// recrea la consola, no contesta. Devuelve error si no llegó.
func (i Informe) Informar(ctx context.Context, r Resultado, intentos int, espera time.Duration) error {
	b, _ := json.Marshal(map[string]string{"version": r.Version, "estado": r.Estado, "detalle": r.Detalle, "tipo": "configuracion"})
	var ultimo error
	for n := 0; n < intentos; n++ {
		if n > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(espera):
			}
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, i.URL, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+i.Token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := i.HTTP.Do(req)
		if err != nil {
			ultimo = err
			continue
		}
		resp.Body.Close()
		// 409: la consola ya no espera esa versión; no se arregla reintentando.
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusConflict {
			return nil
		}
		ultimo = fmt.Errorf("consola: %s", resp.Status)
	}
	return ultimo
}
