package main

import (
	"crypto/sha256"
	"encoding/binary"
	"math/rand/v2"
	"strings"
	"time"
)

// En modo ssh reten mandaba líneas de letras minúsculas al azar (de 3 a 32
// bytes) cada retardo exacto: la firma de Endlessh, que los buscadores de
// Internet etiquetan como tarpit a la primera, y la misma en toda la flota.
// Ahora manda, línea a línea, un aviso legal como el que pone delante de su
// SSH un tcpd (banners) o un equipo de red, y vuelve a empezar cuando lo
// acaba. Cada trampa tiene el suyo (texto y adorno salen de su semilla) y
// las líneas no llegan a un ritmo fijo: entre la mitad y vez y media del
// retardo. Ninguna empieza por "SSH-" (el cliente la tomaría por la versión
// y seguiría).
var avisos = [][]string{
	{
		"WARNING: Unauthorized access to this system is prohibited.",
		"All connections are monitored and recorded.",
		"Disconnect IMMEDIATELY if you are not an authorized user!",
	},
	{
		"This system is for the use of authorized users only.",
		"Individuals using this computer system without authority, or in",
		"excess of their authority, are subject to having all of their",
		"activities on this system monitored and recorded by system personnel.",
		"Anyone using this system expressly consents to such monitoring.",
	},
	{
		"NOTICE TO USERS",
		"This computer system is private property. It is for authorized use only.",
		"Users (authorized or unauthorized) have no explicit or implicit",
		"expectation of privacy. Any or all uses of this system and all files",
		"on this system may be intercepted, monitored, recorded, copied,",
		"audited, inspected, and disclosed to authorized personnel.",
		"Unauthorized or improper use of this system may result in",
		"disciplinary action and civil and criminal penalties.",
	},
	{
		"Access to this device is restricted to authorized personnel.",
		"All activity is logged. Violations will be reported.",
	},
	{
		"Restricted system.",
		"Use of this system constitutes consent to security monitoring and testing.",
		"All activity is logged with your host name and IP address.",
	},
	{
		"Private system - authorized use only.",
		"If you are not authorized to access this system, disconnect now.",
		"Activity on this system is recorded and may be used as evidence.",
	},
	{
		"AVISO: acceso restringido al personal autorizado.",
		"Todas las conexiones quedan registradas.",
		"Si no tiene autorización, desconéctese ahora.",
	},
	{
		"Sistema de uso exclusivo para personal autorizado.",
		"El uso de este sistema implica la aceptación de su monitorización.",
		"Cualquier acceso no autorizado será comunicado a las autoridades.",
	},
}

// avisoDeLaTrampa da las líneas (sin \r\n) que manda esta trampa, siempre las
// mismas con la misma semilla.
func avisoDeLaTrampa(semilla string) []string {
	h := sha256.Sum256([]byte("aviso\x00" + semilla))
	r := rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[:8]), binary.LittleEndian.Uint64(h[8:16])))
	texto := avisos[r.IntN(len(avisos))]
	ancho := 0
	for _, l := range texto {
		ancho = max(ancho, len([]rune(l)))
	}
	var out []string
	switch r.IntN(4) {
	case 0: // tal cual
		out = append(out, texto...)
	case 1, 2: // entre dos rayas
		raya := strings.Repeat(string("*=-#"[r.IntN(4)]), min(ancho+r.IntN(5), 78))
		out = append(out, raya)
		out = append(out, texto...)
		out = append(out, raya)
	default: // en una caja de asteriscos
		raya := strings.Repeat("*", ancho+4)
		out = append(out, raya)
		for _, l := range texto {
			out = append(out, "* "+l+strings.Repeat(" ", ancho-len([]rune(l)))+" *")
		}
		out = append(out, raya)
	}
	// Una línea en blanco antes de volver a empezar.
	return append(out, "")
}

// espera: cuánto hasta la línea siguiente, entre la mitad y vez y media del
// retardo.
func espera(retardo time.Duration) time.Duration {
	return retardo/2 + rand.N(retardo+1)
}
