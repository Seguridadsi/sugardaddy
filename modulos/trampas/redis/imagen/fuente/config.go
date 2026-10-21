package main

import (
	"os"
	"strconv"
	"time"
)

// conf es la configuración de la trampa, leída de SD_REDIS_* (como Cowrie).
// Los topes los fija el manifiesto, no el cliente: acotan memoria, CPU y disco
// aunque miles de atacantes escriban a la vez.
type conf struct {
	escucha    string // SD_REDIS_LISTEN, por defecto :6379
	registro   string // SD_REDIS_LOG, por defecto /registros/redis.json
	version    string // SD_REDIS_VERSION: 7.2.4, 7.0.15 o 6.2.14
	contrasena string // SD_REDIS_PASSWORD, vacía = sin AUTH requerido (Redis "abierto")
	// semilla de la identidad de esta trampa (SD_REDIS_SEMILLA). Vacía: la que
	// se guarda junto al registro, creada al azar la primera vez.
	semilla string
	// puerto que ve el atacante (SD_REDIS_PUERTO): lo anuncia INFO cuando la
	// trampa finge un Redis instalado en la máquina y no en un contenedor.
	puerto int

	maxConex    int // SD_REDIS_MAX_CONN: conexiones a la vez en total
	maxConexIP  int // SD_REDIS_MAX_CONN_IP: conexiones a la vez de una misma IP
	maxComando  int // SD_REDIS_MAX_CMD_BYTES: bytes de una orden
	maxClaves   int // SD_REDIS_MAX_KEYS: claves en total
	maxClavesIP int // SD_REDIS_MAX_KEYS_IP: claves de una misma IP
	maxValorKb  int // SD_REDIS_MAX_VALUE_KB: tamaño de un valor
	maxBancoMb  int // SD_REDIS_MAX_KEYSPACE_MB: bytes de todas las claves y valores
	// SD_REDIS_MAX_CLIENTS_MEM_MB: memoria que los clientes pueden hacer
	// crecer entre todos (órdenes a medio leer, colas de MULTI); cada IP, la
	// octava parte.
	maxMemClientesMb int
	vidaClaves       time.Duration
	maxLogDia        int64         // SD_REDIS_MAX_LOG_BYTES: tope de bytes por día del registro (0 = sin tope)
	resumen          time.Duration // SD_REDIS_RESUMEN_S: cada cuánto se resume lo que se calla

	inactividad   time.Duration // sin recibir nada en este tiempo, se cierra (como timeout 300)
	plazoOrden    time.Duration // tiempo para mandar una orden entera
	plazoEscribir time.Duration // tiempo para que el cliente acepte una respuesta
}

// versiones que puede fingir. Cualquier otra cosa se queda en la 7.2.4.
var versiones = map[string]bool{"7.2.4": true, "7.0.15": true, "6.2.14": true}

func cargarConf() conf {
	c := conf{
		escucha:          env("SD_REDIS_LISTEN", ":6379"),
		registro:         env("SD_REDIS_LOG", "/registros/redis.json"),
		version:          env("SD_REDIS_VERSION", "7.2.4"),
		contrasena:       os.Getenv("SD_REDIS_PASSWORD"),
		semilla:          os.Getenv("SD_REDIS_SEMILLA"),
		puerto:           envN("SD_REDIS_PUERTO", 6379),
		maxConex:         envN("SD_REDIS_MAX_CONN", 256),
		maxConexIP:       envN("SD_REDIS_MAX_CONN_IP", 8),
		maxComando:       envN("SD_REDIS_MAX_CMD_BYTES", 65536),
		maxClaves:        envN("SD_REDIS_MAX_KEYS", 256),
		maxClavesIP:      envN("SD_REDIS_MAX_KEYS_IP", 32),
		maxValorKb:       envN("SD_REDIS_MAX_VALUE_KB", 64),
		maxBancoMb:       envN("SD_REDIS_MAX_KEYSPACE_MB", 8),
		maxMemClientesMb: envN("SD_REDIS_MAX_CLIENTS_MEM_MB", 12),
		vidaClaves:       time.Duration(envN("SD_REDIS_KEY_LIFE_MIN", 30)) * time.Minute,
		maxLogDia:        int64(envN("SD_REDIS_MAX_LOG_BYTES", 64<<20)),
		resumen:          time.Duration(envN("SD_REDIS_RESUMEN_S", 300)) * time.Second,
		inactividad:      5 * time.Minute,
		plazoOrden:       5 * time.Minute,
		plazoEscribir:    30 * time.Second,
	}
	if !versiones[c.version] {
		c.version = "7.2.4"
	}
	if c.puerto < 1 || c.puerto > 65535 {
		c.puerto = 6379
	}
	return c.conMinimos()
}

// conMinimos corrige valores absurdos (0, negativos) para que un error de
// configuración no deje la trampa sin servicio ni sin topes.
func (c conf) conMinimos() conf {
	al := func(v *int, def int) {
		if *v <= 0 {
			*v = def
		}
	}
	al(&c.maxConex, 256)
	al(&c.maxConexIP, 8)
	al(&c.maxComando, 65536)
	al(&c.maxClaves, 256)
	al(&c.maxClavesIP, 32)
	al(&c.maxValorKb, 64)
	al(&c.maxBancoMb, 8)
	al(&c.maxMemClientesMb, 12)
	al(&c.puerto, 6379)
	if c.vidaClaves <= 0 {
		c.vidaClaves = 30 * time.Minute
	}
	if c.resumen <= 0 {
		c.resumen = 5 * time.Minute
	}
	// Sin plazos, cada lectura caducaría al momento (o nunca): una conexión
	// inactiva siempre caduca.
	if c.inactividad <= 0 {
		c.inactividad = 5 * time.Minute
	}
	if c.plazoOrden <= 0 {
		c.plazoOrden = 5 * time.Minute
	}
	if c.plazoEscribir <= 0 {
		c.plazoEscribir = 30 * time.Second
	}
	if c.maxLogDia < 0 {
		c.maxLogDia = 0
	}
	return c
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envN(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
