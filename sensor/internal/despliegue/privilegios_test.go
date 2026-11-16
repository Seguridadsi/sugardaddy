package despliegue

// La parte de la tabla de privilegios por contenedor (plan de fortificación §2.8)
// que no está en ningún compose: lo que crean el sensor (a través de sd-motor) y el
// actualizador, sacado del mismo código que lo crea. herramientas/privilegios.ts la
// junta con los compose y los manifiestos de las trampas y escribe
// docs/seguridad/privilegios-contenedores.md. Esta prueba falla si el código cambia
// y el JSON no: regenerarlo con
//
//	cd sensor && SD_PRIVILEGIOS=escribir go test ./internal/despliegue -run TestTablaDePrivilegios
//	node --experimental-strip-types herramientas/privilegios.ts

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/copias"
	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/intermediario"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

const rutaPrivilegios = "../../../docs/seguridad/privilegios-creados.json"

// Lo que cuenta para la tabla; lo demás (entorno, etiquetas, puertos, registros) no.
var camposPrivilegio = []string{"Privileged", "User", "Runtime", "CapAdd", "CapDrop", "SecurityOpt",
	"ReadonlyRootfs", "NetworkMode", "PidMode", "IpcMode", "UsernsMode", "Memory", "MemorySwap",
	"NanoCpus", "CpuShares", "PidsLimit", "Tmpfs", "Binds", "Mounts", "Devices"}

type contenedorCreado struct {
	Nombre string         `json:"nombre"`
	Quien  string         `json:"quien"`
	Cuando string         `json:"cuando"`
	Config map[string]any `json:"config"`
}

// resumir deja los campos de privilegio con valores estables: rutas de prueba en
// <DATOS>, y el perfil seccomp (cientos de líneas) en su nombre.
func resumir(t *testing.T, cfg map[string]any, datos string) map[string]any {
	t.Helper()
	b, _ := json.Marshal(cfg)
	b = bytes.ReplaceAll(b, []byte(datos), []byte("<DATOS>"))
	var c map[string]any
	_ = json.Unmarshal(b, &c)
	h, _ := c["HostConfig"].(map[string]any)
	if h == nil {
		h = map[string]any{}
	}
	if u, ok := c["User"]; ok {
		h["User"] = u
	}
	out := map[string]any{}
	for _, k := range camposPrivilegio {
		v, ok := h[k]
		if !ok || v == nil {
			continue
		}
		if k == "SecurityOpt" {
			var opts []string
			for _, o := range v.([]any) {
				s := o.(string)
				if strings.HasPrefix(s, "seccomp=") {
					s = "seccomp=sugardaddy-trampa"
				}
				opts = append(opts, s)
			}
			v = opts
		}
		if k == "Mounts" {
			var ms []map[string]any
			for _, m := range v.([]any) {
				m := m.(map[string]any)
				r := map[string]any{"Type": m["Type"], "Target": m["Target"], "ReadOnly": m["ReadOnly"] == true}
				if m["Type"] == "bind" {
					r["Source"] = m["Source"]
				}
				ms = append(ms, r)
			}
			sort.Slice(ms, func(i, j int) bool { return ms[i]["Target"].(string) < ms[j]["Target"].(string) })
			v = ms
		}
		out[k] = v
	}
	return out
}

func TestTablaDePrivilegios(t *testing.T) {
	datos := t.TempDir()
	o := Opciones{Datos: datos, Escucha: "0.0.0.0", ImagenSonda: "sensor@sha256:s"}
	var puente plan.Manifiesto
	if err := json.Unmarshal([]byte(`{
		"id": "ejemplo",
		"contenedor": {"imagen": "trampa@sha256:t", "registros": "/log", "escribibles": ["/data"],
			"puertos": [{"interno": 6379, "expuesto": "6379", "protocolo": "tcp"}]},
		"aislamiento": {"soloLectura": true, "cpu": 0.5, "memoriaMb": 128}
	}`), &puente); err != nil {
		t.Fatal(err)
	}
	var enlace plan.Manifiesto
	if err := json.Unmarshal([]byte(`{
		"id": "darknet",
		"contenedor": {"imagen": "trampa@sha256:t", "registros": "/log"},
		"red": {"modo": "ip-propia", "capturar": "10.0.0.0/24"},
		"aislamiento": {"soloLectura": true, "cpu": 0.25, "memoriaMb": 64}
	}`), &enlace); err != nil {
		t.Fatal(err)
	}
	var creados []contenedorCreado
	anadir := func(nombre, quien, cuando string, cfg map[string]any) {
		creados = append(creados, contenedorCreado{nombre, quien, cuando, resumir(t, cfg, datos)})
	}

	// Las trampas, en cada aislamiento que puede decidir sd-motor.
	modos := []struct {
		nombre string
		a      intermediario.Aislamiento
	}{
		{"runsc", intermediario.Decidir([]string{"runc", "runsc"}, true, "")},
		{"runc-perfiles", intermediario.Decidir([]string{"runc"}, true, actualizador.NombrePerfilAppArmor)},
		{"runc-seccomp", intermediario.Decidir([]string{"runc"}, true, "")},
	}
	for _, m := range modos {
		for _, conDisco := range []bool{false, true} {
			cfg, _, err := config(o, "local", datos+"/licencia.json", plan.TrampaPlan{ID: "ejemplo", Manifiesto: puente}, conDisco, nil)
			if err != nil {
				t.Fatal(err)
			}
			m.a.Endurecer(cfg, false)
			nombre := "decoy (isolated bridge), " + m.nombre
			if conDisco {
				nombre += ", with its own disk"
			}
			anadir(nombre, "sensor → sd-motor", "one per deployed decoy", cfg)
		}
	}
	o.RedPropia = &RedPropia{Puente: "sd-banco-ip-propia", IPFija: "172.31.201.10", Rango: netip.MustParsePrefix("172.31.201.0/24")}
	for _, m := range modos[1:] {
		cfg, _, err := config(o, "local", "", plan.TrampaPlan{ID: "darknet", Manifiesto: enlace}, false, nil)
		if err != nil {
			t.Fatal(err)
		}
		m.a.Endurecer(cfg, true)
		anadir("decoy with capture (own IP), "+m.nombre, "sensor → sd-motor", "decoys with red.capturar (always runc, also with gVisor)", cfg)
	}
	anadir("capture companion", "sensor → sd-motor", "one per decoy with red.capturar", configCaptura("sensor@sha256:s", "darknet", "sd_trampa", "BPF"))
	for _, s := range []struct{ orden, red string }{{"probar-clone3", "none"}, {"puerta-enlace", "host"}, {"puertos-anfitrion", "host"}, {"escuchar", "sd-trampas"}, {"sondear", "sd-trampas"}} {
		anadir("probe «"+s.orden+"»", "sensor → sd-motor", "seconds, on start and every few minutes",
			docker.ConfigSonda(docker.Sonda{Nombre: "sd_sonda", Imagen: "sensor@sha256:s", Orden: []string{s.orden}, Red: s.red}))
	}
	// Los auxiliares del actualizador (que ya tiene el socket de Docker).
	anadir("version helper («aplicar»)", "updater", "while a signed version is applied",
		actualizador.ConfigAuxiliar(actualizador.Pedido{Imagen: "actualizador@sha256:a", Dir: "<NODO>", Proyecto: "sugardaddy"}))
	anadir("machine isolation helper («aislar-anfitrion»)", "version helper", "seconds, once per applied version",
		actualizador.ConfigAislarAnfitrion("actualizador@sha256:a", "<DATOS>"))
	anadir("SEN-5 firewall helper («cortafuegos-trampas»)", "updater", "seconds, on start and every 10 minutes",
		actualizador.ConfigCortafuegosTrampas("actualizador@sha256:a"))
	anadir("console firewall helper («cortafuegos»)", "updater", "seconds, when the console access list changes",
		actualizador.ConfigCortafuegos("actualizador@sha256:a", cortafuegos.Pedido{Puerto: 443}))
	anadir("strict host firewall helper («cortafuegos-anfitrion»)", "updater", "up to 90 s (dead-man wait), on change and every 5 minutes while on",
		actualizador.ConfigCortafuegosAnfitrion("actualizador@sha256:a", []string{"ESTRICTO=<estado>"}, "<NODO>/cortafuegos-anfitrion"))
	anadir("host facts and audit rules helper («anfitrion»)", "updater", "seconds, on start and every 30 minutes",
		actualizador.ConfigMaquina("actualizador@sha256:a", "<NODO>", nil))
	anadir("SMB backups helper («copias-smb»), upload, list or delete", "updater", "seconds, after each nightly backup (cifs volume mounted by Docker, removed after)",
		copias.ConfigAuxiliarSMB("actualizador@sha256:a", "<VOLUMEN-CIFS>", "<NODO>/copias", "", "subir", "<COPIA>", nil))
	anadir("SMB backups helper («copias-smb»), download for the restore test", "updater", "seconds, once a month or when asked",
		copias.ConfigAuxiliarSMB("actualizador@sha256:a", "<VOLUMEN-CIFS>", "<NODO>/copias", "", "bajar", "<COPIA>", nil))

	seccomp := intermediario.PerfilSeccomp()
	suma := sha256.Sum256([]byte(seccomp))
	var perfil struct {
		Syscalls []struct {
			Names  []string `json:"names"`
			Action string   `json:"action"`
		} `json:"syscalls"`
	}
	_ = json.Unmarshal([]byte(seccomp), &perfil)
	permitidas := map[string]bool{}
	for _, r := range perfil.Syscalls {
		if r.Action == "SCMP_ACT_ALLOW" {
			for _, n := range r.Names {
				permitidas[n] = true
			}
		}
	}
	servicio, _ := actualizador.UnidadesDiscos("<DATOS>/sensor")
	salida := map[string]any{
		"creados":  creados,
		"seccomp":  map[string]any{"nombre": "sugardaddy-trampa", "sha256": hex.EncodeToString(suma[:]), "llamadasPermitidas": len(permitidas)},
		"apparmor": map[string]any{"nombre": actualizador.NombrePerfilAppArmor, "sha256": hex.EncodeToString(func() []byte { s := sha256.Sum256(actualizador.PerfilAppArmor); return s[:] }())},
		"sdDiscos": servicio,
		"sen5": map[string]any{"puentes": []string{PuenteTrampas, PuenteConSalida},
			"input": "-A INPUT " + strings.Join(cortafuegos.SaltoTrampas(), " "), "cadena": cortafuegos.RestoreTrampas()},
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "\t")
	if err := enc.Encode(salida); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	ruta := filepath.FromSlash(rutaPrivilegios)
	if os.Getenv("SD_PRIVILEGIOS") == "escribir" {
		if err := os.WriteFile(ruta, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	actual, err := os.ReadFile(ruta)
	if errors.Is(err, os.ErrNotExist) {
		if _, e := os.Stat(filepath.Dir(ruta)); errors.Is(e, os.ErrNotExist) {
			t.Skip("docs/seguridad is not in this tree (the Community edition does not carry it)")
		}
	}
	if err != nil || !bytes.Equal(actual, b) {
		t.Fatalf("docs/seguridad/privilegios-creados.json is not what the code creates: regenerate it with\n" +
			"  cd sensor && SD_PRIVILEGIOS=escribir go test ./internal/despliegue -run TestTablaDePrivilegios\n" +
			"  node --experimental-strip-types herramientas/privilegios.ts")
	}
}
