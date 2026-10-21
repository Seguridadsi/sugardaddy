package main

// Este fichero lo deja preparar-base.sh cuando la trampa es RDP: registra el
// manejador RDP de glutton (X.224 con cookie mstshash, TLS con el certificado
// de la instancia, CredSSP/NLA con NTLM y el Client Info), con
// sugardaddy-rdp.patch. Lo que recoge lo traduce sd/mapa_rdp.go.
import "github.com/mushorg/glutton/protocols/tcp"

func init() { registrar("rdp", tcp.HandleRDP) }
