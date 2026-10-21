//go:build linux

package red

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"syscall"
	"time"
)

// El sondeo y el vigilante viven en el ANFITRIÓN, no en la trampa: el sensor
// abre el enlace crudo de la interfaz física del cliente (para eso corre como
// corre, con el socket de Docker al lado). Le da NET_RAW a una trampa, pero
// lo que aquí abre es suyo y con su propio filtro: solo ARP.

// abiertoEnlace abre el enchufe crudo ARP de una interfaz del anfitrión y lo
// deja con el filtro BPF de solo-ARP (lo de abajo, ensamblado a mano: carga
// el ethertype, y solo pasa si es ARP; lo demás lo tira el kernel). El
// sensor sondea y vigila sin oír nada más del segmento, ni un byte.
func abiertoEnlace(interfaz string) (*enlace, error) {
	red, err := net.InterfaceByName(interfaz)
	if err != nil {
		return nil, fmt.Errorf("no hay interfaz %s: %w", interfaz, err)
	}
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(0x0003))) // ETH_P_ALL
	if err != nil {
		return nil, fmt.Errorf("AF_PACKET en %s (hace falta NET_RAW): %w", interfaz, err)
	}
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(0x0003), Ifindex: red.Index}); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("bind a %s: %w", interfaz, err)
	}
	// El filtro de solo-ARP (igual que CompilarBPF, pero a mano y fijo):
	// cargar el ethertype; si es ARP, ACCEPT; si no, REJECT.
	soloARP := []struct {
		codigo uint16
		jt, jf uint8
		k      uint32
	}{
		{0x28, 0, 0, 12},         // cargar 2 bytes en el 12: el ethertype
		{0x15, 1, 0, 0x0806},     // si es ARP, saltar al ACCEPT; si no, al REJECT
		{0x06, 0, 0, 0xFFFFFFFF}, // ACCEPT: la trama entera
		{0x06, 0, 0, 0},          // REJECT: nada
	}
	bruto := make([]byte, 8*len(soloARP))
	for i, in := range soloARP {
		bruto[i*8+0] = byte(in.codigo)
		bruto[i*8+1] = byte(in.codigo >> 8)
		bruto[i*8+2] = in.jt
		bruto[i*8+3] = in.jf
		bruto[i*8+4] = byte(in.k)
		bruto[i*8+5] = byte(in.k >> 8)
		bruto[i*8+6] = byte(in.k >> 16)
		bruto[i*8+7] = byte(in.k >> 24)
	}
	if err := syscall.SetsockoptString(fd, syscall.SOL_SOCKET, 0x1a /* SO_ATTACH_FILTER */, string(bruto)); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("enganchar el filtro de solo-ARP: %w", err)
	}
	return &enlace{fd: fd, interfaz: red}, nil
}

// htons: el orden de red de un uint16.
func htons(v uint16) uint16 { return v<<8 | v>>8 }

// enlace crudo del anfitrión, ya con su filtro de solo-ARP.
type enlace struct {
	fd       int
	interfaz *net.Interface
}

func (e *enlace) cerrar() { _ = syscall.Close(e.fd) }

// enviarARP manda una trama ARP por el enlace.
func (e *enlace) enviarARP(t []byte) error {
	return syscall.Sendto(e.fd, t, 0, &syscall.SockaddrLinklayer{
		Protocol: htons(0x0003), Ifindex: e.interfaz.Index,
	})
}

// leer un ARP del enlace (con plazo) y devolverlo como arpOido, con el
// sll_pkttype del Recvfrom: Saliente dice si la trama la TRANSMITIÓ este
// propio anfitrión (PACKET_OUTGOING, packet(7)) — el tap del AF_PACKET copia
// también lo que sale, y las trampas macvlan egresan por esta misma interfaz.
// Quien decide qué hacer con lo saliente es quien llama (reclamo.go): el
// vigilante lo descarta (hallazgo 1), el sondeo de Libre lo oye a propósito
// (es como cuenta ocupada una IP que otra trampa ya tiene).
func (e *enlace) leer(plazo time.Time) (o arpOido, ok bool) {
	falta := time.Until(plazo)
	if falta < 0 {
		falta = 0
	}
	tv := syscall.NsecToTimeval(falta.Nanoseconds())
	_ = syscall.SetsockoptTimeval(e.fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv)
	buf := make([]byte, 128)
	n, de, err := syscall.Recvfrom(e.fd, buf, 0)
	if err != nil || n < 42 {
		return o, false
	}
	if ll, es := de.(*syscall.SockaddrLinklayer); es && ll.Pkttype == paqueteSaliente {
		o.saliente = true
	}
	spa, sha, _, vale := analizarARP(buf[:n])
	if !vale {
		return o, false
	}
	o.spa, o.sha = spa, sha
	return o, true
}

// Libre dice si una IP del rango propio parece desocupada: el sondeo ARP de
// RFC 5227 (§1.1), tres preguntas «¿quién tiene <ip>? díselo a 0.0.0.0» desde
// la propia MAC del anfitrión, y si CONTESTA ALGUIEN, la IP no está libre.
// También cuenta cualquier ARP que oigamos en el que otro equipo diga que la
// tiene (su propio sondeo, un anuncio): mejor no pisar a nadie por prisa.
//
// El sondeo es lo que evita que la IP propia de una trampa se ponga encima
// de un equipo real del cliente: sin respuesta, nadie la tiene (o nadie que
// conteste ARP, que en la práctica es lo mismo para el tráfico IP).
func Libre(interfaz string, ip netip.Addr, espera time.Duration) (bool, error) {
	if !ip.Is4() {
		return false, fmt.Errorf("la IP propia %s no es IPv4", ip)
	}
	e, err := abiertoEnlace(interfaz)
	if err != nil {
		return false, err
	}
	defer e.cerrar()

	mac := e.interfaz.HardwareAddr
	var sha, tha [6]byte
	copy(sha[:], mac)
	var spa [4]byte
	tpa := ip.As4()
	// RFC 5227 §2.1.1: el emisor es 0.0.0.0 para no confundir las cachés ARP
	// del segmento mientras se pregunta.
	sondeo := tramaARP(sha, spa, tha, tpa, 1)

	// Tres preguntas, esperando entre ellas: una pérdida aislada no basta
	// para dar una IP por libre. Lo saliente TAMBIÉN cuenta aquí: una
	// respuesta que otra trampa da por una IP que ya tiene sale por la
	// interfaz física y vuelve por el tap — es exactamente cómo sondea el
	// anfitrión, y la IP tiene dueño.
	tercio := espera / 3
	for range 3 {
		if err := e.enviarARP(sondeo); err != nil {
			return false, err
		}
		fin := time.Now().Add(tercio)
		for time.Now().Before(fin) {
			if o, ok := e.leer(fin); ok && o.spa == tpa {
				return false, nil // alguien la tiene
			}
		}
	}
	return true, nil
}

// Reclamo: otro equipo ha reclamado en ARP una IP que una trampa tenía como
// propia (RFC 5227 §2.5 desde el otro lado: el defensor no puede). La
// trampa se para para no pisarlo y se avisa.
type Reclamo struct {
	IP  string
	MAC string
}

// Vigilar escucha el ARP del segmento y avisa (por el canal) cuando otro
// equipo reclama una de las IP propias que se le han apuntado. Solo oye ARP
// (su enchufe lleva el filtro de solo-ARP) y solo lo que llega a la interfaz
// física del anfitrión. Lo que el propio anfitrión transmite — TODO el ARP
// de las trampas propias, que egresan por esa interfaz (PACKET_OUTGOING,
// packet(7); ver reclamo.go, hallazgo 1) — no es reclamo de nadie: el modo
// «IP propia» no se puede matar a sí mismo con su propio ARP. Y, por si una
// trama de una trampa propia volviera marcada como entrante (un eco del
// conmutador, un espejo), macPropia — que el despliegue responde con las MAC
// de las trampas con IP propia — la descarta también: doble defensa.
//
// Si el enlace no se puede abrir (sin NET_RAW en el anfitrión, interfaz
// rara), Vigilar lo devuelve como error y quien lo monta decide: el sensor
// NO pierde el modo «IP propia» por un vigilante cojo — sigue el sondeo
// previo de cada IP y los anuncios de IP ajena que apuntan las trampas.
func Vigilar(ctx context.Context, interfaz string, macPropia func([6]byte) bool, reclamos chan<- Reclamo) (func(netip.Addr), error) {
	e, err := abiertoEnlace(interfaz)
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	vistas := map[netip.Addr]bool{}
	apuntar := func(ip netip.Addr) {
		mu.Lock()
		vistas[ip.Unmap()] = true
		mu.Unlock()
	}
	go func() {
		defer e.cerrar()
		for {
			o, ok := e.leer(time.Now().Add(5 * time.Second))
			if !ok {
				if ctx.Err() != nil {
					return
				}
				continue
			}
			ip, vale := netip.AddrFromSlice(o.spa[:])
			if !vale {
				continue
			}
			mu.Lock()
			vista := vistas[ip.Unmap()]
			mu.Unlock()
			if !vista || !reclamoAjeno(o, macPropia) {
				continue
			}
			select {
			case reclamos <- Reclamo{IP: ip.String(), MAC: net.HardwareAddr(o.sha[:]).String()}:
			case <-ctx.Done():
				return
			}
		}
	}()
	return apuntar, nil
}
