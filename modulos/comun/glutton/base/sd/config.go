package sd

import (
	"os"
	"strconv"
	"strings"
)

// Config es la configuración de arranque de una trampa de la base glutton,
// leída del entorno. La pone el manifiesto de cada trampa (smb, rdp, mssql).
type Config struct {
	Proto    string   // protocolo a escuchar: "smb" (más adelante "rdp", "mssql")
	Modulo   string   // nombre del módulo, para el nombre del registro y los eventid
	Listen   string   // dirección de escucha, p. ej. ":445"
	LogDir   string   // carpeta de registros, p. ej. "/registros"
	SeedFile string   // fichero con la semilla de la persona, junto al registro
	Seed     string   // semilla explícita (si está, no se usa el fichero)
	Persona  string   // sistema que finge ser (afecta a nombres anunciados)
	Equipo   string   // nombre NetBIOS/host que se anuncia
	Dominio  string   // dominio/grupo de trabajo que se anuncia
	Recursos []string // recursos compartidos creíbles que se ofrecen

	// VNCPassword es una contraseña VNC sembrada (SD_VNC_ACEPTA): es la única
	// que abre el escritorio falso (las demás reciben "Authentication failure",
	// como en un servidor real); si un intento responde al reto cifrándolo con
	// ella (DES), se marca como aceptado y se apunta la contraseña en claro.
	// Vacía: no entra ninguna y solo se guardan el reto y la respuesta para
	// crackear offline. VNCSinClave (SD_VNC_SIN_CLAVE, todo salvo "no") ofrece
	// además la seguridad None (VNC abierto). Solo los usa la trampa VNC; no
	// afectan a los demás protocolos.
	VNCPassword string
	VNCSinClave bool

	// Topes (no los toca el cliente): protegen memoria, CPU y disco.
	MaxConn       int   // conexiones simultáneas totales
	MaxConnIP     int   // conexiones simultáneas por IP de origen
	IdleSegundos  int   // segundos de inactividad antes de cortar una conexión
	VidaSegundos  int   // vida máxima absoluta de una conexión (0 = sin límite extra)
	MaxLogBytes   int64 // tope de bytes del registro por día
	LibresPorTipo int   // primeros eventos de cada eventid que SIEMPRE se apuntan
	// Bolsa prioritaria: eventids que nunca deben silenciarse del todo (p. ej.
	// smb.exploit, smb.session.auth) y cuántos se garantizan por IP y día.
	Prioritarios       []string
	LibresPrioritarios int
	ResumenSeg         int // cada cuántos segundos se resume lo que se calla
	MaxIPs             int // IP distintas que se contabilizan a la vez (memoria)
}

func env(clave, pordefecto string) string {
	if v, ok := os.LookupEnv(clave); ok && v != "" {
		return v
	}
	return pordefecto
}

func envInt(clave string, pordefecto int) int {
	if v, ok := os.LookupEnv(clave); ok && v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return pordefecto
}

func envInt64(clave string, pordefecto int64) int64 {
	if v, ok := os.LookupEnv(clave); ok && v != "" {
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return n
		}
	}
	return pordefecto
}

// DesdeEntorno lee la configuración del entorno (prefijo SD_GLUTTON_* para lo
// común y SD_<MODULO>_* para la persona). Devuelve valores por defecto seguros.
func DesdeEntorno() Config {
	c := Config{
		Proto:        env("SD_GLUTTON_PROTO", "smb"),
		Modulo:       env("SD_GLUTTON_MODULE", "smb"),
		Listen:       env("SD_GLUTTON_LISTEN", ":445"),
		LogDir:       env("SD_GLUTTON_LOG_DIR", "/registros"),
		SeedFile:     env("SD_GLUTTON_SEED_FILE", "persona.semilla"),
		Seed:         env("SD_GLUTTON_SEED", ""),
		Persona:      env("SD_GLUTTON_PERSONA", "windows2016"),
		VNCPassword:  env("SD_VNC_ACEPTA", ""),
		VNCSinClave:  env("SD_VNC_SIN_CLAVE", "si") != "no",
		Equipo:       env("SD_GLUTTON_EQUIPO", "FS01"),
		Dominio:      env("SD_GLUTTON_DOMINIO", "WORKGROUP"),
		MaxConn:      envInt("SD_GLUTTON_MAX_CONN", 512),
		MaxConnIP:    envInt("SD_GLUTTON_MAX_CONN_IP", 16),
		IdleSegundos: envInt("SD_GLUTTON_IDLE_S", 30),
		// 0 = sin vida máxima absoluta (comportamiento de antes); cada trampa que
		// la quiera la fija en su manifiesto (SMB usa 120). Así RDP y MSSQL no
		// cambian de comportamiento con esta base común.
		VidaSegundos:       envInt("SD_GLUTTON_VIDA_S", 0),
		MaxLogBytes:        envInt64("SD_GLUTTON_MAX_LOG_BYTES", 64<<20),
		LibresPorTipo:      envInt("SD_GLUTTON_LIBRES_TIPO", 64),
		LibresPrioritarios: envInt("SD_GLUTTON_LIBRES_PRIO", 128),
		ResumenSeg:         envInt("SD_GLUTTON_RESUMEN_S", 300),
		MaxIPs:             envInt("SD_GLUTTON_MAX_IPS", 4096),
	}
	if r := env("SD_GLUTTON_RECURSOS", "Finanzas,RRHH,Backups,IT$"); r != "" {
		for _, p := range strings.Split(r, ",") {
			if p = strings.TrimSpace(p); p != "" {
				c.Recursos = append(c.Recursos, p)
			}
		}
	}
	// Eventids prioritarios (bolsa aparte en el registro). Vacío por defecto: las
	// trampas que lo quieran (SMB) lo ponen en su manifiesto.
	if p := env("SD_GLUTTON_PRIORITARIOS", ""); p != "" {
		for _, s := range strings.Split(p, ",") {
			if s = strings.TrimSpace(s); s != "" {
				c.Prioritarios = append(c.Prioritarios, s)
			}
		}
	}
	return c
}
