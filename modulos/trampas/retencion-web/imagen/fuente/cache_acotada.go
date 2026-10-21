// Código propio de SeguridadSI (no viene de go-pot) para la trampa
// retencion-web de Sugardaddy. preparar.sh lo copia a core/metrics/ y cambia
// por ella las dos cachés por IP del TimeoutWatcher (timeout.go).
//
// go-pot usaba go-cache, que solo caduca por tiempo (la caliente, 1 h; la
// fría, 48 h) y no tiene máximo de entradas: cada IP de origen distinta, con
// una sola petición, dejaba una entrada (unos 200 bytes), aunque el tarpit
// estuviera lleno. Con cientos de miles de IP (un sensor de cara a Internet,
// una botnet) la memoria crecía sin tope hasta el OOM, y GOMEMLIMIT no puede
// liberar entradas vivas. Esta caduca igual por tiempo y, además, no pasa de
// max entradas: al llegar, se va la que lleva más tiempo sin usarse.
package metrics

import (
	"container/list"
	"sync"
	"time"
)

// maxIPsPorCache: entradas como mucho en cada caché del TimeoutWatcher. Con
// las dos llenas, menos de 10 MiB (medido en cache_acotada_test.go). Pasado
// eso, la IP que lleva más tiempo sin aparecer vuelve a empezar (con sus
// tres peticiones de gracia): se pierde algo de retención, nunca memoria.
const maxIPsPorCache = 16384

type cacheAcotada struct {
	mu    sync.Mutex
	ttl   time.Duration
	max   int
	orden *list.List // de la usada más recientemente (delante) a la que menos
	items map[string]*list.Element
	reloj func() time.Time
}

type entradaCache struct {
	clave  string
	valor  any
	caduca time.Time
}

func nuevaCacheAcotada(ttl time.Duration, max int) *cacheAcotada {
	return &cacheAcotada{ttl: ttl, max: max, orden: list.New(), items: map[string]*list.Element{}, reloj: time.Now}
}

// Get, como el de go-cache: lo caducado no está.
func (c *cacheAcotada) Get(clave string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[clave]
	if !ok {
		return nil, false
	}
	en := e.Value.(*entradaCache)
	if !c.reloj().Before(en.caduca) {
		c.quitar(e)
		return nil, false
	}
	c.orden.MoveToFront(e)
	return en.valor, true
}

// Set guarda o renueva la entrada con el TTL de la caché. El tercer argumento
// es el de go-cache (siempre cache.DefaultExpiration en timeout.go).
func (c *cacheAcotada) Set(clave string, valor any, _ time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	caduca := c.reloj().Add(c.ttl)
	if e, ok := c.items[clave]; ok {
		en := e.Value.(*entradaCache)
		en.valor, en.caduca = valor, caduca
		c.orden.MoveToFront(e)
		return
	}
	for len(c.items) >= c.max && c.orden.Len() > 0 {
		c.quitar(c.orden.Back())
	}
	c.items[clave] = c.orden.PushFront(&entradaCache{clave: clave, valor: valor, caduca: caduca})
}

func (c *cacheAcotada) Delete(clave string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[clave]; ok {
		c.quitar(e)
	}
}

// ItemCount, como el de go-cache, cuenta también lo caducado aún no retirado.
func (c *cacheAcotada) ItemCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}

func (c *cacheAcotada) quitar(e *list.Element) {
	delete(c.items, e.Value.(*entradaCache).clave)
	c.orden.Remove(e)
}
