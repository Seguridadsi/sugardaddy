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
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
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
	// La trampa va con su disco de tamaño fijo (SEN-4, docs/diseno/discos-trampa.md).
	etiquetaDisco = "sugardaddy.disco"
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
	// EnLaRed da, para un puerto del anfitrión que se publicaría en 0.0.0.0,
	// las direcciones de red de la máquina donde publicarlo en su lugar porque
	// algo local ya lo tiene (motor.Anfitrion.PublicarEn); nil o sin función:
	// en Escucha, como siempre.
	EnLaRed func(proto string, puerto int) []string
	// Direcciones son las IPv4 de red de la máquina (motor.Anfitrion), sin las
	// locales ni las de los puentes de Docker. Con Escucha en 0.0.0.0 son las
	// que rellenan ${sd.ipsAnfitrion}; vacías si el sensor aún no las midió.
	Direcciones []string
	// RedPropia es el modo «IP propia» de este sensor (desde la 0.16.0;
	// docs/diseno/red.md): la interfaz física y el rango propio elegidos por
	// quien instala el sensor, o el puente de banco con su IP fija. nil: el
	// sensor no trae el modo y las trampas que lo piden dan su error, nunca
	// van al puente aislado sin decir nada.
	RedPropia *RedPropia
	// Catalogo dice por qué no se puede arrancar una trampa que no está en el catálogo
	// de la versión firmada instalada ("" si se puede; SEN-3). nil: sin catálogo, como
	// siempre. Una que ya está en marcha sigue como estaba, con el aviso.
	Catalogo func(plan.TrampaPlan) (motivo string)
	// sinEscribir: config solo calcula, sin escribir los ficheros de la trampa en el
	// anfitrión (para decir dónde está una trampa que el catálogo rechaza).
	sinEscribir bool
	// Discos da a cada trampa un disco de tamaño fijo para sus registros y sus
	// carpetas escribibles, si la máquina puede (SEN-4, docs/diseno/discos-trampa.md).
	// nil: sin discos, como antes.
	Discos *discos.Gestor
}

// idValido: el id de una trampa sale de la consola y acaba en una ruta del anfitrión
// (Registros) y en el nombre del contenedor. La consola los da en minúsculas y con guiones;
// aquí basta con que no pueda salir de su carpeta (SEN-3).
var idValido = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// CodigoCatalogo y CodigoSalida son los códigos estables de los dos rechazos de SEN-3.
const (
	CodigoCatalogo = "catalogo.fuera"
	CodigoSalida   = "aislamiento.salida"
	CodigoID       = "plan.id"
)

type Estado struct {
	ID    string `json:"id"`
	Donde string `json:"donde"`
	// Codigo estable (fase.causa) del fallo, si lo hay. Desde la 0.13.1; las
	// consolas anteriores lo ignoran y ven el mismo código al principio de Donde.
	Codigo string `json:"codigo,omitempty"`
	// Avisos: los códigos de lo que hay que saber de una trampa que funciona (sin
	// disco propio, disco.sin-loop…). Su texto va también en Donde.
	Avisos []string `json:"avisos,omitempty"`
}

func recortarID(id string) string {
	if len(id) > 64 {
		return id[:64]
	}
	return id
}

// Lo que puede tardar el motor en dar la lista de contenedores: si no la da
// en este tiempo, no responde.
const esperaMotor = time.Minute

// Registros es la carpeta de registros de una trampa, donde la lee el sensor: en su
// disco si su contenedor va con él; si no, en la carpeta del sensor. Sin el disco
// montado, la de su disco no existe y no se lee nada: no se confunde con otra.
func Registros(o Opciones, id string) string {
	if o.Discos != nil && o.Discos.Usa(id) {
		return discos.Registros(o.Datos, id)
	}
	return registrosAnfitrion(o, id)
}

// registrosAnfitrion: la carpeta de registros de una trampa sin disco.
func registrosAnfitrion(o Opciones, id string) string {
	return filepath.Join(o.Datos, "registros", id)
}

// prefijoVolumenDisco: los volúmenes de las escribibles que están en el disco de su
// trampa. Con «_», que no cabe en el id de un sensor ni de una trampa: no se
// confunden con los de antes (sd-<sensor>-<id>-<i>).
const prefijoVolumenDisco = "sd_disco_"

func volumenDisco(sensor, id string, i int) string {
	return fmt.Sprintf("%s%s_%s_%d", prefijoVolumenDisco, sensor, id, i)
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
//
// conDisco: sus registros y sus escribibles van en su disco (SEN-4). Sin el disco
// montado, ninguna de las dos carpetas existe y Docker no arranca la trampa (un
// montaje bind sin origen es un error, y lo mismo el volumen que es una carpeta
// del disco): ni tras un reinicio de la máquina, antes de que el sensor lo monte,
// escribe nada en el disco de la máquina. Por eso puede seguir con unless-stopped.
// volumenesImagen son los VOLUME que declara su imagen: con disco, los que la
// trampa no monta van también a él (si no, Docker les pondría un volumen anónimo
// en el disco de la máquina, sin tope).
func config(o Opciones, sensor, licenciaRuta string, s plan.TrampaPlan, conDisco bool, volumenesImagen []string) (map[string]any, []string, error) {
	c, a := s.Manifiesto.Contenedor, s.Manifiesto.Aislamiento
	if c == nil || a == nil {
		return nil, nil, fmt.Errorf("decoy %s is missing its container or isolation", s.ID)
	}

	rellenar := func(t string) string {
		return hueco.ReplaceAllStringFunc(t, func(h string) string {
			nombre := h[2 : len(h)-1]
			if nombre == "sd.ipsAnfitrion" {
				return ipsAnfitrion(o)
			}
			return fmt.Sprint(s.Parametros[nombre])
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
			return nil, nil, fmt.Errorf("decoy %s has network mode %q and the sensor only understands ip-propia (docs/diseno/red.md §1)", s.ID, s.Manifiesto.Red.Modo)
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
			ips := []string{o.Escucha}
			if o.Escucha == "0.0.0.0" && o.EnLaRed != nil {
				if en := o.EnLaRed(p.Protocolo, anfitrion); len(en) > 0 {
					ips = en
				}
			}
			var enlaces []map[string]string
			for _, ip := range ips {
				enlaces = append(enlaces, map[string]string{"HostIp": ip, "HostPort": fmt.Sprint(anfitrion)})
				donde = append(donde, fmt.Sprintf("%s:%d", ip, anfitrion))
			}
			publicados[clave] = enlaces
		}
	}

	registros := registrosAnfitrion(o, s.ID)
	if conDisco {
		registros = discos.Registros(o.Datos, s.ID)
	}
	montajes := []map[string]any{{
		"Type": "bind", "Source": registros, "Target": c.Registros,
	}}
	// Los ficheros de configuración se escriben en el anfitrión y entran de solo
	// lectura. Su contenido va en la huella: si cambia, el contenedor se rehace.
	contenidos := sha256.New()
	for i, f := range c.Ficheros {
		origen := filepath.Join(o.Datos, "config", s.ID, fmt.Sprint(i))
		texto := rellenar(f.Contenido)
		if !o.sinEscribir {
			if err := escribirFichero(origen, texto); err != nil {
				return nil, nil, err
			}
		}
		contenidos.Write([]byte(texto + "\x00"))
		montajes = append(montajes, map[string]any{
			"Type": "bind", "Source": origen, "Target": f.Destino, "ReadOnly": true,
		})
	}
	// La licencia de pago, de solo lectura, en ruta fija, solo en las trampas de
	// pago (la consola lo dice en el plan): en Cowrie o en una gratis solo
	// serviría para que quien la tome lea el nombre del cliente y sus módulos
	// (SEN-9). Con una consola anterior, que no lo dice, en todas. La ruta del
	// anfitrión es constante, así que reemitir la licencia (mismo fichero,
	// contenido nuevo) no rehace la trampa; que una copia envejezca se apoya en
	// que la trampa relea al reiniciarse.
	if licenciaRuta != "" && (s.Licencia == nil || *s.Licencia) {
		montajes = append(montajes, map[string]any{
			"Type": "bind", "Source": licenciaRuta, "Target": rutaLicenciaTrampa, "ReadOnly": true,
		})
	}
	for i, ruta := range c.Escribibles {
		// Con etiquetas, para encontrarlos y borrarlos al retirar la trampa
		// aunque su contenedor ya no esté.
		etiquetas := map[string]string{etiquetaSensor: sensor, etiquetaTrampa: s.ID}
		v := map[string]any{
			"Type": "volume", "Source": fmt.Sprintf("sd-%s-%s-%d", sensor, s.ID, i), "Target": ruta,
			"VolumeOptions": map[string]any{"Labels": etiquetas},
		}
		if conDisco {
			// Un volumen que es su carpeta del disco: Docker lo llena la primera vez
			// con lo que trae la imagen (con su dueño), como cualquier volumen.
			v["Source"] = volumenDisco(sensor, s.ID, i)
			v["VolumeOptions"] = map[string]any{"Labels": etiquetas, "DriverConfig": map[string]any{
				"Name":    "local",
				"Options": map[string]string{"type": "none", "o": "bind", "device": discos.Escribible(o.Datos, s.ID, i)},
			}}
		}
		montajes = append(montajes, v)
	}
	if conDisco {
		for _, ruta := range sinMontar(volumenesImagen, objetivosFijos(s, licenciaRuta)) {
			carpeta := discos.CarpetaImagen(ruta)
			montajes = append(montajes, map[string]any{
				"Type": "volume", "Source": prefijoVolumenDisco + sensor + "_" + s.ID + "_" + carpeta, "Target": ruta,
				"VolumeOptions": map[string]any{
					"Labels": map[string]string{etiquetaSensor: sensor, etiquetaTrampa: s.ID},
					"DriverConfig": map[string]any{
						"Name":    "local",
						"Options": map[string]string{"type": "none", "o": "bind", "device": filepath.Join(discos.Dir(o.Datos, s.ID), carpeta)},
					},
				},
			})
		}
	}

	red := redTrampas
	if a.Salida {
		red = redConSalida
	}
	cfg := map[string]any{
		"Image":        c.Imagen,
		"Env":          entorno,
		"ExposedPorts": expuestos,
		"Labels":       etiquetasTrampa(s.ID, sensor, hex.EncodeToString(contenidos.Sum(nil)[:8]), conDisco),
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
				return nil, nil, fmt.Errorf("the decoy capture filter (%s) is not valid: %v", capturar, err)
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

// objetivosFijos: dónde monta config algo en la trampa, además de los VOLUME de su imagen.
func objetivosFijos(s plan.TrampaPlan, licenciaRuta string) []string {
	c := s.Manifiesto.Contenedor
	if c == nil {
		return nil
	}
	t := []string{c.Registros, "/tmp"}
	for _, f := range c.Ficheros {
		t = append(t, f.Destino)
	}
	if licenciaRuta != "" && (s.Licencia == nil || *s.Licencia) {
		t = append(t, rutaLicenciaTrampa)
	}
	return append(t, c.Escribibles...)
}

// sinMontar: los VOLUME de la imagen que no tienen ya un montaje justo ahí (Docker
// les pondría un volumen anónimo aunque haya montajes más adentro), sin repetir y
// ordenados: la huella no cambia de una vuelta a otra.
func sinMontar(volumenes, objetivos []string) []string {
	puestos := map[string]bool{}
	for _, t := range objetivos {
		puestos[filepath.Clean(t)] = true
	}
	var r []string
	for _, v := range volumenes {
		if v = filepath.Clean(v); filepath.IsAbs(v) && !puestos[v] && !slices.Contains(r, v) {
			r = append(r, v)
		}
	}
	sort.Strings(r)
	return r
}

// carpetasImagen: las carpetas del disco para los VOLUME de la imagen que la trampa no monta.
func carpetasImagen(s plan.TrampaPlan, licenciaRuta string, volumenesImagen []string) []string {
	var r []string
	for _, ruta := range sinMontar(volumenesImagen, objetivosFijos(s, licenciaRuta)) {
		r = append(r, discos.CarpetaImagen(ruta))
	}
	return r
}

// Lo que declara como VOLUME cada imagen (fijada por digest: no cambia), por si la
// trampa no lo monta: así no se pregunta al motor en cada vuelta.
var volumenesDe = struct {
	sync.Mutex
	en map[string][]string
}{en: map[string][]string{}}

// volumenesDeImagen: los VOLUME que declara una imagen local. Un error que no es
// «no está» deja la trampa como esté: sin saberlos, su huella cambiaría.
func volumenesDeImagen(ctx context.Context, d *docker.Cliente, imagen string) ([]string, error) {
	volumenesDe.Lock()
	v, ya := volumenesDe.en[imagen]
	volumenesDe.Unlock()
	if ya {
		return v, nil
	}
	i, err := d.InspeccionarImagen(ctx, imagen)
	if err != nil {
		return nil, err
	}
	cfg, _ := i["Config"].(map[string]any)
	vols, _ := cfg["Volumes"].(map[string]any)
	v = []string{}
	for ruta := range vols {
		v = append(v, ruta)
	}
	sort.Strings(v)
	if strings.Contains(imagen, "@sha256:") {
		volumenesDe.Lock()
		volumenesDe.en[imagen] = v
		volumenesDe.Unlock()
	}
	return v, nil
}

func etiquetasTrampa(id, sensor, ficheros string, conDisco bool) map[string]string {
	e := map[string]string{etiquetaTrampa: id, etiquetaSensor: sensor, etiquetaFicheros: ficheros}
	if conDisco {
		e[etiquetaDisco] = "1"
	}
	return e
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

	// Los discos de las trampas (SEN-4, docs/diseno/discos-trampa.md): si esta
	// máquina puede, cada trampa va con el suyo. Se averigua antes que nada (una
	// vez), para no rehacer ninguna trampa antes de saberlo.
	maquina := ""
	if o.Discos != nil {
		maquina = o.Discos.Maquina(ctx, p.Sensor, len(p.Trampas) > 0)
		o.Discos.Olvidar(quedan)
	}

	// La licencia de pago, si el nodo la tiene, se escribe una vez y se monta en
	// cada trampa. Se escribe en el sitio (os.WriteFile trunca) para que una
	// trampa ya en marcha vea el contenido nuevo al reiniciarse, sin rehacerse.
	// Sin licencia (edición gratis) se borra la que quedara: las gratis siguen
	// igual y una de pago dejaría de arrancar en su próximo redespliegue.
	licenciaRuta := licenciaFichero(o)
	if len(p.Licencia) > 0 {
		if err := escribirFichero(licenciaRuta, string(p.Licencia)); err != nil {
			fallos = append(fallos, fmt.Errorf("writing the license: %w", err))
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
	// Y su disco: si no está montado (tras un reinicio) lo borra el sensor; si lo
	// está, el auxiliar, junto con lo que haya que montar.
	var retirarDiscos []string
	if o.Discos != nil {
		for _, id := range o.Discos.Presentes() {
			if !quedan[id] && !o.Discos.RetirarSinAuxiliar(id) {
				retirarDiscos = append(retirarDiscos, id)
			}
		}
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
	// Las trampas que van sin disco y por qué (disco.sin-loop…): lo dice su estado.
	sinDisco := map[string]string{}
	// Las que esperan a que el auxiliar monte su disco, que va una sola vez al final.
	var pendientes []pendiente
	// crear crea y arranca el contenedor de una trampa. Con disco, nunca sin él montado.
	crear := func(s plan.TrampaPlan, cfg map[string]any, aqui string, conDisco bool, nec discos.Montaje) Estado {
		if !conDisco {
			if err := prepararRegistros(o, s.ID); err != nil {
				return Estado{ID: s.ID, Donde: "error: log folder: " + err.Error()}
			}
		} else if !o.Discos.Listo(nec) {
			return Estado{ID: s.ID, Donde: "error: its disk is not mounted", Codigo: discos.CodigoError}
		}
		id, err := d.Crear(ctx, "sd-"+p.Sensor+"-"+s.ID, cfg)
		if err == nil {
			err = d.Arrancar(ctx, id)
		}
		if err != nil {
			return Estado{ID: s.ID, Donde: "error: " + err.Error()}
		}
		if o.Discos != nil {
			o.Discos.Usar(s.ID, conDisco)
		}
		if s.Manifiesto.Red != nil {
			// La MAC del contenedor recién creado, para el vigilante ARP
			// (hallazgo 1: no dar por reclamo el ARP de una trampa propia).
			apuntarMAC(ctx, d, id, s.ID)
		} else {
			// para las sondas de aislamiento van solo las del puente:
			// las de IP propia comparten segmento por diseño.
			porRed[redDe(o, s)]++
		}
		return Estado{ID: s.ID, Donde: aqui}
	}
	for _, s := range p.Trampas {
		if !idValido.MatchString(s.ID) || strings.Contains(s.ID, "..") {
			estados = append(estados, Estado{ID: recortarID(s.ID), Donde: "error: invalid decoy identifier", Codigo: CodigoID})
			continue
		}
		c, existe := porID[s.ID]
		// Dónde lee el sensor sus registros: donde los escribe su contenedor de ahora.
		discoAhora := existe && c.Labels[etiquetaDisco] == "1"
		if o.Discos != nil && existe {
			o.Discos.Usar(s.ID, discoAhora)
		}
		if aviso, parada := o.Paradas[s.ID]; parada {
			// Si sigue en marcha (el sensor se reinició o no la pudo parar), se para.
			if existe && c.State == "running" {
				if err := parar(ctx, d, c.ID); err != nil {
					fallos = append(fallos, fmt.Errorf("parar %s: %w", s.ID, err))
				}
			}
			// Parada, su disco sigue montado: el sensor tiene que leerla para dejarla volver.
			if discoAhora && maquina == discos.CodigoFijo && !o.Discos.Montado(s.ID) {
				pendientes = append(pendientes, pendiente{i: -1, s: s, montar: true, nec: necesidad(s, "", nil)})
			}
			estados = append(estados, Estado{ID: s.ID, Donde: prefijoParada + aviso})
			continue
		}
		// Ninguna trampa sale a internet (SEN-3): ninguna lo usa, y con NAT de salida una
		// consola tomada tendría un contenedor con salida en cada VLAN con sensor.
		if s.Manifiesto.Aislamiento != nil && s.Manifiesto.Aislamiento.Salida {
			estados = append(estados, Estado{ID: s.ID, Donde: "error: decoys may not reach the internet (isolation.outbound)", Codigo: CodigoSalida})
			continue
		}
		conDisco := maquina == discos.CodigoFijo && o.Discos.Fallo(s.ID) == ""
		if o.Discos != nil && !conDisco {
			if porque := codigoSinDisco(maquina, o.Discos.Fallo(s.ID)); porque != "" {
				sinDisco[s.ID] = porque
			}
		}
		// Con disco, los VOLUME de su imagen que no monta van también a él.
		var volsImagen []string
		var errImagen error
		if conDisco && s.Manifiesto.Contenedor != nil {
			// Sin la imagen aún (se descarga más abajo) no se saben, pero tampoco se
			// creará el contenedor hasta tenerla.
			volsImagen, errImagen = volumenesDeImagen(ctx, d, s.Manifiesto.Contenedor.Imagen)
			if docker.NoExiste(errImagen) {
				errImagen = nil
			}
		}
		// El catálogo se mira antes de escribir nada: config escribe los ficheros de la trampa
		// en el anfitrión, y la que está en marcha los ve al momento (A2 de la revisión).
		if o.Catalogo != nil {
			if motivo := o.Catalogo(s); motivo != "" {
				// La que ya está en marcha salió de un manifiesto que valía: sigue como estaba.
				if existe && c.State == "running" {
					calcular := o
					calcular.sinEscribir = true
					aqui := "running"
					if _, donde, err := config(calcular, p.Sensor, licenciaRuta, s, conDisco, volsImagen); err == nil {
						aqui = strings.Join(donde, ", ")
					}
					estados = append(estados, Estado{ID: s.ID, Donde: aqui + " · warning: " + motivo + "; it keeps running as before", Codigo: CodigoCatalogo})
				} else {
					estados = append(estados, Estado{ID: s.ID, Donde: "error: " + motivo, Codigo: CodigoCatalogo})
				}
				continue
			}
		}
		nec := necesidad(s, licenciaRuta, volsImagen)
		cfg, donde, err := config(o, p.Sensor, licenciaRuta, s, conDisco, volsImagen)
		if err != nil {
			estados = append(estados, Estado{ID: s.ID, Donde: "error: " + err.Error()})
			continue
		}
		aqui := strings.Join(donde, ", ")
		if errImagen != nil {
			// Sin saber sus VOLUME, su huella cambiaría y se rehará sin ellos: se deja como esté.
			if existe && c.State == "running" {
				estados = append(estados, Estado{ID: s.ID, Donde: aqui + " · warning: could not inspect its image (" + errImagen.Error() + "); it keeps running as before"})
			} else {
				estados = append(estados, Estado{ID: s.ID, Donde: "error: could not inspect its image (" + errImagen.Error() + ")"})
			}
			continue
		}
		h := huella(cfg)
		cfg["Labels"].(map[string]string)[etiquetaHuella] = h

		enMarcha := existe && c.State == "running"
		if discoAhora && o.Discos != nil && maquina == "" {
			// Aún no se sabe si la máquina puede (un fallo pasajero del auxiliar): la
			// que ya va con disco no se rehace sin él. Se espera.
			if enMarcha {
				estados = append(estados, Estado{ID: s.ID, Donde: aqui + " · warning: waiting to check its disk; it keeps running as before"})
			} else {
				estados = append(estados, Estado{ID: s.ID, Donde: "error: waiting to mount its disk", Codigo: discos.CodigoError})
			}
			continue
		}
		if enMarcha && c.Labels[etiquetaHuella] == h {
			if conDisco && !o.Discos.Listo(nec) {
				// Le han desmontado el disco con la trampa en marcha: se vuelve a montar
				// (el mismo dispositivo, que ella aún tiene) para seguir leyéndola.
				pendientes = append(pendientes, pendiente{i: len(estados), s: s, aqui: aqui, montar: true, nec: nec})
				estados = append(estados, Estado{ID: s.ID})
				continue
			}
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
				estados = append(estados, Estado{ID: s.ID, Donde: aqui + " · warning: " + aviso + "; it keeps running as before"})
			} else {
				estados = append(estados, Estado{ID: s.ID, Donde: "error: " + aviso})
			}
		}
		if e := errRed[redDe(o, s)]; e != nil {
			sigue("could not prepare the decoy network (" + e.Error() + ")")
			continue
		}
		// La imagen se descarga aparte: una descarga larga no para al sensor
		// (ni su salud, ni la lectura de eventos) y la trampa sigue con la
		// imagen de antes hasta que la nueva esté entera.
		if img := s.Manifiesto.Contenedor.Imagen; !d.ImagenPresente(ctx, img) {
			sigue(pedirImagen(d, img))
			continue
		}
		// El contenedor de antes se quita antes de montar su disco: lo que tenga
		// en la carpeta de la máquina pasa al disco nuevo con nadie escribiendo.
		if existe {
			if err := borrar(ctx, d, c.ID); err != nil {
				sigue("could not remove the previous container (" + err.Error() + ")")
				continue
			}
		}
		if conDisco && !o.Discos.Listo(nec) {
			pendientes = append(pendientes, pendiente{i: len(estados), s: s, cfg: cfg, aqui: aqui, nec: nec})
			estados = append(estados, Estado{ID: s.ID})
			continue
		}
		estados = append(estados, crear(s, cfg, aqui, conDisco, nec))
	}

	// Los discos que faltan y los que sobran, con un solo auxiliar.
	if len(pendientes) > 0 || len(retirarDiscos) > 0 {
		var montar []discos.Montaje
		for _, x := range pendientes {
			montar = append(montar, conViejos(ctx, d, p.Sensor, x.nec))
		}
		res := o.Discos.Asegurar(ctx, p.Sensor, montar, retirarDiscos)
		for _, x := range pendientes {
			e := res[x.s.ID]
			montado := e.Codigo == "" && o.Discos.Listo(x.nec)
			switch {
			case x.i < 0:
				// Parada: su estado no cambia.
			case montado && x.montar:
				estados[x.i] = Estado{ID: x.s.ID, Donde: x.aqui}
				if x.s.Manifiesto.Red == nil {
					porRed[redDe(o, x.s)]++
				}
			case montado:
				estados[x.i] = crear(x.s, x.cfg, x.aqui, true, x.nec)
			case x.montar:
				estados[x.i] = Estado{ID: x.s.ID, Donde: "error: its disk could not be mounted again, so its events cannot be read (" + motivoDisco(e) + ")", Codigo: e.Codigo}
			case o.Discos.Fallo(x.s.ID) != "" || o.Discos.Maquina(ctx, p.Sensor, true) != discos.CodigoFijo:
				// Sin su disco, por la máquina o por el suyo: va como antes, con el
				// vigilante de 10 s, y se dice.
				sinDisco[x.s.ID] = codigoSinDisco(o.Discos.Maquina(ctx, p.Sensor, true), o.Discos.Fallo(x.s.ID))
				cfg, donde, err := config(o, p.Sensor, licenciaRuta, x.s, false, nil)
				if err != nil {
					estados[x.i] = Estado{ID: x.s.ID, Donde: "error: " + err.Error()}
					continue
				}
				cfg["Labels"].(map[string]string)[etiquetaHuella] = huella(cfg)
				estados[x.i] = crear(x.s, cfg, strings.Join(donde, ", "), false, x.nec)
			default:
				// Pasajero: se espera, sin rehacerla sin disco.
				estados[x.i] = Estado{ID: x.s.ID, Donde: "error: waiting to mount its disk (" + motivoDisco(e) + ")", Codigo: discos.CodigoError}
			}
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
		if c := sinDisco[e.ID]; c != "" {
			estados[i].Donde += " · " + avisoSinDisco(c)
			estados[i].Avisos = append(estados[i].Avisos, c)
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

// pendiente: una trampa que espera a que el auxiliar monte su disco. i es su sitio
// en los estados (-1: parada, su estado no cambia); montar, que solo hay que montar
// (su contenedor sigue en marcha o está parada), sin crear nada.
type pendiente struct {
	i      int
	s      plan.TrampaPlan
	cfg    map[string]any
	aqui   string
	montar bool
	nec    discos.Montaje // lo que tiene que tener su disco
}

// necesidad: lo que tiene que tener el disco de una trampa para su contenedor: una
// carpeta por escribible y otra por cada VOLUME de su imagen que no monta.
func necesidad(s plan.TrampaPlan, licenciaRuta string, volumenesImagen []string) discos.Montaje {
	m := discos.Montaje{ID: s.ID, Carpetas: carpetasImagen(s, licenciaRuta, volumenesImagen)}
	if s.Manifiesto.Contenedor != nil {
		m.Escribibles = len(s.Manifiesto.Contenedor.Escribibles)
	}
	return m
}

// conViejos añade a lo que necesita el auxiliar los volúmenes de antes del disco
// (los de sus escribibles), cuyo contenido pasa al disco si es nuevo: las claves
// SSH de Cowrie no cambian.
func conViejos(ctx context.Context, d *docker.Cliente, sensor string, m discos.Montaje) discos.Montaje {
	if m.Escribibles == 0 {
		return m
	}
	ctx, cancelar := context.WithTimeout(ctx, 30*time.Second)
	defer cancelar()
	vs, err := d.Volumenes(ctx, map[string][]string{"label": {etiquetaSensor + "=" + sensor, etiquetaTrampa + "=" + m.ID}})
	if err != nil {
		return m
	}
	for _, v := range vs {
		for i := 0; i < m.Escribibles; i++ {
			if v.Name == fmt.Sprintf("sd-%s-%s-%d", sensor, m.ID, i) {
				if m.Volumenes == nil {
					m.Volumenes = map[int]string{}
				}
				m.Viejos = append(m.Viejos, i)
				m.Volumenes[i] = v.Name
			}
		}
	}
	sort.Ints(m.Viejos)
	return m
}

// codigoSinDisco: por qué una trampa va sin disco. Sin saber aún si la máquina
// puede (un fallo pasajero), nada que decir.
func codigoSinDisco(maquina, fallo string) string {
	switch {
	case maquina == "":
		return ""
	case maquina != discos.CodigoFijo:
		return maquina
	}
	return fallo
}

func motivoDisco(e discos.Estado) string {
	if e.Detalle != "" {
		return e.Codigo + ": " + e.Detalle
	}
	return e.Codigo
}

// avisoSinDisco: lo que dice el estado de una trampa sin disco propio. La consola
// guarda 200 caracteres de él; el hecho disco.trampas lo explica entero.
func avisoSinDisco(codigo string) string {
	return "warning: no fixed-size disk (" + codigo + "); its folders are checked every 10 s"
}

const avisoSinGarantia = "warning: the container engine does not confirm that this decoy cannot reach the Internet or see the other decoys"

// avisoSegmento: lo que cambia el modo «IP propia» (docs/diseno/red.md §2):
// sin puente aislado que las separe, las trampas con IP propia son equipos
// más del segmento del cliente. Los atacantes de una trampa pueden ver a
// las demás, como pueden ver cualquier equipo real de esa red.
const avisoSegmento = "warning: with its own IP the decoy sits on the customer segment, not isolated from the other decoys or the devices on that network"

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
// 0.12.1) o, los de antes, por su nombre exacto. Y los de una trampa que sigue y
// ya no los usa: los de antes del disco cuando su contenedor ya va con él (su
// contenido ya pasó al disco), o los del disco cuando va sin él.
func borrarVolumenesRetirados(ctx context.Context, d *docker.Cliente, sensor string, quedan map[string]bool, porID map[string]docker.Contenedor) error {
	ctx, cancelar := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancelar()
	var fallos []error
	etiquetados, err := d.Volumenes(ctx, map[string][]string{"label": {etiquetaSensor + "=" + sensor}})
	if err != nil {
		return err
	}
	for _, v := range etiquetados {
		id := v.Labels[etiquetaTrampa]
		if id == "" {
			continue
		}
		sobra := !quedan[id]
		if c, existe := porID[id]; quedan[id] && existe {
			sobra = (c.Labels[etiquetaDisco] == "1") != strings.HasPrefix(v.Name, prefijoVolumenDisco)
		}
		if sobra {
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

// ContenedorDeTrampa da el id del contenedor EN MARCHA de una trampa de este
// sensor, para sacarle un fichero que capturó (captura de artefactos). "" si no
// hay (la trampa no está, o está parada): el que llama lo reintenta. Solo mira
// contenedores de este sensor por su etiqueta, nunca de otro de la máquina.
func ContenedorDeTrampa(ctx context.Context, d *docker.Cliente, sensor, trampa string) (string, error) {
	cs, err := d.ListarConEtiqueta(ctx, etiquetaSensor+"="+sensor)
	if err != nil {
		return "", err
	}
	for _, c := range cs {
		id := c.Labels[etiquetaTrampa]
		if id == "" {
			id = c.Labels[etiquetaAntigua]
		}
		if id == trampa && c.State == "running" {
			return c.ID, nil
		}
	}
	return "", nil
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
		return "downloading the new image"
	}
	if x != nil && x.err != nil && time.Since(x.fin) < reintentoDescarga {
		return "could not download the new image (" + x.err.Error() + "); will retry"
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
	return "downloading the new image"
}

const avisoAislamiento = "warning: the decoys on this machine can see each other (the Docker engine does not enforce isolation between containers)"

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
		return false, fmt.Errorf("the probe has no address on %s", red)
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
//
// Solo la de una trampa sin disco: dentro de discos/<id>/ no crea nunca nada el
// sensor. Si creara la carpeta de registros con el disco desmontado, Docker podría
// arrancar la trampa sobre el disco de la máquina.
func prepararRegistros(o Opciones, id string) error {
	dir := registrosAnfitrion(o, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Con el bit pegajoso: nadie más que su dueño puede apartar o cambiar los
	// ficheros del honeypot (por ejemplo, poner un FIFO en su lugar).
	return os.Chmod(dir, 0o777|os.ModeSticky)
}

// ipsAnfitrion rellena ${sd.ipsAnfitrion} (contrato: HUECOS_DEL_SENSOR): las IP
// de la máquina por las que llega el atacante, separadas por comas, para lo que
// una trampa anuncia en el descubrimiento (SSDP, WS-Discovery). Dentro del
// contenedor la trampa solo ve la IP interna de Docker, que la delataría. La de
// escucha si el sensor publica en una; si publica en todas, las de sus
// interfaces de red; vacío si aún no las sabe (la trampa usa la suya).
func ipsAnfitrion(o Opciones) string {
	if o.Escucha != "" && o.Escucha != "0.0.0.0" {
		return o.Escucha
	}
	return strings.Join(o.Direcciones, ",")
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
			return 0, fmt.Errorf("invalid port: %q", rellenar(e))
		}
		return n, nil
	}
	return 0, fmt.Errorf("invalid port: %v", expuesto)
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

// PuertosPropios da los puertos que publican en el anfitrión las trampas de
// este sensor («tcp/2222»…): la sonda de puertos los ve ocupados, pero son
// suyos.
func PuertosPropios(ctx context.Context, d *docker.Cliente, sensor string) (map[string]bool, error) {
	existentes, err := d.ListarConEtiqueta(ctx, etiquetaSensor+"="+sensor)
	if err != nil {
		return nil, err
	}
	r := map[string]bool{}
	for _, c := range existentes {
		for _, p := range c.Ports {
			if p.PublicPort > 0 {
				r[fmt.Sprintf("%s/%d", p.Type, p.PublicPort)] = true
			}
		}
	}
	return r, nil
}
