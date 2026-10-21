// Banco de pruebas de una trampa: la despliega con el mismo código que el
// sensor (endurecida, en su red aislada), la ataca desde contenedores con las
// órdenes de su prueba y comprueba que sus registros dan los eventos
// esperados, traducidos con el mismo adaptador. No hace falta consola.
//
// Lo normal es lanzarlo con herramientas/probar-trampa.sh <módulo>, que
// construye la imagen y pasa a JSON el manifiesto y su prueba.
//
//	probartrampa -manifiesto m.json -prueba p.json [-imagen local/x:prueba]
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/adaptador"
	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/seguidor"
)

var conservar bool

// El banco del modo «IP propia» (docs/diseno/red.md §5, manual H76 §2.4): la
// subred fija de pruebas del banco (la del ejemplo del manual), donde la
// trampa va con IP fija y su atacante coincide con ella en capa 2: los
// dos enchufes crudos ven las mismas tramas (en un puente Linux el
// unknown-unicast se inunda) y la multidifusión pasa. IP fijas para que
// los eventos del banco digan siempre lo mismo; las de los ataques
// (.10, .11, .20-.29, .30) no son de nadie: eso es lo que prueba.
const (
	subredBanco     = "172.31.201.0/24"
	redBanco        = "sd-banco-ip-propia"
	ipTrampaBanco   = "172.31.201.2"
	ipAtacanteBanco = "172.31.201.50"
)

// Prueba es el prueba.yaml del módulo, pasado a JSON.
type Prueba struct {
	Parametros map[string]any `json:"parametros"`
	// Segundos que se deja arrancar a la trampa antes de atacarla.
	Arranque int      `json:"arranque"`
	Ataques  []Ataque `json:"ataques"`
	// Eventos que tienen que salir, cada uno al menos una vez.
	Espera []Esperado `json:"espera"`
	// Segundos que se esperan los eventos tras el último ataque.
	Tiempo int `json:"tiempo"`
}

type Ataque struct {
	// "atacante" es la imagen de herramientas/atacante; si no, una fijada por digest.
	Imagen string   `json:"imagen"`
	Orden  []string `json:"orden"`
	// El ataque puede fallar (p. ej. un login rechazado a propósito).
	PuedeFallar bool `json:"puedeFallar"`
}

type Esperado struct {
	Accion    string `json:"accion"`
	Severidad string `json:"severidad"`
	Usuario   string `json:"usuario"`
	// Campos de detalle que tienen que contener ese texto.
	Detalle map[string]string `json:"detalle"`
	// Si el evento dice que hubo sesión completa (nil: da igual).
	Conexion *bool `json:"conexion"`
}

func main() {
	rutaM := flag.String("manifiesto", "", "manifiesto de la trampa en JSON")
	rutaP := flag.String("prueba", "", "prueba de la trampa en JSON")
	imagen := flag.String("imagen", "", "imagen local que sustituye a la del manifiesto")
	atacante := flag.String("atacante", "sd-prueba/atacante:local", "imagen de herramientas/atacante")
	socket := flag.String("docker", "/var/run/docker.sock", "socket de Docker")
	datos := flag.String("datos", "", "carpeta de datos (por defecto, una temporal)")
	licenciaRuta := flag.String("licencia", "", "fichero con la licencia de pago firmada, que se monta en la trampa")
	flag.BoolVar(&conservar, "conservar", false, "no retirar la trampa al acabar (para mirar qué ha pasado)")
	flag.Parse()
	if err := probar(*rutaM, *rutaP, *imagen, *atacante, *socket, *datos, *licenciaRuta); err != nil {
		fmt.Fprintln(os.Stderr, "FALLA:", err)
		os.Exit(1)
	}
	fmt.Println("BIEN: la trampa da los eventos esperados")
}

func leerJSON(ruta string, v any) error {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// subredSinAnfitrion comprueba que ninguna dirección IPv4 LOCAL del
// anfitrión caiga dentro de la subred del banco (hallazgo 8 de la revisión):
// la subred del banco es fija y sus IP van sin sondeo a un puente sandbox; si
// este anfitrión tiene esa subred de verdad (p. ej. la LAN de producción del
// cliente siendo justo 172.31.201.0/24), crear el puente choca con la ruta
// local y las IP fijas pisarían a equipos reales. Una red conectada de
// verdad siempre trae una dirección de interfaz: net.InterfaceAddrs.
func subredSinAnfitrion(subred netip.Prefix) error {
	dir, err := net.InterfaceAddrs()
	if err != nil {
		// Sin poder mirar las direcciones locales no se puede afirmar que
		// la subred esté libre: se dice y no se arranca el banco.
		return fmt.Errorf("no se pudieron leer las direcciones locales del anfitrión: %w", err)
	}
	return subredSin(subred, dir)
}

// subredSin: la comprobación de arriba, suelta para probarla con
// direcciones fijas.
func subredSin(subred netip.Prefix, direcciones []net.Addr) error {
	for _, a := range direcciones {
		ipn, es := a.(*net.IPNet)
		if !es {
			continue
		}
		v4 := ipn.IP.To4()
		if v4 == nil {
			continue
		}
		var b [4]byte
		copy(b[:], v4)
		if subred.Contains(netip.AddrFrom4(b)) {
			return fmt.Errorf("la subred del banco %s la tiene de verdad este anfitrión (dirección %s): el banco no se lanza aquí, pisaría la red del cliente", subred, netip.AddrFrom4(b))
		}
	}
	return nil
}

func probar(rutaM, rutaP, imagen, atacante, socket, datos, licenciaRuta string) error {
	var m plan.Manifiesto
	var p Prueba
	if err := leerJSON(rutaM, &m); err != nil {
		return fmt.Errorf("manifiesto: %w", err)
	}
	if err := leerJSON(rutaP, &p); err != nil {
		return fmt.Errorf("prueba: %w", err)
	}
	if m.Contenedor == nil {
		return errors.New("la trampa no es de contenedor")
	}
	if imagen != "" {
		m.Contenedor.Imagen = imagen
	}
	if datos == "" {
		d, err := os.MkdirTemp("", "sd-prueba-")
		if err != nil {
			return err
		}
		if !conservar {
			defer os.RemoveAll(d)
		}
		datos = d
	}
	ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancelar()
	d := docker.Nuevo(socket)
	o := despliegue.Opciones{Datos: datos, Escucha: "127.0.0.1"}
	// Si la trampa trae el bloque red, se despliega como en producción con
	// el modo «IP propia»: red de banco propia, IP fija, sin puertos
	// publicados, y el atacante va a esa misma red y ataca la IP
	// directamente (la IP ES la trampa). Sin bloque red, igual que siempre:
	// puente aislado y puertos en 127.0.0.1.
	if m.Red != nil {
		// Hallazgo 8 de la revisión: el banco usa una subred FIJA con IP
		// fija en un puente sandbox y sin sondeo. Si ESTE anfitrión ya
		// tiene esa subred de verdad (una dirección local suya dentro de
		// ella — p. ej. la LAN de producción del cliente siendo justo
		// 172.31.201.0/24), crear el puente choca con la ruta local: el
		// banco se niega antes de tocar nada.
		if err := subredSinAnfitrion(netip.MustParsePrefix(subredBanco)); err != nil {
			return err
		}
		if err := d.AsegurarRedBanco(ctx, redBanco, netip.MustParsePrefix(subredBanco)); err != nil {
			return fmt.Errorf("la red de banco del modo «IP propia»: %w", err)
		}
		o.RedPropia = &despliegue.RedPropia{
			Puente: redBanco, IPFija: ipTrampaBanco, Rango: netip.MustParsePrefix(subredBanco),
		}
		fmt.Println("modo IP propia: red de banco", redBanco, "con subred", subredBanco)
	}
	trampa := plan.TrampaPlan{ID: "prueba-" + m.ID, Nombre: "Prueba", Manifiesto: m, Parametros: p.Parametros}
	// Un sensor por módulo: dos pruebas a la vez no se retiran las trampas.
	sensor := "banco-" + m.ID
	pl := plan.Plan{Sensor: sensor, Trampas: []plan.TrampaPlan{trampa}}
	// La licencia de pago, si se da: se monta en la trampa igual que en un nodo.
	if licenciaRuta != "" {
		b, err := os.ReadFile(licenciaRuta)
		if err != nil {
			return fmt.Errorf("licencia: %w", err)
		}
		pl.Licencia = b
	}
	// Al acabar, la trampa se retira como lo haría el sensor (con su volumen)
	// y la red de banco, si quedó sin contenedores, se desmonta (hallazgo 8:
	// antes quedaba de adorno para siempre en el motor; en abort también).
	defer func() {
		if conservar {
			fmt.Println("trampa conservada; datos en", datos)
			return
		}
		retirar := context.WithoutCancel(ctx)
		_, _ = despliegue.Aplicar(retirar, d, o, plan.Plan{Sensor: sensor})
		if m.Red == nil {
			return
		}
		if r, err := d.InspeccionarRed(retirar, redBanco); err == nil && len(r.Containers) == 0 {
			if err := d.BorrarRed(retirar, redBanco); err != nil {
				fmt.Fprintln(os.Stderr, "la red de banco", redBanco, "quedó sin desmontar:", err)
			}
		}
	}()

	// Desplegar, esperando a que la imagen esté (la descarga va aparte).
	var donde string
	for i := 0; ; i++ {
		estados, err := despliegue.Aplicar(ctx, d, o, pl)
		if err != nil {
			return fmt.Errorf("desplegar: %w", err)
		}
		donde = estados[0].Donde
		if !strings.HasPrefix(donde, "error: descargando") && !strings.Contains(donde, "descargando la imagen") {
			break
		}
		if i > 120 {
			return errors.New("la imagen no termina de descargarse")
		}
		time.Sleep(time.Second)
	}
	fmt.Println("desplegada:", donde)
	if strings.HasPrefix(donde, "error") {
		return errors.New(donde)
	}
	time.Sleep(time.Duration(max(p.Arranque, 3)) * time.Second)

	for i, a := range p.Ataques {
		img := a.Imagen
		if img == "atacante" {
			img = atacante
		}
		// Con IP propia el atacante entra en la red de banco, con IP fija:
		// ataca la IP de la trampa de igual a igual, en capa 2 (así se ve
		// el tráfico multidifusión del LLMNR/NBT-NS, que no cruza ningún NAT).
		redAtacante, ipAtacante := "", ""
		if m.Red != nil {
			redAtacante, ipAtacante = redBanco, ipAtacanteBanco
		}
		codigo, err := atacar(ctx, d, img, rellenar(a.Orden, p.Parametros), redAtacante, ipAtacante)
		fmt.Printf("ataque %d: código %d\n", i+1, codigo)
		if err != nil {
			return fmt.Errorf("ataque %d: %w", i+1, err)
		}
		if codigo != 0 && !a.PuedeFallar {
			return fmt.Errorf("el ataque %d ha fallado (código %d)", i+1, codigo)
		}
	}

	// Leer sus registros como el sensor y comprobar lo esperado.
	ruta := filepath.Join(despliegue.Registros(o, trampa.ID), m.Eventos.Fuente.Ruta)
	var vistos []evento.Evento
	var pos seguidor.Posicion
	fin := time.Now().Add(time.Duration(max(p.Tiempo, 10)) * time.Second)
	for {
		lineas, nueva, aviso, err := seguidor.Seguir(ruta, pos)
		if err != nil {
			return fmt.Errorf("registro: %w", err)
		}
		if aviso != "" {
			fmt.Println("aviso:", aviso)
		}
		pos = nueva
		for _, l := range lineas {
			e, err := adaptador.Adaptar(sensor, trampa, l)
			if errors.Is(err, adaptador.ErrIgnorada) {
				continue
			}
			if err != nil {
				return fmt.Errorf("línea que el adaptador no entiende: %w\n%s", err, l)
			}
			// Sin sensorMinimo, la trampa también llega a sensores 0.12: tienen que entenderla.
			if m.SensorMinimo == "" {
				if err := adaptador.Compatible012(trampa, l); err != nil {
					return fmt.Errorf("un sensor 0.12 no entendería esta línea (%v): pon sensorMinimo: 0.13.0 en el manifiesto o cambia su registro\n%s", err, l)
				}
			}
			vistos = append(vistos, e)
			fmt.Printf("  evento: %-13s %-8s %s:%d usuario=%q conexion=%v %s\n", e.Accion, e.Severidad, e.Origen.IP, e.Origen.Puerto, e.Origen.Usuario, e.ConexionEstablecida, resumen(e.Detalle))
		}
		faltan := faltantes(p.Espera, vistos)
		if len(faltan) == 0 {
			return nil
		}
		if time.Now().After(fin) {
			b, _ := json.Marshal(faltan)
			return fmt.Errorf("faltan eventos: %s", b)
		}
		time.Sleep(time.Second)
	}
}

var hueco = regexp.MustCompile(`\$\{([^}]*)\}`)

func rellenar(orden []string, parametros map[string]any) []string {
	r := make([]string, len(orden))
	for i, o := range orden {
		r[i] = hueco.ReplaceAllStringFunc(o, func(h string) string { return fmt.Sprint(parametros[h[2:len(h)-1]]) })
	}
	return r
}

// atacar corre una orden en un contenedor y devuelve su código de salida.
// Sin red (el banco de siempre): red del anfitrión, para llegar a los
// puertos publicados en 127.0.0.1. Con red (modo «IP propia»): la red de
// banco, con su IP fija, para atacar la IP de la trampa de igual a igual.
func atacar(ctx context.Context, d *docker.Cliente, imagen string, orden []string, red, ip string) (int, error) {
	if err := d.AsegurarImagen(ctx, imagen); err != nil {
		return -1, err
	}
	cfg := map[string]any{
		"Image":  imagen,
		"Cmd":    orden,
		"Labels": map[string]string{"sugardaddy.banco": "ataque"},
		"HostConfig": map[string]any{
			"NetworkMode": "host", "LogConfig": docker.RegistrosAcotados(),
		},
	}
	if red != "" {
		host := cfg["HostConfig"].(map[string]any)
		host["NetworkMode"] = red
		cfg["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{
			red: map[string]any{"IPAMConfig": map[string]string{"IPv4Address": ip}},
		}}
		/*
		 * Los ataques de capa 2 (el arping y la trama cruda) van con
		 * enchufes crudos, como los del atacante real en la VLAN. El
		 * contenedor de herramientas va de fábrica sin privilegios (sin
		 * root, sin capacidades): solo aquí, en el banco del modo «IP
		 * propia», el ATACANTE corre como root y con NET_RAW — lo mínimo
		 * para fingir el ARP de un equipo de la red. Es el banco, no una
		 * trampa: en producción nadie más que las trampas con capturar
		 * recibe NET_RAW del sensor, y ellas lo llevan con su BPF puesto.
		 */
		host["CapAdd"] = []string{"NET_RAW"}
		cfg["User"] = "root"
	}
	id, err := d.Crear(ctx, fmt.Sprintf("sd-banco-ataque-%d", time.Now().UnixNano()), cfg)
	if err != nil {
		return -1, err
	}
	defer func() { _ = d.Borrar(context.WithoutCancel(ctx), id) }()
	if err := d.Arrancar(ctx, id); err != nil {
		return -1, err
	}
	actx, cancelar := context.WithTimeout(ctx, 3*time.Minute)
	defer cancelar()
	codigo, err := d.Esperar(actx, id)
	if codigo != 0 {
		if out, e := d.Salida(ctx, id, 20); e == nil && out != "" {
			fmt.Printf("  salida del ataque:\n%s\n", out)
		}
	}
	return codigo, err
}

func faltantes(espera []Esperado, vistos []evento.Evento) []Esperado {
	var faltan []Esperado
	for _, x := range espera {
		ok := false
		for _, e := range vistos {
			if cumple(x, e) {
				ok = true
				break
			}
		}
		if !ok {
			faltan = append(faltan, x)
		}
	}
	return faltan
}

func cumple(x Esperado, e evento.Evento) bool {
	if x.Accion != "" && e.Accion != x.Accion || x.Severidad != "" && e.Severidad != x.Severidad {
		return false
	}
	if x.Usuario != "" && e.Origen.Usuario != x.Usuario {
		return false
	}
	if x.Conexion != nil && e.ConexionEstablecida != *x.Conexion {
		return false
	}
	for k, v := range x.Detalle {
		if !strings.Contains(fmt.Sprint(e.Detalle[k]), v) {
			return false
		}
	}
	return true
}

func resumen(d map[string]any) string {
	b, _ := json.Marshal(d)
	if len(b) > 160 {
		return string(b[:160]) + "…"
	}
	return string(b)
}
