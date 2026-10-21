package red

// Lo que decide si un ARP oído en el enlace es un reclamo AJENO de una IP
// vigilada (hallazgo 1 de la revisión adversarial). Vive aparte y sin etiqueta
// de plataforma para poder probarlo en cualquier sitio: el fallo que cerraba
// era que un enchufe AF_PACKET ligado a la interfaz física recibe TAMBIÉN las
// tramas que el propio anfitrión transmite por ella, marcadas
// sll_pkttype = PACKET_OUTGOING (packet(7): «a packet originating from the
// local host that is looped back to a packet socket»).
//
// Los contenedores macvlan egresan por su interfaz padre (la física): TODO el
// ARP que una trampa propia emite — la respuesta a quien pregunta por su IP,
// la petición de su kernel con spa = su propia IP — vuelve al enchufe del
// vigilante como si la hubiera oído en el segmento. Sin descartar lo saliente,
// el vigilante mata a las trampas con su propio ARP (se dispara a sí mismo en
// el primer contacto real) y el modo «IP propia» no funciona en una LAN viva.

// PACKET_OUTGOING (packet(7), linux/if_packet.h): la trama la transmitió este
// mismo anfitrión y el tap del AF_PACKET la devuelve al enchufe.
const paqueteSaliente = 4

// tramaARP: pregunta (op 1) o respuesta (op 2) ARP (RFC 826), en difusión.
func tramaARP(sha [6]byte, spa [4]byte, tha [6]byte, tpa [4]byte, op uint16) []byte {
	t := make([]byte, 0, 42)
	for _, b := range [6]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff} {
		t = append(t, b)
	}
	t = append(t, sha[:]...)
	t = append(t, 0x08, 0x06) // ethertype ARP
	t = append(t, 0x00, 0x01) // hardware: Ethernet
	t = append(t, 0x08, 0x00) // protocolo: IPv4
	t = append(t, 6, 4)       // tamaños de MAC y de IP
	t = append(t, byte(op>>8), byte(op))
	t = append(t, sha[:]...)
	t = append(t, spa[:]...)
	t = append(t, tha[:]...)
	t = append(t, tpa[:]...)
	return t
}

// analizarARP saca de una trama Ethernet el ARP de IPv4 que lleva (si lo es y
// está bien formado): la IP que el emisor dice tener (spa) y su MAC (sha).
func analizarARP(trama []byte) (spa [4]byte, sha [6]byte, op uint16, ok bool) {
	if len(trama) < 42 {
		return
	}
	if trama[12] != 0x08 || trama[13] != 0x06 { // ethertype ARP
		return
	}
	if trama[14] != 0x00 || trama[15] != 0x01 || trama[16] != 0x08 || trama[17] != 0x00 || trama[18] != 6 || trama[19] != 4 {
		return // no es ARP de IPv4 sobre Ethernet
	}
	copy(sha[:], trama[22:28])
	copy(spa[:], trama[28:32])
	return spa, sha, uint16(trama[20])<<8 | uint16(trama[21]), true
}

// arpOido: un ARP de IPv4 oído en el enlace, con lo que al vigilante le hace
// decidir. Saliente es el sll_pkttype == PACKET_OUTGOING del Recvfrom.
type arpOido struct {
	spa      [4]byte // la IP que el emisor dice tener
	sha      [6]byte // la MAC fuente
	saliente bool    // la transmitió el propio anfitrión (sus trampas incluidas)
}

// reclamoAjeno dice si un ARP oído puede ser el reclamo de OTRO equipo.
//
// No lo es nunca si la trama la transmitió este anfitrión ( PACKET_OUTGOING):
// entre ellas TODAS las respuestas y peticiones ARP de las trampas propias,
// que egresan por la interfaz física padre de su macvlan. El sondeo de Libre
// (RFC 5227) sigue oyendo lo saliente a propósito — es como cuenta ocupada una
// IP que otra trampa ya tiene — así que la distinción la hace el vigilante,
// no el enchufe.
//
// Y tampoco, como defensa en profundidad, si la MAC fuente es la de una
// trampa propia de este sensor (macPropia, que el despliegue sabe): una trama
// de una trampa que llegara marcada como entrante (un eco del conmutador, un
// espejo de puerto) no mata a su dueña.
func reclamoAjeno(o arpOido, macPropia func([6]byte) bool) bool {
	if o.saliente {
		return false
	}
	if macPropia != nil && macPropia(o.sha) {
		return false
	}
	return true
}
