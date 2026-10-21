// Binario de las trampas de la base glutton de Sugardaddy (SMB, y más adelante
// RDP y MSSQL). Escucha UN solo protocolo (el de SD_GLUTTON_PROTO) en su puerto
// interno con un listener TCP normal: sin TPROXY, sin iptables, sin NET_ADMIN y
// sin red del anfitrión. Cada conexión la atiende el manejador de glutton
// correspondiente, que nunca ejecuta nada de verdad; lo que recoge se traduce a
// nuestro registro JSON por líneas, con topes y recortes, en /registros.
package main

import (
	"context"
	"log"
	"net"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/mushorg/glutton/connection"
	"github.com/mushorg/glutton/protocols/interfaces"
	"github.com/mushorg/glutton/sd"
)

// La edición community solo trae protocolos libres (smb, rdp): no hay candado de
// pago. El binario no exige ninguna licencia antes de escuchar.

// manejador es la firma de los HandleXxx de glutton.
type manejador func(ctx context.Context, conn net.Conn, md connection.Metadata, logger interfaces.Logger, h interfaces.Honeypot) error

var manejadores = map[string]manejador{}

// registrar lo llama el fichero proto_<p>.go que deja preparar-base.sh.
func registrar(proto string, h manejador) { manejadores[proto] = h }

func main() {
	cfg := sd.DesdeEntorno()
	h := manejadores[cfg.Proto]
	if h == nil {
		log.Fatalf("protocolo %q sin manejador compilado en este binario", cfg.Proto)
	}

	reg, err := sd.NuevoRegistro(cfg)
	if err != nil {
		log.Fatalf("no se puede abrir el registro: %v", err)
	}
	defer reg.Cierra()
	// Temporizador del resumen de omitidos (emite aunque no llegue otro evento).
	reg.IniciarResumenPeriodico()
	hp := sd.NuevoHoneypot(cfg, reg)
	lg := sd.Logger{}

	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer parar()

	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", cfg.Listen)
	if err != nil {
		log.Fatalf("no se puede escuchar en %s: %v", cfg.Listen, err)
	}
	log.Printf("trampa %s (%s) escuchando en %s; registro en %s/%s.json", cfg.Modulo, cfg.Proto, cfg.Listen, cfg.LogDir, cfg.Modulo)

	// Resumen de conexiones rechazadas por tope (global o por IP): sin esto, un
	// atacante que ocupe todos los huecos deja la trampa muda sin dejar rastro.
	rech := sd.NuevosRechazos(reg, cfg.Modulo, cfg.MaxIPs)
	if cfg.ResumenSeg > 0 {
		go func() {
			t := time.NewTicker(time.Duration(cfg.ResumenSeg) * time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					rech.Volcar()
				}
			}
		}()
	}

	sem := make(chan struct{}, cfg.MaxConn)
	var mu sync.Mutex
	porIP := map[string]int{}
	activos := map[net.Conn]struct{}{}
	var wg sync.WaitGroup

	// Al cancelar (SIGTERM de un docker stop, o redespliegue), cerrar el listener
	// y TODAS las conexiones vivas para que sus manejadores salgan del Read y
	// vacíen lo pendiente antes del SIGKILL, en vez de perderse.
	go func() {
		<-ctx.Done()
		_ = ln.Close()
		mu.Lock()
		for c := range activos {
			_ = c.SetDeadline(time.Now())
			_ = c.Close()
		}
		mu.Unlock()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			continue
		}
		ip := ipDe(conn)

		// Tope global: si está lleno, se cierra sin bloquear el bucle, pero se
		// cuenta para el resumen de rechazos.
		select {
		case sem <- struct{}{}:
		default:
			rech.Global(ip)
			_ = conn.Close()
			continue
		}
		// Tope por IP de origen.
		mu.Lock()
		if cfg.MaxConnIP > 0 && porIP[ip] >= cfg.MaxConnIP {
			mu.Unlock()
			rech.PorIP(ip)
			<-sem
			_ = conn.Close()
			continue
		}
		porIP[ip]++
		activos[conn] = struct{}{}
		mu.Unlock()

		wg.Add(1)
		go func(c net.Conn, ip string) {
			defer wg.Done()
			defer func() {
				<-sem
				mu.Lock()
				delete(activos, c)
				if porIP[ip] > 0 {
					porIP[ip]--
					if porIP[ip] == 0 {
						delete(porIP, ip)
					}
				}
				mu.Unlock()
				_ = c.Close()
			}()
			md := connection.NewMetadata(puertoLocal(c), hostLocal(c))
			_ = c.SetDeadline(time.Now().Add(time.Duration(cfg.IdleSegundos) * time.Second))
			// Vida máxima absoluta: aunque el atacante mande keepalives para no
			// caer por inactividad, la conexión se cierra a los VidaSegundos y el
			// manejador vacía lo que lleve capturado.
			if cfg.VidaSegundos > 0 {
				tope := time.AfterFunc(time.Duration(cfg.VidaSegundos)*time.Second, func() {
					_ = c.SetDeadline(time.Now())
					_ = c.Close()
				})
				defer tope.Stop()
			}
			if err := h(ctx, c, md, lg, hp); err != nil {
				// El manejador ya cierra y produce; un error aquí no es fatal.
				_ = err
			}
		}(conn, ip)
	}

	wg.Wait()
	// Último resumen de rechazos pendiente antes de salir.
	rech.Volcar()
}

func ipDe(conn net.Conn) string {
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return ""
	}
	return host
}

func hostLocal(conn net.Conn) string {
	host, _, err := net.SplitHostPort(conn.LocalAddr().String())
	if err != nil {
		return ""
	}
	return host
}

func puertoLocal(conn net.Conn) uint16 {
	_, port, err := net.SplitHostPort(conn.LocalAddr().String())
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(port)
	return uint16(n)
}
