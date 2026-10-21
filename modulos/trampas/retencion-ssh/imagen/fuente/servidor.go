package main

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// maxPrimera: bytes de la primera línea del cliente que se guardan.
	maxPrimera = 256
	// maxIPsResumen: IPs distintas que cuenta el resumen de rechazos. Pasado
	// eso solo suma el total: una avalancha desde miles de IPs no gasta memoria.
	maxIPsResumen = 1024
)

// Motivos por los que se suelta a un cliente (campo motivo de "fin").
const (
	motivoCliente  = "cliente"         // se ha ido él
	motivoTiempo   = "tiempo_maximo"   // lleva duracionMax
	motivoEscribir = "error_escritura" // no acepta lo que se le manda
	motivoExceso   = "exceso_datos"    // ha mandado más de maxLeido
	motivoParada   = "parada"          // se para la trampa
)

type servidor struct {
	cfg   config
	reg   *registrador
	aviso []string // modo ssh: las líneas que se mandan, sin \r\n

	mu      sync.Mutex
	activas int
	porIP   map[string]int
	rech    rechazos

	conexiones sync.WaitGroup
}

// rechazos de un periodo, para el resumen (una línea por periodo, no una por
// conexión rechazada).
type rechazos struct {
	total, global, porIP int
	ips                  map[string]int
	sinContar            int // rechazos de IPs que ya no caben en ips
}

func nuevoServidor(cfg config, reg *registrador) *servidor {
	return &servidor{cfg: cfg, reg: reg, aviso: avisoDeLaTrampa(cfg.semilla), porIP: map[string]int{}}
}

// servir acepta conexiones hasta que se cierra l. Al cancelar ctx, suelta a
// todos (con su línea de fin) y espera a que acaben.
func (s *servidor) servir(ctx context.Context, l net.Listener) error {
	defer s.conexiones.Wait()
	go func() {
		<-ctx.Done()
		l.Close()
	}()
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			// Sin descriptores u otro error pasajero: no quemar CPU.
			time.Sleep(50 * time.Millisecond)
			continue
		}
		s.conexiones.Add(1)
		go func() {
			defer s.conexiones.Done()
			s.atender(ctx, c)
		}()
	}
}

// admitir aplica los topes de conexiones (global y por IP). Si no cabe, la
// apunta para el resumen.
func (s *servidor) admitir(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.activas >= s.cfg.maxConex:
		s.rech.global++
	case s.porIP[ip] >= s.cfg.maxPorIP:
		s.rech.porIP++
	default:
		s.activas++
		s.porIP[ip]++
		return true
	}
	s.rech.total++
	if s.rech.ips == nil {
		s.rech.ips = map[string]int{}
	}
	if _, ok := s.rech.ips[ip]; ok || len(s.rech.ips) < maxIPsResumen {
		s.rech.ips[ip]++
	} else {
		s.rech.sinContar++
	}
	return false
}

func (s *servidor) soltar(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activas--
	if s.porIP[ip]--; s.porIP[ip] <= 0 {
		delete(s.porIP, ip)
	}
}

// resumir escribe el resumen de los rechazos del periodo y el de las líneas
// no apuntadas, si los hubo. Cada uno va a nombre de su IP con más.
func (s *servidor) resumir() {
	defer s.reg.resumirCallados(s.cfg.modo, s.cfg.resumen)
	s.mu.Lock()
	r := s.rech
	s.rech = rechazos{}
	activas := s.activas
	s.mu.Unlock()
	if r.total == 0 {
		return
	}
	var ip string
	var deIP int
	for k, v := range r.ips {
		if v > deIP || v == deIP && k < ip {
			ip, deIP = k, v
		}
	}
	extra := campos{
		"id":              nuevoID(),
		"modo":            s.cfg.modo,
		"src_ip":          ip,
		"de_su_ip":        deIP,
		"rechazadas":      r.total,
		"por_tope_global": r.global,
		"por_tope_ip":     r.porIP,
		"ips_distintas":   len(r.ips),
		"activas":         activas,
		"periodo_s":       int(s.cfg.resumen / time.Second),
	}
	if r.sinContar > 0 {
		extra["ips_sin_contar"] = r.sinContar
	}
	s.reg.escribir("rechazos", nil, extra)
}

// resumirCada escribe el resumen de rechazos cada cfg.resumen, y uno último al
// parar.
func (s *servidor) resumirCada(ctx context.Context) {
	t := time.NewTicker(s.cfg.resumen)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.resumir()
			return
		case <-t.C:
			s.resumir()
		}
	}
}

func (s *servidor) atender(ctx context.Context, c net.Conn) {
	defer c.Close()
	ip, puerto := origen(c.RemoteAddr())
	if !s.admitir(ip) {
		return
	}
	if tc, ok := c.(*net.TCPConn); ok {
		// Búferes pequeños: miles de conexiones que apenas mueven datos.
		tc.SetReadBuffer(4096)
		tc.SetWriteBuffer(4096)
		// En modo banner no se le manda nada tras el saludo: sin keepalive, un
		// cliente que desaparece sin cerrar (NAT, cable) ocuparía su hueco
		// hasta duracionMax. Así se nota en unos minutos.
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
	}
	inicio := time.Now()
	base := campos{"id": nuevoID(), "modo": s.cfg.modo, "src_ip": ip, "src_port": puerto}
	s.reg.escribir("conexion", base, nil)

	var recibidos atomic.Int64
	fuera := make(chan string, 1)
	go func() { fuera <- s.leer(c, base, &recibidos) }()
	motivo, enviados := s.retener(ctx, c, fuera)
	c.Close()
	// Lo que el lector tuviera a medias (su primera línea) se apunta antes del fin.
	if motivo != motivoCliente && motivo != motivoExceso {
		<-fuera
	}
	// El hueco se libera antes de apuntar el fin: quien lea el fin ya puede
	// volver a entrar.
	s.soltar(ip)
	s.reg.escribir("fin", base, campos{
		"duracion_s": float64(time.Since(inicio).Milliseconds()) / 1000,
		"bytes":      enviados,
		"recibidos":  recibidos.Load(),
		"motivo":     motivo,
	})
}

// leer apunta la primera línea del cliente (su versión de SSH o su primera
// orden): hasta el salto de línea, maxPrimera bytes o cfg.esperaPrimera, lo
// que llegue antes. El resto se lee y se tira, hasta cfg.maxLeido. Devuelve
// por qué ha acabado.
func (s *servidor) leer(c net.Conn, base campos, recibidos *atomic.Int64) string {
	buf := make([]byte, 512)
	var primera []byte
	apuntada := false
	apuntar := func() {
		if !apuntada && len(primera) > 0 {
			if i := bytes.IndexByte(primera, '\n'); i >= 0 {
				primera = primera[:i]
			}
			s.reg.escribir("cliente", base, campos{"datos": limpio(primera, maxPrimera)})
			apuntada = true
		}
	}
	c.SetReadDeadline(time.Now().Add(s.cfg.esperaPrimera))
	for {
		n, err := c.Read(buf)
		total := recibidos.Add(int64(n))
		if !apuntada && n > 0 {
			primera = append(primera, buf[:min(n, maxPrimera-len(primera))]...)
			if bytes.IndexByte(primera, '\n') >= 0 || len(primera) >= maxPrimera {
				apuntar()
				c.SetReadDeadline(time.Time{})
			}
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) && !apuntada {
				// Lleva un rato sin acabar la línea: se apunta lo que haya
				// mandado (si algo) y se sigue leyendo sin plazo.
				apuntar()
				c.SetReadDeadline(time.Time{})
				continue
			}
			apuntar()
			return motivoCliente
		}
		if total > s.cfg.maxLeido {
			apuntar()
			return motivoExceso
		}
	}
}

// retener hace esperar al cliente: en modo ssh, una línea del aviso cada
// cfg.retardo más o menos; en modo banner, el saludo y nada más. Devuelve por
// qué se le suelta y cuántos bytes se le han mandado.
func (s *servidor) retener(ctx context.Context, c net.Conn, fuera <-chan string) (string, int64) {
	var enviados int64
	escribir := func(b []byte) bool {
		c.SetWriteDeadline(time.Now().Add(s.cfg.plazoEscribir))
		n, err := c.Write(b)
		enviados += int64(n)
		return err == nil
	}
	limite := time.NewTimer(s.cfg.duracionMax)
	defer limite.Stop()
	var tic <-chan time.Time
	var t *time.Timer
	if s.cfg.modo == "banner" {
		if !escribir([]byte(s.cfg.banner + "\r\n")) {
			return motivoEscribir, enviados
		}
	} else {
		t = time.NewTimer(espera(s.cfg.retardo))
		defer t.Stop()
		tic = t.C
	}
	siguiente := 0
	for {
		select {
		case m := <-fuera:
			return m, enviados
		case <-limite.C:
			return motivoTiempo, enviados
		case <-ctx.Done():
			return motivoParada, enviados
		case <-tic:
			if !escribir([]byte(s.aviso[siguiente%len(s.aviso)] + "\r\n")) {
				return motivoEscribir, enviados
			}
			siguiente++
			t.Reset(espera(s.cfg.retardo))
		}
	}
}

// limpio deja lo que mandó el cliente en texto apto para el registro: sin el
// salto de línea final, como mucho max bytes sin partir un carácter, con lo
// que no es UTF-8 o no es imprimible cambiado por un punto.
func limpio(b []byte, max int) string {
	b = bytes.TrimRight(b, "\r\n")
	if len(b) > max {
		b = b[:max]
		// Sin partir un carácter: si el último ha quedado a medias, fuera.
		for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
			if utf8.RuneStart(b[i]) {
				if !utf8.FullRune(b[i:]) {
					b = b[:i]
				}
				break
			}
		}
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n <= 1 || !unicode.IsPrint(r) {
			sb.WriteByte('.')
		} else {
			sb.WriteRune(r)
		}
		b = b[n:]
	}
	return sb.String()
}

func origen(a net.Addr) (string, int) {
	if t, ok := a.(*net.TCPAddr); ok {
		return t.IP.String(), t.Port
	}
	host, _, _ := net.SplitHostPort(a.String())
	return host, 0
}

func nuevoID() string {
	b := make([]byte, 8)
	_, _ = crand.Read(b)
	return hex.EncodeToString(b)
}
