// Package despliegue lleva los contenedores del sensor al estado que pide el
// plan: crea los que faltan, rehace los que han cambiado y retira los que ya
// no están. Solo toca contenedores con la etiqueta de Sugardaddy.
package despliegue

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	redpkg "github.com/kinomakino/sugardaddy/sensor/internal/red"
)

const (
	etiquetaTrampa = "sugardaddy.trampa"
	// Antes de la 0.8.0 la etiqueta era esta: sin leerla, el sensor no
	// reconocería sus trampas ya desplegadas y chocaría con sus puertos.
	etiquetaAntigua  = "sugardaddy.senuelo"
	etiquetaSensor   = "sugardaddy.sensor"
	etiquetaHuella   = "sugardaddy.huella"
	etiquetaFicheros = "sugardaddy.ficheros"
	// Desde la 0.12.1 las trampas no se ven entre sí (ver docker.AsegurarRed).
	// Las redes tienen nombre nuevo para que cada trampa se rehaga sola en ellas.
	redTrampas   = "sugardaddy-trampas-aisladas"
	redConSalida = "sugardaddy-trampas-salida-aisladas"
	// Desde la 0.16.0, las trampas con el bloque red (modo «IP propia»)
	// van en su propia red macvlan, no en el puente aislado.
	redTrampasPropia = "sugardaddy-trampas-ip-propia"
)

// Redes de antes de la 0.12.1, en las que las trampas se veían entre sí. Se
// quitan cuando ya no tienen ningún contenedor.
var redesAntiguas = []string{"sugardaddy-trampas", "sugardaddy-trampas-salida"}

// Redes son las redes en las que el sensor pone sus trampas.
func Redes() []string { return []string{redTrampas, redConSalida} }

type Opciones struct {
	// Datos es la carpeta del sensor; los registros de cada trampa van en Datos/registros/<id>.
	Datos string
	// Escucha es la IP del anfitrión donde se publican los puertos.
	Escucha string
	// Desplazar suma este número a los puertos expuestos (en desarrollo, para no chocar con el 22 del Mac).
	Desplazar int
	// ImagenSonda es la imagen con la que se comprueba que las trampas no se
	// ven entre sí (la del propio sensor, con su orden «sondear»). Vacía: no se comprueba.
	ImagenSonda string
	// Paradas son las trampas que el sensor ha parado (p. ej. porque sus
	// registros pasaban de su cuota), con el aviso para el cliente: no se
	// arrancan ni se rehacen hasta que salen de aquí.
	Paradas map[string]string
	// RedPropia es el modo «IP propia» de este sensor (desde la 0.16.0;
	// docs/diseno/red.md): la interfaz física y el rango propio elegidos por
	// quien instala el sensor, o el puente de banco con su IP fija. nil: el
	// sensor no trae el modo y las trampas que lo piden dan su error, nunca
	// van al puente aislado sin decir nada.
	RedPropia *RedPropia
}

type Estado struct {
	ID    string `json:"id"`
	Donde string `json:"donde"`
	// Codigo estable (fase.causa) del fallo, si lo hay. Desde la 0.13.1; las
	// consolas anteriores lo ignoran y ven el mismo código al principio de Donde.
	Codigo string `json:"codigo,omitempty"`
}

// Lo que puede tardar el motor en dar la lista de contenedores: si no la da
// en este tiempo, no responde.
const esperaMotor = time.Minute

func Registros(o Opciones, id string) string {
	return filepath.Join(o.Datos, "registros", id)
}

// licenciaFichero es dónde se guarda, en el anfitrión, la licencia de pago que
// se monta en las trampas.
func licenciaFichero(o Opciones) string {
	return filepath.Join(o.Datos, "licencia.json")
}

var hueco = regexp.MustCompile(`\$\{([^}]*)\}`)

// rutaLicenciaTrampa es donde se monta la licencia de pago dentro de cada
// trampa, de solo lectura. Tiene que coincidir con licencia.RutaPorDefecto
// (modulos/comun/licencia), que es lo que el binario de la trampa de pago lee
// al arrancar. No se importa de allí para no atar el sensor a ese módulo.
const rutaLicenciaTrampa = "/sugardaddy/licencia.json"

// config traduce una trampa del plan a la petición de creación de Docker.
// Todo lo que endurece el contenedor está aquí y no depende del manifiesto:
// un módulo puede pedir menos aislamiento, nunca quitar estos mínimos.
// licenciaRuta es el fichero del anfitrión con la licencia de pago, que se monta
// de solo lectura en la trampa; vacía si el nodo no tiene licencia.
func config(o Opciones, sensor, licenciaRuta string, s plan.TrampaPlan) (map[string]any, []string, error) {
	c, a := s.Manifiesto.Contenedor, s.Manifiesto.Aislamiento
	if c == nil || a == nil {
		return nil, nil, fmt.Errorf("a la trampa %s le falta contenedor o aislamiento", s.ID)
	}

	rellenar := func(t string) string {
		return hueco.ReplaceAllStringFunc(t, func(h string) string {
			return fmt.Sprint(s.Parametros[h[2:len(h)-1]])
		})
	}

	var entorno []string
	for k, v := range c.Entorno {
		switch v := v.(type) {
		case string:
			entorno = append(entorno, k+"="+rellenar(v))
		case map[string]any:
			// {segun: parámetro, valores: {opción: valor}}: el valor de la opción elegida.
			segun, _ := v["segun"].(string)
			valores, _ := v["valores"].(map[string]any)
			if x, ok := valores[fmt.Sprint(s.Parametros[segun])].(string); ok {
				entorno = append(entorno, k+"="+x)
			}
		}
	}
	sort.Strings(entorno)

	// El modo «IP propia» (docs/diseno/red.md): solo la trampa con el bloque
	// red. Su tráfico no pasa por el puente del anfitrión: la trampa ESTÁ en
	// el segmento del cliente con su propia IP, sin NAT, y los puertos no se
	// publican (macvlan no publica puertos: la IP ES la trampa).
	var ipPropia string
	expuestos := map[string]any{}
	publicados := map[string]any{}
	var donde []string
	if s.Manifiesto.Red != nil {
		// Defensa en profundidad (hallazgo 11): el esquema de la consola
		// cierra el valor con `const: ip-propia`, pero el sensor no se fía
		// de quien firma el manifiesto — solo entiende UN modo de red. El
		// capturar se valida igual de fuerte, al compilarlo a BPF.
		if s.Manifiesto.Red.Modo != "ip-propia" {
			return nil, nil, fmt.Errorf("la trampa %s trae el modo de red %q y el sensor solo entiende «ip-propia» (docs/diseno/red.md §1)", s.ID, s.Manifiesto.Red.Modo)
		}
		var err error
		ipPropia, err = IPPropia(o, s)
		if err != nil {
			return nil, nil, err
		}
	} else {
		for _, p := range c.Puertos {
			if p.Si != "" && !encendido(s.Parametros[p.Si]) {
				continue
			}
			clave := fmt.Sprintf("%d/%s", p.Interno, p.Protocolo)
			anfitrion, err := puerto(p.Expuesto, rellenar, o.Desplazar)
			if err != nil {
				return nil, nil, err
			}
			expuestos[clave] = map[string]any{}
			publicados[clave] = []map[string]string{{"HostIp": o.Escucha, "HostPort": fmt.Sprint(anfitrion)}}
			donde = append(donde, fmt.Sprintf("%s:%d", o.Escucha, anfitrion))
		}
	}

	montajes := []map[string]any{{
		"Type": "bind", "Source": Registros(o, s.ID), "Target": c.Registros,
	}}
	// Los ficheros de configuración se escriben en el anfitrión y entran de solo
	// lectura. Su contenido va en la huella: si cambia, el contenedor se rehace.
	contenidos := sha256.New()
	for i, f := range c.Ficheros {
		origen := filepath.Join(o.Datos, "config", s.ID, fmt.Sprint(i))
		texto := rellenar(f.Contenido)
		if err := escribirFichero(origen, texto); err != nil {
			return nil, nil, err
		}
		contenidos.Write([]byte(texto + "\x00"))
		montajes = append(montajes, map[string]any{
			"Type": "bind", "Source": origen, "Target": f.Destino, "ReadOnly": true,
		})
	}
	// La licencia de pago, de solo lectura, en ruta fija. Se monta en TODAS las
	// trampas por simplicidad (así el sensor no clasifica pago/gratis): las
	// gratis no leen el fichero. La ruta del anfitrión es constante, así que
	// reemitir la licencia (mismo fichero, contenido nuevo) no rehace la trampa;
	// que una copia envejezca se apoya en que la trampa relea al reiniciarse.
	if licenciaRuta != "" {
		montajes = append(montajes, map[string]any{
			"Type": "bind", "Source": licenciaRuta, "Target": rutaLicenciaTrampa, "ReadOnly": true,
		})
	}
	for i, ruta := range c.Escribibles {
		montajes = append(montajes, map[string]any{
			"Type": "volume", "Source": fmt.Sprintf("sd-%s-%s-%d", sensor, s.ID, i), "Target": ruta,
			// Con etiquetas, para encontrarlos y borrarlos al retirar la trampa
			// aunque su contenedor ya no esté.
			"VolumeOptions": map[string]any{"Labels": map[string]string{etiquetaSensor: sensor, etiquetaTrampa: s.ID}},
		})
	}

	red := redTrampas
	if a.Salida {
		red = redConSalida
	}
	cfg := map[string]any{
		"Image":        c.Imagen,
		"Env":          entorno,
		"ExposedPorts": expuestos,
		"Labels": map[string]string{
			etiquetaTrampa: s.ID, etiquetaSensor: sensor,
			etiquetaFicheros: hex.EncodeToString(contenidos.Sum(nil)[:8]),
		},
		"HostConfig": map[string]any{
			"NetworkMode":    red,
			"PortBindings":   publicados,
			"ReadonlyRootfs": a.SoloLectura,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges"},
			"Memory":         int64(a.MemoriaMb) << 20,
			// Sin swap de más: en un anfitrión con swap, el tope de memoria es el real.
			"MemorySwap":    int64(a.MemoriaMb) << 20,
			"NanoCpus":      int64(a.CPU * 1e9),
			"PidsLimit":     256,
			"Mounts":        montajes,
			"RestartPolicy": map[string]string{"Name": "unless-stopped"},
			"Tmpfs":         map[string]string{"/tmp": "rw,noexec,nosuid,size=16m"},
			"LogConfig":     docker.RegistrosAcotados(),
		},
	}
	if s.Manifiesto.Red != nil {
		host := cfg["HostConfig"].(map[string]any)
		red = redPropiaDe(o)
		host["NetworkMode"] = red
		// NET_RAW SOLO si la trampa pide capturar, y siempre con el filtro
		// BPF puesto ANTES: el enchufe crudo de la trampa solo ve el ARP y
		// el IPv4 de los rangos que ha pedido. Sin capturar, sin NET_RAW
		// (el envenenador va de enchufes UDP normales). NET_ADMIN jamás:
		// ninguna trampa cambia rutas ni reglas del anfitrión
		// (docs/diseno/red.md: por qué es seguro).
		if capturar := rellenar(s.Manifiesto.Red.Capturar); capturar != "" {
			bpf, err := redpkg.CompilarBPF(capturar)
			if err != nil {
				return nil, nil, fmt.Errorf("el capturar de la trampa (%s) no vale: %v", capturar, err)
			}
			entorno = append(entorno, "SD_RED_BPF="+bpf)
			// el append puede mudar el slice: el mapa se queda con el nuevo.
			cfg["Env"] = entorno
			host["CapAdd"] = []string{"NET_RAW"}
			/*
			 * Y como root: una capacidad concedida (NET_RAW) solo la puede
			 * usar un proceso raíz — las imágenes de trampa van de fábrica
			 * con usuario sin privilegios (p. ej. 65534), y para un usuario
			 * así CapAdd no es efectivo, no hay capacidades ambientales en
			 * Docker y el enchufe crudo daría EPERM. Este «root» no es el
			 * de antes: con CapDrop ALL solo conserva NET_RAW — ni CHOWN,
			 * ni SETUID, ni SYS_ADMIN, ni NET_ADMIN — y sigue con su
			 * sistema de ficheros de solo lectura, sin privilegios nuevos
			 * y con sus topes de memoria, CPU y procesos
			 * (docs/diseno/red.md: por qué es seguro).
			 */
			cfg["User"] = "0:0"
		}
		// La IP propia elegida (sondeada en producción, fija en el banco):
		// en la huella, para que la trampa se rehaga si cambia.
		cfg["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{
			red: map[string]any{
				"IPAMConfig": map[string]string{"IPv4Address": ipPropia},
				"Aliases":    []string{s.ID},
			},
		}}
		donde = []string{"IP propia " + ipPropia}
	}
	return cfg, donde, nil
}

func huella(cfg map[string]any) string {
	b, _ := json.Marshal(cfg)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

// Aplicar reconcilia y devuelve dónde ha quedado cada trampa. Nada de lo
// que falle (una red, una imagen) quita una trampa que ya funciona ni impide
// retirar las que salen del plan. Un fallo general del motor (no responde,
// no deja o es demasiado antiguo) es un *docker.ErrMotor, y cada trampa del
// plan lo lleva en su estado (menos las paradas por el sensor, que siguen
// diciendo por qué): la consola tiene que saberlo de todas.
func Aplicar(ctx context.Context, d *docker.Cliente, o Opciones, p plan.Plan) ([]Estado, error) {
	// Solo los contenedores de ESTE sensor: en la misma máquina puede haber
	// otros sensores, y lo suyo no es asunto de este.
	ctxLista, cancelar := context.WithTimeout(ctx, esperaMotor)
	existentes, err := d.ListarConEtiqueta(ctxLista, etiquetaSensor+"="+p.Sensor)
	cancelar()
	if err != nil {
		fallo := d.Clasificar(err)
		estados := make([]Estado, 0, len(p.Trampas))
		for _, s := range p.Trampas {
			// Una trampa que ha parado el sensor sigue parada aunque el motor
			// falle: si su estado llevara el fallo, la consola la daría por
			// activa. El fallo le llega igual, en las demás y en el bloque motor.
			if aviso, parada := o.Paradas[s.ID]; parada {
				estados = append(estados, Estado{ID: s.ID, Donde: prefijoParada + aviso})
				continue
			}
			estados = append(estados, Estado{ID: s.ID, Donde: "error: " + fallo.Codigo + ": " + fallo.Texto, Codigo: fallo.Codigo})
		}
		return estados, fallo
	}
	porID := map[string]docker.Contenedor{}
	for _, c := range existentes {
		id := c.Labels[etiquetaTrampa]
		if id == "" {
			id = c.Labels[etiquetaAntigua]
		}
		porID[id] = c
	}
	quedan := map[string]bool{}
	for _, s := range p.Trampas {
		quedan[s.ID] = true
	}

	var fallos []error

	// La licencia de pago, si el nodo la tiene, se escribe una vez y se monta en
	// cada trampa. Se escribe en el sitio (os.WriteFile trunca) para que una
	// trampa ya en marcha vea el contenido nuevo al reiniciarse, sin rehacerse.
	// Sin licencia (edición gratis) se borra la que quedara: las gratis siguen
	// igual y una de pago dejaría de arrancar en su próximo redespliegue.
	licenciaRuta := licenciaFichero(o)
	if len(p.Licencia) > 0 {
		if err := escribirFichero(licenciaRuta, string(p.Licencia)); err != nil {
			fallos = append(fallos, fmt.Errorf("escribir la licencia: %w", err))
			licenciaRuta = ""
		}
	} else {
		_ = os.Remove(licenciaRuta)
		licenciaRuta = ""
	}

	// Primero lo que sale del plan: retirar no depende de redes ni de
	// imágenes, y lo que no se pueda retirar se reintenta en la vuelta
	// siguiente sin parar a las demás.
	for id, c := range porID {
		if quedan[id] {
			continue
		}
		if err := borrar(ctx, d, c.ID); err != nil {
			fallos = append(fallos, fmt.Errorf("retirar %s: %w", id, err))
		}
	}
	// Lo que escribió el atacante en ellas (sesiones, claves) se va con la
	// trampa, también si su contenedor ya no estaba.
	if err := borrarVolumenesRetirados(ctx, d, p.Sensor, quedan, porID); err != nil {
		fallos = append(fallos, err)
	}

	// Las redes. Si una no se puede preparar (sin subredes libres, por
	// ejemplo), las trampas que ya están en marcha siguen como están. Si el
	// motor no confirma sus opciones (Podman), cada trampa lo dice.
	errRed, garantizada := map[string]error{}, map[string]bool{}
	garantizada[redTrampas], errRed[redTrampas] = d.AsegurarRed(ctx, redTrampas, false)
	for _, s := range p.Trampas {
		if redDe(o, s) == redConSalida {
			garantizada[redConSalida], errRed[redConSalida] = d.AsegurarRed(ctx, redConSalida, true)
			break
		}
	}
	// La red macvlan de las trampas con IP propia, sobre la interfaz física
	// del segmento del cliente (docs/diseno/red.md §4). En el banco no se
	// toca: la red de banco la crea quien lanza la prueba, con su subred.
	for _, s := range p.Trampas {
		if s.Manifiesto.Red == nil || o.RedPropia == nil || o.RedPropia.Puente != "" {
			continue
		}
		garantizada[redTrampasPropia], errRed[redTrampasPropia] = d.AsegurarRedPropia(ctx, redTrampasPropia, o.RedPropia.Interfaz, o.RedPropia.Rango)
		break
	}

	estados := []Estado{}
	porRed := map[string]int{}
	for _, s := range p.Trampas {
		if aviso, parada := o.Paradas[s.ID]; parada {
			// Si sigue en marcha (el sensor se reinició o no la pudo parar), se para.
			if c, existe := porID[s.ID]; existe && c.State == "running" {
				if err := parar(ctx, d, c.ID); err != nil {
					fallos = append(fallos, fmt.Errorf("parar %s: %w", s.ID, err))
				}
			}
			estados = append(estados, Estado{ID: s.ID, Donde: prefijoParada + aviso})
			continue
		}
		cfg, donde, err := config(o, p.Sensor, licenciaRuta, s)
		if err != nil {
			estados = append(estados, Estado{ID: s.ID, Donde: "error: " + err.Error()})
			continue
		}
		aqui := strings.Join(donde, ", ")
		h := huella(cfg)
		cfg["Labels"].(map[string]string)[etiquetaHuella] = h

		c, existe := porID[s.ID]
		enMarcha := existe && c.State == "running"
		if enMarcha && c.Labels[etiquetaHuella] == h {
			estados = append(estados, Estado{ID: s.ID, Donde: aqui})
			if s.Manifiesto.Red == nil {
				// para las sondas de aislamiento van solo las del puente:
				// las de IP propia comparten segmento por diseño.
				porRed[redDe(o, s)]++
			} else {
				// La MAC de la trampa, para el vigilante ARP (hallazgo 1):
				// se pide solo mientras no se sepa (tras un reinicio, la
				// trampa reusa contenedor y no vuelve a crearse).
				apuntarMAC(ctx, d, c.ID, s.ID)
			}
			continue
		}
		sigue := func(aviso string) {
			if enMarcha {
				estados = append(estados, Estado{ID: s.ID, Donde: aqui + " · aviso: " + aviso + "; sigue como estaba"})
			} else {
				estados = append(estados, Estado{ID: s.ID, Donde: "error: " + aviso})
			}
		}
		if e := errRed[redDe(o, s)]; e != nil {
			sigue("no se pudo preparar la red de trampas (" + e.Error() + ")")
			continue
		}
		// La imagen se descarga aparte: una descarga larga no para al sensor
		// (ni su salud, ni la lectura de eventos) y la trampa sigue con la
		// imagen de antes hasta que la nueva esté entera.
		if img := s.Manifiesto.Contenedor.Imagen; !d.ImagenPresente(ctx, img) {
			sigue(pedirImagen(d, img))
			continue
		}
		if existe {
			if err := borrar(ctx, d, c.ID); err != nil {
				sigue("no se pudo quitar el contenedor anterior (" + err.Error() + ")")
				continue
			}
		}
		if err := prepararRegistros(o, s.ID); err != nil {
			estados = append(estados, Estado{ID: s.ID, Donde: "error: carpeta de registros: " + err.Error()})
			continue
		}
		id, err := d.Crear(ctx, "sd-"+p.Sensor+"-"+s.ID, cfg)
		if err == nil {
			err = d.Arrancar(ctx, id)
		}
		if err != nil {
			estados = append(estados, Estado{ID: s.ID, Donde: "error: " + err.Error()})
			continue
		}
		if s.Manifiesto.Red != nil {
			// La MAC del contenedor recién creado, para el vigilante ARP
			// (hallazgo 1: no dar por reclamo el ARP de una trampa propia).
			apuntarMAC(ctx, d, id, s.ID)
		}
		estados = append(estados, Estado{ID: s.ID, Donde: aqui})
		if s.Manifiesto.Red == nil {
			// para las sondas de aislamiento van solo las del puente:
			// las de IP propia comparten segmento por diseño.
			porRed[redDe(o, s)]++
		}
	}

	for _, red := range redesAntiguas {
		if r, err := d.InspeccionarRed(ctx, red); err == nil && len(r.Containers) == 0 {
			_ = d.BorrarRed(ctx, red)
		}
	}
	// El aislamiento no se supone: se prueba. Si el motor no lo aplica (sin
	// iptables, Podman, algunos motores en VM), cada trampa afectada lo dice.
	seVen := comprobarAislamiento(ctx, d, o, p.Sensor, porRed)
	redes := map[string]string{}
	propia := map[string]bool{}
	for _, t := range p.Trampas {
		redes[t.ID] = redDe(o, t)
		propia[t.ID] = t.Manifiesto.Red != nil
	}
	for i, e := range estados {
		if strings.HasPrefix(e.Donde, "error") || strings.HasPrefix(e.Donde, prefijoParada) {
			continue
		}
		if propia[e.ID] {
			// Con IP propia no hay puente que aislar: las trampas van en el
			// segmento del cliente y se ven entre sí como dos equipos
			// cualesquiera de esa red. Es lo que hay y se dice.
			estados[i].Donde += " · " + avisoSegmento
			continue
		}
		if seVen[redes[e.ID]] {
			estados[i].Donde += " · " + avisoAislamiento
		} else if !garantizada[redes[e.ID]] {
			estados[i].Donde += " · " + avisoSinGarantia
		}
	}
	return estados, errors.Join(fallos...)
}

const avisoSinGarantia = "aviso: el motor de contenedores no confirma que esta trampa no salga a Internet ni que no vea a las demás"

// avisoSegmento: lo que cambia el modo «IP propia» (docs/diseno/red.md §2):
// sin puente aislado que las separe, las trampas con IP propia son equipos
// más del segmento del cliente. Los atacantes de una trampa pueden ver a
// las demás, como pueden ver cualquier equipo real de esa red.
const avisoSegmento = "aviso: con IP propia la trampa va en el segmento del cliente, no aislada de las demás trampas ni de los equipos de esa red"

// prefijoParada encabeza el estado de una trampa que el sensor ha parado.
const prefijoParada = "parada: "

// Parar para los contenedores de una trampa de este sensor y no vuelve hasta
// que lo están. Sin contenedor, o ya parado, no es un error: así se puede
// llamar las veces que haga falta para confirmar que no corre.
func Parar(ctx context.Context, d *docker.Cliente, sensor, id string) error {
	existentes, err := d.ListarConEtiqueta(ctx, etiquetaSensor+"="+sensor)
	if err != nil {
		return err
	}
	var fallos []error
	for _, c := range existentes {
		de := c.Labels[etiquetaTrampa]
		if de == "" {
			de = c.Labels[etiquetaAntigua]
		}
		if de != id || c.State == "exited" || c.State == "created" || c.State == "dead" {
			continue
		}
		if err := parar(ctx, d, c.ID); err != nil {
			fallos = append(fallos, err)
		}
	}
	return errors.Join(fallos...)
}

// parar para un contenedor sin dejarse cortar a medias; si ya no estaba, no
// es un error.
func parar(ctx context.Context, d *docker.Cliente, id string) error {
	ctx, cancelar := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancelar()
	if err := d.Parar(ctx, id); err != nil && !docker.NoExiste(err) {
		return err
	}
	return nil
}

// borrar quita un contenedor sin dejarse cortar a medias (el sensor puede
// estar parándose); si ya no estaba, no es un error.
func borrar(ctx context.Context, d *docker.Cliente, id string) error {
	ctx, cancelar := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancelar()
	if err := d.Borrar(ctx, id); err != nil && !docker.NoExiste(err) {
		return err
	}
	return nil
}

// apuntarMAC le pregunta al motor por la MAC del contenedor de una trampa con
// IP propia y la deja apuntada (hallazgo 1): el vigilante ARP la usa para no
// dar por reclamo de otro equipo un ARP cuya MAC fuente es de una trampa de
// este sensor. Pregunta SIEMPRE y actualiza si cambió (hallazgo N4 de la
// re-revisión): un contenedor recreado trae MAC nueva y la defensa de
// profundidad quedaría con la vieja; la primera línea, descartar el ARP
// saliente (PACKET_OUTGOING), no se afecta. Si el motor no la dice, no pasa
// nada: la MAC es la defensa de profundidad, no la única.
func apuntarMAC(ctx context.Context, d *docker.Cliente, contenedor, idTrampa string) {
	if idTrampa == "" || contenedor == "" {
		return
	}
	ctx, cancelar := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancelar()
	insp, err := d.Inspeccionar(ctx, contenedor)
	if err != nil {
		return
	}
	ns, _ := insp["NetworkSettings"].(map[string]any)
	if ns == nil {
		return
	}
	// La del punto de red propio (macvlan en producción, puente de banco en el
	// banco), y si no, la general: una trampa va en una sola red.
	if redes, es := ns["Networks"].(map[string]any); es {
		for _, r := range redes {
			if punto, es := r.(map[string]any); es {
				if mac, _ := punto["MacAddress"].(string); mac != "" {
					ApuntarMAC(idTrampa, mac)
					return
				}
			}
		}
	}
	if mac, _ := ns["MacAddress"].(string); mac != "" {
		ApuntarMAC(idTrampa, mac)
	}
}

// borrarVolumenesRetirados quita los volúmenes de las trampas de este sensor
// que ya no están en el plan ni tienen contenedor: por su etiqueta (desde la
// 0.12.1) o, los de antes, por su nombre exacto.
func borrarVolumenesRetirados(ctx context.Context, d *docker.Cliente, sensor string, quedan map[string]bool, porID map[string]docker.Contenedor) error {
	ctx, cancelar := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancelar()
	var fallos []error
	etiquetados, err := d.Volumenes(ctx, map[string][]string{"label": {etiquetaSensor + "=" + sensor}})
	if err != nil {
		return err
	}
	for _, v := range etiquetados {
		if id := v.Labels[etiquetaTrampa]; id != "" && !quedan[id] {
			if err := d.BorrarVolumen(ctx, v.Name); err != nil {
				fallos = append(fallos, err)
			}
		}
	}
	// Los de antes de la 0.12.1, sin etiquetas: solo los de las trampas que se
	// acaban de retirar, por su nombre exacto.
	for id := range porID {
		if quedan[id] {
			continue
		}
		prefijo := "sd-" + sensor + "-" + id + "-"
		patron := regexp.MustCompile(`^` + regexp.QuoteMeta(prefijo) + `\d+$`)
		viejos, err := d.Volumenes(ctx, map[string][]string{"name": {prefijo}})
		if err != nil {
			fallos = append(fallos, err)
			continue
		}
		for _, v := range viejos {
			if len(v.Labels) == 0 && patron.MatchString(v.Name) {
				if err := d.BorrarVolumen(ctx, v.Name); err != nil {
					fallos = append(fallos, err)
				}
			}
		}
	}
	return errors.Join(fallos...)
}

// redDe: la red del puente donde va la trampa, o la macvlan propia si pide
// el modo «IP propia» (docs/diseno/red.md §4).
func redDe(o Opciones, s plan.TrampaPlan) string {
	if s.Manifiesto.Red != nil {
		return redPropiaDe(o)
	}
	if s.Manifiesto.Aislamiento != nil && s.Manifiesto.Aislamiento.Salida {
		return redConSalida
	}
	return redTrampas
}

// Descargas de imágenes en curso o fallidas, por imagen. Las lanza Aplicar y
// corren aparte; una fallida se reintenta pasado un rato.
var descargas = struct {
	sync.Mutex
	en map[string]*descarga
	wg sync.WaitGroup
}{en: map[string]*descarga{}}

type descarga struct {
	enCurso bool
	err     error
	fin     time.Time
}

const reintentoDescarga = 5 * time.Minute

// pedirImagen lanza (si no está ya) la descarga de una imagen y dice cómo va.
func pedirImagen(d *docker.Cliente, img string) string {
	descargas.Lock()
	defer descargas.Unlock()
	x := descargas.en[img]
	if x != nil && x.enCurso {
		return "descargando la imagen nueva"
	}
	if x != nil && x.err != nil && time.Since(x.fin) < reintentoDescarga {
		return "no se pudo descargar la imagen nueva (" + x.err.Error() + "); se reintenta"
	}
	descargas.en[img] = &descarga{enCurso: true}
	descargas.wg.Add(1)
	go func() {
		defer descargas.wg.Done()
		ctx, cancelar := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancelar()
		err := d.Descargar(ctx, img)
		descargas.Lock()
		descargas.en[img] = &descarga{err: err, fin: time.Now()}
		descargas.Unlock()
	}()
	return "descargando la imagen nueva"
}

const avisoAislamiento = "aviso: las trampas de esta máquina se ven entre sí (el motor de Docker no aplica el aislamiento entre contenedores)"

// Último resultado de la sonda por red. Es una propiedad del motor, no de
// las trampas: se vuelve a probar cada hora.
var sondas = map[string]struct {
	seVen  bool
	cuando time.Time
}{}

const cadaSonda = time.Hour

// comprobarAislamiento prueba, en cada red con dos trampas o más de este
// sensor, si dos contenedores de esa red se ven. Lo hacen dos contenedores
// efímeros con la imagen del sensor (uno escucha y otro llama), tan
// endurecidos como una trampa: no se toca ninguna trampa, que lo apuntaría
// como un ataque. Devuelve las redes donde se ven.
func comprobarAislamiento(ctx context.Context, d *docker.Cliente, o Opciones, sensor string, porRed map[string]int) map[string]bool {
	if o.ImagenSonda == "" {
		return nil
	}
	seVen := map[string]bool{}
	for red, n := range porRed {
		if n < 2 {
			continue
		}
		if s, ok := sondas[red]; ok && time.Since(s.cuando) < cadaSonda {
			seVen[red] = s.seVen
			continue
		}
		llega, err := sondear(ctx, d, o.ImagenSonda, sensor, red)
		if err != nil {
			continue // sin resultado no se avisa ni se guarda: se reintenta la próxima vez
		}
		sondas[red] = struct {
			seVen  bool
			cuando time.Time
		}{llega, time.Now()}
		seVen[red] = llega
	}
	return seVen
}

const etiquetaSonda = "sugardaddy.sonda"

func sondear(ctx context.Context, d *docker.Cliente, imagen, sensor, red string) (bool, error) {
	ctx, cancelar := context.WithTimeout(ctx, time.Minute)
	defer cancelar()
	// Las que quedaran de otra vuelta, por su etiqueta, nunca por nombre.
	if viejas, err := d.ListarConEtiqueta(ctx, etiquetaSonda+"="+sensor); err == nil {
		for _, c := range viejas {
			_ = d.Borrar(ctx, c.ID)
		}
	}
	crear := func(papel string, cmd ...string) (string, error) {
		// Con «_», que no cabe en el id de un sensor ni de una trampa: nunca
		// coincide con el nombre de un contenedor de trampa.
		id, err := d.Crear(ctx, "sd_sonda_"+sensor+"_"+papel, map[string]any{
			"Image":  imagen,
			"Cmd":    cmd,
			"Labels": map[string]string{etiquetaSonda: sensor},
			"HostConfig": map[string]any{
				"NetworkMode":    red,
				"ReadonlyRootfs": true,
				"CapDrop":        []string{"ALL"},
				"SecurityOpt":    []string{"no-new-privileges"},
				"Memory":         int64(32) << 20,
				"PidsLimit":      16,
				"LogConfig":      docker.RegistrosAcotados(),
			},
		})
		if err != nil {
			return "", err
		}
		return id, d.Arrancar(ctx, id)
	}
	limpiar := func(id string) { _ = d.Borrar(context.WithoutCancel(ctx), id) }

	escucha, err := crear("escucha", "escuchar", ":"+puertoSonda)
	if escucha != "" {
		defer limpiar(escucha)
	}
	if err != nil {
		return false, err
	}
	i, err := d.Inspeccionar(ctx, escucha)
	if err != nil {
		return false, err
	}
	ns, _ := i["NetworkSettings"].(map[string]any)
	redes, _ := ns["Networks"].(map[string]any)
	r, _ := redes[red].(map[string]any)
	ip, _ := r["IPAddress"].(string)
	if ip == "" {
		return false, fmt.Errorf("la sonda no tiene dirección en %s", red)
	}
	llama, err := crear("llama", "sondear", net.JoinHostPort(ip, puertoSonda))
	if llama != "" {
		defer limpiar(llama)
	}
	if err != nil {
		return false, err
	}
	codigo, err := d.Esperar(ctx, llama)
	if err != nil {
		return false, err
	}
	return codigo == 0, nil
}

// Puerto de la sonda: alto, porque la sonda no tiene capacidades.
const puertoSonda = "7777"

// La carpeta de registros es lo único del anfitrión que ve el contenedor. El
// honeypot corre con su propio usuario, así que tiene que poder escribir en ella.
func prepararRegistros(o Opciones, id string) error {
	dir := Registros(o, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Con el bit pegajoso: nadie más que su dueño puede apartar o cambiar los
	// ficheros del honeypot (por ejemplo, poner un FIFO en su lugar).
	return os.Chmod(dir, 0o777|os.ModeSticky)
}

func encendido(v any) bool {
	return v == true || v == "yes" || v == "true"
}

// puerto resuelve el puerto del anfitrión: uno fijo del manifiesto lleva el
// desplazamiento del nodo; uno que viene de un parámetro se usa tal cual,
// porque es el que ha elegido quien despliega.
func puerto(expuesto any, rellenar func(string) string, desplazar int) (int, error) {
	switch e := expuesto.(type) {
	case float64:
		return int(e) + desplazar, nil
	case string:
		n, err := strconv.Atoi(rellenar(e))
		if err != nil || n < 1 || n > 65535 {
			return 0, fmt.Errorf("puerto no válido: %q", rellenar(e))
		}
		return n, nil
	}
	return 0, fmt.Errorf("puerto no válido: %v", expuesto)
}

func escribirFichero(ruta, texto string) error {
	if err := os.MkdirAll(filepath.Dir(ruta), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(ruta, []byte(texto), 0o644); err != nil {
		return err
	}
	// El honeypot corre con su propio usuario: tiene que poder leerlo.
	return os.Chmod(ruta, 0o644)
}
