package sd

import "unicode/utf8"

// Evento es una línea del registro JSON de la trampa. Campos planos y sin
// puntos en las claves, para que el adaptador del sensor los lea por ruta
// simple (y lo entienda también un sensor 0.12). "cuando" en RFC3339Nano UTC.
// Todo lo que viene del atacante (usuario, dominio, equipo, recurso, fichero,
// hash) se recorta antes de escribirlo; el contenido subido nunca se guarda,
// solo su huella y su tamaño.
type Evento struct {
	Cuando  string `json:"cuando"`
	EventID string `json:"eventid"`
	Session string `json:"session,omitempty"`

	SrcIP   string `json:"src_ip,omitempty"`
	SrcPort int    `json:"src_port,omitempty"`
	DstPort int    `json:"dst_port,omitempty"`
	Proto   string `json:"proto,omitempty"`

	Dialecto    string `json:"dialecto,omitempty"`
	Usuario     string `json:"usuario,omitempty"`
	Dominio     string `json:"dominio,omitempty"`
	Equipo      string `json:"equipo,omitempty"`
	Password    string `json:"password,omitempty"`
	NTLMVersion string `json:"ntlm_version,omitempty"`
	NTLMHash    string `json:"ntlm_hash,omitempty"`
	Reto        string `json:"reto,omitempty"`
	// Campos de VNC (RFB). omitempty: no afectan a SMB, RDP ni MSSQL. El reto de
	// la autenticación VNC va en Reto y la respuesta DES del cliente en Respuesta
	// (ambos en hex, para contrastar contraseñas offline); Seguridad son los
	// tipos de seguridad VNC (los ofrecidos, o el elegido); la versión RFB va en
	// Dialecto; las teclas y el portapapeles capturados, en Comando; y la
	// contraseña en claro (si coincide con una sembrada), en Password.
	Respuesta string `json:"respuesta,omitempty"`
	Seguridad string `json:"seguridad,omitempty"`
	// Huellas TLS del ClientHello (RDP sobre TLS/NLA): identifican la
	// herramienta del atacante aunque cambie de IP. En SMB no se rellenan.
	JA3 string `json:"ja3,omitempty"`
	JA4 string `json:"ja4,omitempty"`

	// Campos de MSSQL (TDS). omitempty: no afectan a SMB ni a RDP. El usuario,
	// la contraseña, el dominio y el equipo (workstation NTLM) van en los campos
	// comunes de arriba; la versión TDS, en Dialecto.
	Aplicacion     string `json:"aplicacion,omitempty"`      // app_name del LOGIN7 (la herramienta: sqlcmd, SSMS, impacket…)
	BaseDatos      string `json:"base_datos,omitempty"`      // base a la que se intenta entrar
	Hostname       string `json:"hostname,omitempty"`        // nombre del equipo cliente que declara el LOGIN7
	Biblioteca     string `json:"biblioteca,omitempty"`      // client interface (ODBC, go-mssqldb…)
	Instancia      string `json:"instancia,omitempty"`       // instancia pedida en el PRELOGIN
	Cifrado        string `json:"cifrado,omitempty"`         // opción de cifrado del PRELOGIN
	VersionCliente string `json:"version_cliente,omitempty"` // versión que declara el cliente en el PRELOGIN

	Recurso  string `json:"recurso,omitempty"`
	Fichero  string `json:"fichero,omitempty"`
	Huella   string `json:"huella,omitempty"`
	Tamano   int    `json:"tamano,omitempty"`
	Interfaz string `json:"interfaz,omitempty"`
	Opnum    *int   `json:"opnum,omitempty"`

	Comando      string `json:"comando,omitempty"`
	Grave        string `json:"grave,omitempty"`
	Variante     string `json:"variante,omitempty"`
	MotivoCierre string `json:"motivo_cierre,omitempty"`

	// Resumen de lo que se calla (eventid <modulo>.log.omitidos) y avisos del
	// propio registro.
	Omitidos     int64            `json:"omitidos,omitempty"`
	PorTipo      map[string]int64 `json:"por_tipo,omitempty"`
	IPsRuidosas  []string         `json:"ips_ruidosas,omitempty"`
	IPsDistintas int              `json:"ips_distintas,omitempty"`
	PeriodoS     int              `json:"periodo_s,omitempty"`
	TopeBytes    int64            `json:"tope_bytes,omitempty"`
	Motivo       string           `json:"motivo,omitempty"`
	Error        string           `json:"error,omitempty"`
}

// conEvento copia la base de una conexión (IP, puerto, sesión…) y le pone el
// eventid. Lo usan los mapeadores de cada protocolo (SMB, RDP).
func conEvento(base Evento, id string) Evento {
	e := base
	e.EventID = id
	return e
}

// recortar deja como mucho n bytes sin partir un carácter UTF-8.
func recortar(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

const (
	maxTexto = 256 // usuario, dominio, equipo, recurso, fichero, interfaz
	// La respuesta NetNTLMv2 real ronda los 300-700 bytes (más con muchos pares
	// AV y un SPN largo); en hex son el doble. 512 caracteres hex (256 bytes) la
	// cortaba y la dejaba inservible para reconstruir (Kino quiere las
	// credenciales COMPLETAS). 4096 caracteres hex = 2 KiB cubre de sobra el
	// material de autenticación capturado sin dejar que crezca sin tope.
	maxHash = 4096 // respuesta NTLM en hex, reto
)
