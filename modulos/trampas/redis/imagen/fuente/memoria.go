package main

import (
	"errors"
	"sync"
)

// presupuesto: bytes que los clientes pueden hacer crecer en memoria (órdenes
// a medio leer y colas de MULTI), con un tope total y otro por IP de origen
// (su /64 en IPv6). Una IP no pasa de su parte aunque abra todas las
// conexiones que le dejan, y entre todas no pasan del total: por muchos
// clientes que escriban a la vez, el contenedor no llega al OOM. Lo que no
// cabe se corta como hace Redis con un cliente que pasa sus límites (cierra
// la conexión) y queda apuntado.
type presupuesto struct {
	mu         sync.Mutex
	total      int64
	porIP      map[string]int64
	max, maxIP int64
}

func nuevoPresupuesto(max, maxIP int64) *presupuesto {
	return &presupuesto{porIP: map[string]int64{}, max: max, maxIP: maxIP}
}

// tomar reserva n bytes para la clave de IP k. Si no caben, no reserva nada.
func (p *presupuesto) tomar(k string, n int64) bool {
	if n <= 0 {
		return true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.total+n > p.max || p.porIP[k]+n > p.maxIP {
		return false
	}
	p.total += n
	p.porIP[k] += n
	return true
}

func (p *presupuesto) soltar(k string, n int64) {
	if n <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.total -= n
	if p.porIP[k] -= n; p.porIP[k] <= 0 {
		delete(p.porIP, k)
	}
}

func (p *presupuesto) usado() (total int64, ips int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.total, len(p.porIP)
}

// franquiciaOrden: bytes de una orden que no se descuentan del presupuesto.
// Son los de cualquier orden normal y ya están acotados por el tope de
// conexiones; solo lo que pasa de aquí compite con las demás conexiones.
const franquiciaOrden = 8 << 10

// errMemoria: la conexión pasa de su parte del presupuesto. Se cierra sin
// contestar, como Redis con un cliente que supera sus límites.
var errMemoria = errors.New("memoria de cliente agotada")

// cuota es lo que retiene una conexión del presupuesto. No es concurrente: la
// usa solo la goroutine de su conexión. Un puntero nil no limita nada (las
// pruebas que no la necesitan).
type cuota struct {
	p      *presupuesto
	ip     string // clave de IP (claveIP)
	orden  int64  // bytes de la orden que se lee o se atiende
	tomado int64  // de ellos, descontados del presupuesto (lo que pasa de la franquicia)
	cola   int64  // bytes de la cola de MULTI, descontados enteros
	resp   int64  // bytes de la respuesta que se escribe (lo que pasa de la franquicia)
}

func (p *presupuesto) cuotaPara(ip string) *cuota {
	return &cuota{p: p, ip: claveIP(ip)}
}

// tomarOrden cuenta n bytes más de la orden en curso.
func (c *cuota) tomarOrden(n int) bool {
	if c == nil || n <= 0 {
		return true
	}
	c.orden += int64(n)
	exceso := c.orden - franquiciaOrden
	if exceso <= c.tomado {
		return true
	}
	if !c.p.tomar(c.ip, exceso-c.tomado) {
		return false
	}
	c.tomado = exceso
	return true
}

// soltarOrden: la orden ya se atendió; lo que siga vivo (la cola) va aparte.
func (c *cuota) soltarOrden() {
	if c == nil {
		return
	}
	c.p.soltar(c.ip, c.tomado)
	c.orden, c.tomado = 0, 0
}

func (c *cuota) tomarCola(n int64) bool {
	if c == nil {
		return true
	}
	if !c.p.tomar(c.ip, n) {
		return false
	}
	c.cola += n
	return true
}

func (c *cuota) soltarCola() {
	if c == nil {
		return
	}
	c.p.soltar(c.ip, c.cola)
	c.cola = 0
}

// tomarRespuesta cuenta lo que retiene la respuesta que se va a escribir: un
// KEYS o un CONFIG GET arma la lista con cadenas del banco, y si el cliente no
// lee, la lista sigue viva hasta plazoEscribir aunque esas cadenas ya no estén
// en el banco (otro CONFIG SET, un FLUSHALL). Solo compite lo que pasa de la
// franquicia; soltarRespuesta lo devuelve en cuanto la respuesta está escrita.
func (c *cuota) tomarRespuesta(n int64) bool {
	if c == nil {
		return true
	}
	exceso := n - franquiciaOrden
	if exceso <= 0 {
		return true
	}
	if !c.p.tomar(c.ip, exceso) {
		return false
	}
	c.resp += exceso
	return true
}

func (c *cuota) soltarRespuesta() {
	if c == nil {
		return
	}
	c.p.soltar(c.ip, c.resp)
	c.resp = 0
}

func (c *cuota) soltarTodo() {
	c.soltarOrden()
	c.soltarCola()
	c.soltarRespuesta()
}

// retenerRespuesta reserva en la cuota de la conexión la lista de una
// respuesta. Si no cabe, la conexión se corta sin contestar (cli.corte), como
// hace Redis con un cliente que pasa client-output-buffer-limit.
func retenerRespuesta(cli *cliente, partes []string) bool {
	if cli.cuota.tomarRespuesta(costeOrden(partes)) {
		return true
	}
	cli.corte = "respuesta más grande que lo que le queda a su IP del tope de memoria de clientes"
	return false
}

// costeOrden: lo que retiene en memoria una orden guardada (en la cola de
// MULTI): sus bytes más la cabecera de cada cadena y la del slice. Sin las
// cabeceras, una línea inline de miles de argumentos de un byte quedaba casi
// sin medir y retenía once veces lo enviado.
func costeOrden(args []string) int64 {
	n := int64(24)
	for _, a := range args {
		n += int64(len(a)) + 16
	}
	return n
}
