package red

import (
	"testing"
)

// TestVigilanteNoSeDisparaConElARPSaliente (hallazgo 1, CRÍTICO): el enchufe
// AF_PACKET ligado a la interfaz física devuelve también lo que el anfitrión
// mismo transmite (sll_pkttype == PACKET_OUTGOING, packet(7)) — y las trampas
// macvlan egresan por esa misma interfaz. Sin descartarlo, la respuesta ARP de
// una trampa por su propia IP (o la petición de su kernel con spa = su IP) la
// mata en su primer contacto real. Con trama construida, igual que la oye el
// vigilante:
//
//   - trama SALIENTE con spa = IP vigilada → NO es reclamo (la emitió una
//     trampa propia o el anfitrión);
//   - trama ENTRANTE de MAC ajena con spa = IP vigilada → reclamo;
//   - trama entrante con MAC de una trampa propia → NO reclamo (defensa en
//     profundidad, por si la trama de una trampa volviera marcada entrante).
func TestVigilanteNoSeDisparaConElARPSaliente(t *testing.T) {
	ipVigilada := [4]byte{10, 0, 0, 7}
	macTrampa := [6]byte{0x02, 0x00, 0xac, 0x10, 0x01, 0xbb}
	macAjena := [6]byte{0x02, 0x00, 0xac, 0x10, 0x01, 0xaa}
	vacio := [6]byte{}

	// La respuesta ARP de una trampa por su propia IP: exactamente la trama
	// que el vigilante oye en el tap saliente cuando alguien pregunta por ella.
	trama := tramaARP(macTrampa, ipVigilada, macAjena, [4]byte{10, 0, 0, 99}, 2)
	spa, sha, op, ok := analizarARP(trama)
	if !ok || spa != ipVigilada || sha != macTrampa || op != 2 {
		t.Fatalf("el ARP no se analizó bien: spa=%v sha=%v op=%d ok=%v", spa, sha, op, ok)
	}

	// Saliente (sll_pkttype == PACKET_OUTGOING): la transmitió este anfitrión.
	if reclamoAjeno(arpOido{spa: spa, sha: sha, saliente: true}, nil) {
		t.Fatal("el vigilante se disparó con el ARP SALIENTE de la propia trampa: la mata en su primer contacto real")
	}

	// Entrante y de MAC ajena: ese sí es un reclamo de otro equipo.
	if !reclamoAjeno(arpOido{spa: spa, sha: macAjena, saliente: false}, nil) {
		t.Fatal("el ARP entrante de una MAC ajena con spa vigilada no cuenta como reclamo")
	}

	// Entrante pero con la MAC de una trampa propia: tampoco (defensa en
	// profundidad: el vigilante puede preguntarle al despliegue por las MAC).
	if reclamoAjeno(arpOido{spa: spa, sha: macTrampa, saliente: false}, func([6]byte) bool { return true }) {
		t.Fatal("un ARP cuya MAC fuente es de una trampa propia contó como reclamo ajeno")
	}

	// Una pregunta ARP (op 1) del kernel de una trampa, con spa = su propia
	// IP, también viaja saliente: no puede ser reclamo.
	pregunta := tramaARP(macTrampa, ipVigilada, vacio, [4]byte{10, 0, 0, 98}, 1)
	spa, sha, op, ok = analizarARP(pregunta)
	if !ok || op != 1 {
		t.Fatalf("la pregunta ARP no se analizó bien: op=%d ok=%v", op, ok)
	}
	if reclamoAjeno(arpOido{spa: spa, sha: sha, saliente: true}, nil) {
		t.Fatal("la pregunta ARP saliente del kernel de una trampa contó como reclamo: suicidio al resolver cualquier vecino")
	}

	// Lo que no es ARP de IPv4 bien formado, no se analiza (el filtro del
	// enchufe ya lo garantiza; aquí la defensa es doble).
	if _, _, _, ok := analizarARP([]byte{0xde, 0xad, 0xbe, 0xef}); ok {
		t.Fatal("una trama que no es ARP se dio por ARP bien formado")
	}
}
