package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

const pasarelaPrueba = "172.19.0.1"

func motorRootful() motor.Descripcion {
	return motor.Descripcion{Modo: motor.ModoRootful, Pasarelas: []string{pasarelaPrueba}}
}

func TestEsPropio(t *testing.T) {
	direcciones := []string{"10.0.0.5", "192.168.1.9"}
	casos := []struct {
		nombre string
		ip     string
		dirs   []string
		d      motor.Descripcion
		quiere bool
	}{
		{"una dirección de la máquina", "10.0.0.5", direcciones, motorRootful(), true},
		{"otra dirección de la máquina", "192.168.1.9", direcciones, motorRootful(), true},
		{"escrita como IPv6", "::ffff:10.0.0.5", direcciones, motorRootful(), true},
		{"otro equipo de la misma red", "10.0.0.6", direcciones, motorRootful(), false},
		{"internet", "203.0.113.7", direcciones, motorRootful(), false},
		{"sin IP", "", direcciones, motorRootful(), false},
		{"algo que no es una IP", "fulano", direcciones, motorRootful(), false},
		{"sin direcciones medidas", "10.0.0.5", nil, motorRootful(), false},

		// Con la IP del motor puede llegar cualquiera: nunca se da por propia.
		{"la pasarela", pasarelaPrueba, direcciones, motorRootful(), false},
		{"una dirección local", "127.0.0.1", direcciones, motorRootful(), false},
		{"una dirección local en IPv6", "::1", direcciones, motorRootful(), false},
		{
			"la pasarela aunque la sonda la dé como de la máquina",
			pasarelaPrueba, []string{pasarelaPrueba}, motorRootful(), false,
		},

		// El motor enseña direcciones que no son de quien se conecta.
		{"sin root", "10.0.0.5", direcciones, motor.Descripcion{Modo: motor.ModoRootless}, false},
		{"Docker Desktop", "10.0.0.5", direcciones, motor.Descripcion{Modo: motor.ModoDesktop}, false},
		{"WSL", "10.0.0.5", direcciones, motor.Descripcion{Modo: motor.ModoWSL, PuertaEnlace: "10.9.9.9"}, false},
		{"sin saber aún qué motor es", "10.0.0.5", direcciones, motor.Descripcion{}, false},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			if got := esPropio(c.ip, c.dirs, c.d); got != c.quiere {
				t.Fatalf("esPropio(%q) = %v", c.ip, got)
			}
		})
	}
}

func deIP(ip string) evento.Evento {
	return evento.Evento{Origen: evento.Origen{IP: ip}, Cuando: time.Now().UTC().Format(time.RFC3339Nano)}
}

func trampaPropia(id string) plan.TrampaPlan {
	var sp plan.TrampaPlan
	sp.ID = id
	return sp
}

// Un sensor con 10.0.0.5 como dirección de la máquina, recién medida.
func sensorPropio(ignorar bool, siempre ...string) *sensor {
	s := &sensor{
		estado:   &estado.Estado{OrigenReal: time.Now()},
		plan:     &plan.Plan{IgnorarPropio: ignorar, RegistrarSiempre: siempre},
		conocido: motorRootful(),
	}
	s.anfitrion.a = &motor.Anfitrion{Direcciones: []string{"10.0.0.5"}}
	s.anfitrion.medido = time.Now()
	return s
}

func TestIgnorarPropio(t *testing.T) {
	t1 := trampaPropia("t1")

	if !sensorPropio(true).ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("lo de su dirección de red no se registra si lo pide la consola")
	}
	if sensorPropio(true).ignorarPropio(t1, deIP(pasarelaPrueba)) {
		t.Error("con la IP del motor puede llegar cualquiera: se registra")
	}
	if sensorPropio(true).ignorarPropio(t1, deIP("203.0.113.7")) {
		t.Error("lo de fuera se registra siempre")
	}
	if sensorPropio(false).ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("con el interruptor encendido se registra")
	}
	if sensorPropio(true, "t1").ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("una trampa de RegistrarSiempre registra lo suyo")
	}
	if !sensorPropio(true, "otra").ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("lo de otra trampa no cuenta para esta")
	}

	toque := deIP("10.0.0.5")
	toque.Detalle = map[string]any{campoToque: "abc12345"}
	if sensorPropio(true).ignorarPropio(t1, toque) {
		t.Error("el toque de «Prueba mi detección» se registra siempre")
	}

	delCuerpo := deIP("10.0.0.5")
	delCuerpo.Detalle = map[string]any{campoIPSocket: "203.0.113.7"}
	if sensorPropio(true).ignorarPropio(t1, delCuerpo) {
		t.Error("la IP que dice el cuerpo de un aviso no es de quien se ha conectado")
	}

	resumen := deIP("10.0.0.5")
	resumen.Detalle = map[string]any{campoIPsDistintas: 12}
	if sensorPropio(true).ignorarPropio(t1, resumen) {
		t.Error("un resumen de rechazos cuenta las de todas las IP, aunque nombre la de esta máquina")
	}

	antiguo := deIP("10.0.0.5")
	antiguo.Cuando = time.Now().Add(-vidaDirecciones - time.Minute).UTC().Format(time.RFC3339Nano)
	if sensorPropio(true).ignorarPropio(t1, antiguo) {
		t.Error("entonces esa dirección pudo ser de otro: se registra")
	}
	sinHora := deIP("10.0.0.5")
	sinHora.Cuando = "ayer"
	if sensorPropio(true).ignorarPropio(t1, sinHora) {
		t.Error("sin saber cuándo fue no se puede saber de quién era esa dirección")
	}

	conIPPropia := trampaPropia("t1")
	conIPPropia.Manifiesto.Red = &plan.RedTrampa{}
	if sensorPropio(true).ignorarPropio(conIPPropia, deIP("10.0.0.5")) {
		t.Error("la máquina no llega a una trampa con IP propia: esa dirección es falsa")
	}

	// Una consola anterior no manda nada: se registra todo.
	s := sensorPropio(false)
	s.plan = &plan.Plan{}
	if s.ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("sin el campo, como siempre")
	}
	s.plan = nil
	if s.ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("sin plan no se descarta nada")
	}

	// Sin saber cuáles son sus direcciones no se descarta nada.
	s = sensorPropio(true)
	s.anfitrion.a = nil
	if s.ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("sin medir las direcciones no se sabe")
	}
	s = sensorPropio(true)
	s.anfitrion.medido = time.Now().Add(-vidaDirecciones - time.Minute)
	if s.ignorarPropio(t1, deIP("10.0.0.5")) {
		t.Error("una medida vieja no vale: esa IP puede ser ya de otro equipo")
	}
}

func TestRetenidos(t *testing.T) {
	t1 := trampaPropia("t1")
	s := sensorPropio(true)
	retener := func() { s.retenidos = s.retener(s.retenidos, t1, deIP("10.0.0.5")) }
	retener()

	listos, siguen, olvidados := s.repartirRetenidos()
	if len(listos) != 0 || len(siguen) != 1 || len(olvidados) != 0 {
		t.Fatalf("con el mismo plan sigue esperando: %d, %d, %v", len(listos), len(siguen), olvidados)
	}

	// El plan siguiente dice que esa trampa tiene una prueba abierta: se registra.
	s.plan = &plan.Plan{IgnorarPropio: true, RegistrarSiempre: []string{"t1"}}
	listos, siguen, olvidados = s.repartirRetenidos()
	if len(listos) != 1 || len(siguen) != 0 || len(olvidados) != 0 {
		t.Fatalf("era de una prueba: %d, %d, %v", len(listos), len(siguen), olvidados)
	}

	// El plan siguiente no dice nada de ella: se olvida, y se cuenta.
	s.retenidos = nil
	retener()
	retener()
	s.plan = &plan.Plan{IgnorarPropio: true}
	listos, siguen, olvidados = s.repartirRetenidos()
	if len(listos) != 0 || len(siguen) != 0 || olvidados["t1"] != 2 {
		t.Fatalf("no era de una prueba: %d, %d, %v", len(listos), len(siguen), olvidados)
	}

	// Han encendido el interruptor mientras tanto: se registra.
	s.retenidos = nil
	retener()
	s.plan = &plan.Plan{}
	if listos, _, _ = s.repartirRetenidos(); len(listos) != 1 {
		t.Fatalf("con el interruptor encendido: %d listos", len(listos))
	}

	// Con la consola caída no crece sin fin, y lo que se pierde es lo más viejo.
	s = sensorPropio(true)
	var lista []retenido
	for i := range maxRetenidos + 5 {
		e := deIP("10.0.0.5")
		e.ID = fmt.Sprint(i)
		lista = s.retener(lista, t1, e)
	}
	if len(lista) != maxRetenidos || lista[0].e.ID != "5" {
		t.Fatalf("%d retenidos, el primero %q", len(lista), lista[0].e.ID)
	}
}

// El toque se reconoce por la hora de su evento: desplegar puede retrasar la lectura.
func TestUnToqueLeidoTardeSigueSiendoDeLaPrueba(t *testing.T) {
	s := sensorPropio(true)
	ahora := time.Now()
	s.toques.apuntar(plan.Toque{Trampa: "t1", Codigo: "abc12345", IPs: []string{"10.0.0.5"}}, ahora.Add(-5*time.Minute))
	e := deIP("10.0.0.5")
	e.Trampa.ID = "t1"
	e.Cuando = ahora.Add(-5*time.Minute + 2*time.Second).UTC().Format(time.RFC3339Nano)
	s.origen(&e)
	if e.Detalle[campoToque] != "abc12345" {
		t.Fatalf("el toque de hace 5 minutos no se ha reconocido: %+v", e.Detalle)
	}
	if s.ignorarPropio(trampaPropia("t1"), e) {
		t.Fatal("el toque se registra siempre")
	}

	// Una hora en el futuro cuenta como ahora: ni deja fuera un toque vivo...
	s = sensorPropio(true)
	s.toques.apuntar(plan.Toque{Trampa: "t1", Codigo: "abc12345", IPs: []string{"10.0.0.5"}}, ahora)
	e = deIP("10.0.0.5")
	e.Trampa.ID = "t1"
	e.Cuando = ahora.Add(5 * time.Hour).UTC().Format(time.RFC3339Nano)
	s.origen(&e)
	if e.Detalle[campoToque] != "abc12345" {
		t.Fatalf("un reloj adelantado ha dejado fuera el toque: %+v", e.Detalle)
	}

	// ...ni da por toque lo que llega cuando ya ha acabado.
	s = sensorPropio(true)
	s.toques.apuntar(plan.Toque{Trampa: "t1", Codigo: "abc12345", IPs: []string{"10.0.0.5"}}, ahora.Add(-5*time.Minute))
	e = deIP("10.0.0.5")
	e.Trampa.ID = "t1"
	e.Cuando = ahora.UTC().Format(time.RFC3339Nano)
	s.origen(&e)
	if _, marcado := e.Detalle[campoToque]; marcado {
		t.Fatal("lo de ahora no es de un toque de hace 5 minutos")
	}
}

// Las líneas de un registro, con esas IP y cada una de un minuto distinto, ya pasado.
func escribirIPs(t *testing.T, ruta string, ips []string) {
	t.Helper()
	f, err := os.OpenFile(ruta, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for i, ip := range ips {
		fmt.Fprintf(f, `{"eventid":"conexion","timestamp":%q,"src_ip":%q,"session":"s%d","message":"m"}`+"\n",
			time.Now().UTC().Add(time.Duration(i-len(ips))*time.Minute).Format(time.RFC3339), ip, i)
	}
}

func ipsEnLaCola(t *testing.T, s *sensor, ips ...string) []string {
	t.Helper()
	cola, err := os.Open(s.salida)
	if err != nil {
		t.Fatal(err)
	}
	defer cola.Close()
	var vistas []string
	for b := bufio.NewScanner(cola); b.Scan(); {
		for _, ip := range ips {
			if strings.Contains(b.Text(), `"ip":"`+ip+`"`) {
				vistas = append(vistas, ip)
			}
		}
	}
	return vistas
}

// Por el camino de verdad: lo descartado no entra en la cola, y si el plan siguiente dice
// que era de una prueba, entra entonces.
func TestLeerNoRegistraLoDeSuMaquina(t *testing.T) {
	conDiscoLibre(t, 0)
	s, registro := sensorDeCola(t, &consolaFalsa{})
	s.plan.IgnorarPropio = true
	s.conocido = motorRootful()
	s.anfitrion.a = &motor.Anfitrion{Direcciones: []string{"10.0.0.5"}}
	s.anfitrion.medido = time.Now()

	const propia, fuera1, fuera2 = "10.0.0.5", "203.0.113.7", "198.51.100.4"
	todas := []string{propia, fuera1, fuera2, pasarelaPrueba}
	escribirIPs(t, registro, []string{fuera1, propia, pasarelaPrueba, propia, fuera2})
	s.leer()
	if got, quiere := ipsEnLaCola(t, s, todas...), []string{fuera1, pasarelaPrueba, fuera2}; fmt.Sprint(got) != fmt.Sprint(quiere) {
		t.Fatalf("en la cola: %v, quería %v", got, quiere)
	}
	if len(s.retenidos) != 2 {
		t.Fatalf("retenidos: %d", len(s.retenidos))
	}

	// Sigue el mismo plan: nada cambia.
	s.leer()
	if got := ipsEnLaCola(t, s, propia); len(got) != 0 {
		t.Fatalf("con el mismo plan se ha registrado: %v", got)
	}

	// Llega el plan con la prueba abierta: lo retenido entra, en la misma cadena.
	otro := *s.plan
	otro.RegistrarSiempre = []string{"t1"}
	s.plan = &otro
	s.leer()
	if got := ipsEnLaCola(t, s, propia); len(got) != 2 {
		t.Fatalf("lo de la prueba no ha entrado: %v", got)
	}
	if len(s.retenidos) != 0 {
		t.Fatalf("quedan retenidos: %d", len(s.retenidos))
	}
}

// Si la cola no se puede escribir, la vuelta no cuenta: lo soltado no se pierde y lo que
// se vuelve a leer no se retiene dos veces.
func TestUnFalloDeLaColaNoPierdeNiRepite(t *testing.T) {
	conDiscoLibre(t, 0)
	s, registro := sensorDeCola(t, &consolaFalsa{})
	s.plan.IgnorarPropio = true
	s.conocido = motorRootful()
	s.anfitrion.a = &motor.Anfitrion{Direcciones: []string{"10.0.0.5"}}
	s.anfitrion.medido = time.Now()
	const propia, fuera = "10.0.0.5", "203.0.113.7"

	buena := anadirACola
	t.Cleanup(func() { anadirACola = buena })
	roto := func(string, int64, [][]byte) error { return errors.New("fallo de E/S") }

	// Las dos líneas se leen dos veces porque la cola falla: la propia se retiene una.
	escribirIPs(t, registro, []string{fuera, propia})
	anadirACola = roto
	s.leer()
	s.leer()
	if len(s.retenidos) != 0 {
		t.Fatalf("una vuelta fallida ha retenido %d", len(s.retenidos))
	}
	anadirACola = buena
	s.leer()
	if len(s.retenidos) != 1 {
		t.Fatalf("retenidos: %d", len(s.retenidos))
	}
	if got := ipsEnLaCola(t, s, propia, fuera); len(got) != 1 || got[0] != fuera {
		t.Fatalf("en la cola: %v", got)
	}

	// Llega la prueba y la cola falla: lo retenido no se pierde, y entra una vez.
	otro := *s.plan
	otro.RegistrarSiempre = []string{"t1"}
	s.plan = &otro
	anadirACola = roto
	s.leer()
	s.leer()
	if len(s.retenidos) != 1 {
		t.Fatalf("lo soltado sin poder escribirlo se ha perdido: %d", len(s.retenidos))
	}
	anadirACola = buena
	s.leer()
	s.leer()
	if len(s.retenidos) != 0 {
		t.Fatalf("quedan retenidos: %d", len(s.retenidos))
	}
	if got := ipsEnLaCola(t, s, propia); len(got) != 1 {
		t.Fatalf("lo de la prueba tiene que entrar una vez: %v", got)
	}
}

// SEN-7: una interfaz que va y viene no cambia lo que se anuncia (no rehace la
// trampa); una nueva se añade; pasado el tope se empieza con las de ahora.
func TestUnirDirecciones(t *testing.T) {
	a := unirDirecciones(nil, []string{"10.0.0.4", "192.168.1.4"})
	if strings.Join(a, ",") != "10.0.0.4,192.168.1.4" {
		t.Fatalf("primera medida: %v", a)
	}
	if b := unirDirecciones(a, []string{"10.0.0.4"}); strings.Join(b, ",") != strings.Join(a, ",") {
		t.Fatalf("la VPN se fue y no cambia: %v", b)
	}
	if c := unirDirecciones(a, []string{"10.0.0.4", "172.20.0.9"}); len(c) != 3 {
		t.Fatalf("una nueva se añade: %v", c)
	}
	var muchas []string
	for i := 0; i < 9; i++ {
		muchas = unirDirecciones(muchas, []string{fmt.Sprintf("10.9.0.%d", i)})
	}
	if len(muchas) != 1 || muchas[0] != "10.9.0.8" {
		t.Fatalf("pasado el tope, solo las de ahora: %v", muchas)
	}
}
