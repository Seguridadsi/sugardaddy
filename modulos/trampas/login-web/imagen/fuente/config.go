package main

import (
	"os"
	"strconv"
	"time"
)

// conf es la configuración de la trampa, leída de SD_LOGINWEB_*. Los topes
// los fija el manifiesto, no el cliente: acotan memoria, CPU y disco aunque
// miles de atacantes escriban a la vez.
type conf struct {
	escucha   string // SD_LOGINWEB_LISTEN, por defecto :8080
	registro  string // SD_LOGINWEB_LOG, por defecto /registros/login-web.json
	plantilla string // SD_LOGINWEB_PLANTILLA: portal que finge ser (intranet/admin/portal)
	// Credencial cebo (SD_LOGINWEB_USUARIO / SD_LOGINWEB_PASSWORD): usuario y
	// contraseña que, si se usan, se aceptan y se enseña el contenido falso.
	// Contraseña vacía = no se acepta ningún login (solo se apuntan intentos).
	usuario  string
	password string
	// puerto que ve el atacante (SD_LOGINWEB_PUERTO): el del pie de las
	// páginas de error del servidor, cuando finge estar en la máquina y no en
	// un contenedor.
	puerto int
	// semilla de la identidad de esta trampa (SD_LOGINWEB_SEMILLA). Vacía:
	// la que se guarda junto al registro, creada al azar la primera vez.
	semilla string

	maxConex   int   // SD_LOGINWEB_MAX_CONN: conexiones a la vez en total
	maxConexIP int   // SD_LOGINWEB_MAX_CONN_IP: conexiones a la vez de una IP
	maxCuerpo  int   // SD_LOGINWEB_MAX_CUERPO_BYTES: bytes leídos del cuerpo de un POST
	maxLogDia  int64 // SD_LOGINWEB_MAX_LOG_BYTES: tope de bytes por día del registro (0 = sin tope)
	resumen    time.Duration
}

// plantillasValidas: los portales que la trampa sabe fingir. Cambia el aspecto
// del formulario y el contenido falso tras el login cebo, con títulos
// coherentes.
var plantillasValidas = map[string]bool{"intranet": true, "admin": true, "portal": true}

func cargarConf() conf {
	c := conf{
		escucha:    env("SD_LOGINWEB_LISTEN", ":8080"),
		registro:   env("SD_LOGINWEB_LOG", "/registros/login-web.json"),
		plantilla:  env("SD_LOGINWEB_PLANTILLA", "intranet"),
		usuario:    env("SD_LOGINWEB_USUARIO", "admin"),
		password:   os.Getenv("SD_LOGINWEB_PASSWORD"),
		puerto:     envN("SD_LOGINWEB_PUERTO", 8080),
		semilla:    os.Getenv("SD_LOGINWEB_SEMILLA"),
		maxConex:   envN("SD_LOGINWEB_MAX_CONN", 512),
		maxConexIP: envN("SD_LOGINWEB_MAX_CONN_IP", 32),
		maxCuerpo:  envN("SD_LOGINWEB_MAX_CUERPO_BYTES", 8192),
		maxLogDia:  int64(envN("SD_LOGINWEB_MAX_LOG_BYTES", 64<<20)),
		resumen:    time.Duration(envN("SD_LOGINWEB_RESUMEN_S", 300)) * time.Second,
	}
	if !plantillasValidas[c.plantilla] {
		c.plantilla = "intranet"
	}
	if c.puerto < 1 || c.puerto > 65535 {
		c.puerto = 8080
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
	al(&c.maxConex, 512)
	al(&c.maxConexIP, 32)
	al(&c.maxCuerpo, 8192)
	al(&c.puerto, 8080)
	if c.maxLogDia < 0 {
		c.maxLogDia = 0
	}
	if c.resumen <= 0 {
		c.resumen = 5 * time.Minute
	}
	if c.escucha == "" {
		c.escucha = ":8080"
	}
	if c.registro == "" {
		c.registro = "/registros/login-web.json"
	}
	if c.usuario == "" {
		c.usuario = "admin"
	}
	if !plantillasValidas[c.plantilla] {
		c.plantilla = "intranet"
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
