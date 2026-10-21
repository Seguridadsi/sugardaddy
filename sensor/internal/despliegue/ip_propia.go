// El modo de red «IP propia» dentro del despliegue (docs/diseno/red.md): lo
// que cambia para las trampas que lo piden y SOLO para ellas. Las demás van
// igual que siempre: puente aislado, CapDrop ALL, puertos publicados.
package despliegue

import (
	"fmt"
	"hash/fnv"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/red"
)

// RedPropia es el modo «IP propia» de ESTE sensor, con lo que eligió quien lo
// instaló: la interfaz física del segmento del cliente y el rango de IP
// propias reservado (fuera del DHCP, sondeado antes de usar cada IP).
//
// Con Puente (el banco de pruebas) no hay interfaz: la trampa va a una red
// de banco ya creada con su subred, con la IP fija que dice su prueba, y sin
// sondeo (la subred la gobierna el motor y nadie más la usa).
type RedPropia struct {
	// Interfaz física del segmento del cliente (p. ej. eth0). Vacía en banco.
	Interfaz string
	// Rango de IP propias reservado (p. ej. 10.0.0.240/28).
	Rango netip.Prefix
	// Puente: red de banco ya creada con la subred (banco; producción: "").
	Puente string
	// IPFija: la IP de la trampa en el banco (producción: se elige del rango).
	IPFija string
}

// redPropiaDe: el nombre de la red de una trampa «IP propia».
func redPropiaDe(o Opciones) string {
	if o.RedPropia != nil && o.RedPropia.Puente != "" {
		return o.RedPropia.Puente
	}
	return redTrampasPropia
}

// topeSondas es lo que IPPropia sondea como mucho POR LLAMADA (hallazgo 9):
// el sondeo ARP de una candidata lleva hasta 3 s de espera y Aplicar corre
// dentro del bucle de eventos del sensor — un rango ocupado entero (cupo×3 s,
// hasta ~3,4 h con el tope de 4096) congelaría la lectura de registros y la
// entrega de TODAS las trampas. Con el tope, cada llamada avanza un tramo y
// la siguiente sigue por donde iba: no se pierde nada y nadie espera horas.
const topeSondas = 8

// las IP elegidas por trampa, para que la huella no baile entre vueltas: se
// elige una vez (con su sondeo) y se reusa hasta que la trampa sale del plan
// o su IP la reclama otro equipo (SoltarIP). Con su mutex: el vigilante ARP
// pregunta (TrampaDeIP, EsMACDeTrampa) desde su propia goroutina.
//
// siguiente apunta por dónde se quedó el sondeo la última vez que el tope
// cortó la búsqueda (hallazgo 9), acumuladas cuenta cuántas candidatas lleva
// sondeadas esa búsqueda (para saber cuándo el anillo entero ya está visto
// aunque el tope lo parta en varias llamadas), y mac guarda la MAC del
// contenedor de cada trampa con IP propia (hallazgo 1: el vigilante no da
// por reclamo un ARP cuya MAC fuente sea de una trampa propia).
var (
	muIP       sync.Mutex
	ipsPropias = struct {
		por        map[string]string
		de         map[string]string
		mac        map[string]string
		siguiente  map[string]int
		acumuladas map[string]int
	}{por: map[string]string{}, de: map[string]string{}, mac: map[string]string{}, siguiente: map[string]int{}, acumuladas: map[string]int{}}
)

// addrsDelAnfitrion y sondeoLibre son las funciones de verdad, variables solo
// para que las pruebas las sustituyan (hallazgos 3, 7 y 9).
var (
	addrsDelAnfitrion = net.InterfaceAddrs
	sondeoLibre       = red.Libre
)

// direccionesDelAnfitrion: TODAS las IPv4 que tiene este anfitrión — la IP de
// LAN, las secundarias, docker0… (hallazgo 3). Es el único equipo cuyas
// direcciones NO se pueden sondear por ARP: la sonda sale del propio
// anfitrión y su kernel no procesa sus tramas transmitidas, así que si una IP
// candidata es del sensor, nadie contesta y se daría por libre con el dueño
// dentro. Se excluyen de los candidatos, además del sondeo. Si no se pueden
// leer, error: no se reparte NADA esa vuelta antes que arriesgarse a pisar
// al propio sensor.
func direccionesDelAnfitrion() (map[netip.Addr]bool, error) {
	dir := map[netip.Addr]bool{}
	lista, err := addrsDelAnfitrion()
	if err != nil {
		return nil, fmt.Errorf("no se pudieron leer las direcciones locales del anfitrión: %w", err)
	}
	for _, a := range lista {
		if ipn, es := a.(*net.IPNet); es {
			if v4 := ipn.IP.To4(); v4 != nil {
				var b [4]byte
				copy(b[:], v4)
				dir[netip.AddrFrom4(b)] = true
			}
		}
	}
	return dir, nil
}

// IPPropia dice la IP que le toca a la trampa: la que ya tenía, o una nueva
// del rango propio, la primera libre a partir de un sitio que depende del
// nombre (dos trampas no se pelean por la misma) y comprobada con el sondeo
// ARP de RFC 5227 antes de dársela. Del reparto se salen, además de la
// dirección de red y de la pasarela que nadie tiene, la dirección de
// DIFUSIÓN (hallazgo 7: la última del rango, la «.255» de un /28) y TODAS las
// direcciones del propio anfitrión (hallazgo 3). Sin rangos que valgan,
// error: no se inventa una IP ni se la quita a nadie.
//
// Por llamada se sondean como mucho topeSondas candidatas (hallazgo 9): no
// congelar el bucle de eventos del sensor; la búsqueda sigue en la siguiente
// llamada por donde se quedó.
//
// En el banco (Puente + IPFija) se toma la fija: la subred de la prueba es
// suya y las IP están escritas en la prueba, no hay que buscarlas.
func IPPropia(o Opciones, s plan.TrampaPlan) (string, error) {
	if o.RedPropia == nil {
		return "", fmt.Errorf("la trampa %s pide el modo de red «IP propia» y este sensor no lo trae (docs/diseno/red.md)", s.ID)
	}
	if o.RedPropia.Puente != "" {
		if o.RedPropia.IPFija == "" {
			return "", fmt.Errorf("la red de banco %s no trae la IP de la trampa", o.RedPropia.Puente)
		}
		return o.RedPropia.IPFija, nil
	}
	muIP.Lock()
	ip, tenia := ipsPropias.por[s.ID]
	iba, quedaba := ipsPropias.siguiente[s.ID]
	acumuladas := ipsPropias.acumuladas[s.ID]
	muIP.Unlock()
	if tenia {
		return ip, nil
	}
	rango := o.RedPropia.Rango
	if !rango.IsValid() || !rango.Addr().Is4() || rango.Bits() < 8 || rango.Bits() > 30 {
		return "", fmt.Errorf("el rango de IP propias (%s) no vale: tiene que ser un CIDR IPv4 de /8 a /30, con sitio para una trampa", o.RedPropia.Rango)
	}
	// Las direcciones útiles del rango: sin la dirección de red y sin la
	// primera IP (la «pasarela que nadie tiene», pasarelaNadie).
	tamaño := 1 << uint(32-rango.Bits())
	cupo := tamaño - 2
	if cupo > 4096 {
		cupo = 4096 // un rango mayor se recorre igual: nadie tiene 4096 trampas
	}
	base := binaria(rango.Masked().Addr().As4()) + 2
	// La dirección de difusión, FUERA del reparto (hallazgo 7): la última del
	// rango — darla a una trampa es pelearse con el protocolo IP mismo.
	difusion := deBinaria(binaria(rango.Masked().Addr().As4()) + uint32(tamaño) - 1)
	// Las direcciones del propio anfitrión, fuera también (hallazgo 3).
	anfitrion, err := direccionesDelAnfitrion()
	if err != nil {
		return "", err
	}
	// Las direcciones del propio anfitrión que de verdad caen entre las
	// candidatas (la .0 y la .1 del prefijo jamás lo fueron — la base es la
	// .2; y la difusión se descuenta sola una vez, sin contarla dos veces).
	delAnfitrion := 0
	bDif := binaria(difusion.As4())
	for a := range anfitrion {
		if !rango.Contains(a) {
			continue
		}
		if b := binaria(a.As4()); b >= base && b != bDif {
			delAnfitrion++
		}
	}
	// Lo que de verdad se puede sondear: todo menos difusión y anfitrión.
	sondeables := cupo - 1 - delAnfitrion
	if sondeables <= 0 {
		return "", fmt.Errorf("el rango propio %s no tiene ninguna candidata para %s: todo él es difusión o direcciones del anfitrión", rango, s.ID)
	}
	// El sitio donde empieza esta trampa lo decide su nombre (fnv), para
	// que dos trampas distintas no caigan a la primera IP a la vez — o por
	// donde se quedó la última búsqueda cortada por el tope (hallazgo 9).
	sitio := int(hash(s.ID) % uint64(cupo))
	if quedaba {
		sitio = iba
	}
	hallada := ""
	sondadas := 0
	for i := range cupo {
		candidato := deBinaria(base + uint32((sitio+i)%cupo))
		if candidato == difusion || anfitrion[candidato] {
			continue // difusión (hallazgo 7) o dirección del anfitrión (hallazgo 3): sin sondear
		}
		libre, err := sondeoLibre(o.RedPropia.Interfaz, candidato, 3*time.Second)
		if err != nil {
			// Sin sondeo (sin NET_RAW en el anfitrión, o sin AF_PACKET) no
			// se paraliza el modo por eso: la IP viene de un rango RESERVADO
			// por el cliente, el vigilante escucha los reclamos y la
			// trampa misma apunta los anuncios de IP ajena. Se sigue.
			hallada = candidato.String()
			break
		}
		acumuladas++
		sondadas++
		if libre {
			hallada = candidato.String()
			break
		}
		if acumuladas >= sondeables {
			// El anillo entero, visto y ocupado — aunque el tope lo partiera
			// en varias llamadas (acumuladas no se pierde entre ellas).
			muIP.Lock()
			delete(ipsPropias.siguiente, s.ID)
			ipsPropias.acumuladas[s.ID] = 0
			muIP.Unlock()
			return "", fmt.Errorf("el rango propio %s no tiene una IP libre para %s (el sondeo ARP encontró equipo en todas)", rango, s.ID)
		}
		if sondadas >= topeSondas {
			// Tope de esta vuelta (hallazgo 9): la siguiente llamada sigue
			// por la candidata de después de la última sondeada.
			muIP.Lock()
			ipsPropias.siguiente[s.ID] = (sitio + i + 1) % cupo
			ipsPropias.acumuladas[s.ID] = acumuladas
			muIP.Unlock()
			return "", fmt.Errorf("el rango propio %s no tiene una IP libre a la vista para %s (sondeadas %d candidatas esta vuelta; se sigue en la siguiente)", rango, s.ID, sondadas)
		}
	}
	if hallada == "" {
		// Rango pequeño: el bucle cubrió el anillo entero sin cortarse y
		// todo estaba ocupado.
		muIP.Lock()
		delete(ipsPropias.siguiente, s.ID)
		ipsPropias.acumuladas[s.ID] = 0
		muIP.Unlock()
		return "", fmt.Errorf("el rango propio %s no tiene una IP libre para %s (el sondeo ARP encontró equipo en todas)", rango, s.ID)
	}
	muIP.Lock()
	delete(ipsPropias.siguiente, s.ID)
	ipsPropias.acumuladas[s.ID] = 0
	muIP.Unlock()
	apuntarIP(s.ID, hallada)
	return hallada, nil
}

// SoltarIP olvida la IP de una trampa (salga del plan o la reclame otro
// equipo): la siguiente vuelta elige otra, no la suelta ahí muerta.
func SoltarIP(id string) {
	muIP.Lock()
	defer muIP.Unlock()
	if ip, ok := ipsPropias.por[id]; ok {
		delete(ipsPropias.por, id)
		delete(ipsPropias.de, ip)
	}
	delete(ipsPropias.mac, id)
	delete(ipsPropias.siguiente, id)
	delete(ipsPropias.acumuladas, id)
}

// SoltarIPsFuera olvida las IP (y MAC) de las trampas que ya no están en el
// plan (hallazgo N3 de la re-revisión): sin esto el registro las conservaba
// para siempre y una trampa reinstalada con el mismo id heredaba su IP vieja
// sin sondearla.
func SoltarIPsFuera(quedan map[string]bool) {
	muIP.Lock()
	defer muIP.Unlock()
	for id, ip := range ipsPropias.por {
		if quedan[id] {
			continue
		}
		delete(ipsPropias.por, id)
		delete(ipsPropias.de, ip)
		delete(ipsPropias.mac, id)
		delete(ipsPropias.siguiente, id)
		delete(ipsPropias.acumuladas, id)
	}
}

// TrampaDeIP: qué trampa tiene esa IP propia (para el vigilante ARP: el
// reclamo llega por IP, la trampa se para por id).
func TrampaDeIP(ip string) (string, bool) {
	muIP.Lock()
	defer muIP.Unlock()
	id, ok := ipsPropias.de[ip]
	return id, ok
}

// IPsPropias: las IP propias elegidas hasta ahora (id → ip), para que quien
// vigila el ARP sepa cuáles son de este sensor.
func IPsPropias() map[string]string {
	muIP.Lock()
	defer muIP.Unlock()
	copia := make(map[string]string, len(ipsPropias.por))
	for id, ip := range ipsPropias.por {
		copia[id] = ip
	}
	return copia
}

// ApuntarMAC apunta la MAC del contenedor de una trampa con IP propia
// (hallazgo 1): el vigilante ARP no da por reclamo un ARP cuya MAC fuente
// sea de una trampa de este sensor, venga marcada como venga.
func ApuntarMAC(id, mac string) {
	if id == "" || mac == "" {
		return
	}
	muIP.Lock()
	defer muIP.Unlock()
	ipsPropias.mac[id] = mac
}

// EsMACDeTrampa: si la MAC es la de una trampa propia de este sensor.
func EsMACDeTrampa(mac string) bool {
	if mac == "" {
		return false
	}
	muIP.Lock()
	defer muIP.Unlock()
	for _, m := range ipsPropias.mac {
		if m == mac {
			return true
		}
	}
	return false
}

// EsMACDeTrampaBytes: EsMACDeTrampa con la MAC como viene del enlace ([6]byte
// en orden de red), que es como el vigilante ARP la lee de la trama. Las MAC
// se apuntan tal como las escribe el motor («02:42:ac:11:00:02»: hexagonal,
// en minúsculas, con sus dos guarismos), y así se vuelve a escribir aquí.
func EsMACDeTrampaBytes(mac [6]byte) bool {
	return EsMACDeTrampa(fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
		mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]))
}

// MACDeTrampa: la MAC apuntada de una trampa (vacía si aún no se sabe).
func MACDeTrampa(id string) string {
	muIP.Lock()
	defer muIP.Unlock()
	return ipsPropias.mac[id]
}

func apuntarIP(id, ip string) {
	muIP.Lock()
	defer muIP.Unlock()
	if anterior, ok := ipsPropias.por[id]; ok {
		delete(ipsPropias.de, anterior)
	}
	ipsPropias.por[id] = ip
	ipsPropias.de[ip] = id
}

// saltar quedó fuera: la búsqueda de IPPropia anda por direcciones dentro
// del rango y no envuelve fuera de él (base + i con i < cupo).

// deBinaria: la IPv4 de una palabra en orden de red.
func deBinaria(n uint32) netip.Addr {
	var a [4]byte
	a[0], a[1], a[2], a[3] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
	return netip.AddrFrom4(a)
}

func binaria(ip [4]byte) uint32 {
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}

func hash(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}
