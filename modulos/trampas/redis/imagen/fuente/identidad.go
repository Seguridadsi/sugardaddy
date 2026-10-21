package main

import (
	"crypto/sha256"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// identidad: lo que hace que cada trampa parezca un servidor distinto y
// coherente consigo mismo. Lo que en un Redis real cambia con cada arranque
// (run_id, master_replid) sale de crypto/rand al arrancar; lo que depende de
// la instalación (sistema, compilador, rutas, memoria de la máquina, build id)
// sale de una semilla propia de la trampa, así que se mantiene entre
// reinicios y es distinto en cada cliente. Nada sale del reloj ni es común a
// toda la flota, y la imagen sigue siendo la misma para todos (la semilla se
// lee al arrancar, no se compila).
type identidad struct {
	version string
	nver    int // 602, 700, 702
	perfil  string

	runID, replID string
	buildID       string
	sistema       string // os: de INFO
	gcc           string
	jemalloc      string
	pid           int
	supervisado   string
	ejecutable    string
	ficheroConf   string
	dir           string
	bind          string
	puerto        int
	logfile       string
	pidfile       string
	daemonize     string
	protegido     string // protected-mode
	contrasena    string
	// ipLocal: la IP privada de la interfaz de la máquina fingida (laddr de
	// CLIENT LIST en los perfiles paquete y compilado).
	ipLocal string
	// parametros: los de CONFIG SET de esta versión e instalación.
	parametros map[string]claseParametro

	memBase    int64   // used_memory sin clientes ni datos
	rssBase    int64   // used_memory_rss en reposo
	memSistema int64   // total_system_memory
	cpuSys     float64 // segundos de CPU de sistema por segundo en marcha
	cpuUser    float64
	arranque   time.Time
}

// nombreSemilla: el fichero, junto al registro, donde se guarda la semilla.
// No empieza por el nombre del registro: el sensor no lo lee ni lo poda.
const nombreSemilla = ".semilla-redis"

// cargarSemilla: la de SD_REDIS_SEMILLA; si no hay, la guardada junto al
// registro; si no hay, una nueva al azar que se guarda ahí. Si la carpeta no
// se puede escribir, el nombre del equipo (el del contenedor), que al menos es
// distinto en cada trampa.
func cargarSemilla(c conf) string {
	if c.semilla != "" {
		return c.semilla
	}
	ruta := filepath.Join(filepath.Dir(c.registro), nombreSemilla)
	if b, err := os.ReadFile(ruta); err == nil {
		if s := strings.TrimSpace(string(b)); len(s) >= 16 && len(s) <= 128 {
			return s
		}
	}
	s := aleatorioHex(16)
	if err := os.WriteFile(ruta, []byte(s+"\n"), 0o600); err != nil {
		if h, err := os.Hostname(); err == nil && h != "" {
			return "equipo:" + h
		}
	}
	return s
}

func numVersion(v string) int {
	var a, b int
	fmt.Sscanf(v, "%d.%d", &a, &b)
	return a*100 + b
}

// sistemas de la máquina anfitriona: cómo se ve en os:, el gcc con el que se
// compila ahí y si es una distribución con paquete de Redis.
type sistema struct {
	nombre  string
	gcc     string
	paquete bool
	kernel  func(r *rand.Rand) string
}

func entre(r *rand.Rand, a, b int) int { return a + r.IntN(b-a+1) }

var sistemas = []sistema{
	{"debian12", "12.2.0", true, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 6.1.0-%d-amd64 x86_64", entre(r, 17, 33))
	}},
	{"debian12-cloud", "12.2.0", true, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 6.1.0-%d-cloud-amd64 x86_64", entre(r, 17, 33))
	}},
	{"ubuntu2204", "11.4.0", true, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 5.15.0-%d-generic x86_64", entre(r, 91, 139))
	}},
	{"ubuntu2204-azure", "11.4.0", true, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 6.5.0-%d-azure x86_64", entre(r, 1015, 1025))
	}},
	{"ubuntu2404", "13.2.0", true, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 6.8.0-%d-generic x86_64", entre(r, 31, 63))
	}},
	{"ubuntu2404-aws", "13.2.0", true, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 6.8.0-%d-aws x86_64", entre(r, 1008, 1030))
	}},
	{"ubuntu2004", "9.4.0", true, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 5.4.0-%d-generic x86_64", entre(r, 170, 216))
	}},
	{"el8", "8.5.0", false, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 4.18.0-553.%d.1.el8_10.x86_64 x86_64", entre(r, 5, 60))
	}},
	{"el9", "11.4.1", false, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 5.14.0-427.%d.1.el9_4.x86_64 x86_64", entre(r, 13, 50))
	}},
	{"el7", "9.3.1", false, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 3.10.0-1160.%d.1.el7.x86_64 x86_64", entre(r, 80, 119))
	}},
	{"amzn2", "7.3.1", false, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 5.10.%d-%d.%d.amzn2.x86_64 x86_64", entre(r, 200, 237), entre(r, 190, 230), entre(r, 700, 999))
	}},
	{"amzn2023", "11.4.1", false, func(r *rand.Rand) string {
		return fmt.Sprintf("Linux 6.1.%d-%d.%d.amzn2023.x86_64 x86_64", entre(r, 90, 130), entre(r, 100, 140), entre(r, 180, 230))
	}},
}

func generador(partes ...string) *rand.Rand {
	h := sha256.Sum256([]byte(strings.Join(partes, "\x00")))
	return rand.New(rand.NewChaCha8(h))
}

// nuevaIdentidad deriva la identidad de la semilla y la versión. arranque es
// la hora a la que arranca el proceso (de ahí sale uptime).
func nuevaIdentidad(c conf, semilla string, arranque time.Time) *identidad {
	r := generador("sugardaddy-redis", semilla)
	id := &identidad{
		version:    c.version,
		nver:       numVersion(c.version),
		runID:      aleatorioHex(20),
		replID:     aleatorioHex(20),
		arranque:   arranque,
		contrasena: c.contrasena,
		jemalloc:   "jemalloc-5.3.0",
	}
	if id.nver < 700 {
		id.jemalloc = "jemalloc-5.1.0"
	}

	// Sistema de la máquina y forma de instalarlo: imagen oficial de Docker,
	// paquete de la distribución (o de packages.redis.io) o compilado a mano.
	so := sistemas[r.IntN(len(sistemas))]
	id.sistema = so.kernel(r)
	switch x := r.IntN(100); {
	case x < 45:
		id.perfil = "docker"
	case x < 80 && so.paquete:
		id.perfil = "paquete"
	default:
		id.perfil = "compilado"
	}
	switch id.perfil {
	case "docker":
		// La imagen oficial (Debian bookworm): PID 1, sin fichero de
		// configuración, en /data, y el entrypoint quita protected-mode.
		id.gcc = "12.2.0"
		id.pid = 1
		id.supervisado = "no"
		id.ejecutable = "/data/redis-server"
		id.dir = "/data"
		id.puerto = 6379
		id.daemonize = "no"
		id.protegido = "no"
		id.bind = "* -::*"
		if id.nver < 700 {
			id.bind = ""
		}
	case "paquete":
		id.gcc = so.gcc
		id.pid = entre(r, 600, 3500)
		id.supervisado = "systemd"
		id.ejecutable = "/usr/bin/redis-server"
		id.ficheroConf = "/etc/redis/redis.conf"
		id.dir = "/var/lib/redis"
		id.puerto = c.puerto
		id.logfile = "/var/log/redis/redis-server.log"
		id.pidfile = "/run/redis/redis-server.pid"
		id.daemonize = "no"
		id.bind = []string{"0.0.0.0", "0.0.0.0 ::", "* -::*"}[r.IntN(3)]
	default:
		id.gcc = so.gcc
		id.pid = entre(r, 900, 40000)
		id.supervisado = "no"
		id.ejecutable = "/usr/local/bin/redis-server"
		id.ficheroConf = []string{"/etc/redis/6379.conf", "/etc/redis.conf", "/usr/local/etc/redis.conf"}[r.IntN(3)]
		id.dir = []string{"/var/lib/redis/6379", "/var/lib/redis", "/data/redis"}[r.IntN(3)]
		id.puerto = c.puerto
		id.logfile = "/var/log/redis_6379.log"
		id.pidfile = "/var/run/redis_6379.pid"
		id.daemonize = "yes"
		id.bind = []string{"0.0.0.0", "* -::*"}[r.IntN(2)]
	}
	if id.protegido == "" {
		// Sin contraseña, un Redis al que se llega desde fuera tiene que
		// tener protected-mode desactivado; con contraseña, se deja el de
		// fábrica.
		id.protegido = "yes"
		if c.contrasena == "" {
			id.protegido = "no"
		}
	}

	gib := []int64{1, 2, 2, 4, 4, 4, 8, 8, 8, 16, 16, 32, 64}[r.IntN(13)]
	id.memSistema = int64(float64(gib<<30)*(0.93+r.Float64()*0.06)) &^ 4095
	if id.nver >= 700 {
		id.memBase = int64(entre(r, 845000, 1010000))
	} else {
		id.memBase = int64(entre(r, 820000, 880000))
	}
	id.rssBase = int64(entre(r, 3200, 13800)) << 10
	id.cpuSys = 0.0004 + r.Float64()*0.0011
	id.cpuUser = 0.0003 + r.Float64()*0.0009

	// La IP privada de la interfaz: la de la red de la nube o la LAN en que
	// estaría la máquina, fija por trampa.
	switch r.IntN(3) {
	case 0:
		id.ipLocal = fmt.Sprintf("10.%d.%d.%d", r.IntN(256), r.IntN(256), entre(r, 4, 250))
	case 1:
		id.ipLocal = fmt.Sprintf("172.31.%d.%d", r.IntN(256), entre(r, 4, 250))
	default:
		id.ipLocal = fmt.Sprintf("192.168.%d.%d", r.IntN(256), entre(r, 2, 250))
	}

	// El build id depende de la compilación (versión, máquina y hora en que se
	// compiló): sale de la semilla en todos los perfiles, así que es distinto
	// en cada trampa y no se puede cruzar entre clientes. Nunca un valor común
	// a la flota (un build id fijo del perfil docker listaba en Shodan casi la
	// mitad de las trampas). Hexadecimal sin ceros a la izquierda, como %llx:
	// puede tener menos de 16 cifras, como en un Redis real.
	rb := generador("sugardaddy-redis-build", semilla, c.version, id.perfil)
	id.buildID = fmt.Sprintf("%x", rb.Uint64())

	// Un make a mano se compila sin TLS; la imagen oficial y los paquetes, con.
	id.parametros = parametrosDe(id.nver, id.perfil != "compilado")
	return id
}

// uptime: segundos desde que arrancó el proceso.
func (id *identidad) uptime(ahora time.Time) int64 {
	return int64(ahora.Sub(id.arranque) / time.Second)
}

// configDefecto: lo que contesta CONFIG GET de fábrica, coherente con la
// instalación, la versión y el modo (con o sin contraseña).
func (id *identidad) configDefecto() [][2]string {
	supervisado := "no"
	if id.supervisado == "systemd" {
		supervisado = "systemd"
	}
	todo := [][2]string{
		{"dir", id.dir},
		{"dbfilename", "dump.rdb"},
		{"maxmemory", "0"},
		{"maxmemory-policy", "noeviction"},
		{"save", "3600 1 300 100 60 10000"},
		{"appendonly", "no"},
		{"appendfilename", "appendonly.aof"},
		{"requirepass", id.contrasena},
		{"masterauth", ""},
		{"bind", id.bind},
		{"protected-mode", id.protegido},
		{"port", fmt.Sprint(id.puerto)},
		// Coherente con lo que hace la trampa: cierra a quien lleva 5 minutos
		// sin mandar nada.
		{"timeout", "300"},
		{"tcp-keepalive", "300"},
		{"databases", "16"},
		{"daemonize", id.daemonize},
		{"supervised", supervisado},
		{"pidfile", id.pidfile},
		{"logfile", id.logfile},
		{"loglevel", "notice"},
		{"maxclients", "10000"},
		{"hz", "10"},
		{"replica-read-only", "yes"},
		{"slave-read-only", "yes"},
		{"stop-writes-on-bgsave-error", "yes"},
		{"rdbcompression", "yes"},
		{"rdbchecksum", "yes"},
		{"appendfsync", "everysec"},
		{"slowlog-log-slower-than", "10000"},
		{"slowlog-max-len", "128"},
		{"notify-keyspace-events", ""},
		{"lua-time-limit", "5000"},
		{"io-threads", "1"},
		{"lazyfree-lazy-eviction", "no"},
	}
	if id.nver >= 700 {
		todo = append(todo,
			[2]string{"enable-protected-configs", "no"},
			[2]string{"enable-debug-command", "no"},
			[2]string{"enable-module-command", "no"},
			[2]string{"busy-reply-threshold", "5000"},
			[2]string{"appenddirname", "appendonlydir"},
		)
	}
	return todo
}
