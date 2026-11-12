package main

import (
	"log/slog"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Lo que viene de la propia máquina del sensor no es un ataque, y por defecto no se
// registra: lo decide un interruptor de la consola, que llega en el plan. Se descarta
// aquí, antes de que el evento entre en la cadena de hashes: si lo tirara la consola,
// la cadena se rompería.
//
// Lo que no se registra no se puede recuperar, y este producto no puede quedarse ciego
// ante un atacante de verdad: solo se descarta lo que seguro que es de esta máquina.

const (
	// Unas direcciones medidas hace tanto ya no se dan por buenas: la sonda mide cada
	// 2 minutos, y si deja de poder, esa IP puede ser ya de otro equipo de la red.
	vidaDirecciones = 10 * time.Minute
	// Tope de lo retenido a la espera del plan siguiente: si la consola no contesta, lo
	// más viejo se pierde. Sigue siendo lo de su propia máquina, sin ser de una prueba.
	maxRetenidos = 1000
	// Lo pone el receptor de balizas cuando la IP del evento sale del cuerpo del aviso
	// (la nube dice quién usó el token), y no de quien se ha conectado.
	campoIPSocket = "ipSocket"
	// Lo pone el receptor de balizas cuando la IP del evento la dice su proxy de confianza.
	campoIPProxy = "ipProxy"
	// Lo lleva el resumen de conexiones rechazadas de las trampas: cuenta las de todas
	// las IP y solo nombra la que más tiene, así que no es solo de esa.
	campoIPsDistintas = "ips_distintas"
)

// ipDeLaConexion da la IP con la que llegó la conexión de este evento, que es lo que dice
// si las trampas ven el origen. La IP del evento puede salir del cuerpo de un POST al
// receptor de balizas, y esa la escribe quien quiera. Sin una IP que se entienda, false.
func ipDeLaConexion(e evento.Evento) (string, bool) {
	socket, ok := e.Detalle[campoIPSocket]
	if !ok {
		return e.Origen.IP, true
	}
	ip, _ := socket.(string)
	_, err := netip.ParseAddr(ip)
	return ip, err == nil
}

// esPropio dice si una IP que ha visto una trampa viene SEGURO de esta máquina: es su
// dirección de red, en un motor que deja ver el origen.
//
// La IP del motor no cuenta nunca, aunque sea lo que se ve con «curl localhost»: una
// conexión de fuera también puede llegar con ella, sin las reglas del cortafuegos de
// Docker, por una VPN que enmascara o por un túnel, y durante días sin que nada lo
// note. Se registra. Sin root, con Docker Desktop o con WSL el motor enseña direcciones
// que no son de quien se conecta, así que no se descarta nada.
func esPropio(ip string, direcciones []string, d motor.Descripcion) bool {
	if d.Modo != motor.ModoRootful || d.Oculta(ip) {
		return false
	}
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	a = a.Unmap()
	return slices.ContainsFunc(direcciones, func(x string) bool {
		b, err := netip.ParseAddr(x)
		return err == nil && b.Unmap() == a
	})
}

// publicarEn da dónde publica el plan p los puertos de las trampas. Si lo de esta máquina
// no se registra, tampoco llega: con un motor que deja ver el origen, solo en sus
// direcciones de red, y así «curl localhost» no toca ninguna trampa. Lo que entra por la
// IP de red con la propia máquina como origen se descarta (esPropio); lo que llega con la
// IP del motor viene de fuera o de otro contenedor, y se registra.
//
// Sin direcciones medidas hace poco, o con un motor que enseña otras, como siempre: en
// 0.0.0.0, menos los puertos que ya tiene algo local en 127.x (PublicarEn). Una trampa
// publicada en una IP que la máquina ya no tiene no la ve nadie, y eso es peor que el ruido.
func (s *sensor) publicarEn(p plan.Plan) func(proto string, puerto int) []string {
	a := s.anfitrion.a
	if p.IgnorarPropio && s.conocido.Modo == motor.ModoRootful && a != nil && len(a.Direcciones) > 0 &&
		time.Since(s.anfitrion.medido) <= vidaDirecciones {
		dirs := slices.Clone(a.Direcciones)
		return func(string, int) []string { return dirs }
	}
	return a.PublicarEn
}

// maxDireccionesAnunciadas acota las direcciones que se recuerdan para
// ${sd.ipsAnfitrion}: pasado el tope, se empieza de nuevo con las de ahora.
const maxDireccionesAnunciadas = 8

// unirDirecciones añade a las ya conocidas las de la medida nueva, ordenadas y sin
// repetir; si pasan del tope, se queda solo con las nuevas.
func unirDirecciones(conocidas, nuevas []string) []string {
	todas := slices.Clone(conocidas)
	for _, d := range nuevas {
		if !slices.Contains(todas, d) {
			todas = append(todas, d)
		}
	}
	if len(todas) > maxDireccionesAnunciadas {
		todas = slices.Clone(nuevas)
	}
	slices.Sort(todas)
	return slices.Compact(todas)
}

// anunciaIPsAnfitrion dice si alguna trampa del plan pide las IP de la máquina
// (${sd.ipsAnfitrion} en su entorno o en sus ficheros).
func anunciaIPsAnfitrion(p plan.Plan) bool {
	for _, t := range p.Trampas {
		// La que pide una dirección de la máquina: sin medirlas no se puede comprobar.
		if t.Escucha != "" {
			return true
		}
		c := t.Manifiesto.Contenedor
		if c == nil {
			continue
		}
		for _, v := range c.Entorno {
			if v, ok := v.(string); ok && strings.Contains(v, "${sd.ipsAnfitrion}") {
				return true
			}
		}
		for _, f := range c.Ficheros {
			if strings.Contains(f.Contenido, "${sd.ipsAnfitrion}") {
				return true
			}
		}
	}
	return false
}

// filtraPropio dice si en esa trampa se descarta lo de esta máquina según el plan de
// ahora. Una trampa con IP propia no: la máquina no puede llegar a ella, así que lo que
// diga venir de esta máquina es falso.
func (s *sensor) filtraPropio(sp plan.TrampaPlan) bool {
	return s.plan != nil && s.plan.IgnorarPropio && sp.Manifiesto.Red == nil &&
		!slices.Contains(s.plan.RegistrarSiempre, sp.ID)
}

// ignorarPropio dice si este evento de esa trampa no se registra. Va después de origen,
// que marca el toque de «Prueba mi detección», que se registra siempre.
func (s *sensor) ignorarPropio(sp plan.TrampaPlan, e evento.Evento) bool {
	if !s.filtraPropio(sp) {
		return false
	}
	if _, toque := e.Detalle[campoToque]; toque {
		return false
	}
	if _, delCuerpo := e.Detalle[campoIPSocket]; delCuerpo {
		return false
	}
	if _, deVarias := e.Detalle[campoIPsDistintas]; deVarias {
		return false
	}
	if s.anfitrion.a == nil || time.Since(s.anfitrion.medido) > vidaDirecciones {
		return false
	}
	// Las direcciones son las de ahora: un evento antiguo (leído al volver de una
	// parada, por ejemplo) pudo venir de quien tenía entonces esa dirección.
	cuando, err := time.Parse(time.RFC3339Nano, e.Cuando)
	if err != nil || time.Since(cuando) > vidaDirecciones {
		return false
	}
	return esPropio(e.Origen.IP, s.anfitrion.a.Direcciones, s.conocido)
}

// retenido es un evento de su máquina que espera al plan siguiente. La prueba se abre en
// la consola y el sensor se entera al pedir el plan, hasta 10 segundos después: si se
// descartara ya, lo que haga quien prueba en ese rato se perdería para siempre. Está en
// memoria: si el sensor se reinicia justo en esos segundos, se pierde.
type retenido struct {
	plan *plan.Plan
	sp   plan.TrampaPlan
	e    evento.Evento
}

func (s *sensor) retener(lista []retenido, sp plan.TrampaPlan, e evento.Evento) []retenido {
	if len(lista) >= maxRetenidos {
		lista = slices.Delete(lista, 0, 1)
	}
	return append(lista, retenido{plan: s.plan, sp: sp, e: e})
}

// repartirRetenidos separa lo retenido: lo que hay que registrar al final (de un plan
// anterior que el de ahora ya no descarta), lo que sigue esperando (del plan de ahora) y,
// por trampa, cuánto se olvida (lo demás de un plan anterior). No toca s.retenidos: eso lo
// hace leer cuando la vuelta ha quedado escrita.
func (s *sensor) repartirRetenidos() (listos, siguen []retenido, olvidados map[string]int) {
	for _, r := range s.retenidos {
		switch {
		case r.plan == s.plan:
			siguen = append(siguen, r)
		case !s.filtraPropio(r.sp):
			listos = append(listos, r)
		default:
			if olvidados == nil {
				olvidados = map[string]int{}
			}
			olvidados[r.sp.ID]++
		}
	}
	return listos, siguen, olvidados
}

// anotarOlvidados deja rastro de lo que no se ha registrado: si una trampa deja de ver
// conexiones por esto (un reenviador en la máquina, por ejemplo), aquí se nota.
func anotarOlvidados(olvidados map[string]int) {
	for id, n := range olvidados {
		slog.Info("connections from this sensor's own machine were not recorded", "trampa", id, "n", n)
	}
}
