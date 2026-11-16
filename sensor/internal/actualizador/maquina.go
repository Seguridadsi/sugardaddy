package actualizador

// Lo que el nodo mira y pone en su máquina (docs/diseno/cortafuegos-anfitrion.md,
// plan de fortificación §1.1, §1.5 y §1.6). Lo hace el auxiliar «anfitrion», un
// contenedor de un instante de la imagen firmada del actualizador que entra en la
// raíz de la máquina (privilegiado, con su PID, sin red) y:
//
//  1. cuenta quién puede entrar por SSH: si el servicio está en marcha, qué
//     usuarios tienen claves autorizadas y sus huellas (nunca las claves);
//  2. deja las reglas de auditd de Sugardaddy (ReglasAuditd) y las carga, si la
//     máquina tiene auditd;
//  3. en el appliance, si Docker no está en la versión que fija la versión firmada
//     del nodo, lanza en la máquina (systemd-run, fuera de Docker: actualizar Docker
//     reinicia sus contenedores, también este) el guion que baja esos paquetes,
//     comprueba su sha256 con lo firmado y los instala. En una máquina del cliente
//     solo se avisa: su Docker es suyo.
//
// Nunca cambia nada más ni lee nada que no sea eso.

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// GuionActualizarDocker es el guion que sube Docker en el appliance, el mismo que
// trae la imagen del appliance.
//
//go:embed scripts/actualizar-docker
var GuionActualizarDocker []byte

const (
	rutaReglasAuditd     = "/etc/audit/rules.d/50-sugardaddy.rules"
	rutaGuionDocker      = CarpetaBinarios + "/actualizar-docker"
	rutaEstadoDocker     = "/var/lib/sugardaddy/docker-actualizacion.json"
	rutaApplianceEnv     = "/etc/sugardaddy/appliance.env"
	UnidadDocker         = "sugardaddy-docker"
	MarcaMaquina         = `{"maquina":`
	maxClavesPorUsuario  = 20
	maxUsuariosSSH       = 50
	maxFicheroClaves     = 64 << 10
	ReintentoDockerFallo = 6 * time.Hour
)

// MotorFijado es el Docker que fija una versión firmada (Release.Motor).
type MotorFijado struct {
	// Docker, la versión del motor tal como la dice Docker (29.9.1).
	Docker string `json:"docker"`
	// Paquetes del appliance (Ubuntu 24.04, amd64), con su versión de apt y su sha256.
	Paquetes []PaqueteFijado `json:"paquetes,omitempty"`
}

// PaqueteFijado es un .deb de Docker con su huella.
type PaqueteFijado struct {
	Nombre  string `json:"nombre"`
	Version string `json:"version"`
	Sha256  string `json:"sha256"`
}

var (
	versionMotor       = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}$`)
	versionApt         = regexp.MustCompile(`^[0-9][0-9A-Za-z.:~+-]{0,63}$`)
	sha256Hex          = regexp.MustCompile(`^[0-9a-f]{64}$`)
	paquetesPermitidos = []string{"docker-ce", "docker-ce-cli", "containerd.io", "docker-compose-plugin", "docker-buildx-plugin"}
)

// ValidarMotor comprueba la forma de lo fijado: va a un guion de la máquina.
func ValidarMotor(m *MotorFijado) error {
	if m == nil {
		return nil
	}
	if !versionMotor.MatchString(m.Docker) {
		return fmt.Errorf("malformed pinned Docker version %q", m.Docker)
	}
	if len(m.Paquetes) > len(paquetesPermitidos) {
		return errors.New("too many pinned Docker packages")
	}
	vistos := map[string]bool{}
	for _, p := range m.Paquetes {
		permitido := false
		for _, n := range paquetesPermitidos {
			permitido = permitido || n == p.Nombre
		}
		if !permitido || vistos[p.Nombre] || !versionApt.MatchString(p.Version) || !sha256Hex.MatchString(p.Sha256) {
			return fmt.Errorf("malformed pinned Docker package %.40q", p.Nombre)
		}
		vistos[p.Nombre] = true
	}
	return nil
}

// CompararVersiones compara dos versiones x.y.z: -1, 0 o 1. Lo que no se entiende
// cuenta como 0.
func CompararVersiones(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(strings.SplitN(pa[i], "-", 2)[0])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(strings.SplitN(pb[i], "-", 2)[0])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// UsuarioSSH es quien puede entrar por SSH con clave.
type UsuarioSSH struct {
	Usuario string   `json:"usuario"`
	UID     int      `json:"uid"`
	Claves  int      `json:"claves"`
	Huellas []string `json:"huellas"`
}

// HechosMaquina es lo que cuenta el auxiliar.
type HechosMaquina struct {
	Appliance bool `json:"appliance"`
	SSH       struct {
		Activo   bool         `json:"activo"`
		Usuarios []UsuarioSSH `json:"usuarios"`
	} `json:"ssh"`
	Auditd struct {
		Estado  string `json:"estado"` // puesta, no-instalado, fallo
		Detalle string `json:"detalle,omitempty"`
	} `json:"auditd"`
	Docker struct {
		Version       string `json:"version,omitempty"`
		Actualizacion string `json:"actualizacion"` // no-aplica, al-dia, lanzada, en-marcha, fallo, espera
		Detalle       string `json:"detalle,omitempty"`
	} `json:"docker"`
}

// vigiladasAuditd: lo que vigilan las reglas, con su clave. Una vigilancia cuya
// carpeta madre no existe en la máquina haría fallar la carga de todas: se deja
// fuera (ReglasAuditd).
var vigiladasAuditd = []struct{ ruta, clave string }{
	{"/run/docker.sock", "sd-docker"},
	{"/etc/docker", "sd-docker"},
	{"/etc/systemd/system/docker.service.d", "sd-docker"},
	{"/usr/lib/systemd/system/docker.service", "sd-docker"},
	{"/usr/lib/systemd/system/docker.socket", "sd-docker"},
	{"/usr/bin/dockerd", "sd-docker"},
	{"/usr/bin/containerd", "sd-docker"},
	{"/usr/bin/runc", "sd-docker"},
	{"/etc/sudoers", "sd-sudoers"},
	{"/etc/sudoers.d", "sd-sudoers"},
	{"/etc/ssh/sshd_config", "sd-ssh"},
	{"/etc/ssh/sshd_config.d", "sd-ssh"},
	{"/etc/passwd", "sd-usuarios"},
	{"/etc/shadow", "sd-usuarios"},
	{"/etc/group", "sd-usuarios"},
	{"/etc/gshadow", "sd-usuarios"},
	{"/etc/audit", "sd-auditoria"},
}

// ReglasAuditd son las reglas de Sugardaddy para auditd. nodo es la carpeta del
// nodo en la máquina; casas, las de los usuarios que pueden entrar (root y uid ≥
// 1000), cuyas .ssh se vigilan; existe dice si una carpeta está en la máquina. Lo
// que escribe el propio nodo (sus contenedores no tienen auid) no se apunta en su
// carpeta: solo lo que hace alguien que ha entrado en la máquina.
func ReglasAuditd(nodo string, casas []string, existe func(string) bool) string {
	var b strings.Builder
	b.WriteString("# Sugardaddy: host audit rules (docs/diseno/cortafuegos-anfitrion.md). Written by the node; do not edit.\n")
	b.WriteString("# Keys start with sd-: the node sends these events to its console and on to the customer's SIEM.\n")
	for _, v := range vigiladasAuditd {
		if existe(filepath.Dir(v.ruta)) {
			b.WriteString("-w " + v.ruta + " -p wa -k " + v.clave + "\n")
		}
	}
	vistas := map[string]bool{}
	for _, c := range casas {
		ssh := filepath.Join(c, ".ssh")
		if RutaDatosValida(c) && !vistas[ssh] && existe(c) {
			vistas[ssh] = true
			b.WriteString("-w " + ssh + " -p wa -k sd-ssh\n")
		}
	}
	if RutaDatosValida(nodo) && existe(nodo) {
		b.WriteString("-a always,exit -F arch=b64 -F dir=" + nodo + " -F perm=wa -F auid>=1000 -F auid!=4294967295 -k sd-nodo\n")
		b.WriteString("-a always,exit -F arch=b64 -F dir=" + nodo + " -F perm=wa -F auid=0 -k sd-nodo\n")
	}
	return b.String()
}

// Maquina mira y prepara la máquina. Raiz es «/» dentro del auxiliar (tras entrar
// en la raíz de la máquina) y una carpeta en las pruebas.
type Maquina struct {
	Anfitrion
	Ahora func() time.Time
}

// Mirar hace lo de las tres partes y devuelve lo que ha visto. motor puede ser nil.
func (m Maquina) Mirar(nodo string, motor *MotorFijado) HechosMaquina {
	var h HechosMaquina
	_, err := os.Stat(m.ruta(rutaApplianceEnv))
	h.Appliance = err == nil
	h.SSH.Activo = m.sshActivo()
	h.SSH.Usuarios = m.usuariosSSH()
	h.Auditd.Estado, h.Auditd.Detalle = m.auditd(nodo, m.casas())
	h.Docker.Version, h.Docker.Actualizacion, h.Docker.Detalle = m.docker(h.Appliance, motor)
	return h
}

func (m Maquina) sshActivo() bool {
	if !m.Hay("systemctl") {
		return false
	}
	for _, u := range []string{"ssh.service", "sshd.service", "ssh.socket"} {
		if out, err := m.Ejecutar("systemctl", "is-active", u); err == nil && strings.TrimSpace(string(out)) == "active" {
			return true
		}
	}
	return false
}

// usuariosSSH: root y los usuarios de verdad (uid ≥ 1000) con un fichero de claves autorizadas.
func (m Maquina) usuariosSSH() []UsuarioSSH {
	b, err := leerAcotado(m.ruta("/etc/passwd"), 1<<20)
	if err != nil {
		return nil
	}
	var r []UsuarioSSH
	for _, l := range strings.Split(string(b), "\n") {
		c := strings.Split(l, ":")
		if len(c) < 7 {
			continue
		}
		uid, err := strconv.Atoi(c[2])
		if err != nil || (uid != 0 && (uid < 1000 || uid >= 65534)) {
			continue
		}
		casa := c[5]
		if !strings.HasPrefix(casa, "/") {
			continue
		}
		var huellas []string
		claves := 0
		for _, f := range []string{"authorized_keys", "authorized_keys2"} {
			hs, n := HuellasClaves(m.ruta(filepath.Join(casa, ".ssh", f)))
			huellas = append(huellas, hs...)
			claves += n
		}
		if claves == 0 {
			continue
		}
		sort.Strings(huellas)
		if len(huellas) > maxClavesPorUsuario {
			huellas = huellas[:maxClavesPorUsuario]
		}
		r = append(r, UsuarioSSH{Usuario: c[0], UID: uid, Claves: claves, Huellas: huellas})
		if len(r) >= maxUsuariosSSH {
			break
		}
	}
	return r
}

func leerAcotado(ruta string, tope int64) ([]byte, error) {
	f, err := os.Open(ruta)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var b bytes.Buffer
	_, err = b.ReadFrom(&limitado{f, tope})
	return b.Bytes(), err
}

type limitado struct {
	f    *os.File
	tope int64
}

func (l *limitado) Read(p []byte) (int, error) {
	if l.tope <= 0 {
		return 0, errors.New("file too large")
	}
	if int64(len(p)) > l.tope {
		p = p[:l.tope]
	}
	n, err := l.f.Read(p)
	l.tope -= int64(n)
	return n, err
}

// HuellasClaves lee un authorized_keys y devuelve las huellas SHA256 de sus claves
// (como «ssh-keygen -l») y cuántas hay.
func HuellasClaves(ruta string) ([]string, int) {
	b, err := leerAcotado(ruta, maxFicheroClaves)
	if err != nil {
		return nil, 0
	}
	var r []string
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		campos := strings.Fields(l)
		for i := 0; i+1 < len(campos); i++ {
			t := campos[i]
			if !(strings.HasPrefix(t, "ssh-") || strings.HasPrefix(t, "ecdsa-") || strings.HasPrefix(t, "sk-")) {
				continue
			}
			blob, err := base64.StdEncoding.DecodeString(campos[i+1])
			if err != nil || len(blob) < 8 {
				continue
			}
			s := sha256.Sum256(blob)
			r = append(r, "SHA256:"+base64.RawStdEncoding.EncodeToString(s[:]))
			break
		}
	}
	return r, len(r)
}

// casas: las carpetas de root y de los usuarios de verdad (uid ≥ 1000).
func (m Maquina) casas() []string {
	b, err := leerAcotado(m.ruta("/etc/passwd"), 1<<20)
	if err != nil {
		return nil
	}
	var r []string
	for _, l := range strings.Split(string(b), "\n") {
		c := strings.Split(l, ":")
		if len(c) < 7 {
			continue
		}
		if uid, err := strconv.Atoi(c[2]); err == nil && (uid == 0 || (uid >= 1000 && uid < 65534)) {
			r = append(r, c[5])
		}
		if len(r) >= maxUsuariosSSH {
			break
		}
	}
	return r
}

func (m Maquina) auditd(nodo string, casas []string) (string, string) {
	if !m.Hay("auditctl") || !m.Hay("augenrules") || !m.esCarpeta("/etc/audit") {
		return "no-instalado", "auditd is not installed on this machine"
	}
	cambio, err := m.escribirSiCambia(rutaReglasAuditd, []byte(ReglasAuditd(nodo, casas, m.esCarpeta)), 0o640)
	if err != nil {
		return PiezaFallo, "audit rules: " + err.Error()
	}
	if cambio {
		if out, err := m.Ejecutar("augenrules", "--load"); err != nil {
			return PiezaFallo, "augenrules --load: " + err.Error() + " " + recortarSalida(out)
		}
	}
	out, err := m.Ejecutar("auditctl", "-l")
	if err != nil {
		return PiezaFallo, "auditctl -l: " + err.Error()
	}
	if !strings.Contains(string(out), "sd-sudoers") {
		// Las reglas están en el fichero pero no cargadas (auditd parado o inmutable, -e 2).
		if out, err := m.Ejecutar("augenrules", "--load"); err != nil || !bytes.Contains(mustOut(m.Ejecutar("auditctl", "-l")), []byte("sd-sudoers")) {
			return PiezaFallo, "the rules are written but not loaded (is auditd running, or locked with -e 2?) " + recortarSalida(out)
		}
	}
	return PiezaPuesta, ""
}

func mustOut(b []byte, _ error) []byte { return b }

type estadoDocker struct {
	Estado  string `json:"estado"`
	Detalle string `json:"detalle"`
	Cuando  string `json:"cuando"`
	Version string `json:"version,omitempty"`
}

func (m Maquina) docker(appliance bool, motor *MotorFijado) (version, estado, detalle string) {
	if m.Hay("docker") {
		if out, err := m.Ejecutar("docker", "version", "--format", "{{.Server.Version}}"); err == nil {
			version = strings.TrimSpace(string(out))
		}
	}
	switch {
	case motor == nil || motor.Docker == "":
		return version, "no-aplica", "the signed version does not pin Docker"
	case version != "" && CompararVersiones(version, motor.Docker) >= 0:
		return version, "al-dia", ""
	case !appliance:
		return version, "no-aplica", "Docker on this machine is managed by its owner: update it to " + motor.Docker + " or later"
	case len(motor.Paquetes) == 0:
		return version, "no-aplica", "the signed version pins Docker " + motor.Docker + " but carries no appliance packages"
	case !m.Hay("systemd-run"):
		return version, PiezaFallo, "systemd-run is not available"
	}
	if out, _ := m.Ejecutar("systemctl", "is-active", UnidadDocker); strings.TrimSpace(string(out)) == "activating" || strings.TrimSpace(string(out)) == "active" {
		return version, "en-marcha", "the Docker update is running"
	}
	var antes estadoDocker
	if b, err := os.ReadFile(m.ruta(rutaEstadoDocker)); err == nil && json.Unmarshal(b, &antes) == nil && antes.Estado == PiezaFallo {
		ahora := time.Now
		if m.Ahora != nil {
			ahora = m.Ahora
		}
		if t, err := time.Parse(time.RFC3339, antes.Cuando); err == nil && ahora().Sub(t) < ReintentoDockerFallo {
			return version, "espera", "the last Docker update failed (" + antes.Detalle + "); retrying after " + t.Add(ReintentoDockerFallo).UTC().Format(time.RFC3339)
		}
	}
	if _, err := m.escribirSiCambia(rutaGuionDocker, GuionActualizarDocker, 0o755); err != nil {
		return version, PiezaFallo, "update script: " + err.Error()
	}
	args := []string{"--unit=" + UnidadDocker, "--collect", "--property=Type=oneshot", "--description=Sugardaddy: update Docker to the signed version", rutaGuionDocker}
	for _, p := range motor.Paquetes {
		args = append(args, p.Nombre+"="+p.Version+"="+p.Sha256)
	}
	if out, err := m.Ejecutar("systemd-run", args...); err != nil {
		return version, PiezaFallo, "systemd-run: " + err.Error() + " " + recortarSalida(out)
	}
	return version, "lanzada", "updating Docker " + version + " → " + motor.Docker + " (containers restart)"
}

// LeerHechosMaquina saca lo que dejó el auxiliar en su salida.
func LeerHechosMaquina(salida string) (HechosMaquina, bool) {
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	for i := len(lineas) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lineas[i])
		if !strings.HasPrefix(l, MarcaMaquina) {
			continue
		}
		var v struct {
			Maquina HechosMaquina `json:"maquina"`
		}
		if json.Unmarshal([]byte(l), &v) == nil && v.Maquina.Auditd.Estado != "" {
			return v.Maquina, true
		}
	}
	return HechosMaquina{}, false
}

// ConfigMaquina es el auxiliar «anfitrion»: como el de aislar-anfitrion,
// privilegiado y con el PID de la máquina para entrar en su raíz, sin red y con una
// orden fija. Lo que recibe (la carpeta del nodo y el Docker fijado) se valida antes
// y otra vez dentro.
func ConfigMaquina(imagen, nodo string, motor *MotorFijado) map[string]any {
	c := ConfigAislarAnfitrion(imagen, "")
	c["Cmd"] = []string{"anfitrion"}
	env := []string{"ANFITRION_NODO=" + nodo}
	if motor != nil {
		b, _ := json.Marshal(motor)
		env = append(env, "ANFITRION_MOTOR="+string(b))
	}
	c["Env"] = env
	c["Labels"] = map[string]string{"sugardaddy.auxiliar": "anfitrion"}
	return c
}
