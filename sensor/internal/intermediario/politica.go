// Package intermediario es sd-motor: el único proceso del nodo que habla con el
// socket de Docker (docs/diseno/aislamiento-trampas.md). El sensor ya no lo
// monta: habla con sd-motor por un socket Unix, con la misma forma que la API de
// Docker para no reescribir el sensor, pero sd-motor solo deja pasar los cinco
// verbos de una trampa (crear, arrancar, parar, borrar y estado) y el
// mantenimiento acotado que necesitan (descargar una imagen fijada por digest,
// las redes fijas de las trampas, sus volúmenes etiquetados, las sondas y el
// acompañante de captura con la imagen del propio sensor). Todo lo demás se
// rechaza.
//
// Lo que distingue a sd-motor de un proxy por rutas es que mira el CONTENIDO de
// cada creación: una trampa solo se crea si trae su manifiesto, si ese manifiesto
// está en el catálogo de la versión firmada (SEN-3) y si la petición es la que sale
// de él. Y se niega por construcción, venga de donde venga, a privileged, a la red,
// el PID o el IPC del anfitrión, a dispositivos, a binds fuera de la carpeta de la
// trampa y a capacidades añadidas.
package intermediario

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Etiquetas con las que el sensor marca lo suyo. Tienen que coincidir con las del
// paquete despliegue y con motor.etiquetaSonda; la prueba de este paquete lo
// comprueba contra un plan real.
const (
	EtiquetaTrampa   = "sugardaddy.trampa"
	EtiquetaAntigua  = "sugardaddy.senuelo"
	EtiquetaSensor   = "sugardaddy.sensor"
	EtiquetaSonda    = "sugardaddy.sonda"
	EtiquetaCaptura  = "sugardaddy.captura"
	rutaLicencia     = "/sugardaddy/licencia.json"
	prefijoRedTrampa = "sugardaddy-trampas-"
	// La red con salida a internet no la usa ninguna trampa (SEN-3): tampoco se crea.
	redConSalida = "sugardaddy-trampas-salida-aisladas"
	// Las redes de banco de probartrampa (modo IP propia en el banco).
	prefijoRedBanco = "sd-banco-"
	// Tope de procesos de una trampa (el del despliegue).
	maxProcesos = 256
)

// Códigos estables de los rechazos, para el estado de la trampa en la consola.
const (
	CodigoRechazo   = "motor.rechazo"
	CodigoCatalogo  = "catalogo.fuera"
	CodigoSinManif  = "motor.sin-manifiesto"
	CodigoRootTramp = "motor.trampa-root"
)

// Rechazo es una petición que sd-motor no deja pasar, con su código estable.
type Rechazo struct {
	Codigo string
	Texto  string
}

func (r *Rechazo) Error() string { return "sd-motor: " + r.Texto }

func rechazar(formato string, a ...any) *Rechazo {
	return &Rechazo{Codigo: CodigoRechazo, Texto: fmt.Sprintf(formato, a...)}
}

// idValido: el de despliegue (SEN-3). El id acaba en rutas del anfitrión.
var idValido = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// Reglas es lo que sd-motor sabe de este nodo para decidir.
type Reglas struct {
	// Datos: la carpeta del sensor en el anfitrión. Los binds de una trampa solo
	// pueden ser de su carpeta dentro de ella.
	Datos string
	// ImagenSensor: la imagen del propio sensor (firmada), la única con la que se
	// crean sondas y acompañantes de captura.
	ImagenSensor string
	// Catalogo dice por qué un manifiesto no se puede arrancar ("" si se puede).
	// nil: sin catálogo (nodo montado a mano o banco de pruebas).
	Catalogo func(plan.Manifiesto) string
	// UsuarioImagen da el USER de una imagen local (para no dejar una trampa como root).
	UsuarioImagen func(imagen string) (string, error)
	// VolumenesImagen da los VOLUME de una imagen local.
	VolumenesImagen func(imagen string) ([]string, error)
	// EsNuestro dice si un contenedor (id o nombre) es una trampa del sensor y de
	// cuál: el acompañante de captura solo se une a la red de una trampa.
	TrampaDe func(contenedor string) (id string, ok bool)
}

// Tipo de lo que se pide crear.
type Tipo int

const (
	TipoTrampa Tipo = iota
	TipoSonda
	TipoCaptura
)

// Peticion es una creación de contenedor ya decodificada.
type Peticion struct {
	Nombre     string
	Config     map[string]any
	Manifiesto *plan.Manifiesto
}

// TipoDe clasifica una creación por sus etiquetas. Lo que no lleva ninguna de
// las nuestras se rechaza: sd-motor no crea contenedores que no sean del sensor.
func TipoDe(cfg map[string]any) (Tipo, error) {
	et := etiquetas(cfg)
	n := 0
	var t Tipo
	if et[EtiquetaTrampa] != "" {
		n, t = n+1, TipoTrampa
	}
	if et[EtiquetaSonda] != "" {
		n, t = n+1, TipoSonda
	}
	if et[EtiquetaCaptura] != "" {
		n, t = n+1, TipoCaptura
	}
	if n != 1 {
		return 0, rechazar("only a decoy, a probe or a capture companion can be created")
	}
	return t, nil
}

func etiquetas(cfg map[string]any) map[string]string {
	r := map[string]string{}
	m, _ := cfg["Labels"].(map[string]any)
	for k, v := range m {
		if s, ok := v.(string); ok {
			r[k] = s
		}
	}
	return r
}

// Validar decide si una creación pasa. No toca la petición: lo que sd-motor añade
// (runtime y perfiles) lo pone Endurecer después.
func (r Reglas) Validar(p Peticion) (Tipo, error) {
	t, err := TipoDe(p.Config)
	if err != nil {
		return 0, err
	}
	// Lo que vale para todo: ni un campo que no conozcamos, ni privilegios.
	if err := comun(p.Config); err != nil {
		return 0, err
	}
	switch t {
	case TipoTrampa:
		return t, r.trampa(p)
	case TipoSonda:
		return t, r.sonda(p)
	default:
		return t, r.captura(p)
	}
}

// Campos de nivel superior y de HostConfig que sd-motor entiende. Un campo
// desconocido se rechaza: así Docker no puede ganar mañana una opción peligrosa
// que pase sin mirar.
var (
	camposArriba = []string{"Image", "Env", "ExposedPorts", "Labels", "HostConfig", "NetworkingConfig", "User", "Cmd"}
	camposHost   = []string{"NetworkMode", "PortBindings", "ReadonlyRootfs", "CapDrop", "CapAdd", "SecurityOpt",
		"Memory", "MemorySwap", "NanoCpus", "PidsLimit", "Mounts", "RestartPolicy", "Tmpfs", "LogConfig"}
)

func comun(cfg map[string]any) error {
	for k := range cfg {
		if !slices.Contains(camposArriba, k) {
			return rechazar("field %q is not allowed", k)
		}
	}
	h, ok := cfg["HostConfig"].(map[string]any)
	if !ok {
		return rechazar("HostConfig is required")
	}
	for k, v := range h {
		if !slices.Contains(camposHost, k) {
			// Privileged, Devices, PidMode, IpcMode, UsernsMode, Binds, VolumesFrom,
			// CgroupParent, Sysctls, Runtime… caen aquí, con su nombre.
			return rechazar("HostConfig.%s is not allowed", k)
		}
		_ = v
	}
	if !contiene(lista(h["CapDrop"]), "ALL") {
		return rechazar("all capabilities must be dropped (CapDrop ALL)")
	}
	opts := lista(h["SecurityOpt"])
	if !contiene(opts, "no-new-privileges") && !contiene(opts, "no-new-privileges:true") {
		return rechazar("no-new-privileges is required")
	}
	for _, o := range opts {
		if o != "no-new-privileges" && o != "no-new-privileges:true" {
			// El perfil seccomp y AppArmor los pone sd-motor, no quien pide.
			return rechazar("security option %q is chosen by sd-motor, not by the sensor", recortar(o, 40))
		}
	}
	if v, ok := h["PidsLimit"]; ok {
		n, ok := entero(v)
		if !ok || n < 1 || n > maxProcesos {
			return rechazar("PidsLimit must be between 1 and %d", maxProcesos)
		}
	} else {
		return rechazar("PidsLimit is required")
	}
	if m, ok := entero(h["Memory"]); !ok || m <= 0 {
		return rechazar("a memory limit is required")
	}
	if rp, ok := h["RestartPolicy"].(map[string]any); ok {
		if n, _ := rp["Name"].(string); n != "unless-stopped" && n != "no" && n != "" {
			return rechazar("restart policy %q is not allowed", n)
		}
	}
	if lc, ok := h["LogConfig"].(map[string]any); ok {
		if t, _ := lc["Type"].(string); t != "json-file" && t != "local" {
			return rechazar("log driver %q is not allowed", t)
		}
	}
	return nil
}

func (r Reglas) trampa(p Peticion) error {
	cfg := p.Config
	h := cfg["HostConfig"].(map[string]any)
	et := etiquetas(cfg)
	id := et[EtiquetaTrampa]
	if !idValido.MatchString(id) || strings.Contains(id, "..") {
		return rechazar("invalid decoy identifier")
	}
	if p.Manifiesto == nil {
		return &Rechazo{Codigo: CodigoSinManif, Texto: "a decoy is only created with its manifest"}
	}
	m := *p.Manifiesto
	if r.Catalogo != nil {
		if motivo := r.Catalogo(m); motivo != "" {
			return &Rechazo{Codigo: CodigoCatalogo, Texto: motivo}
		}
	}
	c, a := m.Contenedor, m.Aislamiento
	if c == nil || a == nil {
		return rechazar("the manifest has no container or isolation block")
	}
	if a.Salida {
		return rechazar("decoys may not reach the internet (isolation.outbound)")
	}
	imagen, _ := cfg["Image"].(string)
	if !mismaImagen(imagen, c.Imagen) {
		return rechazar("the image is not the one in the decoy manifest")
	}
	if _, ok := cfg["Cmd"]; ok {
		return rechazar("a decoy runs its image as built: no command")
	}
	// Nunca como root, ni pidiéndolo ni porque la imagen lo sea.
	if u, ok := cfg["User"]; ok {
		if s, _ := u.(string); esRoot(s) {
			return &Rechazo{Codigo: CodigoRootTramp, Texto: "a decoy never runs as root"}
		}
	} else if r.UsuarioImagen != nil {
		u, err := r.UsuarioImagen(imagen)
		if err != nil {
			return rechazar("could not inspect the decoy image: %v", err)
		}
		if esRoot(u) {
			return &Rechazo{Codigo: CodigoRootTramp, Texto: "the decoy image runs as root; decoys never run as root"}
		}
	}
	if len(lista(h["CapAdd"])) > 0 {
		// Ni NET_RAW: la captura la hace el acompañante (docs/diseno/aislamiento-trampas.md).
		return rechazar("decoys get no added capabilities")
	}
	if ro, _ := h["ReadonlyRootfs"].(bool); a.SoloLectura && !ro {
		return rechazar("the manifest asks for a read-only root filesystem")
	}
	if mem, _ := entero(h["Memory"]); a.MemoriaMb > 0 && mem > int64(a.MemoriaMb)<<20 {
		return rechazar("more memory than the manifest allows")
	}
	if sw, ok := entero(h["MemorySwap"]); ok {
		if mem, _ := entero(h["Memory"]); sw != mem {
			return rechazar("swap must equal the memory limit")
		}
	}
	if cpu, ok := entero(h["NanoCpus"]); ok && a.CPU > 0 && cpu > int64(a.CPU*1e9) {
		return rechazar("more CPU than the manifest allows")
	}
	if err := tmpfs(h["Tmpfs"]); err != nil {
		return err
	}
	red, _ := h["NetworkMode"].(string)
	if !redDeTrampa(red) {
		return rechazar("network %q is not a decoy network", red)
	}
	if (m.Red != nil) != (red == "sugardaddy-trampas-ip-propia" || strings.HasPrefix(red, prefijoRedBanco)) {
		return rechazar("only own-IP decoys go on the own-IP network")
	}
	if err := puertos(cfg, h); err != nil {
		return err
	}
	if err := redes(cfg, red); err != nil {
		return err
	}
	return r.montajes(id, et[EtiquetaSensor], m, imagen, h["Mounts"])
}

// mismaImagen: la misma referencia o, si las dos van por digest, el mismo digest
// (el sensor puede pedir la del registro privado o la pública: el contenido es el firmado).
func mismaImagen(a, b string) bool {
	if a == "" {
		return false
	}
	if a == b {
		return true
	}
	da, db := digest(a), digest(b)
	return da != "" && da == db
}

func digest(ref string) string {
	if i := strings.Index(ref, "@sha256:"); i >= 0 {
		return ref[i+1:]
	}
	return ""
}

func esRoot(u string) bool {
	u = strings.TrimSpace(u)
	usuario, _, _ := strings.Cut(u, ":")
	return usuario == "" || usuario == "0" || usuario == "root"
}

func tmpfs(v any) error {
	if v == nil {
		return nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return rechazar("invalid Tmpfs")
	}
	for ruta, o := range m {
		op, _ := o.(string)
		if ruta != "/tmp" || !strings.Contains(op, "noexec") || !strings.Contains(op, "nosuid") {
			return rechazar("only /tmp may be a tmpfs, and noexec,nosuid")
		}
	}
	return nil
}

func redDeTrampa(red string) bool {
	if red == redConSalida {
		return false
	}
	return (strings.HasPrefix(red, prefijoRedTrampa) || strings.HasPrefix(red, prefijoRedBanco)) && !strings.ContainsAny(red, ":/")
}

func puertos(cfg, h map[string]any) error {
	clave := regexp.MustCompile(`^[0-9]{1,5}/(tcp|udp)$`)
	if e, ok := cfg["ExposedPorts"].(map[string]any); ok {
		for k := range e {
			if !clave.MatchString(k) {
				return rechazar("invalid exposed port %q", k)
			}
		}
	}
	pb, _ := h["PortBindings"].(map[string]any)
	for k, v := range pb {
		if !clave.MatchString(k) {
			return rechazar("invalid published port %q", k)
		}
		enlaces, _ := v.([]any)
		for _, e := range enlaces {
			em, _ := e.(map[string]any)
			ip, _ := em["HostIp"].(string)
			if ip != "" {
				if _, err := netip.ParseAddr(ip); err != nil {
					return rechazar("invalid host address %q", ip)
				}
			}
			hp, _ := em["HostPort"].(string)
			if n, err := strconv.Atoi(hp); err != nil || n < 1 || n > 65535 {
				return rechazar("invalid host port %q", hp)
			}
		}
	}
	return nil
}

func redes(cfg map[string]any, red string) error {
	nc, ok := cfg["NetworkingConfig"]
	if !ok {
		return nil
	}
	m, _ := nc.(map[string]any)
	for k := range m {
		if k != "EndpointsConfig" {
			return rechazar("NetworkingConfig.%s is not allowed", k)
		}
	}
	ep, _ := m["EndpointsConfig"].(map[string]any)
	for nombre, v := range ep {
		if nombre != red {
			return rechazar("a decoy joins only its own network")
		}
		e, _ := v.(map[string]any)
		for k := range e {
			if k != "IPAMConfig" && k != "Aliases" {
				return rechazar("endpoint option %q is not allowed", k)
			}
		}
	}
	return nil
}

// montajes: binds solo de la carpeta de esa trampa, volúmenes solo suyos y
// destinos solo los que salen de su manifiesto (o los VOLUME de su imagen).
func (r Reglas) montajes(id, sensor string, m plan.Manifiesto, imagen string, v any) error {
	if r.Datos == "" {
		return rechazar("sd-motor does not know the sensor folder (-datos)")
	}
	c := m.Contenedor
	destinos := []string{c.Registros, rutaLicencia}
	for _, f := range c.Ficheros {
		destinos = append(destinos, f.Destino)
	}
	destinos = append(destinos, c.Escribibles...)
	var vols []string
	volsSabidos := false
	lst, _ := v.([]any)
	for _, x := range lst {
		mt, ok := x.(map[string]any)
		if !ok {
			return rechazar("invalid mount")
		}
		for k := range mt {
			if !slices.Contains([]string{"Type", "Source", "Target", "ReadOnly", "VolumeOptions"}, k) {
				// BindOptions (propagación), TmpfsOptions… no.
				return rechazar("mount option %q is not allowed", k)
			}
		}
		tipo, _ := mt["Type"].(string)
		origen, _ := mt["Source"].(string)
		destino, _ := mt["Target"].(string)
		ro, _ := mt["ReadOnly"].(bool)
		if destino == "" || !filepath.IsAbs(destino) || filepath.Clean(destino) != destino {
			return rechazar("invalid mount target %q", recortar(destino, 60))
		}
		if !slices.Contains(destinos, destino) {
			if !volsSabidos && r.VolumenesImagen != nil {
				vols, _ = r.VolumenesImagen(imagen)
				volsSabidos = true
			}
			if !slices.Contains(vols, destino) {
				return rechazar("mount target %q does not come from the decoy manifest", recortar(destino, 60))
			}
		}
		switch tipo {
		case "bind":
			if err := r.bind(id, origen, destino, ro); err != nil {
				return err
			}
		case "volume":
			if err := r.volumen(id, sensor, origen, mt["VolumeOptions"]); err != nil {
				return err
			}
		default:
			return rechazar("mount type %q is not allowed", tipo)
		}
	}
	return nil
}

// bind: el origen tiene que ser de la carpeta de esa trampa en el anfitrión.
func (r Reglas) bind(id, origen, destino string, ro bool) error {
	if origen == "" || !filepath.IsAbs(origen) || filepath.Clean(origen) != origen {
		return rechazar("invalid bind source")
	}
	datos := filepath.Clean(r.Datos)
	switch {
	case origen == filepath.Join(datos, "registros", id), origen == discos.Registros(datos, id):
		// Sus registros: los escribe ella.
	case dentro(origen, filepath.Join(datos, "config", id)):
		if !ro {
			return rechazar("decoy configuration files are mounted read-only")
		}
	case origen == filepath.Join(datos, "licencia.json"):
		if !ro || destino != rutaLicencia {
			return rechazar("the license is mounted read-only at its fixed path")
		}
	default:
		return rechazar("bind source %q is outside the decoy folder", recortar(origen, 80))
	}
	return sinEnlaceFuera(origen, datos)
}

func (r Reglas) volumen(id, sensor, nombre string, opciones any) error {
	permitido := strings.HasPrefix(nombre, fmt.Sprintf("sd-%s-%s-", sensor, id)) ||
		strings.HasPrefix(nombre, fmt.Sprintf("sd_disco_%s_%s_", sensor, id))
	if sensor == "" || !permitido {
		return rechazar("volume %q is not this decoy's", recortar(nombre, 80))
	}
	vo, _ := opciones.(map[string]any)
	for k := range vo {
		if k != "Labels" && k != "DriverConfig" {
			return rechazar("volume option %q is not allowed", k)
		}
	}
	dc, ok := vo["DriverConfig"].(map[string]any)
	if !ok {
		return nil
	}
	if n, _ := dc["Name"].(string); n != "local" {
		return rechazar("volume driver %q is not allowed", n)
	}
	op, _ := dc["Options"].(map[string]any)
	for k := range op {
		if k != "type" && k != "o" && k != "device" {
			return rechazar("volume driver option %q is not allowed", k)
		}
	}
	if op["type"] != "none" || op["o"] != "bind" {
		return rechazar("a decoy volume can only be a folder of its own disk")
	}
	dev, _ := op["device"].(string)
	dir := discos.Dir(filepath.Clean(r.Datos), id)
	if filepath.Clean(dev) != dev || !dentro(dev, dir) {
		return rechazar("the volume folder is outside the decoy disk")
	}
	return sinEnlaceFuera(dev, filepath.Clean(r.Datos))
}

// dentro: ruta es dir o algo debajo de él (ya limpias).
func dentro(ruta, dir string) bool {
	return ruta == dir || strings.HasPrefix(ruta, dir+string(filepath.Separator))
}

// sinEnlaceFuera: si la ruta existe donde sd-motor la ve, que no salga de la
// carpeta del sensor por un enlace simbólico (lo que escribe una trampa en sus
// carpetas no puede llevar un bind a otra parte). Si no la ve, no decide: los
// destinos ya están acotados por nombre.
var sinEnlaceFuera = func(ruta, datos string) error {
	real, err := filepath.EvalSymlinks(ruta)
	if err != nil {
		return nil
	}
	base, err := filepath.EvalSymlinks(datos)
	if err != nil {
		base = datos
	}
	if !dentro(real, base) {
		return rechazar("%q leads outside the sensor folder", recortar(ruta, 80))
	}
	return nil
}

// Órdenes de la imagen del sensor que pueden correr como sonda, y en qué red.
var ordenesSonda = map[string][]string{
	"probar-clone3":     {"none"},
	"puerta-enlace":     {"host"},
	"puertos-anfitrion": {"host"},
	"escuchar":          {"*trampa"},
	"sondear":           {"*trampa"},
}

func (r Reglas) sonda(p Peticion) error {
	cfg := p.Config
	h := cfg["HostConfig"].(map[string]any)
	if r.ImagenSensor == "" || !mismaImagen(str(cfg["Image"]), r.ImagenSensor) {
		return rechazar("probes run only with the sensor image")
	}
	orden := lista(cfg["Cmd"])
	if len(orden) == 0 {
		return rechazar("a probe needs its command")
	}
	redes, ok := ordenesSonda[orden[0]]
	if !ok {
		return rechazar("probe command %q is not allowed", recortar(orden[0], 30))
	}
	red := str(h["NetworkMode"])
	if !(slices.Contains(redes, red) || (slices.Contains(redes, "*trampa") && redDeTrampa(red))) {
		return rechazar("probe %q may not use network %q", orden[0], red)
	}
	if len(lista(h["CapAdd"])) > 0 || h["Mounts"] != nil || h["PortBindings"] != nil {
		return rechazar("a probe has no capabilities, mounts or ports")
	}
	if ro, _ := h["ReadonlyRootfs"].(bool); !ro {
		return rechazar("a probe has a read-only root filesystem")
	}
	if esRootExplicito(cfg) {
		return rechazar("a probe never runs as root")
	}
	return nil
}

// captura: el acompañante que abre el enchufe crudo en el espacio de red de una
// trampa. Es la imagen del sensor con su orden «captura», con NET_RAW y nada
// más, sin montajes ni puertos, unido a la red de una trampa de este sensor.
func (r Reglas) captura(p Peticion) error {
	cfg := p.Config
	h := cfg["HostConfig"].(map[string]any)
	if r.ImagenSensor == "" || !mismaImagen(str(cfg["Image"]), r.ImagenSensor) {
		return rechazar("the capture companion runs only with the sensor image")
	}
	orden := lista(cfg["Cmd"])
	if len(orden) == 0 || orden[0] != "captura" {
		return rechazar("the capture companion only runs «captura»")
	}
	cap := lista(h["CapAdd"])
	if len(cap) != 1 || strings.TrimPrefix(cap[0], "CAP_") != "NET_RAW" {
		return rechazar("the capture companion gets NET_RAW and nothing else")
	}
	if h["Mounts"] != nil || h["PortBindings"] != nil || cfg["NetworkingConfig"] != nil {
		return rechazar("the capture companion has no mounts, ports or networks of its own")
	}
	if ro, _ := h["ReadonlyRootfs"].(bool); !ro {
		return rechazar("the capture companion has a read-only root filesystem")
	}
	red := str(h["NetworkMode"])
	contenedor, ok := strings.CutPrefix(red, "container:")
	if !ok || contenedor == "" {
		return rechazar("the capture companion joins a decoy's network namespace")
	}
	if r.TrampaDe == nil {
		return rechazar("sd-motor cannot check the decoy of the capture companion")
	}
	id, ok := r.TrampaDe(contenedor)
	if !ok || id != etiquetas(cfg)[EtiquetaCaptura] {
		return rechazar("the capture companion only joins the decoy it is labelled for")
	}
	return nil
}

func esRootExplicito(cfg map[string]any) bool {
	u, ok := cfg["User"].(string)
	return ok && esRoot(u)
}

// ValidarRed decide si se puede crear una red: solo las fijas de las trampas,
// puente sin comunicación entre contenedores o macvlan, sin la de salida.
func ValidarRed(cuerpo map[string]any) error {
	for k := range cuerpo {
		if !slices.Contains([]string{"Name", "Driver", "Options", "IPAM", "Labels", "CheckDuplicate", "Internal", "EnableIPv6", "Attachable"}, k) {
			return rechazar("network field %q is not allowed", k)
		}
	}
	nombre := str(cuerpo["Name"])
	if !redDeTrampa(nombre) {
		return rechazar("network %q is not a decoy network", nombre)
	}
	if a, _ := cuerpo["Attachable"].(bool); a {
		return rechazar("decoy networks are not attachable")
	}
	opts, _ := cuerpo["Options"].(map[string]any)
	switch d := str(cuerpo["Driver"]); d {
	case "", "bridge":
		if opts["com.docker.network.bridge.enable_icc"] != "false" {
			return rechazar("a decoy bridge does not let decoys see each other (enable_icc=false)")
		}
	case "macvlan":
		for k := range opts {
			if k != "parent" && k != "macvlan_mode" {
				return rechazar("macvlan option %q is not allowed", k)
			}
		}
		if m := str(opts["macvlan_mode"]); m != "" && m != "bridge" {
			return rechazar("macvlan mode %q is not allowed", m)
		}
	default:
		return rechazar("network driver %q is not allowed", d)
	}
	return nil
}

// ValidarImagen: solo se descarga una imagen fijada por digest (lo que se arranca
// lo decide el catálogo; descargar no da nada, pero tampoco se baja cualquier cosa).
func ValidarImagen(imagen string) error {
	if digest(imagen) == "" || len(digest(imagen)) != len("sha256:")+64 {
		return rechazar("images are only pulled by digest")
	}
	return nil
}

// VolumenNuestro: solo se borran los volúmenes de las trampas.
func VolumenNuestro(nombre string) bool {
	return strings.HasPrefix(nombre, "sd-") || strings.HasPrefix(nombre, "sd_disco_")
}

// EtiquetasNuestras: un contenedor es del sensor si lleva alguna de sus etiquetas.
func EtiquetasNuestras(e map[string]string) bool {
	for _, k := range []string{EtiquetaTrampa, EtiquetaAntigua, EtiquetaSonda, EtiquetaCaptura} {
		if e[k] != "" {
			return true
		}
	}
	return false
}

func lista(v any) []string {
	var r []string
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			if s, ok := e.(string); ok {
				r = append(r, s)
			}
		}
	case []string:
		r = x
	}
	return r
}

func contiene(l []string, s string) bool { return slices.Contains(l, s) }

func str(v any) string { s, _ := v.(string); return s }

func entero(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case json.Number:
		n, err := x.Int64()
		return n, err == nil
	case int64:
		return x, true
	case int:
		return int64(x), true
	}
	return 0, false
}

func recortar(t string, n int) string {
	if len(t) > n {
		return t[:n] + "…"
	}
	return t
}
