package main

import (
	"time"
)

// conf es la configuración de la trampa, leída de SD_IMPRESORA_* (como Cowrie
// y redis). Los topes los fija el manifiesto, no el cliente: acotan memoria,
// CPU y disco aunque miles de atacantes escriban a la vez.
type conf struct {
	// Qué servicios enciende y en qué puerto interno escucha cada uno.
	raw      bool
	ipp      bool
	web      bool
	rawEsc   string // SD_IMPRESORA_RAW_LISTEN, por defecto :9100
	ippEsc   string // SD_IMPRESORA_IPP_LISTEN, por defecto :1631
	webEsc   string // SD_IMPRESORA_WEB_LISTEN, por defecto :1080
	registro string // SD_IMPRESORA_LOG, por defecto /registros/impresora.json

	// Puertos que anuncia la persona (en las URL de IPP y de la web): los que
	// ve el atacante, no los internos del contenedor.
	puertoIpp int
	puertoWeb int

	// Persona: modelo elegido ("auto" = derivado de la semilla) e identidad de
	// instancia (nombre y ubicación visibles, semilla).
	modelo       string
	nombreEquipo string
	ubicacion    string
	semilla      string

	maxConex    int // conexiones a la vez en total (todos los servicios)
	maxConexIP  int // conexiones a la vez de una misma IP
	maxLinea    int // bytes de una línea PJL o de una línea de cabecera HTTP
	maxPeticion int // bytes de una petición HTTP/IPP (cuerpo incluido) que se leen
	maxTrabajo  int // bytes de un trabajo (RAW/IPP) que se recorren para la huella; el resto se descarta
	// maxCuerpoMem: bytes de un cuerpo HTTP/IPP que se RETIENEN en memoria a la
	// vez por conexión (los atributos IPP y los formularios caben de sobra). El
	// resto del documento se pasa en flujo a la huella y se descarta, sin
	// guardarse: así maxConex × maxCuerpoMem queda muy por debajo de memoriaMb y
	// un atacante con cuerpos lentos no tumba la trampa por OOM. Un presupuesto
	// global de bytes en vuelo (ver presupuesto) lo acota aún más entre todas
	// las conexiones.
	maxCuerpoMem int

	maxLogDia int64         // tope de bytes por día del registro (0 = sin tope)
	resumen   time.Duration // cada cuánto se resume lo que se calla

	inactividad   time.Duration // sin recibir nada en este tiempo, se cierra
	plazoEscribir time.Duration // tiempo para que el cliente acepte una respuesta
}

func cargarConf() conf {
	c := conf{
		raw:           envBool("SD_IMPRESORA_RAW", true),
		ipp:           envBool("SD_IMPRESORA_IPP", true),
		web:           envBool("SD_IMPRESORA_WEB", true),
		rawEsc:        env("SD_IMPRESORA_RAW_LISTEN", ":9100"),
		ippEsc:        env("SD_IMPRESORA_IPP_LISTEN", ":1631"),
		webEsc:        env("SD_IMPRESORA_WEB_LISTEN", ":1080"),
		registro:      env("SD_IMPRESORA_LOG", "/registros/impresora.json"),
		puertoIpp:     envN("SD_IMPRESORA_PUERTO_IPP", 631),
		puertoWeb:     envN("SD_IMPRESORA_PUERTO_WEB", 80),
		modelo:        env("SD_IMPRESORA_MODELO", "auto"),
		nombreEquipo:  envTrim("SD_IMPRESORA_NOMBRE"),
		ubicacion:     envTrim("SD_IMPRESORA_UBICACION"),
		semilla:       envTrim("SD_IMPRESORA_SEMILLA"),
		maxConex:      envN("SD_IMPRESORA_MAX_CONN", 256),
		maxConexIP:    envN("SD_IMPRESORA_MAX_CONN_IP", 16),
		maxLinea:      envN("SD_IMPRESORA_MAX_LINE_BYTES", 8192),
		maxPeticion:   envN("SD_IMPRESORA_MAX_REQ_BYTES", 262144),
		maxCuerpoMem:  envN("SD_IMPRESORA_MAX_BODY_MEM", 32768),
		maxTrabajo:    envN("SD_IMPRESORA_MAX_JOB_BYTES", 4194304),
		maxLogDia:     int64(envN("SD_IMPRESORA_MAX_LOG_BYTES", 64<<20)),
		resumen:       time.Duration(envN("SD_IMPRESORA_RESUMEN_S", 300)) * time.Second,
		inactividad:   5 * time.Minute,
		plazoEscribir: 30 * time.Second,
	}
	if p := envN("SD_IMPRESORA_PUERTO_IPP", 631); p >= 1 && p <= 65535 {
		c.puertoIpp = p
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
	al(&c.maxConexIP, 16)
	al(&c.maxLinea, 8192)
	al(&c.maxPeticion, 262144)
	al(&c.maxCuerpoMem, 32768)
	al(&c.maxTrabajo, 4194304)
	// Lo que se retiene en memoria nunca pasa de lo que se lee entero.
	if c.maxCuerpoMem > c.maxPeticion {
		c.maxCuerpoMem = c.maxPeticion
	}
	if c.puertoIpp < 1 || c.puertoIpp > 65535 {
		c.puertoIpp = 631
	}
	if c.puertoWeb < 1 || c.puertoWeb > 65535 {
		c.puertoWeb = 80
	}
	if c.resumen <= 0 {
		c.resumen = 5 * time.Minute
	}
	if c.inactividad <= 0 {
		c.inactividad = 5 * time.Minute
	}
	if c.plazoEscribir <= 0 {
		c.plazoEscribir = 30 * time.Second
	}
	if c.maxLogDia < 0 {
		c.maxLogDia = 0
	}
	// Al menos un servicio tiene que estar encendido; si el cliente los apaga
	// todos, al menos el 9100, que es la razón de ser de la trampa.
	if !c.raw && !c.ipp && !c.web {
		c.raw = true
	}
	return c
}
