package actualizador

// El aislamiento de las trampas en los nodos de antes de la 0.30.1
// (docs/diseno/aislamiento-trampas.md §4 y §5). instalar.sh carga el perfil
// AppArmor de las trampas y pone la unidad sd-discos; un nodo instalado antes no
// los tiene, y el compose nuevo no puede ponerlos: son de la máquina. Los pone el
// auxiliar de cada versión (asegurarAislamiento), con un contenedor de un instante
// de la imagen del actualizador (orden «aislar-anfitrion») que entra en la raíz de
// la máquina y hace lo mismo que instalar.sh, con el mismo perfil y las mismas
// unidades (lo comprueba una prueba). Nada de esto para la versión: lo que no
// sale se dice en el resultado y la trampa sigue como estaba (runc-seccomp, sin
// disco propio).

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// PerfilAppArmor es el perfil de las trampas, el mismo que escribe instalar.sh.
//
//go:embed scripts/sugardaddy-trampa.apparmor
var PerfilAppArmor []byte

// NombrePerfilAppArmor es el nombre del perfil (TRAMPAS_APPARMOR en .env).
const NombrePerfilAppArmor = "sugardaddy-trampa"

// Rutas en la máquina, las mismas que usa instalar.sh.
const (
	rutaPerfil       = "/etc/apparmor.d/sugardaddy-trampa"
	rutaUnidad       = "/etc/systemd/system/sd-discos.service"
	rutaUnidadPath   = "/etc/systemd/system/sd-discos.path"
	CarpetaBinarios  = "/usr/local/lib/sugardaddy"
	BuzonDiscos      = "/var/lib/sugardaddy/discos"
	binarioSdDiscos  = CarpetaBinarios + "/sd-discos"
	marcaInstalado   = BuzonDiscos + "/instalado"
	rutaAppArmorFS   = "/sys/kernel/security/apparmor"
	rutaSystemdVivo  = "/run/systemd/system"
	MarcaAislamiento = `{"aislamiento":`
)

// Estados de cada pieza en la máquina.
const (
	PiezaPuesta   = "puesta"    // cargada (AppArmor) o en marcha (sd-discos)
	PiezaNoAplica = "no-aplica" // la máquina no tiene AppArmor o systemd
	PiezaFallo    = "fallo"
)

// ResultadoAnfitrion es lo que deja el contenedor «aislar-anfitrion» en su salida.
type ResultadoAnfitrion struct {
	AppArmor string   `json:"apparmor"`
	Discos   string   `json:"discos"`
	Detalle  []string `json:"detalle,omitempty"`
}

// UnidadesDiscos son las unidades de sd-discos para la carpeta del sensor dada,
// letra por letra las de instalar.sh (con $DIR/datos/sensor ya sustituido).
func UnidadesDiscos(datosSensor string) (servicio, path string) {
	servicio = `# Discos de las trampas de Sugardaddy (docs/diseno/aislamiento-trampas.md §5).
[Unit]
Description=Sugardaddy decoy disks
[Service]
Type=oneshot
ExecStart=/usr/local/lib/sugardaddy/sd-discos discos-anfitrion /var/lib/sugardaddy/discos ` + datosSensor + `
# Montar un fichero en loop y formatearlo pide CAP_SYS_ADMIN; dejar las carpetas a
# quien las usa, CHOWN y FOWNER. Nada más. Sin red. Sin espacio de montaje propio
# (ProtectSystem, PrivateTmp…): los discos que monta tienen que verse en la máquina.
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
AmbientCapabilities=
NoNewPrivileges=yes
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
TimeoutStartSec=10min
`
	path = `[Unit]
Description=Sugardaddy decoy disks: request mailbox
[Path]
PathExists=/var/lib/sugardaddy/discos/peticion.json
[Install]
WantedBy=multi-user.target
`
	return servicio, path
}

// Una ruta que puede ir en ExecStart sin comillas ni sorpresas.
var rutaSegura = regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`)

// RutaDatosValida dice si la carpeta del sensor se puede escribir en la unidad.
func RutaDatosValida(p string) bool {
	return rutaSegura.MatchString(p) && filepath.Clean(p) == p && !strings.Contains(p, "/../") && !strings.HasSuffix(p, "/..")
}

// Anfitrion prepara la máquina. Raiz es «/» dentro del contenedor «aislar-anfitrion»
// (tras entrar en la raíz de la máquina) y una carpeta en las pruebas.
type Anfitrion struct {
	Raiz string
	// Ejecutar lanza una orden de la máquina (apparmor_parser, systemctl).
	Ejecutar func(nombre string, args ...string) ([]byte, error)
	// Hay dice si la máquina tiene esa orden.
	Hay func(nombre string) bool
}

func (h Anfitrion) ruta(p string) string { return filepath.Join(h.Raiz, p) }

func (h Anfitrion) esCarpeta(p string) bool {
	fi, err := os.Stat(h.ruta(p))
	return err == nil && fi.IsDir()
}

// escribirSiCambia deja el fichero con ese contenido; dice si lo ha cambiado.
// Lo que haya en su lugar (un enlace, por ejemplo) se sustituye, nunca se sigue.
func (h Anfitrion) escribirSiCambia(p string, contenido []byte, modo os.FileMode) (bool, error) {
	r := h.ruta(p)
	if fi, err := os.Lstat(r); err == nil && fi.Mode().IsRegular() {
		if actual, err := os.ReadFile(r); err == nil && bytes.Equal(actual, contenido) {
			return false, nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(r), 0o755); err != nil {
		return false, err
	}
	return true, escribirAtomico(r, contenido, modo)
}

// Preparar carga el perfil AppArmor de las trampas y pone en marcha sd-discos,
// como instalar.sh. Es idempotente: lo que ya está igual no se toca.
func (h Anfitrion) Preparar(datosSensor string) ResultadoAnfitrion {
	r := ResultadoAnfitrion{AppArmor: PiezaNoAplica, Discos: PiezaNoAplica}
	fallo := func(pieza *string, formato string, args ...any) {
		*pieza = PiezaFallo
		r.Detalle = append(r.Detalle, fmt.Sprintf(formato, args...))
	}
	// 1. AppArmor, si la máquina lo tiene.
	if h.esCarpeta(rutaAppArmorFS) && h.Hay("apparmor_parser") {
		if _, err := h.escribirSiCambia(rutaPerfil, PerfilAppArmor, 0o644); err != nil {
			fallo(&r.AppArmor, "AppArmor profile: %v", err)
		} else if out, err := h.Ejecutar("apparmor_parser", "-r", "-W", rutaPerfil); err != nil {
			fallo(&r.AppArmor, "apparmor_parser: %v %s", err, recortarSalida(out))
		} else {
			r.AppArmor = PiezaPuesta
		}
	}
	// 2. sd-discos, si la máquina tiene systemd.
	if h.esCarpeta(rutaSystemdVivo) && h.Hay("systemctl") {
		if !RutaDatosValida(datosSensor) {
			fallo(&r.Discos, "invalid sensor folder %q", datosSensor)
			return r
		}
		if fi, err := os.Stat(h.ruta(binarioSdDiscos)); err != nil || !fi.Mode().IsRegular() {
			fallo(&r.Discos, "%s is missing", binarioSdDiscos)
			return r
		}
		if err := os.MkdirAll(h.ruta(BuzonDiscos), 0o700); err != nil {
			fallo(&r.Discos, "mailbox: %v", err)
			return r
		}
		_ = os.Chmod(h.ruta(BuzonDiscos), 0o700)
		servicio, path := UnidadesDiscos(datosSensor)
		c1, err1 := h.escribirSiCambia(rutaUnidad, []byte(servicio), 0o644)
		c2, err2 := h.escribirSiCambia(rutaUnidadPath, []byte(path), 0o644)
		if err := errors.Join(err1, err2); err != nil {
			fallo(&r.Discos, "units: %v", err)
			return r
		}
		if c1 || c2 {
			if out, err := h.Ejecutar("systemctl", "daemon-reload"); err != nil {
				fallo(&r.Discos, "systemctl daemon-reload: %v %s", err, recortarSalida(out))
				return r
			}
		}
		if out, err := h.Ejecutar("systemctl", "enable", "--now", "sd-discos.path"); err != nil {
			fallo(&r.Discos, "systemctl enable sd-discos.path: %v %s", err, recortarSalida(out))
			return r
		}
		if err := os.WriteFile(h.ruta(marcaInstalado), nil, 0o600); err != nil {
			fallo(&r.Discos, "%s: %v", marcaInstalado, err)
			return r
		}
		r.Discos = PiezaPuesta
	}
	return r
}

func recortarSalida(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[len(s)-300:]
	}
	return s
}

// LeerResultadoAnfitrion saca el resultado de la salida del contenedor.
func LeerResultadoAnfitrion(salida string) (ResultadoAnfitrion, bool) {
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	for i := len(lineas) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lineas[i])
		if !strings.HasPrefix(l, MarcaAislamiento) {
			continue
		}
		var v struct {
			Aislamiento ResultadoAnfitrion `json:"aislamiento"`
		}
		if json.Unmarshal([]byte(l), &v) == nil && v.Aislamiento.AppArmor != "" && v.Aislamiento.Discos != "" {
			return v.Aislamiento, true
		}
	}
	return ResultadoAnfitrion{}, false
}

// Nombres de los contenedores de un instante: hacen de cerrojo.
const (
	NombreAislarAnfitrion = "sugardaddy-aislar-anfitrion"
	NombreCopiarSdDiscos  = "sugardaddy-copiar-sd-discos"
	NombrePruebaAppArmor  = "sugardaddy-prueba-apparmor"
)

// ejecutarUnInstante crea, arranca y espera un contenedor; devuelve su código y su
// salida. Lo borra siempre, también el que quedara de una vez anterior.
func ejecutarUnInstante(ctx context.Context, d *docker.Cliente, nombre string, cfg map[string]any, espera time.Duration) (int, string, error) {
	ctx, cancelar := context.WithTimeout(ctx, espera)
	defer cancelar()
	if err := d.Borrar(ctx, nombre); err != nil && !docker.NoExiste(err) {
		return 0, "", err
	}
	id, err := d.Crear(ctx, nombre, cfg)
	if id != "" {
		defer func() { _ = d.Borrar(context.WithoutCancel(ctx), id) }()
	}
	if err != nil {
		return 0, "", err
	}
	if err := d.Arrancar(ctx, id); err != nil {
		return 0, "", err
	}
	codigo, err := d.Esperar(ctx, id)
	if err != nil {
		return 0, "", err
	}
	salida, _ := d.Salida(ctx, id, 50)
	return codigo, salida, nil
}

// ConfigAislarAnfitrion es el contenedor que entra en la raíz de la máquina. Es
// privilegiado y con el PID de la máquina: tiene que escribir en /etc, cargar un
// perfil en el núcleo y hablar con systemd. Lo lanza solo el auxiliar de una
// versión firmada (que ya tiene el socket de Docker, equivalente a root), con la
// imagen firmada del actualizador de esa versión, una orden fija y sin red. A él
// no llega nada de las trampas ni de la consola, salvo la carpeta del sensor, que
// se valida antes (RutaDatosValida) y otra vez dentro.
func ConfigAislarAnfitrion(imagen, datosSensor string) map[string]any {
	return map[string]any{
		"Image":  imagen,
		"Cmd":    []string{"aislar-anfitrion"},
		"Env":    []string{"AISLAR_DATOS=" + datosSensor},
		"Labels": map[string]string{"sugardaddy.auxiliar": "aislar-anfitrion"},
		"HostConfig": map[string]any{
			"Privileged":     true,
			"PidMode":        "host",
			"NetworkMode":    "none",
			"ReadonlyRootfs": true,
			"RestartPolicy":  map[string]string{"Name": "no"},
			"LogConfig":      docker.RegistrosAcotados(),
		},
	}
}

// asegurarAislamiento pone en la máquina lo que instalar.sh pone a los nodos nuevos
// (perfil AppArmor y sd-discos) y deja TRAMPAS_APPARMOR en .env solo si Docker
// arranca de verdad un contenedor con ese perfil. Nunca para la versión: devuelve
// un aviso ("" si nada falló) que va en el resultado que ve la consola.
func (a *Aplicacion) asegurarAislamiento(ctx context.Context) string {
	env, err := LeerEnv(a.ruta(".env"))
	if err != nil || env["DATOS"] == "" || env["AISLAMIENTO_ANFITRION"] == "no" {
		return ""
	}
	datos := env["DATOS"]
	if a.Modo == ModoNodo {
		datos = filepath.Join(datos, "sensor")
	}
	versiones, _ := LeerEnv(a.ruta("versiones.env"))
	sensor, actualizadorImg := versiones["SENSOR_IMAGEN"], versiones["ACTUALIZADOR_IMAGEN"]
	if sensor == "" || actualizadorImg == "" {
		return ""
	}
	if !RutaDatosValida(datos) {
		return fmt.Sprintf("decoy isolation: the sensor folder %q cannot go in the sd-discos unit; the decoys keep runc with seccomp and no disk of their own", datos)
	}
	var avisos []string
	// 1. El binario de sd-discos: el del sensor de esta versión (copiar-binario), como instalar.sh.
	codigo, salida, err := ejecutarUnInstante(ctx, a.Docker, NombreCopiarSdDiscos, map[string]any{
		"Image": sensor,
		"Cmd":   []string{"copiar-binario", "/salida/sd-discos"},
		"User":  "0:0",
		"HostConfig": map[string]any{
			"NetworkMode":    "none",
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"CapAdd":         []string{"DAC_OVERRIDE"},
			"SecurityOpt":    []string{"no-new-privileges"},
			"Binds":          []string{CarpetaBinarios + ":/salida"},
			"LogConfig":      docker.RegistrosAcotados(),
		},
	}, 2*time.Minute)
	if err != nil || codigo != 0 {
		a.Log("could not copy the sd-discos binary", "err", err, "codigo", codigo, "salida", recortarSalida([]byte(salida)))
	}
	// 2. La máquina: perfil y unidades.
	if err := a.Docker.AsegurarImagen(ctx, actualizadorImg); err != nil {
		return "decoy isolation: " + err.Error()
	}
	_, salida, err = ejecutarUnInstante(ctx, a.Docker, NombreAislarAnfitrion, ConfigAislarAnfitrion(actualizadorImg, datos), 5*time.Minute)
	res, ok := LeerResultadoAnfitrion(salida)
	if err != nil || !ok {
		res = ResultadoAnfitrion{AppArmor: PiezaFallo, Discos: PiezaFallo}
		avisos = append(avisos, fmt.Sprintf("the machine could not be prepared (%v): %s", err, recortarSalida([]byte(salida))))
	}
	avisos = append(avisos, res.Detalle...)
	a.Log("decoy isolation on the machine", "apparmor", res.AppArmor, "discos", res.Discos)
	// 3. TRAMPAS_APPARMOR: solo si Docker arranca un contenedor con el perfil. Un
	// perfil que Docker no encuentra haría fallar la creación de cada trampa.
	perfil := ""
	if res.AppArmor == PiezaPuesta || env["TRAMPAS_APPARMOR"] != "" {
		if a.pruebaAppArmor(ctx, sensor) {
			perfil = NombrePerfilAppArmor
		} else {
			avisos = append(avisos, "Docker does not start a container with the AppArmor profile "+NombrePerfilAppArmor+": decoys run with seccomp only")
		}
	}
	if v, ya := env["TRAMPAS_APPARMOR"]; !ya || v != perfil {
		if err := fijarVariables(a.ruta(".env"), map[string]string{"TRAMPAS_APPARMOR": perfil}); err != nil {
			avisos = append(avisos, "could not write TRAMPAS_APPARMOR in .env: "+err.Error())
		}
	}
	if len(avisos) == 0 {
		return ""
	}
	return "decoy isolation (the version is applied; decoys keep the isolation they had): " + strings.Join(avisos, "; ")
}

// pruebaAppArmor arranca un instante la imagen del sensor con el perfil de las trampas.
func (a *Aplicacion) pruebaAppArmor(ctx context.Context, imagen string) bool {
	codigo, _, err := ejecutarUnInstante(ctx, a.Docker, NombrePruebaAppArmor, map[string]any{
		"Image": imagen,
		"Cmd":   []string{"version"},
		"HostConfig": map[string]any{
			"NetworkMode":    "none",
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges", "apparmor=" + NombrePerfilAppArmor},
			"LogConfig":      docker.RegistrosAcotados(),
		},
	}, time.Minute)
	return err == nil && codigo == 0
}

// Las redes de las trampas y el nombre fijo de su puente (despliegue.PuenteTrampas…).
var redesTrampas = []struct{ nombre, puente string }{
	{"sugardaddy-trampas-aisladas", "sd-trampas0"},
	{"sugardaddy-trampas-salida-aisladas", "sd-trampas1"},
}

// Las etiquetas de lo que el sensor pone en esas redes: lo único que se puede quitar.
var etiquetasDelSensor = []string{"sugardaddy.trampa", "sugardaddy.sonda", "sugardaddy.captura"}

// rehacerRedesTrampas quita las redes de trampas de antes del nombre fijo del puente
// (SEN-5), con sus trampas, para que el sensor de la versión las cree con él y vuelva
// a poner las trampas. Primero para el sensor, que si no las rehace a medias; compose
// lo arranca otra vez al levantar. Solo si en la red no hay nada que no sea del
// sensor. Nunca para la versión: lo que no sale va en el aviso.
func (a *Aplicacion) rehacerRedesTrampas(ctx context.Context) string {
	var avisos []string
	parado, quitadas := false, 0
	for _, red := range redesTrampas {
		r, err := a.Docker.InspeccionarRed(ctx, red.nombre)
		if err != nil || r.Driver != "bridge" || r.Options[docker.OpcionNombrePuente] == red.puente {
			continue
		}
		var ids []string
		ajeno := ""
		for id := range r.Containers {
			c, err := a.Docker.Inspeccionar(ctx, id)
			if err != nil {
				ajeno = id
				break
			}
			cfg, _ := c["Config"].(map[string]any)
			et, _ := cfg["Labels"].(map[string]any)
			nuestro := false
			for _, e := range etiquetasDelSensor {
				if v, _ := et[e].(string); v != "" {
					nuestro = true
				}
			}
			if !nuestro {
				ajeno = id
				break
			}
			ids = append(ids, id)
		}
		if ajeno != "" {
			avisos = append(avisos, fmt.Sprintf("network %s has a container that is not a decoy (%.12s): it keeps its old bridge, without the SEN-5 rule", red.nombre, ajeno))
			continue
		}
		if !parado && len(ids) > 0 {
			if out, err := a.compose(ctx, "stop", "sensor"); err != nil {
				return "decoy networks (SEN-5): could not stop the sensor to rebuild them: " + err.Error() + " " + recortarSalida([]byte(out))
			}
			parado = true
		}
		for _, id := range ids {
			if err := a.Docker.Borrar(ctx, id); err != nil && !docker.NoExiste(err) {
				avisos = append(avisos, "decoy "+id+": "+err.Error())
			}
		}
		quitadas += len(ids)
		if err := a.Docker.BorrarRed(ctx, red.nombre); err != nil && !docker.NoExiste(err) {
			avisos = append(avisos, "network "+red.nombre+": "+err.Error())
			continue
		}
		a.Log("decoy network rebuilt with a fixed bridge name (SEN-5); the sensor redeploys its decoys", "red", red.nombre, "trampas", len(ids))
	}
	// Los acompañantes de captura van en la red de su trampa: sin ella, sobran.
	if quitadas > 0 {
		if l, err := a.Docker.ListarConEtiqueta(ctx, "sugardaddy.captura"); err == nil {
			for _, c := range l {
				_ = a.Docker.Borrar(ctx, c.ID)
			}
		}
	}
	if len(avisos) == 0 {
		return ""
	}
	return "decoy networks (SEN-5): " + strings.Join(avisos, "; ")
}
