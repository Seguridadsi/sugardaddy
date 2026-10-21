package sd

import (
	"encoding/json"
	"strings"
)

// marcoRDP es la vista JSON de cada marco que el manejador RDP de glutton deja
// en decoded ([]parsedRDP). Solo tomamos lo que nos interesa; el resto se
// descarta. Los nombres json coinciden con los de protocols/tcp/rdp.go y su
// subpaquete rdp (client_data, client_info).
type marcoRDP struct {
	Direction string `json:"direction"`
	Command   string `json:"command"`
	Status    string `json:"status"`

	Cookie    string `json:"cookie"`
	Protocols string `json:"protocols"`

	NTLMDomain          string `json:"ntlm_domain"`
	NTLMUser            string `json:"ntlm_user"`
	NTLMWorkstation     string `json:"ntlm_workstation"`
	NTLMVersion         string `json:"ntlm_version"`
	NTLMServerChallenge string `json:"ntlm_server_challenge"`
	NetNTLMv2           string `json:"netntlmv2"`
	NLAAccepted         bool   `json:"nla_accepted"`
	NLAPassword         string `json:"nla_password"`

	JA3 string `json:"ja3"`
	JA4 string `json:"ja4"`

	ClientInfo *clientInfoRDP `json:"client_info"`
	ClientData *clientDataRDP `json:"client_data"`
}

type clientInfoRDP struct {
	Domain         string `json:"domain"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	AlternateShell string `json:"alternate_shell"`
	ClientAddress  string `json:"client_address"`
	Autologon      bool   `json:"autologon"`
	Encrypted      bool   `json:"encrypted"`
}

type clientDataRDP struct {
	ClientName     string   `json:"client_name"`
	ClientBuild    uint32   `json:"client_build"`
	DesktopWidth   uint16   `json:"desktop_width"`
	DesktopHeight  uint16   `json:"desktop_height"`
	KeyboardLayout uint32   `json:"keyboard_layout"`
	Channels       []string `json:"channels"`
}

func init() { RegistrarMapeador("rdp", mapearRDP) }

// mapearRDP traduce los marcos de una conexión RDP a nuestros eventos. Emite
// una conexión por sesión y, según lo que haga el atacante: la negociación
// X.224 (con la cookie mstshash, que delata la herramienta o el usuario
// tecleado), el reto NTLM que emitimos, la autenticación NLA (usuario, dominio,
// equipo y el hash NetNTLMv2 capturado; contraseña en claro si es una que la
// trampa acepta), y el intento de inicio de sesión clásico del Client Info
// (usuario, dominio y contraseña en claro cuando no va cifrado).
func mapearRDP(_ Config, base Evento, decoded interface{}) []Evento {
	b, err := json.Marshal(decoded)
	if err != nil {
		return nil
	}
	var marcos []marcoRDP
	if err := json.Unmarshal(b, &marcos); err != nil {
		return nil
	}

	eventos := []Evento{conEvento(base, "rdp.session.connect")}
	negociado := false
	// Índice del rdp.auth.aceptado ya emitido en esta sesión (por el Type 3): el
	// authInfo posterior lo completa con la contraseña en claro en vez de emitir
	// otro evento crítico (así un solo login aceptado da UNA sola alerta con el
	// hash y la contraseña juntos, no dos a medias).
	aceptadoIdx := -1
	// Nombre de equipo del cliente, del MCS Connect-Initial (CS_CORE): se añade
	// a la negociación. Sin esto, el equipo del atacante se perdía.
	equipoCliente := ""

	for _, m := range marcos {
		switch {
		// Red de seguridad: un marco de pánico (lo deja el recover por conexión
		// del manejador) se registra como rdp.error para que la consola vea que
		// esa conexión se cortó por un fallo, en vez de desaparecer sin rastro.
		case m.Command == "Panic":
			eventos = append(eventos, conEvento(base, "rdp.error"))

		// MCS Connect-Initial: trae el nombre de equipo del cliente (CS_CORE) y
		// los canales virtuales pedidos (CS_NET). El canal MS_T120 es la firma de
		// BlueKeep (CVE-2019-0708) y de las sondas MS12-020: si aparece, se emite
		// rdp.exploit (crítico). El nombre de equipo enriquece la negociación.
		case m.Command == "MCSConnectInitial" || m.ClientData != nil:
			if m.ClientData != nil {
				if m.ClientData.ClientName != "" {
					equipoCliente = recortar(m.ClientData.ClientName, maxTexto)
				}
				if canalMST120(m.ClientData.Channels) {
					ex := conEvento(base, "rdp.exploit")
					ex.Equipo = equipoCliente
					ex.Variante = "MS_T120"
					ex.Motivo = "canal MS_T120 (BlueKeep CVE-2019-0708 / MS12-020)"
					eventos = append(eventos, ex)
				}
			}
		// Negociación X.224: la cookie mstshash (que delata la herramienta o el
		// usuario tecleado), los protocolos pedidos y, si el cliente arrancó
		// TLS, su huella JA3/JA4. La manda el cliente (direction read); el
		// Connection Confirm del servidor no nos interesa como evento. Se apunta
		// una vez (CR y, luego, ClientHello son el mismo "está negociando").
		case m.Direction == "read" && esNegociacionRDP(m.Command):
			if negociado && m.JA3 == "" && m.JA4 == "" {
				continue
			}
			if negociado {
				// Ya había negociación; solo faltaba la huella TLS: enriquece.
				for i := range eventos {
					if eventos[i].EventID == "rdp.session.negotiate" {
						eventos[i].JA3 = recortar(m.JA3, maxTexto)
						eventos[i].JA4 = recortar(m.JA4, maxTexto)
					}
				}
				continue
			}
			negociado = true
			e := conEvento(base, "rdp.session.negotiate")
			e.Usuario = recortar(m.Cookie, maxTexto)
			e.Dialecto = recortar(m.Protocols, maxTexto)
			e.JA3 = recortar(m.JA3, maxTexto)
			e.JA4 = recortar(m.JA4, maxTexto)
			if m.ClientData != nil && m.ClientData.ClientName != "" {
				e.Equipo = recortar(m.ClientData.ClientName, maxTexto)
			}
			eventos = append(eventos, e)

		// Autenticación NLA (CredSSP): el Type 3 con usuario, dominio, equipo y
		// el NetNTLMv2. Un login ACEPTADO (una contraseña sembrada que la
		// trampa reconoce) es crítico: va con su propio eventid
		// rdp.auth.aceptado, para marcar la severidad sin tocar el adaptador
		// (como redis.command.grave). Los que fallan son rdp.auth (alta): la
		// trampa les devuelve "logon failure", no corta, y el atacante sigue
		// probando (y nosotros capturando su NetNTLMv2).
		case tieneIdentidadRDP(m):
			e := conEvento(base, idAuth(m.NLAAccepted))
			e.Usuario = recortar(m.NTLMUser, maxTexto)
			e.Dominio = recortar(m.NTLMDomain, maxTexto)
			e.Equipo = recortar(m.NTLMWorkstation, maxTexto)
			e.NTLMVersion = m.NTLMVersion
			e.NTLMHash = recortar(m.NetNTLMv2, maxHash)
			e.Reto = recortar(m.NTLMServerChallenge, maxHash)
			e.JA3 = recortar(m.JA3, maxTexto)
			e.JA4 = recortar(m.JA4, maxTexto)
			if m.NLAPassword != "" {
				e.Password = recortar(m.NLAPassword, maxTexto)
			}
			eventos = append(eventos, e)
			if m.NLAAccepted {
				aceptadoIdx = len(eventos) - 1
			}

		// Contraseña en claro del authInfo que llega en un marco posterior
		// (TSRequest con nla_password pero sin Type 3). Si ya hubo un Type 3
		// aceptado en esta sesión, se COMPLETA aquel evento con la contraseña (una
		// sola alerta crítica con el hash y la contraseña juntos), en vez de
		// emitir otro rdp.auth.aceptado. Si no lo hubo, se emite uno solo.
		case m.NLAPassword != "":
			if aceptadoIdx >= 0 {
				if eventos[aceptadoIdx].Password == "" {
					eventos[aceptadoIdx].Password = recortar(m.NLAPassword, maxTexto)
				}
				if eventos[aceptadoIdx].Usuario == "" && m.NTLMUser != "" {
					eventos[aceptadoIdx].Usuario = recortar(m.NTLMUser, maxTexto)
				}
				if eventos[aceptadoIdx].Dominio == "" && m.NTLMDomain != "" {
					eventos[aceptadoIdx].Dominio = recortar(m.NTLMDomain, maxTexto)
				}
				break
			}
			e := conEvento(base, "rdp.auth.aceptado")
			e.Usuario = recortar(m.NTLMUser, maxTexto)
			e.Dominio = recortar(m.NTLMDomain, maxTexto)
			e.Password = recortar(m.NLAPassword, maxTexto)
			eventos = append(eventos, e)
			aceptadoIdx = len(eventos) - 1

		// Inicio de sesión clásico (Client Info sobre TLS, sin NLA): usuario,
		// dominio y, si no va cifrado, la contraseña en claro. Es un intento
		// (la trampa lo deniega después), no un login aceptado: rdp.auth.
		case m.ClientInfo != nil && !m.ClientInfo.Encrypted && tieneClientInfo(m.ClientInfo):
			e := conEvento(base, "rdp.auth")
			e.Usuario = recortar(m.ClientInfo.Username, maxTexto)
			e.Dominio = recortar(m.ClientInfo.Domain, maxTexto)
			e.Password = recortar(m.ClientInfo.Password, maxTexto)
			if m.ClientInfo.ClientAddress != "" {
				e.Equipo = recortar(m.ClientInfo.ClientAddress, maxTexto)
			}
			eventos = append(eventos, e)
		}
	}
	// El nombre de equipo del cliente (MCS Connect-Initial) llega después de la
	// negociación: se añade al evento de negociación si no traía ya uno.
	if equipoCliente != "" {
		for i := range eventos {
			if eventos[i].EventID == "rdp.session.negotiate" && eventos[i].Equipo == "" {
				eventos[i].Equipo = equipoCliente
			}
		}
	}
	return eventos
}

// canalMST120 indica si entre los canales virtuales pedidos está MS_T120 (sin
// distinguir mayúsculas), la firma de BlueKeep (CVE-2019-0708) y de MS12-020.
func canalMST120(canales []string) bool {
	for _, c := range canales {
		if strings.EqualFold(strings.TrimSpace(c), "MS_T120") {
			return true
		}
	}
	return false
}

func idAuth(aceptado bool) string {
	if aceptado {
		return "rdp.auth.aceptado"
	}
	return "rdp.auth"
}

func esNegociacionRDP(cmd string) bool {
	return cmd == "ConnectionRequest" || cmd == "TLSClientHello"
}

func tieneIdentidadRDP(m marcoRDP) bool {
	if m.Command != "NTLMAuthenticate" {
		return false
	}
	return m.NTLMUser != "" || m.NTLMDomain != "" || m.NetNTLMv2 != "" || m.NTLMVersion != ""
}

func tieneClientInfo(ci *clientInfoRDP) bool {
	return ci.Username != "" || ci.Domain != "" || ci.Password != ""
}
