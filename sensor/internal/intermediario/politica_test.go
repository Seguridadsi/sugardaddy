package intermediario

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

const datosPrueba = "/opt/sd/datos/sensor"

func manifiestoPrueba() *plan.Manifiesto {
	var m plan.Manifiesto
	_ = json.Unmarshal([]byte(`{"id": "redis",
		"contenedor": {"imagen": "r/redis@sha256:aaaa", "registros": "/log", "escribibles": ["/data"],
			"ficheros": [{"destino": "/etc/redis.conf", "contenido": "x"}]},
		"aislamiento": {"soloLectura": true, "cpu": 0.5, "memoriaMb": 64}}`), &m)
	return &m
}

// configPrueba: lo que manda el sensor para una trampa (forma de despliegue.config).
func configPrueba() map[string]any {
	var m map[string]any
	_ = json.Unmarshal([]byte(`{
		"Image": "r/redis@sha256:aaaa",
		"Env": ["A=1"],
		"ExposedPorts": {"6379/tcp": {}},
		"Labels": {"sugardaddy.trampa": "cache-1", "sugardaddy.sensor": "local"},
		"HostConfig": {
			"NetworkMode": "sugardaddy-trampas-aisladas",
			"PortBindings": {"6379/tcp": [{"HostIp": "0.0.0.0", "HostPort": "6379"}]},
			"ReadonlyRootfs": true,
			"CapDrop": ["ALL"],
			"SecurityOpt": ["no-new-privileges"],
			"Memory": 67108864, "MemorySwap": 67108864, "NanoCpus": 500000000, "CpuShares": 256, "PidsLimit": 256,
			"Mounts": [
				{"Type": "bind", "Source": "/opt/sd/datos/sensor/registros/cache-1", "Target": "/log"},
				{"Type": "bind", "Source": "/opt/sd/datos/sensor/config/cache-1/0", "Target": "/etc/redis.conf", "ReadOnly": true},
				{"Type": "bind", "Source": "/opt/sd/datos/sensor/licencia.json", "Target": "/sugardaddy/licencia.json", "ReadOnly": true},
				{"Type": "volume", "Source": "sd-local-cache-1-0", "Target": "/data", "VolumeOptions": {"Labels": {"sugardaddy.sensor": "local"}}}
			],
			"RestartPolicy": {"Name": "unless-stopped"},
			"Tmpfs": {"/tmp": "rw,noexec,nosuid,size=16m"},
			"LogConfig": {"Type": "json-file", "Config": {"max-size": "10m"}}
		}
	}`), &m)
	return m
}

func reglasPrueba() Reglas {
	return Reglas{
		Datos: datosPrueba, ImagenSensor: "r/sensor@sha256:bbbb",
		UsuarioImagen:   func(string) (string, error) { return "65534:65534", nil },
		VolumenesImagen: func(string) ([]string, error) { return []string{"/var/lib/extra"}, nil },
		TrampaDe: func(c string) (string, bool) {
			if c == "sd-local-darknet" {
				return "darknet", true
			}
			return "", false
		},
	}
}

func hc(cfg map[string]any) map[string]any { return cfg["HostConfig"].(map[string]any) }

func TestTrampaValidaPasa(t *testing.T) {
	if _, err := reglasPrueba().Validar(Peticion{Config: configPrueba(), Manifiesto: manifiestoPrueba()}); err != nil {
		t.Fatal(err)
	}
}

// Cada fuga conocida por la petición de creación se rechaza, venga de quien venga.
func TestTrampaRechazos(t *testing.T) {
	casos := map[string]func(cfg map[string]any, m *plan.Manifiesto){
		"privileged":             func(c map[string]any, _ *plan.Manifiesto) { hc(c)["Privileged"] = true },
		"red del anfitrión":      func(c map[string]any, _ *plan.Manifiesto) { hc(c)["NetworkMode"] = "host" },
		"red de otro contenedor": func(c map[string]any, _ *plan.Manifiesto) { hc(c)["NetworkMode"] = "container:sd-motor" },
		"red con salida": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["NetworkMode"] = "sugardaddy-trampas-salida-aisladas"
		},
		"red bridge":           func(c map[string]any, _ *plan.Manifiesto) { hc(c)["NetworkMode"] = "bridge" },
		"PID del anfitrión":    func(c map[string]any, _ *plan.Manifiesto) { hc(c)["PidMode"] = "host" },
		"IPC del anfitrión":    func(c map[string]any, _ *plan.Manifiesto) { hc(c)["IpcMode"] = "host" },
		"userns del anfitrión": func(c map[string]any, _ *plan.Manifiesto) { hc(c)["UsernsMode"] = "host" },
		"dispositivos": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["Devices"] = []any{map[string]any{"PathOnHost": "/dev/sda"}}
		},
		"Binds clásicos":  func(c map[string]any, _ *plan.Manifiesto) { hc(c)["Binds"] = []any{"/:/host"} },
		"runtime elegido": func(c map[string]any, _ *plan.Manifiesto) { hc(c)["Runtime"] = "runc" },
		"CapAdd SYS_ADMIN": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["CapAdd"] = []any{"SYS_ADMIN"}
		},
		"CapAdd NET_RAW en la trampa": func(c map[string]any, _ *plan.Manifiesto) { hc(c)["CapAdd"] = []any{"NET_RAW"} },
		"sin CapDrop ALL":             func(c map[string]any, _ *plan.Manifiesto) { hc(c)["CapDrop"] = []any{"NET_RAW"} },
		"seccomp unconfined": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["SecurityOpt"] = []any{"no-new-privileges", "seccomp=unconfined"}
		},
		"apparmor unconfined": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["SecurityOpt"] = []any{"no-new-privileges", "apparmor=unconfined"}
		},
		"sin no-new-privileges": func(c map[string]any, _ *plan.Manifiesto) { hc(c)["SecurityOpt"] = []any{} },
		"como root":             func(c map[string]any, _ *plan.Manifiesto) { c["User"] = "0:0" },
		"como root por nombre":  func(c map[string]any, _ *plan.Manifiesto) { c["User"] = "root" },
		"con orden":             func(c map[string]any, _ *plan.Manifiesto) { c["Cmd"] = []any{"/bin/sh"} },
		"campo desconocido":     func(c map[string]any, _ *plan.Manifiesto) { c["Entrypoint"] = []any{"/bin/sh"} },
		"otra imagen":           func(c map[string]any, _ *plan.Manifiesto) { c["Image"] = "atacante/shell:latest" },
		"bind de /": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 0)["Source"] = "/"
		},
		"bind del socket de docker": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 0)["Source"] = "/var/run/docker.sock"
		},
		"bind de otra trampa": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 0)["Source"] = datosPrueba + "/registros/otra"
		},
		"bind con ..": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 0)["Source"] = datosPrueba + "/registros/cache-1/../../estado"
		},
		"configuración escribible": func(c map[string]any, _ *plan.Manifiesto) { montaje(c, 1)["ReadOnly"] = false },
		"licencia escribible":      func(c map[string]any, _ *plan.Manifiesto) { montaje(c, 2)["ReadOnly"] = false },
		"propagación": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 0)["BindOptions"] = map[string]any{"Propagation": "rshared"}
		},
		"destino /proc": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 0)["Target"] = "/proc"
		},
		"montaje tmpfs": func(c map[string]any, _ *plan.Manifiesto) { montaje(c, 0)["Type"] = "tmpfs" },
		"volumen de otro": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 3)["Source"] = "sugardaddy_datos-postgres"
		},
		"volumen que es una carpeta del anfitrión": func(c map[string]any, _ *plan.Manifiesto) {
			montaje(c, 3)["VolumeOptions"] = map[string]any{"DriverConfig": map[string]any{"Name": "local",
				"Options": map[string]any{"type": "none", "o": "bind", "device": "/etc"}}}
		},
		"tmpfs ejecutable": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["Tmpfs"] = map[string]any{"/tmp": "rw,size=16m"}
		},
		"tmpfs en /dev/shm": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["Tmpfs"] = map[string]any{"/dev/shm": "rw,noexec,nosuid"}
		},
		"raíz escribible": func(c map[string]any, _ *plan.Manifiesto) { hc(c)["ReadonlyRootfs"] = false },
		"más memoria": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["Memory"] = float64(1 << 30)
			hc(c)["MemorySwap"] = float64(1 << 30)
		},
		"sin tope de procesos":        func(c map[string]any, _ *plan.Manifiesto) { delete(hc(c), "PidsLimit") },
		"sin tope de CPU":             func(c map[string]any, _ *plan.Manifiesto) { delete(hc(c), "NanoCpus") },
		"CPU a cero":                  func(c map[string]any, _ *plan.Manifiesto) { hc(c)["NanoCpus"] = float64(0) },
		"sin tope de swap":            func(c map[string]any, _ *plan.Manifiesto) { delete(hc(c), "MemorySwap") },
		"swap de más":                 func(c map[string]any, _ *plan.Manifiesto) { hc(c)["MemorySwap"] = float64(-1) },
		"más peso de CPU que el nodo": func(c map[string]any, _ *plan.Manifiesto) { hc(c)["CpuShares"] = float64(4096) },
		"salida a internet en el manifiesto": func(_ map[string]any, m *plan.Manifiesto) {
			m.Aislamiento.Salida = true
		},
		"driver de registros": func(c map[string]any, _ *plan.Manifiesto) {
			hc(c)["LogConfig"] = map[string]any{"Type": "syslog"}
		},
		"id con ..": func(c map[string]any, _ *plan.Manifiesto) {
			c["Labels"].(map[string]any)["sugardaddy.trampa"] = "../x"
		},
	}
	for nombre, cambiar := range casos {
		cfg, m := configPrueba(), manifiestoPrueba()
		cambiar(cfg, m)
		_, err := reglasPrueba().Validar(Peticion{Config: cfg, Manifiesto: m})
		var rz *Rechazo
		if !errors.As(err, &rz) {
			t.Errorf("%s: tenía que rechazarse (err=%v)", nombre, err)
		}
	}
}

func montaje(c map[string]any, i int) map[string]any {
	return hc(c)["Mounts"].([]any)[i].(map[string]any)
}

func TestTrampaSinManifiestoOFueraDelCatalogo(t *testing.T) {
	_, err := reglasPrueba().Validar(Peticion{Config: configPrueba()})
	if rz := (*Rechazo)(nil); !errors.As(err, &rz) || rz.Codigo != CodigoSinManif {
		t.Fatalf("sin manifiesto: %v", err)
	}
	r := reglasPrueba()
	r.Catalogo = func(plan.Manifiesto) string { return "not in the signed catalog" }
	_, err = r.Validar(Peticion{Config: configPrueba(), Manifiesto: manifiestoPrueba()})
	if rz := (*Rechazo)(nil); !errors.As(err, &rz) || rz.Codigo != CodigoCatalogo {
		t.Fatalf("fuera del catálogo: %v", err)
	}
}

func TestImagenRootSeRechaza(t *testing.T) {
	r := reglasPrueba()
	r.UsuarioImagen = func(string) (string, error) { return "", nil }
	_, err := r.Validar(Peticion{Config: configPrueba(), Manifiesto: manifiestoPrueba()})
	if rz := (*Rechazo)(nil); !errors.As(err, &rz) || rz.Codigo != CodigoRootTramp {
		t.Fatalf("imagen sin USER: %v", err)
	}
}

func TestVolumenDeImagenYDisco(t *testing.T) {
	cfg := configPrueba()
	ms := hc(cfg)["Mounts"].([]any)
	ms = append(ms,
		map[string]any{"Type": "volume", "Source": "sd_disco_local_cache-1_imagen-0011223344556677", "Target": "/var/lib/extra",
			"VolumeOptions": map[string]any{"DriverConfig": map[string]any{"Name": "local", "Options": map[string]any{
				"type": "none", "o": "bind", "device": datosPrueba + "/discos/cache-1/imagen-0011223344556677"}}}},
		map[string]any{"Type": "bind", "Source": datosPrueba + "/discos/cache-1/registros", "Target": "/log"},
	)
	hc(cfg)["Mounts"] = ms
	if _, err := reglasPrueba().Validar(Peticion{Config: cfg, Manifiesto: manifiestoPrueba()}); err != nil {
		t.Fatal(err)
	}
}

func capturaPrueba() map[string]any {
	var m map[string]any
	_ = json.Unmarshal([]byte(`{
		"Image": "r/sensor@sha256:bbbb", "Cmd": ["captura", "AAAA"], "User": "0:0",
		"Labels": {"sugardaddy.captura": "darknet"},
		"HostConfig": {"NetworkMode": "container:sd-local-darknet", "ReadonlyRootfs": true, "CapDrop": ["ALL"],
			"CapAdd": ["NET_RAW"], "SecurityOpt": ["no-new-privileges"], "Memory": 33554432, "MemorySwap": 33554432, "NanoCpus": 500000000, "PidsLimit": 16}
	}`), &m)
	return m
}

func TestCaptura(t *testing.T) {
	if _, err := reglasPrueba().Validar(Peticion{Config: capturaPrueba()}); err != nil {
		t.Fatal(err)
	}
	casos := map[string]func(map[string]any){
		"otra imagen":       func(c map[string]any) { c["Image"] = "alpine" },
		"otra orden":        func(c map[string]any) { c["Cmd"] = []any{"sh"} },
		"más capacidades":   func(c map[string]any) { hc(c)["CapAdd"] = []any{"NET_RAW", "NET_ADMIN"} },
		"en la red de otro": func(c map[string]any) { hc(c)["NetworkMode"] = "container:sd-motor" },
		"de otra trampa":    func(c map[string]any) { c["Labels"].(map[string]any)["sugardaddy.captura"] = "otra" },
		"red del anfitrión": func(c map[string]any) { hc(c)["NetworkMode"] = "host" },
		"con montajes":      func(c map[string]any) { hc(c)["Mounts"] = []any{} },
		"sin tope de CPU":   func(c map[string]any) { delete(hc(c), "NanoCpus") },
	}
	for n, f := range casos {
		c := capturaPrueba()
		f(c)
		if _, err := reglasPrueba().Validar(Peticion{Config: c}); err == nil {
			t.Errorf("captura %s: tenía que rechazarse", n)
		}
	}
}

func TestSonda(t *testing.T) {
	sonda := func(orden, red string) map[string]any {
		return map[string]any{
			"Image": "r/sensor@sha256:bbbb", "Cmd": []any{orden}, "Labels": map[string]any{"sugardaddy.sonda": "local"},
			"HostConfig": map[string]any{"NetworkMode": red, "ReadonlyRootfs": true, "CapDrop": []any{"ALL"},
				"SecurityOpt": []any{"no-new-privileges"}, "Memory": float64(32 << 20), "MemorySwap": float64(32 << 20), "NanoCpus": float64(5e8), "PidsLimit": float64(16)},
		}
	}
	for _, ok := range [][2]string{{"probar-clone3", "none"}, {"puertos-anfitrion", "host"}, {"sondear", "sugardaddy-trampas-aisladas"}} {
		if _, err := reglasPrueba().Validar(Peticion{Config: sonda(ok[0], ok[1])}); err != nil {
			t.Errorf("%v: %v", ok, err)
		}
	}
	for _, malo := range [][2]string{{"probar-clone3", "host"}, {"sh", "none"}, {"sondear", "host"}} {
		if _, err := reglasPrueba().Validar(Peticion{Config: sonda(malo[0], malo[1])}); err == nil {
			t.Errorf("%v: tenía que rechazarse", malo)
		}
	}
	c := sonda("probar-clone3", "none")
	c["Image"] = "alpine"
	if _, err := reglasPrueba().Validar(Peticion{Config: c}); err == nil {
		t.Error("una sonda con otra imagen tenía que rechazarse")
	}
}

func TestSinEtiquetaNoSeCrea(t *testing.T) {
	c := configPrueba()
	c["Labels"] = map[string]any{"cualquiera": "x"}
	if _, err := reglasPrueba().Validar(Peticion{Config: c, Manifiesto: manifiestoPrueba()}); err == nil {
		t.Fatal("un contenedor que no es del sensor no se crea")
	}
}

func TestRedes(t *testing.T) {
	bien := []map[string]any{
		{"Name": "sugardaddy-trampas-aisladas", "Driver": "bridge", "Options": map[string]any{"com.docker.network.bridge.enable_icc": "false",
			"com.docker.network.bridge.enable_ip_masquerade": "false", "com.docker.network.bridge.name": "sd-trampas0"}},
		{"Name": "sugardaddy-trampas-ip-propia", "Driver": "macvlan", "Options": map[string]any{"parent": "eth0"}},
	}
	for _, r := range bien {
		if err := ValidarRed(r); err != nil {
			t.Errorf("%v: %v", r["Name"], err)
		}
	}
	mal := []map[string]any{
		{"Name": "sugardaddy-trampas-aisladas", "Driver": "bridge"},
		// SEN-5: sin el nombre fijo del puente, o con otro, o con salida, o con más opciones.
		{"Name": "sugardaddy-trampas-aisladas", "Driver": "bridge", "Options": map[string]any{"com.docker.network.bridge.enable_icc": "false",
			"com.docker.network.bridge.enable_ip_masquerade": "false"}},
		{"Name": "sugardaddy-trampas-aisladas", "Driver": "bridge", "Options": map[string]any{"com.docker.network.bridge.enable_icc": "false",
			"com.docker.network.bridge.enable_ip_masquerade": "false", "com.docker.network.bridge.name": "docker0"}},
		{"Name": "sugardaddy-trampas-aisladas", "Driver": "bridge", "Options": map[string]any{"com.docker.network.bridge.enable_icc": "false",
			"com.docker.network.bridge.enable_ip_masquerade": "true", "com.docker.network.bridge.name": "sd-trampas0"}},
		{"Name": "sugardaddy-trampas-aisladas", "Driver": "bridge", "Options": map[string]any{"com.docker.network.bridge.enable_icc": "false",
			"com.docker.network.bridge.enable_ip_masquerade": "false", "com.docker.network.bridge.name": "sd-trampas0",
			"com.docker.network.bridge.gateway_mode_ipv4": "nat-unprotected"}},
		{"Name": "sugardaddy-trampas-salida-aisladas", "Driver": "bridge", "Options": map[string]any{"com.docker.network.bridge.enable_icc": "false"}},
		{"Name": "cualquiera", "Driver": "bridge", "Options": map[string]any{"com.docker.network.bridge.enable_icc": "false"}},
		{"Name": "sugardaddy-trampas-x", "Driver": "host"},
		{"Name": "sugardaddy-trampas-x", "Driver": "ipvlan"},
		{"Name": "sugardaddy-trampas-x", "Driver": "macvlan", "Options": map[string]any{"macvlan_mode": "passthru"}},
	}
	for _, r := range mal {
		if err := ValidarRed(r); err == nil {
			t.Errorf("%v: tenía que rechazarse", r)
		}
	}
}

func TestImagenSoloPorDigest(t *testing.T) {
	if ValidarImagen("ghcr.io/x/redis@sha256:"+strings.Repeat("a", 64)) != nil {
		t.Fatal("por digest vale")
	}
	for _, m := range []string{"alpine", "alpine:latest", "x@sha256:abc"} {
		if ValidarImagen(m) == nil {
			t.Errorf("%s: tenía que rechazarse", m)
		}
	}
}

func TestPerfilSeccomp(t *testing.T) {
	var p struct {
		DefaultAction string `json:"defaultAction"`
		Syscalls      []struct {
			Names  []string `json:"names"`
			Action string   `json:"action"`
		} `json:"syscalls"`
	}
	if err := json.Unmarshal([]byte(PerfilSeccomp()), &p); err != nil {
		t.Fatal(err)
	}
	if p.DefaultAction != "SCMP_ACT_ERRNO" {
		t.Fatalf("por defecto: %s", p.DefaultAction)
	}
	prohibidas := []string{"ptrace", "mount", "umount2", "unshare", "setns", "mknod", "mknodat", "pivot_root", "chroot",
		"bpf", "perf_event_open", "keyctl", "process_vm_readv", "process_vm_writev", "io_uring_setup", "userfaultfd",
		"init_module", "finit_module", "open_by_handle_at", "name_to_handle_at", "personality", "socketcall"}
	for _, r := range p.Syscalls {
		if r.Action != "SCMP_ACT_ALLOW" {
			continue
		}
		for _, n := range r.Names {
			for _, x := range prohibidas {
				if n == x {
					t.Errorf("el perfil permite %s", n)
				}
			}
		}
	}
}

func TestDecidirAislamiento(t *testing.T) {
	if a := Decidir([]string{"runc", "runsc"}, true, ""); a.Valor != AislamientoRunsc {
		t.Fatalf("con runsc: %+v", a)
	}
	if a := Decidir([]string{"runc"}, true, "sugardaddy-trampa"); a.Valor != AislamientoPerfiles || a.Motivo != MotivoSinRunsc {
		t.Fatalf("sin runsc, con AppArmor: %+v", a)
	}
	if a := Decidir([]string{"runc", "runsc"}, false, ""); a.Valor != AislamientoSeccomp || a.Motivo != MotivoRunscNo {
		t.Fatalf("runsc desactivado: %+v", a)
	}
	// La trampa de enlace va en runc aunque haya gVisor (su acompañante comparte su red).
	cfg := configPrueba()
	if v := Decidir([]string{"runsc"}, true, "").Endurecer(cfg, true); v != AislamientoSeccomp || hc(cfg)["Runtime"] != nil {
		t.Fatalf("trampa de enlace: %s %v", v, hc(cfg)["Runtime"])
	}
	cfg = configPrueba()
	if v := Decidir([]string{"runsc"}, true, "").Endurecer(cfg, false); v != AislamientoRunsc || hc(cfg)["Runtime"] != "runsc" {
		t.Fatalf("con gVisor: %s", v)
	}
}

func TestRegistroDeTrampa(t *testing.T) {
	r := reglasPrueba()
	for _, bien := range []string{datosPrueba + "/registros/cache-1/redis.jsonl", datosPrueba + "/registros/cowrie/log/cowrie.json",
		datosPrueba + "/discos/cache-1/registros/redis.jsonl"} {
		if _, err := r.RegistroDeTrampa(bien); err != nil {
			t.Errorf("%s: %v", bien, err)
		}
	}
	for _, mal := range []string{"/etc/shadow", datosPrueba + "/estado.json", datosPrueba + "/registros/x", datosPrueba + "/registros/../estado.json",
		datosPrueba + "/discos/cache-1/escribible-0/x", datosPrueba + "/config/cache-1/0", "relativa/registros/a/b", datosPrueba + "/registros/../../../etc/passwd"} {
		if _, err := r.RegistroDeTrampa(mal); err == nil {
			t.Errorf("%s: tenía que rechazarse", mal)
		}
	}
}
