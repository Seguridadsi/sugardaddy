package tcp

import (
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/mushorg/glutton/protocols/recall"
	"github.com/mushorg/glutton/protocols/tcp/smb"
)

// remoteIP devuelve la IP del extremo remoto de una conexión. En el upstream
// vive en sip.go (gosip), que la base de Sugardaddy no incluye; se replica aquí
// para el manejador SMB. Copyright original MushMush, MIT (ver LICENSE).
func remoteIP(conn net.Conn) net.IP {
	if conn == nil {
		return nil
	}
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return nil
	}
	return net.ParseIP(host)
}

// init ajusta la identidad SMB anunciada (nombre de equipo y dominio/grupo) a
// la persona elegida en el manifiesto, para que el nombre que ve el atacante en
// la negociación, en el reto NTLM y en nmap -sV cuadre con el resto de la red.
func init() {
	equipo := os.Getenv("SD_GLUTTON_EQUIPO")
	dominio := os.Getenv("SD_GLUTTON_DOMINIO")
	if equipo != "" {
		smbTargetName = equipo
	}
	smb.SetIdentity(equipo, dominio)

	// Recursos compartidos ofrecidos (del manifiesto): la trampa acepta la
	// conexión a estos (y a IPC$), niega los administrativos (C$, ADMIN$) y
	// responde "no existe" a los demás.
	if r := os.Getenv("SD_GLUTTON_RECURSOS"); r != "" {
		var rec []string
		for _, p := range strings.Split(r, ",") {
			if p = strings.TrimSpace(p); p != "" {
				rec = append(rec, p)
			}
		}
		smb.SetShares(rec)
	}

	// Topes de memoria por conexión (prefijo que se captura de lo subido o
	// inyectado; el contenido no se guarda). Acotan la RAM con muchos atacantes.
	if n := enteroEnv("SD_GLUTTON_MAX_FILE_BYTES"); n > 0 {
		maxSMBFileBuffer = n
	}
	if n := enteroEnv("SD_GLUTTON_MAX_TX_BYTES"); n > 0 {
		maxSMBTxBuffer = uint32(n)
	}
	if n := enteroEnv("SD_GLUTTON_MAX_CONN_BYTES"); n > 0 {
		maxSMBConnBytes = n
	}

	// El almacén recall recuerda cada IP visitante (variante y lo que hizo). El
	// upstream lo deja en 65 536 fuentes y 7 días, y guarda hasta 16 rutas por
	// visita sin recortar: una botnet podía dejar retenidos decenas de MiB. Se
	// acota a 1024 fuentes (las rutas y comandos ya se recortan a 256 B en note()).
	maxIPs := enteroEnv("SD_GLUTTON_MAX_IPS")
	if maxIPs <= 0 || maxIPs > 1024 {
		maxIPs = 1024
	}
	cfg := recall.DefaultConfig()
	cfg.Max = maxIPs
	recall.Shared.Configure(cfg)
}

func enteroEnv(clave string) int {
	if v := os.Getenv(clave); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 0
}
