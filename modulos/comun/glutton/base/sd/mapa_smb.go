package sd

import (
	"encoding/json"
	"strings"
)

// marcoSMB es la vista JSON de cada marco que el manejador SMB de glutton deja
// en decoded ([]parsedSMB). Solo tomamos lo que nos interesa; el resto se
// descarta. Los nombres json coinciden con los de protocols/tcp/smb.go.
type marcoSMB struct {
	Direction      string   `json:"direction"`
	Command        string   `json:"command"`
	Path           string   `json:"path"`
	Setup          string   `json:"setup"`
	Account        string   `json:"account"`
	Password       string   `json:"password"`
	NTLMResponse   string   `json:"ntlm_response"`
	NTLMVersion    string   `json:"ntlm_version"`
	ServerChal     string   `json:"server_challenge"`
	Domain         string   `json:"domain"`
	Workstation    string   `json:"workstation"`
	NativeOS       string   `json:"native_os"`
	Interface      string   `json:"interface"`
	InterfaceVer   string   `json:"interface_version"`
	Opnum          *uint16  `json:"opnum"`
	TotalDataCount uint32   `json:"total_data_count"`
	PayloadHash    string   `json:"payload_hash"`
	PayloadSize    int      `json:"payload_size"`
	Shellcode      []string `json:"shellcode"`
	XORKey         string   `json:"xor_key"`
	Variant        string   `json:"variant"`
}

func init() { RegistrarMapeador("smb", mapearSMB) }

// Umbral de datos de un NT_TRANSACT que delata el desbordamiento de EternalBlue:
// ningún cliente legítimo pide escribir 64 KiB de "datos" por un NT_TRANSACT.
const ntTransactExploit = 0x10000

// mapearSMB traduce los marcos de una conexión SMB a nuestros eventos. Emite
// una conexión por sesión, y luego un evento por acción del atacante
// (negociación, autenticación con captura de usuario/dominio/equipo/NTLMv2 o
// sesión anónima/invitado, conexión a un recurso, apertura o escritura de
// ficheros —solo nombre, huella y tamaño—, llamadas DCERPC y sondas de exploit
// tipo EternalBlue/DoublePulsar/MS17-010). Una vez vista una identidad en la
// conexión, se copia a los eventos siguientes (quién hizo cada cosa).
func mapearSMB(_ Config, base Evento, decoded interface{}) []Evento {
	b, err := json.Marshal(decoded)
	if err != nil {
		return nil
	}
	var marcos []marcoSMB
	if err := json.Unmarshal(b, &marcos); err != nil {
		return nil
	}

	eventos := []Evento{conEvento(base, "smb.session.connect")}
	negociado := false
	// Identidad de la sesión, recordada para los eventos posteriores (MS-SMB
	// reutiliza el UID; aquí basta con la última autenticación de la conexión).
	var sesUser, sesDom, sesEquipo string

	for _, m := range marcos {
		if m.Direction != "read" {
			continue
		}
		switch {
		case esExploit(m):
			e := conEvento(base, "smb.exploit")
			e.Comando = recortar(m.Command, maxTexto)
			e.Grave = graveDe(m)
			if m.PayloadHash != "" {
				e.Huella = m.PayloadHash
			}
			if m.PayloadSize > 0 {
				e.Tamano = m.PayloadSize
			}
			ponIdentidad(&e, sesUser, sesDom, sesEquipo)
			eventos = append(eventos, e)

		case esNegociacion(m.Command):
			if negociado {
				continue
			}
			negociado = true
			eventos = append(eventos, conEvento(base, "smb.session.negotiate"))

		case esSesion(m.Command) && tieneIdentidad(m):
			if credencialesReales(m) {
				e := conEvento(base, "smb.session.auth")
				e.Usuario = recortar(m.Account, maxTexto)
				e.Dominio = recortar(m.Domain, maxTexto)
				e.Equipo = recortar(m.Workstation, maxTexto)
				e.Password = recortar(m.Password, maxTexto)
				e.NTLMVersion = m.NTLMVersion
				e.NTLMHash = recortar(m.NTLMResponse, maxHash)
				e.Reto = recortar(m.ServerChal, maxHash)
				eventos = append(eventos, e)
				sesUser, sesDom, sesEquipo = e.Usuario, e.Dominio, e.Equipo
			} else {
				// Sesión nula o de invitado: un barrido rutinario (nmap -sC),
				// no un robo de credenciales. Media, no alta.
				e := conEvento(base, "smb.session.anonymous")
				e.Usuario = recortar(m.Account, maxTexto)
				e.Dominio = recortar(m.Domain, maxTexto)
				e.NTLMVersion = m.NTLMVersion
				eventos = append(eventos, e)
			}

		case esArbol(m.Command) && m.Path != "":
			e := conEvento(base, "smb.tree.connect")
			e.Recurso = recortar(m.Path, maxTexto)
			ponIdentidad(&e, sesUser, sesDom, sesEquipo)
			eventos = append(eventos, e)

		case m.Interface != "" || m.Opnum != nil:
			e := conEvento(base, "smb.rpc.call")
			e.Interfaz = recortar(m.Interface, maxTexto)
			if m.Opnum != nil {
				n := int(*m.Opnum)
				e.Opnum = &n
			}
			if m.PayloadHash != "" {
				e.Huella = m.PayloadHash
			}
			ponIdentidad(&e, sesUser, sesDom, sesEquipo)
			eventos = append(eventos, e)

		case esCrear(m.Command) && m.Path != "":
			if m.PayloadHash != "" {
				e := conEvento(base, "smb.file.write")
				e.Fichero = recortar(m.Path, maxTexto)
				e.Huella = m.PayloadHash
				e.Tamano = m.PayloadSize
				ponIdentidad(&e, sesUser, sesDom, sesEquipo)
				eventos = append(eventos, e)
			} else {
				e := conEvento(base, "smb.file.open")
				e.Fichero = recortar(m.Path, maxTexto)
				ponIdentidad(&e, sesUser, sesDom, sesEquipo)
				eventos = append(eventos, e)
			}
		}
	}
	return eventos
}

// ponIdentidad copia la identidad de la sesión a un evento posterior que no la
// trae (el atacante ya se autenticó en esta conexión).
func ponIdentidad(e *Evento, user, dom, equipo string) {
	if e.Usuario == "" {
		e.Usuario = user
	}
	if e.Dominio == "" {
		e.Dominio = dom
	}
	if e.Equipo == "" {
		e.Equipo = equipo
	}
}

func esExploit(m marcoSMB) bool {
	if len(m.Shellcode) > 0 || m.XORKey != "" {
		return true
	}
	// TRANS2 SESSION_SETUP es el canal que abusa DoublePulsar; ningún cliente
	// legítimo lo usa.
	if m.Command == "SMB_COM_TRANSACTION2" && m.Setup == "TRANS2_SESSION_SETUP" {
		return true
	}
	// PeekNamedPipe sobre IPC$ es la sonda de MS17-010 (smb-vuln-ms17-010,
	// WannaCry, Metasploit smb_ms17_010).
	if m.Command == "SMB_COM_TRANSACTION" && m.Setup == "TRANS_PEEK_NMPIPE" {
		return true
	}
	// NT_TRANSACT con un TotalDataCount enorme es el desbordamiento de
	// EternalBlue (los datos llegan a cero, repartidos en TRANS2_SECONDARY).
	if m.Command == "SMB_COM_NT_TRANSACT" && m.TotalDataCount > ntTransactExploit {
		return true
	}
	return false
}

func graveDe(m marcoSMB) string {
	switch {
	case len(m.Shellcode) > 0:
		return "shellcode"
	case m.XORKey != "" || m.Setup == "TRANS2_SESSION_SETUP":
		return "doublepulsar"
	case m.Setup == "TRANS_PEEK_NMPIPE":
		return "ms17-010-sonda"
	case m.Command == "SMB_COM_NT_TRANSACT" && m.TotalDataCount > ntTransactExploit:
		return "eternalblue"
	}
	return "exploit"
}

func esNegociacion(cmd string) bool { return cmd == "SMB_COM_NEGOTIATE" || cmd == "SMB2_NEGOTIATE" }
func esSesion(cmd string) bool {
	return cmd == "SMB_COM_SESSION_SETUP_ANDX" || cmd == "SMB2_SESSION_SETUP"
}
func esArbol(cmd string) bool {
	return cmd == "SMB_COM_TREE_CONNECT_ANDX" || cmd == "SMB2_TREE_CONNECT"
}
func esCrear(cmd string) bool { return cmd == "SMB_COM_NT_CREATE_ANDX" }

func tieneIdentidad(m marcoSMB) bool {
	return m.Account != "" || m.NTLMVersion != "" || m.Password != "" || m.NTLMResponse != ""
}

// credencialesReales distingue un inicio de sesión con credenciales de una
// sesión nula o de invitado. Una cuenta con nombre (no "guest") y una respuesta
// NTLM (v1/v2) o una contraseña en claro son credenciales; lo demás (sin
// usuario, usuario "guest" o NTLM "anonymous") es una sesión anónima.
func credencialesReales(m marcoSMB) bool {
	if m.Account == "" || strings.EqualFold(m.Account, "guest") {
		return false
	}
	if m.NTLMVersion == "anonymous" {
		return false
	}
	// Cuenta con nombre (no invitado) y material de autenticación: una respuesta
	// NTLM (v1/v2, de sesión extendida o básica) o una contraseña en claro.
	return m.NTLMVersion == "NTLMv2" || m.NTLMVersion == "NTLMv1" ||
		m.Password != "" || m.NTLMResponse != ""
}
