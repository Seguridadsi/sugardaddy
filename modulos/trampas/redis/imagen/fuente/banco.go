package main

import (
	"container/list"
	"sort"
	"sync"
	"time"
)

// banco es el keyspace fingido. Cada IP de origen (cada /64 en IPv6) ve el
// suyo, con su CONFIG, su réplica y sus clientes: lo que guarda un atacante no
// lo lee otro (la IP del cliente no sirve de buzón para terceros) y ninguno
// llena el banco de los demás. Todo está acotado (claves y bytes por IP y en
// total); al llenarse se desaloja la clave más antigua en vez de dar OOM. Las
// claves duran como mucho vida (desaparecen como si otro hubiera hecho
// FLUSHALL, cosa corriente en un Redis expuesto); TTL da -1 si no se pidió
// plazo, como Redis, y EXPIRE aplica de verdad el plazo pedido.
type banco struct {
	mu     sync.Mutex
	vistas map[string]*vista
	orden  *list.List // todas las entradas, de la más antigua a la más nueva
	bytes  int

	maxClaves, maxClavesIP int
	maxValor               int
	maxBytes, maxBytesIP   int
	maxVistas              int
	vida                   time.Duration
	reloj                  func() time.Time

	expirados, desalojados int64

	// maxTrabajo: pasos de glob que puede gastar una orden (maxTrabajoGlob;
	// las pruebas lo bajan para ver que todos los patrones comparten uno).
	maxTrabajo int
	// trasCopiarClaves, si no es nil, se llama en claves justo después de
	// soltar el candado y antes de aplicar el patrón. Solo para las pruebas:
	// así comprueban sin medir tiempos que el patrón no se aplica con él.
	trasCopiarClaves func()
}

type clave struct {
	db int
	k  string
}

type entrada struct {
	v      *vista
	c      clave
	valor  string
	creada time.Time
	expira time.Time // plazo pedido con EX/EXPIRE...; cero: sin plazo
	global *list.Element
	local  *list.Element
}

// vista: lo que ve una IP de origen.
type vista struct {
	ip         string
	datos      map[clave]*entrada
	orden      *list.List
	bytes      int
	config     map[string]string // CONFIG SET aceptados
	configB    int               // lo que ocupan (cuenta en bytes, como las claves)
	replica    [2]string         // host y puerto de SLAVEOF; vacío: es master
	ultimoSave time.Time
	cambios    int
	clientes   map[*cliente]struct{}
	ultimoUso  time.Time
}

func nuevoBanco(c conf, reloj func() time.Time) *banco {
	if reloj == nil {
		reloj = time.Now
	}
	maxBytes := c.maxBancoMb << 20
	return &banco{
		vistas:      map[string]*vista{},
		orden:       list.New(),
		maxClaves:   c.maxClaves,
		maxClavesIP: c.maxClavesIP,
		maxValor:    c.maxValorKb << 10,
		maxBytes:    maxBytes,
		maxBytesIP:  max(maxBytes/8, c.maxValorKb<<10+4096),
		maxVistas:   4096,
		vida:        c.vidaClaves,
		reloj:       reloj,
		maxTrabajo:  maxTrabajoGlob,
	}
}

// coste: lo que cuenta una entrada para los topes de bytes.
func coste(k, v string) int { return len(k) + len(v) + 64 }

// entrar da la vista de la IP (la crea si hace falta) y apunta al cliente.
func (b *banco) entrar(ip string, cli *cliente) *vista {
	b.mu.Lock()
	defer b.mu.Unlock()
	ahora := b.reloj()
	k := claveIP(ip)
	v := b.vistas[k]
	if v == nil {
		if len(b.vistas) >= b.maxVistas {
			b.olvidarVistaAntigua(nil)
		}
		v = &vista{ip: k, datos: map[clave]*entrada{}, orden: list.New(),
			config: map[string]string{}, clientes: map[*cliente]struct{}{}, ultimoSave: ahora}
		b.vistas[k] = v
	}
	v.clientes[cli] = struct{}{}
	v.ultimoUso = ahora
	return v
}

func (b *banco) salir(v *vista, cli *cliente) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(v.clientes, cli)
	v.ultimoUso = b.reloj()
}

// olvidarVistaAntigua quita la vista sin clientes usada hace más tiempo
// (salvo excepto). Dice si quitó alguna.
func (b *banco) olvidarVistaAntigua(excepto *vista) bool {
	var vieja *vista
	for _, v := range b.vistas {
		if v != excepto && len(v.clientes) == 0 && (vieja == nil || v.ultimoUso.Before(vieja.ultimoUso)) {
			vieja = v
		}
	}
	if vieja != nil {
		b.quitarVista(vieja)
	}
	return vieja != nil
}

func (b *banco) quitarVista(v *vista) {
	for _, e := range v.datos {
		b.orden.Remove(e.global)
		b.bytes -= coste(e.c.k, e.valor)
	}
	b.bytes -= v.configB
	delete(b.vistas, v.ip)
}

// costeConfig: lo que cuenta un parámetro guardado de CONFIG SET.
func costeConfig(k, v string) int { return len(k) + len(v) + 64 }

// ponerConfig guarda pares de CONFIG SET en la vista. Lo que ocupan cuenta en
// los topes de bytes del banco (por IP y total), como las claves: si no cabe,
// se desalojan las claves más antiguas (primero las de la misma IP) y, si
// hace falta, las vistas sin clientes usadas hace más tiempo. Si ni así cabe,
// no se guarda y devuelve false. La lista de parámetros es cerrada, así que
// una vista no guarda más de unos cientos.
func (b *banco) ponerConfig(v *vista, pares [][2]string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	delta := 0
	for _, kv := range pares {
		delta += costeConfig(kv[0], kv[1])
		if viejo, ok := v.config[kv[0]]; ok {
			delta -= costeConfig(kv[0], viejo)
		}
	}
	for delta > 0 && v.orden.Len() > 0 && v.bytes+delta > b.maxBytesIP {
		b.quitar(v.orden.Front().Value.(*entrada))
		b.desalojados++
	}
	for delta > 0 && b.bytes+delta > b.maxBytes {
		if b.orden.Len() > 0 {
			b.quitar(b.orden.Front().Value.(*entrada))
			b.desalojados++
		} else if !b.olvidarVistaAntigua(v) {
			break
		}
	}
	if delta > 0 && (v.bytes+delta > b.maxBytesIP || b.bytes+delta > b.maxBytes) {
		return false
	}
	for _, kv := range pares {
		v.config[kv[0]] = kv[1]
	}
	v.configB += delta
	v.bytes += delta
	b.bytes += delta
	v.ultimoUso = b.reloj()
	return true
}

// conectados: conexiones abiertas desde la IP de la vista (INFO
// connected_clients, que cuadra con CLIENT LIST).
func (b *banco) conectados(v *vista) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(v.clientes)
}

// purgar quita lo caducado y las vistas sin clientes que llevan más de vida
// sin usarse. Se llama de vez en cuando.
func (b *banco) purgar() {
	b.mu.Lock()
	defer b.mu.Unlock()
	ahora := b.reloj()
	for e := b.orden.Front(); e != nil; {
		sig := e.Next()
		if en := e.Value.(*entrada); b.vencida(en, ahora) {
			b.quitar(en)
			b.expirados++
		}
		e = sig
	}
	for _, v := range b.vistas {
		if len(v.clientes) == 0 && ahora.Sub(v.ultimoUso) >= b.vida {
			b.quitarVista(v)
		}
	}
}

func (b *banco) vencida(e *entrada, ahora time.Time) bool {
	return !e.expira.IsZero() && !ahora.Before(e.expira) || ahora.Sub(e.creada) >= b.vida
}

func (b *banco) quitar(e *entrada) {
	b.orden.Remove(e.global)
	e.v.orden.Remove(e.local)
	delete(e.v.datos, e.c)
	n := coste(e.c.k, e.valor)
	b.bytes -= n
	e.v.bytes -= n
}

// buscar da la entrada viva de la clave (quita la caducada).
func (b *banco) buscar(v *vista, c clave) *entrada {
	e := v.datos[c]
	if e != nil && b.vencida(e, b.reloj()) {
		b.quitar(e)
		b.expirados++
		return nil
	}
	return e
}

func (b *banco) get(v *vista, db int, k string) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if e := b.buscar(v, clave{db, k}); e != nil {
		return e.valor, true
	}
	return "", false
}

// set guarda la clave. expira cero y conservarTTL falso: sin plazo. Nunca
// falla: si no hay sitio, desaloja lo más antiguo (primero de la misma IP).
func (b *banco) set(v *vista, db int, k, val string, expira time.Time, conservarTTL bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	val = prefijo(val, b.maxValor)
	ahora := b.reloj()
	c := clave{db, k}
	if e := b.buscar(v, c); e != nil {
		if conservarTTL {
			expira = e.expira
		}
		b.quitar(e)
	}
	n := coste(k, val)
	for v.orden.Len() > 0 && (v.orden.Len() >= b.maxClavesIP || v.bytes+n > b.maxBytesIP) {
		b.quitar(v.orden.Front().Value.(*entrada))
		b.desalojados++
	}
	for b.orden.Len() > 0 && (b.orden.Len() >= b.maxClaves || b.bytes+n > b.maxBytes) {
		b.quitar(b.orden.Front().Value.(*entrada))
		b.desalojados++
	}
	e := &entrada{v: v, c: c, valor: val, creada: ahora, expira: expira}
	e.global = b.orden.PushBack(e)
	e.local = v.orden.PushBack(e)
	v.datos[c] = e
	b.bytes += n
	v.bytes += n
	v.cambios++
	v.ultimoUso = ahora
}

func (b *banco) del(v *vista, db int, k string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if e := b.buscar(v, clave{db, k}); e != nil {
		b.quitar(e)
		v.cambios++
		return true
	}
	return false
}

func (b *banco) existe(v *vista, db int, k string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buscar(v, clave{db, k}) != nil
}

// claves: las de la base db que encajan con el patrón (glob de Redis), en
// orden. Con el candado solo se quitan las caducadas y se copian los nombres
// (copiar un string es copiar su cabecera); el patrón se aplica fuera, con un
// presupuesto de trabajo por orden: por mucho que cueste, ninguna otra IP
// espera en entrar, get o set, y la CPU por orden está acotada.
func (b *banco) claves(v *vista, db int, patron string) []string {
	b.mu.Lock()
	ahora := b.reloj()
	nombres := make([]string, 0, len(v.datos))
	for c, e := range v.datos {
		if c.db != db {
			continue
		}
		if b.vencida(e, ahora) {
			b.quitar(e)
			b.expirados++
			continue
		}
		nombres = append(nombres, c.k)
	}
	b.mu.Unlock()
	if b.trasCopiarClaves != nil {
		b.trasCopiarClaves()
	}

	g := compilarGlob(patron)
	trabajo := b.maxTrabajo
	out := nombres[:0]
	for _, k := range nombres {
		if g.encaja(k, &trabajo) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func (b *banco) tam(v *vista, db int) int {
	return len(b.claves(v, db, "*"))
}

// ttl: -2 si no existe, -1 si no tiene plazo pedido, o lo que le queda.
func (b *banco) ttl(v *vista, db int, k string) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.buscar(v, clave{db, k})
	switch {
	case e == nil:
		return -2
	case e.expira.IsZero():
		return -1
	}
	return e.expira.Sub(b.reloj())
}

// expirar pone plazo a una clave (si el momento ya pasó, la borra). Devuelve
// si existía.
func (b *banco) expirar(v *vista, db int, k string, cuando time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.buscar(v, clave{db, k})
	if e == nil {
		return false
	}
	if !cuando.After(b.reloj()) {
		b.quitar(e)
	} else {
		e.expira = cuando
	}
	v.cambios++
	return true
}

func (b *banco) persistir(v *vista, db int, k string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.buscar(v, clave{db, k})
	if e == nil || e.expira.IsZero() {
		return false
	}
	e.expira = time.Time{}
	return true
}

// vaciar borra la base db de la vista, o todas si db < 0.
func (b *banco) vaciar(v *vista, db int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for c, e := range v.datos {
		if db < 0 || c.db == db {
			b.quitar(e)
		}
	}
	v.cambios++
}

// espacio: por base, claves, claves con plazo y plazo medio en ms (lo que
// enseña INFO keyspace).
type espacioDB struct{ claves, conPlazo, mediaMs int }

func (b *banco) espacio(v *vista) (map[int]espacioDB, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ahora := b.reloj()
	out := map[int]espacioDB{}
	sumas := map[int]int64{}
	for c, e := range v.datos {
		if b.vencida(e, ahora) {
			b.quitar(e)
			b.expirados++
			continue
		}
		x := out[c.db]
		x.claves++
		if !e.expira.IsZero() {
			x.conPlazo++
			sumas[c.db] += e.expira.Sub(ahora).Milliseconds()
		}
		out[c.db] = x
	}
	for db, x := range out {
		if x.conPlazo > 0 {
			x.mediaMs = int(sumas[db] / int64(x.conPlazo))
			out[db] = x
		}
	}
	return out, v.bytes
}

// conVista hace f con el candado del banco: para leer o cambiar la CONFIG, la
// réplica o los clientes de una vista.
func (b *banco) conVista(f func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	f()
}

func (b *banco) estadisticas() (expirados, desalojados int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.expirados, b.desalojados
}

// maxTrabajoGlob: pasos de comparación que puede gastar una orden en aplicar
// patrones (KEYS, SCAN MATCH, CONFIG GET). Unos milisegundos de CPU; lo que
// quede por mirar al acabarse se da por no coincidente.
const maxTrabajoGlob = 4_000_000

// maxPatron: bytes del patrón que se miran. Ningún patrón real se acerca.
const maxPatron = 256

// pieza de un patrón glob ya troceado: '*', '?', una clase o un literal.
type pieza struct {
	tipo  byte // '*', '?', '[' o 'c' (literal)
	c     byte
	clase func(byte) bool
}

type glob struct {
	piezas []pieza
	todo   bool // el patrón es solo '*': encaja con todo sin mirar
}

// compilarGlob trocea el patrón de KEYS, SCAN MATCH y CONFIG GET como
// stringmatchlen de Redis (*, ?, [abc], [^a-z], \x), juntando los '*'
// seguidos (como Redis, que los salta), sobre los primeros maxPatron bytes.
func compilarGlob(patron string) *glob {
	if len(patron) > maxPatron {
		patron = patron[:maxPatron]
	}
	g := &glob{}
	for i := 0; i < len(patron); i++ {
		c := patron[i]
		switch c {
		case '*':
			if n := len(g.piezas); n == 0 || g.piezas[n-1].tipo != '*' {
				g.piezas = append(g.piezas, pieza{tipo: '*'})
			}
		case '?':
			g.piezas = append(g.piezas, pieza{tipo: '?'})
		case '[':
			fin, coincide := claseGlob(patron, i)
			g.piezas = append(g.piezas, pieza{tipo: '[', clase: coincide})
			i = fin
		default:
			if c == '\\' && i+1 < len(patron) {
				i++
				c = patron[i]
			}
			g.piezas = append(g.piezas, pieza{tipo: 'c', c: c})
		}
	}
	g.todo = len(g.piezas) == 1 && g.piezas[0].tipo == '*'
	return g
}

func (p pieza) encaja(x byte) bool {
	switch p.tipo {
	case '?':
		return true
	case '[':
		return p.clase(x)
	}
	return p.c == x
}

// encaja dice si s encaja con el patrón, sin memoria extra: cada pieza que no
// es '*' consume un byte, y al fallar se vuelve al último '*' y se le da un
// byte más. Cada llamada y cada paso gastan una unidad de trabajo (nil: sin
// límite); si se acaba, no encaja. También el '*' solo, que encaja sin mirar:
// así una orden no hace más llamadas que su presupuesto, sea cual sea el patrón.
func (g *glob) encaja(s string, trabajo *int) bool {
	if trabajo != nil {
		if *trabajo <= 0 {
			return false
		}
		*trabajo--
	}
	if g.todo {
		return true
	}
	p, i := 0, 0
	estrella, desde := -1, 0
	for i < len(s) {
		if trabajo != nil {
			if *trabajo <= 0 {
				return false
			}
			*trabajo--
		}
		switch {
		case p < len(g.piezas) && g.piezas[p].tipo == '*':
			estrella, desde = p, i
			p++
		case p < len(g.piezas) && g.piezas[p].encaja(s[i]):
			p++
			i++
		case estrella >= 0:
			p = estrella + 1
			desde++
			i = desde
		default:
			return false
		}
	}
	for p < len(g.piezas) && g.piezas[p].tipo == '*' {
		p++
	}
	return p == len(g.piezas)
}

// globRedis: un patrón contra una cadena, con el presupuesto de una orden.
func globRedis(patron, s string) bool {
	t := maxTrabajoGlob
	return compilarGlob(patron).encaja(s, &t)
}

// claseGlob lee la clase [..] que empieza en patron[i]; devuelve dónde acaba
// y con qué bytes encaja.
func claseGlob(patron string, i int) (int, func(byte) bool) {
	j := i + 1
	negada := false
	if j < len(patron) && patron[j] == '^' {
		negada = true
		j++
	}
	type rango struct{ a, b byte }
	var rangos []rango
	for j < len(patron) && patron[j] != ']' {
		c := patron[j]
		if c == '\\' && j+1 < len(patron) {
			j++
			rangos = append(rangos, rango{patron[j], patron[j]})
		} else if j+2 < len(patron) && patron[j+1] == '-' && patron[j+2] != ']' {
			a, z := c, patron[j+2]
			if a > z {
				a, z = z, a
			}
			rangos = append(rangos, rango{a, z})
			j += 2
		} else {
			rangos = append(rangos, rango{c, c})
		}
		j++
	}
	if j >= len(patron) {
		j = len(patron) - 1 // clase sin cerrar: Redis la da por cerrada al final
	}
	return j, func(x byte) bool {
		for _, r := range rangos {
			if x >= r.a && x <= r.b {
				return !negada
			}
		}
		return negada
	}
}
