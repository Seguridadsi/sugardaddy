package discos

// Lo que el sensor sabe de los discos de sus trampas: si esta máquina puede
// (se averigua una vez), qué trampa no ha podido tener el suyo y qué contenedor
// va con disco (para leer sus registros donde están).

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Tras un fallo pasajero (la imagen del auxiliar no baja, Docker no contesta), no se
// vuelve a lanzar el auxiliar hasta pasado esto: nunca uno cada 10 s.
const esperaReintento = time.Minute

// Un disco que no se ha podido retirar no se reintenta hasta pasado esto.
const esperaRetirada = time.Hour

// Gestor de los discos de las trampas de un sensor.
type Gestor struct {
	// Datos: la carpeta del sensor (la misma ruta en la máquina).
	Datos string
	// Imagen: la del actualizador, que hace de auxiliar (ACTUALIZADOR_IMAGEN). Vacía:
	// el sensor se instaló con un compose sin ella, y no hay discos.
	Imagen string
	TamMb  int
	Docker *docker.Cliente

	// Para las pruebas. nil: el auxiliar de verdad (Lanzar), Montado y RecibeMontajes.
	Lanzar      func(ctx context.Context, nombre string, p Pedido) (Resultado, error)
	Ve          func(dir string) bool
	Propagacion func() bool
	Ahora       func() time.Time

	mu        sync.Mutex
	maquina   string // "" sin saber; CodigoFijo; o por qué no
	reintento time.Time
	fallos    map[string]string    // por trampa, mientras siga en marcha el sensor
	usa       map[string]bool      // trampas cuyo contenedor va con disco
	retiradas map[string]time.Time // retiradas que han fallado, y cuándo
}

func (g *Gestor) ahora() time.Time {
	if g.Ahora != nil {
		return g.Ahora()
	}
	return time.Now()
}

func (g *Gestor) ve(dir string) bool {
	if g.Ve != nil {
		return g.Ve(dir)
	}
	return Montado(dir)
}

func (g *Gestor) lanzar(ctx context.Context, sensor string, p Pedido) (Resultado, error) {
	// Con «_», que no cabe en el id de un sensor: nunca choca con una trampa.
	nombre := "sd_disco_" + sensor
	if g.Lanzar != nil {
		return g.Lanzar(ctx, nombre, p)
	}
	return Lanzar(ctx, g.Docker, g.Imagen, nombre, p)
}

func (g *Gestor) tam() int {
	if g.TamMb > 0 {
		return g.TamMb
	}
	return TamPorDefecto
}

// Maquina dice si esta máquina puede dar disco a sus trampas: CodigoFijo si puede,
// el código de por qué no, o "" si aún no se sabe (sin trampas, o tras un fallo
// pasajero: se vuelve a probar en un rato). Se averigua una vez:
//   - sin la imagen del auxiliar o sin propagación hacia el sensor, no;
//   - con un disco ya montado que el sensor ve, sí;
//   - si no, lo prueba el auxiliar con un disco que no es de ninguna trampa, para
//     no rehacer ninguna antes de saberlo.
func (g *Gestor) Maquina(ctx context.Context, sensor string, hayTrampas bool) string {
	g.mu.Lock()
	if g.maquina != "" || !hayTrampas || g.ahora().Before(g.reintento) {
		defer g.mu.Unlock()
		return g.maquina
	}
	g.mu.Unlock()
	var codigo, detalle string
	switch {
	case g.Imagen == "" && g.Lanzar == nil:
		codigo, detalle = CodigoSinAuxiliar, "the sensor does not know the updater image (ACTUALIZADOR_IMAGEN)"
	case !g.recibe():
		codigo, detalle = CodigoSinPropagacion, "the sensor folder is not mounted with propagation (SENSOR_PROPAGACION)"
	case g.algunoMontado():
		codigo = CodigoFijo
	default:
		r, err := g.lanzar(ctx, sensor, Pedido{Datos: g.Datos, TamMb: g.tam(), Probar: true})
		if err != nil {
			slog.Warn("could not check whether decoys can have their own disk; will retry", "err", err)
			g.mu.Lock()
			g.reintento = g.ahora().Add(esperaReintento)
			g.mu.Unlock()
			return ""
		}
		codigo, detalle = r.Codigo, r.Detalle
		if codigo == "" {
			codigo = CodigoFijo
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fijarMaquina(codigo, detalle)
	return g.maquina
}

// fijarMaquina, con el candado puesto.
func (g *Gestor) fijarMaquina(codigo, detalle string) {
	if g.maquina == codigo {
		return
	}
	g.maquina = codigo
	if codigo == CodigoFijo {
		slog.Info("each decoy gets its own fixed-size disk", "codigo", codigo)
		return
	}
	slog.Warn("decoys cannot have their own fixed-size disk on this machine; their folders are checked every 10 s instead",
		"codigo", codigo, "detalle", detalle)
}

func (g *Gestor) recibe() bool {
	if g.Propagacion != nil {
		return g.Propagacion()
	}
	return RecibeMontajes(g.Datos)
}

// algunoMontado: algún disco de trampa está montado y el sensor lo ve.
func (g *Gestor) algunoMontado() bool {
	for _, id := range g.Presentes() {
		if g.Montado(id) {
			return true
		}
	}
	return false
}

// Montado: el disco de la trampa está montado y el sensor ve su carpeta de registros.
func (g *Gestor) Montado(id string) bool {
	if !g.ve(Dir(g.Datos, id)) {
		return false
	}
	fi, err := os.Stat(Registros(g.Datos, id))
	return err == nil && fi.IsDir()
}

// Listo: el disco de la trampa está montado y tiene todas las carpetas que su
// contenedor va a montar. Si falta alguna (una imagen nueva que declara otro
// VOLUME), la crea el auxiliar: el sensor no crea nada dentro de un disco.
func (g *Gestor) Listo(m Montaje) bool {
	if !g.Montado(m.ID) {
		return false
	}
	carpetas := slices.Clone(m.Carpetas)
	for i := 0; i < m.Escribibles; i++ {
		carpetas = append(carpetas, filepath.Base(Escribible(g.Datos, m.ID, i)))
	}
	for _, c := range carpetas {
		if fi, err := os.Stat(filepath.Join(Dir(g.Datos, m.ID), c)); err != nil || !fi.IsDir() {
			return false
		}
	}
	return true
}

// Presentes: las trampas que tienen disco en la máquina (fichero o punto de montaje).
func (g *Gestor) Presentes() []string {
	entradas, _ := os.ReadDir(filepath.Join(g.Datos, Carpeta))
	vistos := map[string]bool{}
	var ids []string
	for _, e := range entradas {
		id := strings.TrimSuffix(e.Name(), ".img")
		if strings.HasPrefix(id, ".") || vistos[id] || !IDValido(id) {
			continue
		}
		vistos[id] = true
		ids = append(ids, id)
	}
	return ids
}

// Fallo: por qué esta trampa no ha podido tener su disco ("" si no ha fallado).
// No se reintenta mientras el sensor siga en marcha: va sin disco, con el vigilante.
func (g *Gestor) Fallo(id string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.fallos[id]
}

// Usa dice si el contenedor de la trampa va con disco: entonces sus registros están en él.
func (g *Gestor) Usa(id string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.usa[id]
}

// Usar apunta si el contenedor de la trampa va con disco.
func (g *Gestor) Usar(id string, si bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.usa == nil {
		g.usa = map[string]bool{}
	}
	g.usa[id] = si
}

// Olvidar lo de las trampas que ya no están.
func (g *Gestor) Olvidar(quedan map[string]bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for id := range g.usa {
		if !quedan[id] {
			delete(g.usa, id)
		}
	}
	for id := range g.fallos {
		if !quedan[id] {
			delete(g.fallos, id)
		}
	}
}

// Estado para el hecho disco.trampas: si cada trampa tiene su disco y por qué.
func (g *Gestor) Estado() (valor bool, motivo string, sabido bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.maquina == CodigoFijo, g.maquina, g.maquina != ""
}

// RetirarSinAuxiliar borra el disco de una trampa que ya no está si no está montado
// (tras un reinicio de la máquina, por ejemplo): no hace falta el auxiliar. false si
// está montado y tiene que desmontarlo él.
func (g *Gestor) RetirarSinAuxiliar(id string) bool {
	if g.ve(Dir(g.Datos, id)) {
		return false
	}
	if err := os.Remove(Fichero(g.Datos, id)); err != nil && !os.IsNotExist(err) {
		slog.Warn("could not delete the disk of a removed decoy", "trampa", id, "err", err)
		return true
	}
	_ = os.RemoveAll(Dir(g.Datos, id))
	return true
}

// Asegurar deja montados los discos de montar (los crea si faltan) y retira los de
// retirar, con un solo auxiliar. Devuelve cómo ha quedado cada uno de montar: sin
// código, montado y visto por el sensor. Un fallo de la máquina se queda para todas;
// el de un disco (sin sitio, dañado), para esa trampa, que va sin disco. Un fallo
// pasajero no se queda: se reintenta pasado un rato.
func (g *Gestor) Asegurar(ctx context.Context, sensor string, montar []Montaje, retirar []string) map[string]Estado {
	r := map[string]Estado{}
	g.mu.Lock()
	ahora := g.ahora()
	var quitar []string
	for _, id := range retirar {
		if t, ok := g.retiradas[id]; !ok || ahora.Sub(t) >= esperaRetirada {
			quitar = append(quitar, id)
		}
	}
	maquina, espera := g.maquina, ahora.Before(g.reintento)
	g.mu.Unlock()
	if maquina != CodigoFijo {
		for _, m := range montar {
			r[m.ID] = Estado{Codigo: maquina}
		}
		montar = nil
	}
	if DeLaMaquina(maquina) {
		// Si el auxiliar no puede montar aquí, tampoco hay discos montados que retirar.
		quitar = nil
	}
	if len(montar) == 0 && len(quitar) == 0 {
		return r
	}
	if espera {
		for _, m := range montar {
			r[m.ID] = Estado{Codigo: CodigoError, Detalle: "waiting to retry the disk helper"}
		}
		return r
	}
	res, err := g.lanzar(ctx, sensor, Pedido{Datos: g.Datos, TamMb: g.tam(), Montar: montar, Retirar: quitar})
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.retiradas == nil {
		g.retiradas = map[string]time.Time{}
	}
	if err != nil {
		slog.Warn("disk helper failed; will retry", "err", err)
		g.reintento = g.ahora().Add(esperaReintento)
		for _, m := range montar {
			r[m.ID] = Estado{Codigo: CodigoError, Detalle: err.Error()}
		}
		for _, id := range quitar {
			g.retiradas[id] = g.ahora()
		}
		return r
	}
	if g.fallos == nil {
		g.fallos = map[string]string{}
	}
	for _, id := range quitar {
		if e, ok := res.Discos[id]; !ok || e.Codigo != "" {
			g.retiradas[id] = g.ahora()
			slog.Warn("could not remove the disk of a removed decoy; will retry later", "trampa", id, "codigo", e.Codigo, "detalle", e.Detalle)
		} else {
			delete(g.retiradas, id)
		}
	}
	for _, m := range montar {
		e, ok := res.Discos[m.ID]
		switch {
		case !ok && res.Codigo == "":
			e = Estado{Codigo: CodigoError, Detalle: "the disk helper said nothing about this disk"}
		case !ok:
			e = Estado{Codigo: res.Codigo, Detalle: res.Detalle}
		case e.Codigo == "" && !g.Montado(m.ID):
			// Montado en la máquina y el sensor no lo ve: su carpeta no recibe los montajes.
			e = Estado{Codigo: CodigoSinPropagacion, Detalle: "the disk was mounted but the sensor does not see it"}
		case e.Codigo == "" && !g.Listo(m):
			e = Estado{Codigo: CodigoError, Detalle: "the disk was mounted without all its folders"}
		}
		r[m.ID] = e
		switch {
		case e.Codigo == "":
		case DeLaMaquina(e.Codigo):
			g.fijarMaquina(e.Codigo, e.Detalle)
		default:
			g.fallos[m.ID] = e.Codigo
			slog.Warn("decoy without its own disk: its folders are checked every 10 s instead", "trampa", m.ID, "codigo", e.Codigo, "detalle", e.Detalle)
		}
	}
	return r
}

// RecibeMontajes dice si la carpeta del sensor le llega con propagación desde la
// máquina (rslave o rshared): solo entonces ve los discos que monta el auxiliar
// después de que el sensor arranque. Se mira en /proc/self/mountinfo el montaje que
// contiene la carpeta: lo dicen sus campos opcionales («master:» o «shared:»).
func RecibeMontajes(datos string) bool {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return false
	}
	return recibeEn(string(b), filepath.Clean(datos))
}

func recibeEn(mountinfo, datos string) bool {
	mejor, recibe := "", false
	for _, l := range strings.Split(mountinfo, "\n") {
		f := strings.Fields(l)
		if len(f) < 7 {
			continue
		}
		punto := desescapar(f[4])
		if !(punto == "/" || datos == punto || strings.HasPrefix(datos, punto+"/")) || len(punto) < len(mejor) {
			continue
		}
		mejor, recibe = punto, false
		for _, o := range f[6:] {
			if o == "-" {
				break
			}
			if strings.HasPrefix(o, "master:") || strings.HasPrefix(o, "shared:") {
				recibe = true
			}
		}
	}
	return recibe
}

// desescapar las rutas de mountinfo: espacios y demás van como \040.
func desescapar(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			n := 0
			ok := true
			for _, c := range s[i+1 : i+4] {
				if c < '0' || c > '7' {
					ok = false
					break
				}
				n = n*8 + int(c-'0')
			}
			if ok {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
