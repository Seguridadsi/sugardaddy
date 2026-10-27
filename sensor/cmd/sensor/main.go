// Sensor de Sugardaddy. Pide su plan a la consola, despliega las trampas,
// lee sus registros, los traduce al evento normalizado encadenado y los
// entrega. Todas las conexiones salen de aquí; nadie se conecta al sensor.
//
// El token va en SUGARDADDY_TOKEN y no en un argumento, para que no aparezca
// en la lista de procesos.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/adaptador"
	"github.com/kinomakino/sugardaddy/sensor/internal/confianza"
	"github.com/kinomakino/sugardaddy/sensor/internal/consola"
	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/red"
	"github.com/kinomakino/sugardaddy/sensor/internal/relevo"
	"github.com/kinomakino/sugardaddy/sensor/internal/seguidor"
)

var version = "dev"

const (
	cadaPlan    = 10 * time.Second
	cadaLectura = time.Second
	porEntrega  = 500
	// La cola de salida se vacía cuando está entregada entera y pasa de medio
	// MB: la mitad de su tope más pequeño (ver cola.go). Así, con el disco casi
	// lleno y la consola sana, queda sitio para lo que llegue de golpe.
	vaciarDesde = colaMin / 2
	// Lo que el motor dice de sí mismo cambia poco: se le vuelve a preguntar
	// cada tanto, o en cuanto vuelve tras un fallo.
	cadaMotor = 5 * time.Minute
	// Lo que miden las sondas del motor (como clone3) se vuelve a medir cada
	// hora, o en cuanto cambia el motor.
	cadaSondeo = time.Hour
	// Qué se guarda en el disco del cliente y cuánto: registros rotados ya
	// leídos, una semana; carpetas de trampas retiradas, un mes.
	guardarRotados   = 7 * 24 * time.Hour
	guardarRetiradas = 30 * 24 * time.Hour
	cadaPoda         = time.Hour
	cadaCuota        = 10 * time.Second
	// Una entrega no pasa de aquí aunque tenga menos de porEntrega líneas: el
	// servidor de la consola tiene un límite de tamaño, y un lote que lo pase
	// se rechazaría entero, una y otra vez.
	bytesPorEntrega = 256 << 10
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	// La sonda del aislamiento entre trampas (ver despliegue): una mitad escucha
	// y la otra llama; «sondear» sale con 0 si llega.
	if len(os.Args) == 3 && os.Args[1] == "escuchar" {
		os.Exit(escuchar(os.Args[2], time.Minute))
	}
	if len(os.Args) == 3 && os.Args[1] == "sondear" {
		os.Exit(sondear(os.Args[2]))
	}
	// La sonda de clone3 (ver motor.Clone3).
	if len(os.Args) == 2 && os.Args[1] == "probar-clone3" {
		os.Exit(probarClone3())
	}
	// La sonda de la puerta de enlace, en la red del anfitrión (ver
	// motor.PuertaEnlace).
	if len(os.Args) == 2 && os.Args[1] == "puerta-enlace" {
		f, err := os.Open("/proc/net/route")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println(motor.LeerPuertaEnlace(f))
		os.Exit(0)
	}
	// La sonda de los puertos y las direcciones de la máquina, en la red del
	// anfitrión (ver motor.SondaAnfitrion).
	if len(os.Args) == 2 && os.Args[1] == "puertos-anfitrion" {
		os.Exit(puertosAnfitrion())
	}
	// Healthcheck de compose: la imagen no tiene shell ni curl.
	if len(os.Args) == 3 && os.Args[1] == "salud" {
		c := &http.Client{Timeout: 3 * time.Second}
		resp, err := c.Get(os.Args[2])
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	urlConsola := flag.String("consola", "http://localhost:5180", "dirección de la consola del nodo")
	datos := flag.String("datos", "./datos-sensor", "carpeta de trabajo del sensor")
	escucha := flag.String("escucha", "0.0.0.0", "IP del anfitrión donde se publican las trampas")
	desplazar := flag.Int("desplazar", 0, "suma esto a los puertos expuestos (desarrollo)")
	socket := flag.String("docker", "/var/run/docker.sock", "socket de Docker")
	ca := flag.String("ca", "", "raíz de la CA de la consola, si no es de confianza para el sistema (sensor en otra máquina)")
	salud := flag.String("salud", "", "dirección del punto de salud para el actualizador, p. ej. :9100 (vacío: ninguno)")
	// El modo «IP propia» (docs/diseno/red.md): solo si quien instala el
	// sensor elige interfaz y rango. Sin ellos, las trampas con bloque red
	// dan su error en el despliegue en vez de ir al puente aislado rotas.
	enlace := flag.String("enlace", "", "interfaz física del segmento a vigilar, para el modo «IP propia» (por cable o VLAN, no Wi-Fi)")
	rango := flag.String("rango", "", "rango de IP propias reservado para las trampas, p. ej. 10.0.0.240/28 (fuera del reparto del DHCP)")
	flag.Parse()

	token := os.Getenv("SUGARDADDY_TOKEN")
	if token == "" {
		slog.Error("falta SUGARDADDY_TOKEN")
		os.Exit(2)
	}
	if err := os.MkdirAll(*datos, 0o700); err != nil {
		slog.Error("carpeta de datos", "err", err)
		os.Exit(1)
	}

	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()

	h, err := confianza.Cliente(*ca, 30*time.Second)
	if err != nil {
		slog.Error("CA de la consola", "err", err)
		os.Exit(2)
	}
	d := docker.Nuevo(*socket)
	c := consola.NuevoCon(*urlConsola, token, h)
	c.Version = version
	// Las imágenes de las trampas propias están en el registro privado: la misma
	// credencial de solo lectura con la que el actualizador baja las versiones.
	// Sin ella (p. ej., instalado por un actualizador 0.11, antes del relevo),
	// la consola le da la imagen pública de cada trampa.
	if t := os.Getenv("REGISTRO_TOKEN"); t != "" && os.Getenv("REGISTRO") != "" {
		d.ConCredencial(os.Getenv("REGISTRO"), docker.Credencial{Usuario: os.Getenv("REGISTRO_USUARIO"), Token: t})
		c.Registro = true
	}
	s := &sensor{
		consola: c,
		docker:  d,
		opc: despliegue.Opciones{
			Datos: *datos, Escucha: *escucha, Desplazar: *desplazar,
			// La sonda del aislamiento corre con la imagen del propio sensor.
			ImagenSonda: os.Getenv("SENSOR_IMAGEN"),
		},
		salida: filepath.Join(*datos, "salida.jsonl"),
	}
	// El modo «IP propia»: interfaz y rango juntos o ninguno. El hecho
	// red.capa2 que se informa luego dice si la máquina de verdad puede
	// (Wi-Fi y nube no valen: docs/diseno/red.md §2).
	if *enlace != "" || *rango != "" {
		red, err := redPropiaDeArranque(*enlace, *rango)
		if err != nil {
			slog.Error("el modo «IP propia»", "err", err)
			os.Exit(2)
		}
		s.opc.RedPropia = red
	}
	if s.estado, err = estado.Cargar(*datos); err != nil {
		slog.Error("estado ilegible", "err", err)
		os.Exit(1)
	}
	// Las trampas paradas por su cuota siguen paradas tras un reinicio.
	s.opc.Paradas = s.estado.Paradas
	s.pararTrampa = func(id string) error {
		s.muPlan.Lock()
		p := s.plan
		s.muPlan.Unlock()
		if p == nil {
			return errors.New("aún no hay plan")
		}
		ctx, cancelar := context.WithTimeout(ctx, time.Minute)
		defer cancelar()
		return despliegue.Parar(ctx, s.docker, p.Sensor, id)
	}
	// El vigilante va AL FINAL (hallazgo 6 de la revisión): su goroutine lee
	// s.pararTrampa y s.apuntarIP, y esas escrituras tienen que quedar
	// ANTES de arrancarla.
	if s.opc.RedPropia != nil {
		s.montarVigilante(ctx)
	}
	var guardadas []ventana
	_ = json.Unmarshal(s.estado.Ritmo, &guardadas)
	s.ritmo = ritmoDe(guardadas)
	s.retomarDescartes()
	if err := s.retomarCadena(); err != nil {
		slog.Error("cola de salida", "err", err)
		os.Exit(1)
	}
	if *salud != "" {
		go s.servirSalud(*salud)
	}
	slog.Info("sensor en marcha", "version", version, "consola", *urlConsola)
	go s.relevar(ctx, &relevo.Relevo{
		Docker: s.docker, Consola: s.consola, Version: version, Datos: *datos, Socket: *socket,
		Log: func(m string, args ...any) { slog.Info(m, args...) },
	})
	s.correr(ctx)
}

type sensor struct {
	consola *consola.Cliente
	docker  *docker.Cliente
	opc     despliegue.Opciones
	estado  *estado.Estado
	salida  string
	plan    *plan.Plan
	pausa   time.Time
	// Último plan recibido de la consola, en Unix: lo que mira el punto de salud.
	ultimoPlan atomic.Int64
	// Tope de líneas por entrega; baja a la mitad si la consola dice que es
	// demasiado grande y vuelve a porEntrega cuando una entrega sale bien.
	lote int
	// Eventos por trampa y minuto (ver ritmo.go).
	ritmo ritmo
	// Lo descartado con la cola de salida llena, aún sin resumir (ver cola.go).
	descartes descartes
	// La última entrega a la consola salió bien: si la cola se llena, no es
	// porque la consola no recoja (ver abrirCola).
	consolaRecoge bool
	// pararTrampa para los contenedores de una trampa y no vuelve hasta que
	// lo están (ver cuota.go). nil en las pruebas que no lo miran.
	pararTrampa func(id string) error
	// El vigilante ARP del modo «IP propia» (docs/diseno/red.md §3): su
	// «apuntar» dice qué IP propias vigilar y su canal trae los reclamos.
	// nil: sin modo «IP propia» o sin vigilante (sin NET_RAW en el anfitrión).
	apuntarIP func(netip.Addr)
	// vigiladas son las IP ya apuntadas al vigilante, para no repetirlas. Lo
	// tocan el bucle del sensor y la goroutina del vigilante: con su mutex
	// (la carrera era un hallazgo de la revisión — y sin mutex, go test -race
	// la caza en cuanto un reclamo llega mientras se aplica un plan).
	vigiladas   map[string]bool
	muVigiladas sync.Mutex
	// muPlan guarda s.plan entre el bucle que lo reescribe y la goroutine del
	// vigilante, que lo lee por s.pararTrampa (hallazgo N2 de la re-revisión:
	// carrera benigna de puntero, cerrada igual). Los demás lectores viven en
	// la goroutine del bucle, con su propia escritura.
	muPlan sync.Mutex
	// Lo que se informa a la consola del motor (con su fallo, si lo hay) y la
	// última descripción buena, con la que se decide si la IP que ve una
	// trampa es la del atacante o la del propio motor.
	motor, conocido motor.Descripcion
	motorCuando     time.Time
	// Lo último que han medido las sondas del motor (clone3 y, con WSL2, su
	// puerta de enlace), de qué motor (tipo, versión y modo) y cuándo;
	// intento: la última vez que se probó, salga o no.
	sondeo struct {
		clone3          *motor.Hecho
		puerta          string
		de              string
		cuando, intento time.Time
	}
	// Lo último que ha medido la sonda de puertos de la máquina (ver
	// sondearAnfitrion), con los puertos que publican sus trampas.
	anfitrion struct {
		a       *motor.Anfitrion
		propios map[string]bool
		intento time.Time
	}
	// Fallo general del motor en el último despliegue: lo mira el punto de salud.
	falloMotor atomic.Pointer[docker.ErrMotor]
}

// servirSalud responde 200 mientras el sensor siga hablando con su consola
// y con su motor de contenedores. Es lo que mira el actualizador tras
// cambiar la imagen del sensor, y compose al instalar (up --wait).
func (s *sensor) servirSalud(dir string) {
	http.HandleFunc("/salud", s.salud)
	srv := &http.Server{Addr: dir, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("punto de salud", "err", err)
	}
}

func (s *sensor) salud(w http.ResponseWriter, _ *http.Request) {
	if time.Since(time.Unix(s.ultimoPlan.Load(), 0)) > 3*cadaPlan {
		http.Error(w, "sin plan reciente de la consola", http.StatusServiceUnavailable)
		return
	}
	if f := s.falloMotor.Load(); f != nil {
		http.Error(w, "sin motor de contenedores: "+f.Error(), http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("ok\n"))
}

func (s *sensor) correr(ctx context.Context) {
	proximoPlan, proximaPoda, proximaCuota := time.Time{}, time.Now().Add(cadaPoda), time.Time{}
	reloj := time.NewTicker(cadaLectura)
	defer reloj.Stop()
	for {
		if time.Now().After(proximoPlan) {
			s.actualizarPlan(ctx)
			proximoPlan = time.Now().Add(cadaPlan)
		}
		s.leer()
		s.entregar(ctx)
		if time.Now().After(proximaCuota) {
			s.vigilarCuota(time.Now())
			proximaCuota = time.Now().Add(cadaCuota)
		}
		if time.Now().After(proximaPoda) {
			s.podar(time.Now())
			s.guardar()
			proximaPoda = time.Now().Add(cadaPoda)
		}
		select {
		case <-ctx.Done():
			slog.Info("sensor parado")
			return
		case <-reloj.C:
		}
	}
}

func (s *sensor) actualizarPlan(ctx context.Context) {
	p, err := s.consola.Plan(ctx)
	if err != nil {
		slog.Warn("no se pudo pedir el plan; sigo con el anterior", "err", err)
		return
	}
	// Sin estado local, la cadena sigue desde lo último que la consola aceptó.
	if s.estado.UltimoHash == "" {
		s.estado.UltimoHash = p.UltimoHash
		s.guardar()
	}
	for _, d := range p.Descartados {
		slog.Debug("trampa fuera del plan", "id", d.ID, "motivo", d.Motivo)
	}
	// Hay plan: el sensor habla con su consola aunque desplegar tarde.
	s.ultimoPlan.Store(time.Now().Unix())
	s.olvidarParadasRetiradas(p)
	// Un puerto que la máquina ya tiene en una dirección local (el resolvedor
	// de Ubuntu en 127.0.0.53:53) se publica en su IP de red, no en 0.0.0.0.
	s.opc.EnLaRed = s.anfitrion.a.PublicarEn
	estados, err := despliegue.Aplicar(ctx, s.docker, s.opc, p)
	if err != nil {
		slog.Error("despliegue", "err", err)
	}
	s.describirMotor(ctx, p.Sensor, err)
	s.sondearAnfitrion(ctx, p.Sensor, estados)
	if estados == nil {
		// Nunca null: la consola lo rechazaría y no sabría nada del sensor.
		estados = []despliegue.Estado{}
	}
	if err := s.consola.Informar(ctx, estados, s.motor, s.hechos()); err != nil {
		slog.Warn("no se pudo informar del estado", "err", err)
	}
	s.muPlan.Lock()
	s.plan = &p
	s.muPlan.Unlock()
	s.ultimoPlan.Store(time.Now().Unix())
	// Hallazgo N3 de la re-revisión: una trampa que sale del plan suelta su IP
	// (y su MAC) — el registro no conserva IP de trampas que ya no existen y
	// una trampa reinstalada vuelve a sondear en vez de heredar la vieja sin
	// más.
	quedanIP := make(map[string]bool, len(p.Trampas))
	for _, sp := range p.Trampas {
		quedanIP[sp.ID] = true
	}
	despliegue.SoltarIPsFuera(quedanIP)
	// Las IP propias nuevas, apuntadas al vigilante ARP (docs/diseno/red.md §3).
	if s.apuntarIP != nil {
		for _, ip := range despliegue.IPsPropias() {
			if a, err := netip.ParseAddr(ip); err == nil {
				s.vigilar(a)
			}
		}
	}
}

// describirMotor pone al día lo que se sabe del motor tras un despliegue. Un
// fallo general (errAplicar es un *docker.ErrMotor) se informa tal cual y
// deja al sensor sin salud; lo último bueno se sigue usando para decidir si
// una IP es la del motor (las trampas en marcha siguen escribiendo).
func (s *sensor) describirMotor(ctx context.Context, id string, errAplicar error) {
	var fallo *docker.ErrMotor
	if errors.As(errAplicar, &fallo) {
		s.falloMotor.Store(fallo)
		s.motor, s.motorCuando = motor.Fallo(fallo), time.Time{}
		return
	}
	s.falloMotor.Store(nil)
	if s.motor.Codigo != "" || time.Since(s.motorCuando) > cadaMotor {
		s.motor, s.motorCuando = motor.Describir(ctx, s.docker, despliegue.Redes()), time.Now()
	} else {
		// Una red de trampas se puede rehacer: sus pasarelas se miran siempre.
		s.motor.Pasarelas = motor.Pasarelas(ctx, s.docker, despliegue.Redes())
	}
	if s.motor.Codigo == "" {
		s.sondearMotor(ctx, id)
		if s.motor.Modo == motor.ModoWSL {
			s.motor.PuertaEnlace = s.sondeo.puerta
		}
		s.conocido = s.motor
	}
}

// sondearMotor mide con sus sondas lo que el motor no dice de sí mismo. Sin la
// imagen del sensor no hay sonda, y lo que no se mide no se informa. Una
// sonda que falla se reintenta, pero no más de una vez cada cadaMotor.
func (s *sensor) sondearMotor(ctx context.Context, id string) {
	de := s.motor.Tipo + " " + s.motor.Version + " " + s.motor.Modo
	if s.opc.ImagenSonda == "" || id == "" || (s.sondeo.de == de && time.Since(s.sondeo.cuando) < cadaSondeo) ||
		time.Since(s.sondeo.intento) < cadaMotor {
		return
	}
	s.sondeo.intento = time.Now()
	todo := true
	if h, err := motor.Clone3(ctx, s.docker, s.opc.ImagenSonda, id); err == nil {
		s.sondeo.clone3 = h
	} else {
		slog.Warn("no se pudo medir clone3 en el motor", "err", err)
		todo = false
	}
	if s.motor.Modo == motor.ModoWSL {
		if p, err := motor.PuertaEnlace(ctx, s.docker, s.opc.ImagenSonda, id); err == nil {
			s.sondeo.puerta = p
		} else {
			slog.Warn("no se pudo medir la puerta de enlace de WSL", "err", err)
			todo = false
		}
	}
	if todo {
		s.sondeo.de, s.sondeo.cuando = de, time.Now()
	}
}

// hechos que el sensor sabe de su máquina, con su motivo, solo los que ya
// se saben: red.ipOrigenReal, motor.clone3 y red.capa2 (docs/diseno/red.md
// §2.1: si esta máquina puede poner trampas con IP propia en el segmento).
func (s *sensor) hechos() map[string]any {
	h := map[string]any{}
	if o := motor.HechoOrigen(s.conocido, s.estado.OrigenReal, s.estado.OrigenOculto); o != nil {
		h["red.ipOrigenReal"] = o
	}
	if s.sondeo.clone3 != nil {
		h["motor.clone3"] = s.sondeo.clone3
	}
	if a := s.anfitrion.a; a != nil {
		h["puertos.ocupados"] = map[string]any{"valor": a.Ocupados(s.anfitrion.propios)}
		if len(a.Direcciones) > 0 {
			h["red.direcciones"] = map[string]any{"valor": a.Direcciones}
		}
	}
	if s.opc.RedPropia != nil && s.opc.RedPropia.Puente == "" {
		if c := red.Capa2(red.Opciones{Interfaz: s.opc.RedPropia.Interfaz, Rango: s.opc.RedPropia.Rango.String()}); c != nil {
			h["red.capa2"] = c
		}
	}
	return h
}

// redPropiaDeArranque valida el modo «IP propia» al arrancar (hallazgo 10 de
// la revisión): -enlace y -rango JUNTOS, y el rango un CIDR IPv4 de /8 a
// /30 — la MISMA regla que red.Rangos aplica luego a red.capturar y que el
// reparto de IP exige. Antes solo se miraba «/30 o menos»: un /7 arrancaba
// y el sensor acababa informando red.capa2 = false con «el rango no se
// entiende», en vez de rechazarse aquí con el motivo bueno.
func redPropiaDeArranque(enlace, rango string) (*despliegue.RedPropia, error) {
	p, err := netip.ParsePrefix(rango)
	if enlace == "" || rango == "" || err != nil || !p.Addr().Is4() || p.Bits() < 8 || p.Bits() > 30 {
		return nil, fmt.Errorf("quiere -enlace y -rango juntos, con un CIDR IPv4 reservado de /8 a /30 (p. ej. -enlace eth0 -rango 10.0.0.240/28)")
	}
	return &despliegue.RedPropia{Interfaz: enlace, Rango: p}, nil
}

// montarVigilante enciende el vigilante ARP del modo «IP propia» (RFC 5227
// desde el lado del defensor): escucha en la interfaz física, con su propio
// enchufe crudo y filtro de solo-ARP, y avisa cuando otro equipo reclama
// una IP que una trampa tenía como propia. El enchufe crudo es del sensor
// (raíz del anfitrión), no de las trampas: ellas no ven más ARP que el que
// su propio BPF deja pasar (docs/diseno/red.md §3 y «por qué es seguro»).
//
// Sin NET_RAW en el anfitrión o en una máquina sin AF_PACKET, no hay
// vigilante y no pasa nada: el sondeo previo de cada IP y los anuncios de
// IP ajena que apuntan las propias trampas cubren lo esencial.
func (s *sensor) montarVigilante(ctx context.Context) {
	reclamos := make(chan red.Reclamo, 4)
	// macPropia descarta, además de lo saliente, el ARP cuya MAC fuente sea
	// de una trampa de este sensor (hallazgo 1): aunque una trama de una
	// trampa propia volviera marcada como entrante (eco del conmutador,
	// espejo), no es reclamo de nadie. Sin esa defensa, el vigilante se
	// mata a sí mismo en cuanto una trampa propia contesta un ARP.
	apuntar, err := red.Vigilar(ctx, s.opc.RedPropia.Interfaz, despliegue.EsMACDeTrampaBytes, reclamos)
	if err != nil {
		slog.Warn("sin vigilante ARP: el sondeo previo de cada IP propia sigue protegiendo", "err", err)
		return
	}
	s.apuntarIP, s.vigiladas = apuntar, map[string]bool{}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case r := <-reclamos:
				id, de := despliegue.TrampaDeIP(r.IP)
				if !de {
					continue
				}
				// Se suelta la IP y se para la trampa: la siguiente vuelta
				// del plan le da otra del rango (sondeada). No se sigue en
				// el segmento pisando a un equipo de verdad del cliente.
				despliegue.SoltarIP(id)
				s.olvidarVigilada(r.IP)
				if s.pararTrampa != nil {
					if err := s.pararTrampa(id); err != nil {
						slog.Error("no se pudo parar la trampa con la IP reclamada", "err", err)
					}
				}
				slog.Warn("otro equipo reclamó la IP propia de una trampa", "trampa", id, "ip", r.IP, "mac", r.MAC)
			}
		}
	}()
}

// vigilar apunta una IP propia al vigilante ARP, sin repetirla. Con su
// candado: vigiladas lo tocan también la goroutina del vigilante (cuando
// un reclamo llega, la IP deja de estar vigilada) — sin candado era la
// carrera de la revisión, y go test -race la caza enseguida.
func (s *sensor) vigilar(ip netip.Addr) {
	s.muVigiladas.Lock()
	defer s.muVigiladas.Unlock()
	if s.vigiladas[ip.String()] {
		return
	}
	s.apuntarIP(ip)
	s.vigiladas[ip.String()] = true
}

// olvidarVigilada quita una IP de las vigiladas (otro equipo la reclamó):
// la siguiente vuelta, si vuelve a tocararle, se apunta otra vez.
func (s *sensor) olvidarVigilada(ip string) {
	s.muVigiladas.Lock()
	defer s.muVigiladas.Unlock()
	delete(s.vigiladas, ip)
}

// origen apunta si la IP de un evento es la del atacante o la del motor y,
// si es la del motor y la consola lo admite, lo marca en el evento.
func (s *sensor) origen(e *evento.Evento) {
	if e.Origen.IP == "" {
		return
	}
	cuando, err := time.Parse(time.RFC3339Nano, e.Cuando)
	if err != nil {
		cuando = time.Now()
	}
	if !s.conocido.Oculta(e.Origen.IP) {
		if cuando.After(s.estado.OrigenReal) {
			s.estado.OrigenReal = cuando
		}
		return
	}
	if cuando.After(s.estado.OrigenOculto) {
		s.estado.OrigenOculto = cuando
	}
	// Una consola anterior a la 0.13.1 no conoce el campo y apartaría el
	// evento a la cuarentena: solo se marca si el plan dice que lo admite.
	e.Origen.Oculta = s.plan.Acepta(plan.OrigenOculta)
}

// leer pasa lo nuevo de cada registro a la cola de salida. Primero se escribe
// la cola y después se avanza el offset: si se corta entre medias, un evento
// se puede repetir, pero nunca perder. Con la cola en su tope, lo nuevo se
// descarta y se resume (ver cola.go), pero la lectura sigue.
func (s *sensor) leer() {
	if s.plan == nil {
		return
	}
	cadena := evento.NuevaCadena(s.estado.UltimoHash)
	ritmo := s.ritmo.copia()
	cola := s.abrirCola()
	var nuevas [][]byte
	// Lo de esta vuelta que entra en la cola (sin los resúmenes de lo
	// descartado) y lo que no cabe: si no queda disco para escribirla, todo
	// ello se descarta.
	type encolado struct {
		e evento.Evento
		n int
	}
	var encolados, fuera []encolado
	encolar := func(x evento.Evento) {
		antes := cadena.Ultimo()
		linea, err := cadena.Emitir(x)
		if err != nil {
			slog.Error("no se pudo serializar", "err", err)
			return
		}
		if !cola.cabe(len(linea)) {
			// Fuera de la cola y de la cadena: la consola no verá un hueco.
			cadena = evento.NuevaCadena(antes)
			cola.descartar(x, len(linea), false)
			fuera = append(fuera, encolado{x, len(linea)})
			return
		}
		nuevas = append(nuevas, linea)
		encolados = append(encolados, encolado{x, len(linea)})
	}
	// Primero, el resumen de lo descartado con la cola llena, si ya cabe.
	var resumidas []string
	for _, id := range cola.pendientes() {
		antes := cadena.Ultimo()
		linea, err := cadena.Emitir(cola.resumen(s.plan.Sensor, id))
		if err != nil || !cola.cabeResumen(id, len(linea)) {
			cadena = evento.NuevaCadena(antes)
			break
		}
		nuevas = append(nuevas, linea)
		resumidas = append(resumidas, id)
	}
	posiciones := map[string]seguidor.Posicion{}
	leyendo := map[string]bool{}
	for _, sp := range s.plan.Trampas {
		ruta := filepath.Join(despliegue.Registros(s.opc, sp.ID), sp.Manifiesto.Eventos.Fuente.Ruta)
		antes := seguidor.Posicion{Inodo: s.estado.Inodos[sp.ID], Offset: s.estado.Leido[sp.ID], Huella: s.estado.Huellas[sp.ID], Modif: s.estado.Modifs[sp.ID]}
		lineas, pos, aviso, err := seguidor.Seguir(ruta, antes)
		if err != nil {
			slog.Warn("registro ilegible", "trampa", sp.ID, "err", err)
			continue
		}
		if aviso != "" {
			slog.Warn(aviso, "trampa", sp.ID)
		}
		posiciones[sp.ID] = pos
		leyendo[sp.ID] = len(lineas) > 0
		for _, l := range lineas {
			e, err := adaptador.Adaptar(s.plan.Sensor, sp, l)
			if errors.Is(err, adaptador.ErrIgnorada) {
				continue
			}
			if err != nil {
				slog.Warn("línea no traducible", "trampa", sp.ID, "err", err)
				continue
			}
			s.origen(&e)
			pasa, resumen := ritmo.pasa(s.plan.Sensor, sp, e)
			if resumen != nil {
				encolar(*resumen)
			}
			if pasa {
				encolar(e)
			}
		}
	}
	for _, x := range ritmo.vencidos(s.plan.Sensor, time.Now(), leyendo) {
		encolar(x)
	}
	if len(posiciones) == 0 && len(nuevas) == 0 {
		return
	}
	sinDisco := false
	if len(nuevas) > 0 {
		if err := anadirACola(s.salida, cola.inicio, nuevas); err != nil {
			if !discoLleno(err) {
				slog.Error("cola de salida", "err", err)
				return
			}
			// Sin disco, lo de esta vuelta se descarta y se resume como con la
			// cola llena; los resúmenes pendientes se quedan para otra vuelta.
			sinDisco = true
			if len(s.descartes) == 0 {
				slog.Error("cola de salida: no queda disco; se descartan los eventos nuevos hasta que lo haya; irá un resumen",
					"codigo", adaptador.CodigoColaSinDisco, "err", err)
			}
			cola.descartes, nuevas, resumidas = s.descartes.copia(), nil, nil
			cadena = evento.NuevaCadena(s.estado.UltimoHash)
			for _, x := range encolados {
				cola.descartar(x.e, x.n, true)
			}
			for _, x := range fuera {
				cola.descartar(x.e, x.n, false)
			}
		} else {
			slog.Info("eventos nuevos", "n", len(nuevas))
		}
	}
	if len(resumidas) > 0 {
		slog.Info("resumen de lo descartado con la cola llena, ya en la cola", "trampas", resumidas)
	}
	if len(s.descartes) == 0 && len(cola.descartes) > 0 && !sinDisco {
		if cola.porDisco {
			slog.Warn("cola de salida llena: queda poco disco libre y su tope es pequeño; se descartan los eventos nuevos hasta que haya sitio; irá un resumen",
				"codigo", adaptador.CodigoColaPocoDisco, "tope", cola.tope)
		} else {
			slog.Warn("cola de salida llena: se descartan los eventos nuevos hasta que la consola los recoja; irá un resumen",
				"codigo", adaptador.CodigoColaLlena, "tope", cola.tope)
		}
	}
	s.ritmo = ritmo
	s.estado.Ritmo, _ = json.Marshal(ritmo.pendientes())
	s.descartes = cola.descartes
	s.estado.Descartados = nil
	if len(cola.descartes) > 0 {
		s.estado.Descartados, _ = json.Marshal(cola.descartes)
	}
	// La posición entera, aunque no haya líneas: puede haber acabado un
	// rotado o saltado un trozo.
	for id, p := range posiciones {
		s.estado.Leido[id], s.estado.Inodos[id], s.estado.Huellas[id], s.estado.Modifs[id] = p.Offset, p.Inodo, p.Huella, p.Modif
	}
	s.estado.UltimoHash = cadena.Ultimo()
	s.guardar()
}

func (s *sensor) entregar(ctx context.Context) {
	if time.Now().Before(s.pausa) {
		return
	}
	// Más corta que lo entregado: la han vaciado o cambiado por fuera. Se
	// vuelve a mandar entera (la consola da por repetido lo que ya tenga).
	if fi, err := os.Stat(s.salida); err == nil && fi.Size() < s.estado.Entregado {
		slog.Warn("la cola de salida es más corta que lo entregado; se vuelve a mandar desde el principio")
		s.estado.Entregado = 0
	}
	lineas, _, err := seguidor.Leer(s.salida, s.estado.Entregado)
	if err != nil {
		return
	}
	if len(lineas) == 0 {
		// Nada nuevo que entregar, pero puede tocar vaciarla: si llegó a su
		// tope después de la última entrega, sin vaciarla no volvería a entrar
		// nada, ni el resumen de lo descartado.
		s.vaciarCola()
		return
	}
	if s.lote <= 0 {
		s.lote = porEntrega
	}
	lineas = loteDe(lineas, s.lote, bytesPorEntrega)
	r, err := s.consola.Entregar(ctx, lineas)
	if errors.Is(err, consola.ErrDemasiadoGrande) && len(lineas) > 1 {
		s.lote = len(lineas) / 2
		slog.Warn("la consola no admite una entrega tan grande; se parte", "lineas", s.lote)
		return
	}
	if err != nil {
		slog.Warn("entrega fallida; reintento", "err", err)
		s.consolaRecoge = false
		s.pausa = time.Now().Add(5 * time.Second)
		return
	}
	s.consolaRecoge = r.OK
	s.lote = porEntrega
	for _, l := range lineas[:r.Aceptadas] {
		s.estado.Entregado += int64(len(l)) + 1
	}
	s.guardar()
	s.vaciarCola()
	if !r.OK {
		// No se arregla reintentando: la consola ha visto una cadena que no cuadra.
		slog.Error("la consola rechaza la cadena", "linea", r.Linea, "motivo", r.Motivo)
		s.pausa = time.Now().Add(time.Minute)
	}
}

// escuchar acepta conexiones durante un rato y sale: la mitad que escucha de
// la sonda del aislamiento.
func escuchar(dir string, durante time.Duration) int {
	l, err := net.Listen("tcp", dir)
	if err != nil {
		return 1
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	time.Sleep(durante)
	return 0
}

// sondear sale con 0 si llega a dir y con 1 si no. Una conexión rechazada
// también cuenta como que llega (el paquete llegó al otro lado; puede que
// aún no escuche): con el aislamiento de Docker los paquetes se descartan y
// lo que se ve es un tiempo de espera agotado.
func sondear(dir string) int {
	rechazada := false
	for i := 0; i < 5; i++ {
		c, err := net.DialTimeout("tcp", dir, 2*time.Second)
		if err == nil {
			c.Close()
			return 0
		}
		if errors.Is(err, syscall.ECONNREFUSED) {
			rechazada = true
			time.Sleep(300 * time.Millisecond)
			continue
		}
		break
	}
	if rechazada {
		return 0
	}
	return 1
}

// vaciarCola vacía la cola de salida cuando la consola ya lo tiene todo: si
// no, crecería sin fin en la máquina del cliente. Primero se guarda el estado
// (entregado = 0) y después se vacía: si se corta entre medias, la consola
// recibe otra vez esas líneas y las da por repetidas, pero no se pierde nada.
//
// Con descartes sin resumir (la cola llegó a su tope) se vacía aunque sea
// pequeña: su resumen tiene que entrar.
func (s *sensor) vaciarCola() {
	fi, err := os.Stat(s.salida)
	if err != nil || fi.Size() == 0 || s.estado.Entregado != fi.Size() || (fi.Size() < vaciarDesde && len(s.descartes) == 0) {
		return
	}
	s.estado.Entregado = 0
	if err := s.estado.Guardar(s.opc.Datos); err != nil {
		slog.Error("no se pudo guardar el estado; la cola no se vacía", "err", err)
		s.estado.Entregado = fi.Size()
		return
	}
	if err := os.Truncate(s.salida, 0); err != nil {
		slog.Error("no se pudo vaciar la cola de salida", "err", err)
	}
}

// podar quita del disco del cliente lo que ya no hace falta: los registros
// rotados de cada trampa, ya leídos, con más de una semana, y las carpetas de
// las trampas retiradas que llevan un mes sin escribirse.
func (s *sensor) podar(ahora time.Time) {
	if s.plan == nil {
		return
	}
	activas := map[string]bool{}
	for _, sp := range s.plan.Trampas {
		activas[sp.ID] = true
		s.podarTrampa(sp, ahora)
	}
	for _, sub := range []string{"registros", "config"} {
		entradas, _ := os.ReadDir(filepath.Join(s.opc.Datos, sub))
		for _, e := range entradas {
			if activas[e.Name()] || !e.IsDir() {
				continue
			}
			dir := filepath.Join(s.opc.Datos, sub, e.Name())
			if ahora.Sub(ultimaEscritura(dir)) < guardarRetiradas {
				continue
			}
			if err := os.RemoveAll(dir); err == nil {
				slog.Info("carpeta de una trampa retirada borrada", "carpeta", dir)
				delete(s.estado.Leido, e.Name())
				delete(s.estado.Inodos, e.Name())
				delete(s.estado.Huellas, e.Name())
				delete(s.estado.Modifs, e.Name())
			}
		}
	}
}

// podarTrampa borra los registros rotados ya leídos de una trampa con más de
// una semana, o los más antiguos si su carpeta pasa de la cuota. Si aun así
// pasa (un honeypot sin tope propio que llena su registro activo), libera lo
// ya leído del activo, que ya está en la cola de salida; si no se puede, para
// la trampa (ver cuota.go). Devuelve lo que ocupa la carpeta al acabar.
func (s *sensor) podarTrampa(sp plan.TrampaPlan, ahora time.Time) int64 {
	dir := despliegue.Registros(s.opc, sp.ID)
	base := filepath.Base(sp.Manifiesto.Eventos.Fuente.Ruta)
	entradas, _ := os.ReadDir(dir)
	// El sensor puede ir por un rotado a medias (estuvo parado): solo los
	// rotados más antiguos que el que se está leyendo están ya leídos.
	leyendo := time.Time{}
	for _, e := range entradas {
		if fi, err := e.Info(); err == nil && seguidor.InodoDe(fi) == s.estado.Inodos[sp.ID] {
			leyendo = fi.ModTime()
		}
	}
	// Rotados ya leídos, de antiguo a nuevo, y lo que ocupa la carpeta.
	type rotado struct {
		nombre string
		tam    int64
		modif  time.Time
	}
	var leidos []rotado
	var total int64
	for _, e := range entradas {
		fi, err := e.Info()
		if err != nil || !e.Type().IsRegular() {
			continue
		}
		total += ocupado(fi)
		if e.Name() == base || !strings.HasPrefix(e.Name(), base) || seguidor.InodoDe(fi) == s.estado.Inodos[sp.ID] ||
			leyendo.IsZero() || !fi.ModTime().Before(leyendo) {
			continue
		}
		leidos = append(leidos, rotado{e.Name(), ocupado(fi), fi.ModTime()})
	}
	sort.Slice(leidos, func(i, j int) bool { return leidos[i].modif.Before(leidos[j].modif) })
	for _, r := range leidos {
		// Se guardan una semana, salvo que la carpeta pase de su cuota: un
		// honeypot atacado sin parar no llena el disco del cliente.
		if ahora.Sub(r.modif) < guardarRotados && total <= cuotaRegistros {
			continue
		}
		if err := os.Remove(filepath.Join(dir, r.nombre)); err == nil {
			total -= r.tam
			slog.Info("registro rotado retirado", "trampa", sp.ID, "fichero", r.nombre)
		}
	}
	if total <= cuotaRegistros {
		return total
	}
	if _, parada := s.estado.Paradas[sp.ID]; parada {
		// Ya está parada por su cuota: la deja volver reanudar.
		return total
	}
	// Aún por encima: se libera lo ya leído del registro activo, aunque el
	// honeypot siga escribiendo (lo leído ya está en la cola de salida). Si no
	// se puede, la trampa se para antes de que llene el disco (ver cuota.go).
	activo := filepath.Join(dir, base)
	fi, err := os.Lstat(activo)
	if err == nil && fi.Mode().IsRegular() && seguidor.InodoDe(fi) == s.estado.Inodos[sp.ID] {
		antes := ocupado(fi)
		if err := perforar(activo, s.estado.Leido[sp.ID]); err != nil {
			s.pararPorCuota(sp, err)
			return total
		}
		if fi2, err := os.Lstat(activo); err == nil {
			total -= antes - ocupado(fi2)
			slog.Warn("registro de la trampa: liberado lo ya leído, pasaba de su cuota", "trampa", sp.ID, "bytes", antes-ocupado(fi2))
		}
	}
	if total > cuotaRegistros {
		slog.Warn("los registros de la trampa pasan de su cuota con lo que queda por leer", "trampa", sp.ID, "bytes", total)
	}
	return total
}

// cuotaRegistros: lo que puede ocupar en disco la carpeta de registros de
// una trampa (variable para las pruebas).
var cuotaRegistros int64 = 512 << 20

// vigilarCuota mira la cuota de cada trampa a menudo (no solo en la poda de
// cada hora): un honeypot atacado sin parar puede escribir gigas en una hora.
// Las paradas por su cuota, las deja volver en cuanto caben.
func (s *sensor) vigilarCuota(ahora time.Time) {
	if s.plan == nil {
		return
	}
	for _, sp := range s.plan.Trampas {
		if _, parada := s.estado.Paradas[sp.ID]; parada {
			s.reanudar(sp, ahora)
			continue
		}
		var total int64
		entradas, _ := os.ReadDir(despliegue.Registros(s.opc, sp.ID))
		for _, e := range entradas {
			if fi, err := e.Info(); err == nil && e.Type().IsRegular() {
				total += ocupado(fi)
			}
		}
		if total > cuotaRegistros {
			s.podarTrampa(sp, ahora)
		}
	}
}

// olvidarParadasRetiradas quita de las paradas por su cuota las trampas que
// ya no están en el plan: retirarlas es cosa del despliegue.
func (s *sensor) olvidarParadasRetiradas(p plan.Plan) {
	enPlan := map[string]bool{}
	for _, t := range p.Trampas {
		enPlan[t.ID] = true
	}
	cambio := false
	for id := range s.estado.Paradas {
		if !enPlan[id] {
			delete(s.estado.Paradas, id)
			cambio = true
		}
	}
	if cambio {
		s.guardar()
	}
}

// ultimaEscritura es la fecha del fichero más reciente de la carpeta: la de
// la carpeta no cambia cuando se escribe en un fichero que ya existía.
func ultimaEscritura(dir string) time.Time {
	ultima := time.Time{}
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if fi, err := d.Info(); err == nil && fi.ModTime().After(ultima) {
			ultima = fi.ModTime()
		}
		return nil
	})
	return ultima
}

func (s *sensor) guardar() {
	if err := s.estado.Guardar(s.opc.Datos); err != nil {
		slog.Error("no se pudo guardar el estado", "err", err)
	}
}

// retomarCadena deja la cola de salida y el estado de acuerdo al arrancar.
// Si el sensor se apagó a mitad de escribir, la cola puede acabar en media
// línea: se recorta, o se pegaría a la siguiente. Y si se apagó entre
// escribir la cola y guardar el estado, el estado no sabe de las últimas
// líneas: la cadena sigue desde la última escrita, que es la que la consola
// recibirá, y no desde la que recuerda el estado (eso sería una ruptura falsa).
func (s *sensor) retomarCadena() error {
	f, err := os.OpenFile(s.salida, os.O_RDWR, 0o600)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	ultima, completa, err := ultimaLinea(f)
	if err != nil {
		return err
	}
	if completa >= 0 {
		fi, err := f.Stat()
		if err != nil {
			return err
		}
		if completa < fi.Size() {
			slog.Warn("cola de salida acabada en media línea; se recorta", "bytes", fi.Size()-completa)
			if err := f.Truncate(completa); err != nil {
				return err
			}
			if err := f.Sync(); err != nil {
				return err
			}
		}
	}
	if ultima == nil {
		return nil
	}
	if h := evento.Hash(ultima); h != s.estado.UltimoHash {
		slog.Warn("el estado iba por detrás de la cola de salida; la cadena sigue desde la última línea escrita")
		s.estado.UltimoHash = h
		if s.estado.Entregado > completa {
			s.estado.Entregado = completa
		}
		s.guardar()
	}
	return nil
}

// ultimaLinea devuelve la última línea completa (terminada en \n) del
// fichero y dónde acaba (contando su \n). Sin ninguna completa: nil y 0.
// Lee hacia atrás a trozos: la cola puede ser grande.
func ultimaLinea(f *os.File) ([]byte, int64, error) {
	fi, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	const trozo = 64 * 1024
	var cola []byte
	fin := fi.Size()
	for pos := fin; pos > 0; {
		n := int64(trozo)
		if pos < n {
			n = pos
		}
		pos -= n
		b := make([]byte, n)
		if _, err := f.ReadAt(b, pos); err != nil {
			return nil, 0, err
		}
		cola = append(b, cola...)
		// Hace falta ver el \n que cierra la última línea completa y el que la abre.
		ultimoNL := bytes.LastIndexByte(cola, '\n')
		if ultimoNL < 0 {
			continue
		}
		completa := pos + int64(ultimoNL) + 1
		inicio := bytes.LastIndexByte(cola[:ultimoNL], '\n')
		if inicio >= 0 || pos == 0 {
			return cola[inicio+1 : ultimoNL], completa, nil
		}
	}
	return nil, 0, nil
}

// loteDe toma de la cabeza de la cola como mucho n líneas y b bytes, y
// siempre al menos una: una línea sola nunca se queda sin entregar.
func loteDe(lineas [][]byte, n, b int) [][]byte {
	if len(lineas) > n {
		lineas = lineas[:n]
	}
	total := 0
	for i, l := range lineas {
		total += len(l) + 1
		if total > b && i > 0 {
			return lineas[:i]
		}
	}
	return lineas
}

// relevar comprueba cada 5 minutos si toca pasar el nodo 0.11 a la
// configuración firmada (ver el paquete relevo). Nunca tumba al sensor.
func (s *sensor) relevar(ctx context.Context, r *relevo.Relevo) {
	if version == "dev" {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Minute):
		}
		// Solo con un plan reciente: la consola está viva y nos conoce.
		if time.Since(time.Unix(s.ultimoPlan.Load(), 0)) > 3*cadaPlan {
			continue
		}
		func() {
			defer func() {
				if p := recover(); p != nil {
					slog.Error("relevo", "panico", p)
				}
			}()
			if err := r.Intentar(ctx); err != nil {
				slog.Warn("relevo", "err", err)
			}
		}()
	}
}
