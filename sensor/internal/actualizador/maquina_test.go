package actualizador

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const clavePrueba = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDkR1bSxLRezp/394Np7lmhO6Ys2tYjmxsUIopXpUjTW prueba"
const huellaPrueba = "SHA256:DOMK9YseJeuM3ok+0V5N+kf3txhuUes79foP4UYu+YA" // ssh-keygen -lf

func TestHuellasClavesComoSshKeygen(t *testing.T) {
	d := t.TempDir()
	f := filepath.Join(d, "authorized_keys")
	texto := "# comentario\n\n" + clavePrueba + "\n" +
		`command="/bin/true",no-pty ` + clavePrueba + "\nbasura sin clave\nssh-rsa no-es-base64!!\n"
	if err := os.WriteFile(f, []byte(texto), 0o600); err != nil {
		t.Fatal(err)
	}
	hs, n := HuellasClaves(f)
	if n != 2 || hs[0] != huellaPrueba || hs[1] != huellaPrueba {
		t.Fatalf("%d %v", n, hs)
	}
	// Un fichero desmedido no se lee.
	if err := os.WriteFile(f, []byte(strings.Repeat(clavePrueba+"\n", 2000)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, n := HuellasClaves(f); n != 0 {
		t.Fatalf("a file over the limit must not be read: %d", n)
	}
}

func raizMaquina(t *testing.T) string {
	r := t.TempDir()
	escribir := func(p, c string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(r, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(r, p), []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	escribir("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\n"+
		"daemon:x:1:1::/usr/sbin:/usr/sbin/nologin\n"+
		"kino:x:1000:1000::/home/kino:/bin/bash\n"+
		"otro:x:1001:1001::/home/otro:/bin/bash\n"+
		"nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n")
	escribir("/root/.ssh/authorized_keys", clavePrueba+"\n")
	escribir("/home/kino/.ssh/authorized_keys", clavePrueba+"\n"+clavePrueba+"\n")
	escribir("/usr/sbin/.ssh/authorized_keys", clavePrueba+"\n") // daemon: uid < 1000, no cuenta
	if err := os.MkdirAll(filepath.Join(r, "etc/audit/rules.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	return r
}

type ordenes struct {
	hay      map[string]bool
	llamadas []string
	salidas  map[string]string
	fallos   map[string]bool
}

func (o *ordenes) maquina(raiz string) Maquina {
	return Maquina{Anfitrion: Anfitrion{
		Raiz: raiz,
		Hay:  func(n string) bool { return o.hay[n] },
		Ejecutar: func(n string, args ...string) ([]byte, error) {
			l := strings.TrimSpace(n + " " + strings.Join(args, " "))
			o.llamadas = append(o.llamadas, l)
			for k, v := range o.salidas {
				if strings.HasPrefix(l, k) {
					if o.fallos[k] {
						return []byte(v), errors.New("falla")
					}
					return []byte(v), nil
				}
			}
			return nil, nil
		},
	}}
}

func TestMaquinaSSHyAuditd(t *testing.T) {
	r := raizMaquina(t)
	o := &ordenes{
		hay: map[string]bool{"systemctl": true, "auditctl": true, "augenrules": true, "docker": true},
		salidas: map[string]string{
			"systemctl is-active ssh.service": "active\n",
			"auditctl -l":                     "-w /etc/sudoers -p wa -k sd-sudoers\n",
			"docker version":                  "29.9.1\n",
		},
	}
	h := o.maquina(r).Mirar("/opt/sugardaddy", nil)
	if !h.SSH.Activo || len(h.SSH.Usuarios) != 2 {
		t.Fatalf("%+v", h.SSH)
	}
	if h.SSH.Usuarios[0].Usuario != "root" || h.SSH.Usuarios[1].Usuario != "kino" || h.SSH.Usuarios[1].Claves != 2 || h.SSH.Usuarios[1].Huellas[0] != huellaPrueba {
		t.Fatalf("%+v", h.SSH.Usuarios)
	}
	if h.Auditd.Estado != PiezaPuesta {
		t.Fatalf("%+v", h.Auditd)
	}
	b, err := os.ReadFile(filepath.Join(r, rutaReglasAuditd))
	if err != nil || !strings.Contains(string(b), "-w /etc/passwd -p wa -k sd-usuarios") ||
		!strings.Contains(string(b), "-w /home/kino/.ssh -p wa -k sd-ssh") || strings.Contains(string(b), "/usr/sbin/.ssh") {
		t.Fatalf("the audit rules must be written as generated:\n%s", b)
	}
	// Sin /etc/ssh en la máquina, nada de lo de dentro (cargarlo fallaría).
	if strings.Contains(string(b), "/etc/ssh/") || strings.Contains(string(b), "dir=/opt/sugardaddy") {
		t.Fatalf("watches whose folder is missing must be left out:\n%s", b)
	}
	if h.Appliance || h.Docker.Version != "29.9.1" || h.Docker.Actualizacion != "no-aplica" {
		t.Fatalf("%+v %+v", h.Appliance, h.Docker)
	}
	// Una segunda vuelta con las reglas iguales no las recarga.
	o.llamadas = nil
	o.maquina(r).Mirar("/opt/sugardaddy", nil)
	for _, l := range o.llamadas {
		if strings.HasPrefix(l, "augenrules") {
			t.Fatal("unchanged rules must not be reloaded")
		}
	}
	// Sin auditd.
	o.hay["auditctl"] = false
	if h := o.maquina(r).Mirar("/opt/sugardaddy", nil); h.Auditd.Estado != "no-instalado" {
		t.Fatalf("%+v", h.Auditd)
	}
}

func TestReglasAuditd(t *testing.T) {
	todo := func(string) bool { return true }
	r := ReglasAuditd("/opt/sugardaddy", []string{"/root", "/home/kino", "/home/kino", "/raro $(x)"}, todo)
	if strings.Count(r, "/home/kino/.ssh") != 1 || strings.Contains(r, "raro") {
		t.Fatalf("homes: %s", r)
	}
	for _, debe := range []string{"-w /run/docker.sock -p wa -k sd-docker", "-k sd-sudoers", "-w /root/.ssh -p wa -k sd-ssh", "-k sd-usuarios", "dir=/opt/sugardaddy -F perm=wa -F auid>=1000"} {
		if !strings.Contains(r, debe) {
			t.Errorf("missing %q", debe)
		}
	}
	if strings.Contains(r, "-e 2") {
		t.Fatal("the rules must not lock auditd: the node reloads them")
	}
	// Una carpeta rara no entra en las reglas.
	if strings.Contains(ReglasAuditd("/opt/x -k y", nil, todo), "/opt/x") {
		t.Fatal("an unsafe folder must not reach the rules")
	}
}

func motorDePrueba() *MotorFijado {
	return &MotorFijado{Docker: "29.9.1", Paquetes: []PaqueteFijado{
		{"docker-ce", "5:29.9.1-1~ubuntu.24.04~noble", strings.Repeat("a", 64)},
		{"containerd.io", "2.2.1-1~ubuntu.24.04~noble", strings.Repeat("b", 64)},
	}}
}

func TestMaquinaDockerAppliance(t *testing.T) {
	r := raizMaquina(t)
	if err := os.MkdirAll(filepath.Join(r, "etc/sugardaddy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r, rutaApplianceEnv), []byte("APPLIANCE_VERSION=0.4.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	o := &ordenes{
		hay:     map[string]bool{"systemctl": true, "docker": true, "systemd-run": true},
		salidas: map[string]string{"docker version": "28.5.0\n", "systemctl is-active sugardaddy-docker": "inactive\n"},
	}
	h := o.maquina(r).Mirar("/opt/sugardaddy", motorDePrueba())
	if !h.Appliance || h.Docker.Actualizacion != "lanzada" {
		t.Fatalf("%+v", h.Docker)
	}
	var lanzada string
	for _, l := range o.llamadas {
		if strings.HasPrefix(l, "systemd-run") {
			lanzada = l
		}
	}
	if !strings.Contains(lanzada, "--unit=sugardaddy-docker") || !strings.Contains(lanzada, "docker-ce=5:29.9.1-1~ubuntu.24.04~noble="+strings.Repeat("a", 64)) {
		t.Fatalf("%q", lanzada)
	}
	if b, _ := os.ReadFile(filepath.Join(r, rutaGuionDocker)); string(b) != string(GuionActualizarDocker) {
		t.Fatal("the update script must be written to the machine")
	}
	// En marcha: no se lanza otra.
	o.salidas["systemctl is-active sugardaddy-docker"] = "activating\n"
	if h := o.maquina(r).Mirar("/opt/sugardaddy", motorDePrueba()); h.Docker.Actualizacion != "en-marcha" {
		t.Fatalf("%+v", h.Docker)
	}
	// Un fallo reciente: espera.
	o.salidas["systemctl is-active sugardaddy-docker"] = "failed\n"
	est, _ := json.Marshal(estadoDocker{Estado: PiezaFallo, Detalle: "sha256", Cuando: time.Now().UTC().Format(time.RFC3339)})
	if err := os.MkdirAll(filepath.Join(r, "var/lib/sugardaddy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r, rutaEstadoDocker), est, 0o600); err != nil {
		t.Fatal(err)
	}
	if h := o.maquina(r).Mirar("/opt/sugardaddy", motorDePrueba()); h.Docker.Actualizacion != "espera" {
		t.Fatalf("%+v", h.Docker)
	}
	// Al día: nada.
	o.salidas["docker version"] = "29.10.0\n"
	if h := o.maquina(r).Mirar("/opt/sugardaddy", motorDePrueba()); h.Docker.Actualizacion != "al-dia" {
		t.Fatalf("%+v", h.Docker)
	}
}

func TestMaquinaDockerClienteSoloAvisa(t *testing.T) {
	r := raizMaquina(t)
	o := &ordenes{hay: map[string]bool{"docker": true, "systemd-run": true}, salidas: map[string]string{"docker version": "27.0.1\n"}}
	h := o.maquina(r).Mirar("/opt/sugardaddy", motorDePrueba())
	if h.Docker.Actualizacion != "no-aplica" || !strings.Contains(h.Docker.Detalle, "29.9.1") {
		t.Fatalf("%+v", h.Docker)
	}
	for _, l := range o.llamadas {
		if strings.HasPrefix(l, "systemd-run") {
			t.Fatal("a customer-managed machine must never get Docker updated")
		}
	}
}

func TestValidarMotor(t *testing.T) {
	if err := ValidarMotor(motorDePrueba()); err != nil {
		t.Fatal(err)
	}
	malos := []*MotorFijado{
		{Docker: "29.9"},
		{Docker: "29.9.1; rm -rf /"},
		{Docker: "29.9.1", Paquetes: []PaqueteFijado{{"bash", "1", strings.Repeat("a", 64)}}},
		{Docker: "29.9.1", Paquetes: []PaqueteFijado{{"docker-ce", "1 2", strings.Repeat("a", 64)}}},
		{Docker: "29.9.1", Paquetes: []PaqueteFijado{{"docker-ce", "1", "abc"}}},
		{Docker: "29.9.1", Paquetes: []PaqueteFijado{{"docker-ce", "1", strings.Repeat("a", 64)}, {"docker-ce", "1", strings.Repeat("a", 64)}}},
	}
	for i, m := range malos {
		if ValidarMotor(m) == nil {
			t.Errorf("%d accepted", i)
		}
	}
}

func TestCompararVersiones(t *testing.T) {
	casos := []struct {
		a, b string
		r    int
	}{{"29.9.1", "29.9.1", 0}, {"28.5.2", "29.0.0", -1}, {"29.10.0", "29.9.1", 1}, {"29.9.1-rc1", "29.9.1", 0}}
	for _, c := range casos {
		if CompararVersiones(c.a, c.b) != c.r {
			t.Errorf("%s vs %s", c.a, c.b)
		}
	}
}

func TestConfigMaquina(t *testing.T) {
	c := ConfigMaquina("r/actualizador@sha256:1", "/opt/sugardaddy", motorDePrueba())
	hc := c["HostConfig"].(map[string]any)
	if hc["NetworkMode"] != "none" || hc["PidMode"] != "host" || c["Cmd"].([]string)[0] != "anfitrion" {
		t.Fatalf("%v", c)
	}
	if env := c["Env"].([]string); len(env) != 2 || !strings.HasPrefix(env[1], "ANFITRION_MOTOR={") {
		t.Fatalf("%v", env)
	}
}

func TestLeerHechosMaquina(t *testing.T) {
	h, ok := LeerHechosMaquina("ruido\n{\"maquina\":{\"appliance\":true,\"ssh\":{\"activo\":false,\"usuarios\":null},\"auditd\":{\"estado\":\"puesta\"},\"docker\":{\"actualizacion\":\"al-dia\"}}}\n")
	if !ok || !h.Appliance || h.Auditd.Estado != "puesta" {
		t.Fatalf("%v %+v", ok, h)
	}
	if _, ok := LeerHechosMaquina("nada"); ok {
		t.Fatal()
	}
}
