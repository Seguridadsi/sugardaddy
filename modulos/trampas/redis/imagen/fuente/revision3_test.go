package main

// Pruebas de los hallazgos de la tercera revisión (hallazgos3-redis.json) y de
// lo que salió al arreglarlos. Ninguna mide tiempos ni depende del número de
// CPU: corren dentro del Dockerfile al construir la imagen. Un cliente que no
// lee se simula con escritorParado, no con un socket, porque lo que aguantan
// los búferes del socket cambia de un sistema a otro.

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"
)

// escritorParado avisa en la primera escritura y se queda parado hasta
// soltar: como un cliente que no lee nada.
type escritorParado struct {
	una    sync.Once
	parado chan struct{}
	soltar chan struct{}
}

func nuevoEscritorParado() *escritorParado {
	return &escritorParado{parado: make(chan struct{}), soltar: make(chan struct{})}
}

func (e *escritorParado) Write(p []byte) (int, error) {
	e.una.Do(func() { close(e.parado) })
	<-e.soltar
	return len(p), nil
}

// responderParado atiende la orden con el mismo búfer de 4 KB que atender,
// contra un escritorParado. Devuelve lo que devuelve responder (cerrar).
func responderParado(s *servidor, cli *cliente, e *escritorParado, args ...string) <-chan bool {
	fin := make(chan bool, 1)
	go func() {
		w := bufio.NewWriterSize(e, 4<<10)
		o := &resp{w: w, proto: cli.proto, errores: func(string) {}}
		fin <- s.responder(o, cli, nombreComando(args[0]), args)
	}()
	return fin
}

// modificables: los parámetros de CONFIG SET de la versión, en orden fijo.
func modificables(s *servidor) []string {
	var ks []string
	for k, c := range s.id.parametros {
		if c == parModificable {
			ks = append(ks, k)
		}
	}
	return ks
}

// configGetPlano lee la respuesta de CONFIG GET (*2N o %N y los bulks) y
// devuelve la cabecera y los nombres en orden.
func configGetPlano(t *testing.T, out string) (string, []string) {
	t.Helper()
	r := bufio.NewReader(strings.NewReader(out))
	cab, err := r.ReadString('\n')
	if err != nil {
		t.Fatalf("respuesta sin cabecera: %q", out)
	}
	var nombres []string
	for i := 0; ; i++ {
		l, err := r.ReadString('\n')
		if err == io.EOF && l == "" {
			break
		}
		if err != nil || len(l) < 4 || l[0] != '$' {
			t.Fatalf("bulk mal formado en la respuesta: %q", l)
		}
		n, err := strconv.Atoi(strings.TrimSuffix(l[1:], "\r\n"))
		if err != nil {
			t.Fatalf("longitud de bulk mala: %q", l)
		}
		b := make([]byte, n+2)
		if _, err := io.ReadFull(r, b); err != nil {
			t.Fatal(err)
		}
		if i%2 == 0 {
			nombres = append(nombres, string(b[:n]))
		}
	}
	return strings.TrimSuffix(cab, "\r\n"), nombres
}

// ---- Hallazgo 0: CONFIG GET con mil '*' -------------------------------------

// Antes: 'CONFIG GET' con 1.022 '*' armaba mil veces la lista entera (sin
// quitar repetidos ni gastar presupuesto) y la retenía mientras el cliente no
// leía: ocho conexiones de una IP dejaban unos 35 MB vivos. Ahora cada
// parámetro sale una vez, como en Redis 7, y la respuesta no pasa de la lista.
func TestConfigGetConMilAsteriscosNoMultiplicaLaRespuesta(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	fijar := clientePrueba(s, "198.51.100.1")
	for _, k := range modificables(s) {
		ejecutar(s, fijar, "CONFIG", "SET", k, "1")
	}
	args := []string{"CONFIG", "GET"}
	for len(args) < maxArgs {
		args = append(args, "*")
	}
	antes := heapVivo()
	var esperas []*escritorParado
	var fines []<-chan bool
	for i := 0; i < 8; i++ {
		cli := clientePrueba(s, "198.51.100.1")
		e := nuevoEscritorParado()
		fin := responderParado(s, cli, e, args...)
		select {
		case <-e.parado: // escribiendo, con la respuesta armada y sin leer
		case <-fin: // cupo entera en el búfer: no retiene nada
			fin = nil
		}
		esperas, fines = append(esperas, e), append(fines, fin)
	}
	crecio := int64(heapVivo()) - int64(antes)
	for i, e := range esperas {
		close(e.soltar)
		if fines[i] != nil {
			<-fines[i]
		}
	}
	if crecio > 3<<20 {
		t.Fatalf("ocho CONFIG GET con mil '*' sin leer dejan %d KB vivos", crecio>>10)
	}

	// Cada parámetro una vez, con la cabecera de Redis 7: *2N en RESP2, %N en RESP3.
	uno, _ := ejecutar(s, fijar, "CONFIG", "GET", "*")
	_, todos := configGetPlano(t, uno)
	for _, proto := range []int{2, 3} {
		fijar.proto = proto
		out, _ := ejecutar(s, fijar, "CONFIG", "GET", "*", "*", "max*", "maxmemory")
		cab, nombres := configGetPlano(t, out)
		quiere := "*" + strconv.Itoa(2*len(todos))
		if proto == 3 {
			quiere = "%" + strconv.Itoa(len(todos))
		}
		if cab != quiere || len(nombres) != len(todos) {
			t.Fatalf("RESP%d: cabecera %q con %d nombres, se esperaba %q con %d", proto, cab, len(nombres), quiere, len(todos))
		}
		vistos := map[string]bool{}
		for _, n := range nombres {
			if vistos[n] {
				t.Fatalf("RESP%d: %q sale repetido en CONFIG GET", proto, n)
			}
			vistos[n] = true
		}
		out, _ = ejecutar(s, fijar, "CONFIG", "GET", "maxmemory", "maxmemory")
		cab, nombres = configGetPlano(t, out)
		if (proto == 3 && cab != "%1") || (proto == 2 && cab != "*2") || len(nombres) != 1 {
			t.Fatalf("RESP%d: 'CONFIG GET maxmemory maxmemory' debería dar un solo par: %q", proto, out)
		}
	}
}

// Con un patrón '*' también se gasta presupuesto (una unidad por llamada):
// con 20 unidades, CONFIG GET * da 20 parámetros, y KEYS * 5 claves con 5.
func TestElAsteriscoSoloTambienGastaPresupuesto(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	cli := clientePrueba(s, "198.51.100.1")
	for i := 0; i < 16; i++ {
		ejecutar(s, cli, "SET", "k"+strconv.Itoa(i), "x")
	}
	if out, _ := ejecutar(s, cli, "CONFIG", "GET", "*"); len(out) == 0 {
		t.Fatal("CONFIG GET * vacío")
	} else if _, todos := configGetPlano(t, out); len(todos) <= 20 {
		t.Fatalf("la prueba necesita más de 20 parámetros: %d", len(todos))
	}
	s.banco.maxTrabajo = 20
	out, _ := ejecutar(s, cli, "CONFIG", "GET", "*")
	if cab, nombres := configGetPlano(t, out); cab != "*40" || len(nombres) != 20 {
		t.Fatalf("con 20 unidades, CONFIG GET * debería dar 20 pares: %q y %d", cab, len(nombres))
	}
	s.banco.maxTrabajo = 5
	if ks := s.banco.claves(cli.vista, 0, "*"); len(ks) != 5 {
		t.Fatalf("con 5 unidades, KEYS * debería dar 5 claves: %d", len(ks))
	}
}

// ---- Lo que retiene una respuesta cuenta en la cuota de su IP ---------------

// Con el cliente sin leer, la lista de un CONFIG GET (o de un KEYS) sigue viva
// aunque sus cadenas ya no estén en el banco: un CONFIG SET entre cada GET
// dejaba una generación entera de valores de 4 KB por conexión, fuera de todo
// tope. Ahora la respuesta se reserva en la cuota de la IP mientras se
// escribe; la que no cabe corta su conexión, como client-output-buffer-limit.
func TestRespuestaSinLeerCuentaEnLaCuotaDeSuIP(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	const ip = "198.51.100.7"
	fijar := clientePrueba(s, ip)
	ks := modificables(s)
	poner := func(gen int) {
		for _, k := range ks {
			ejecutar(s, fijar, "CONFIG", "SET", k, strings.Repeat(string(rune('a'+gen%26)), maxValorConfig))
		}
	}
	poner(0)
	antes := heapVivo()
	var esperas []*escritorParado
	var fines []<-chan bool
	// Las que caben en la parte de la IP, y dos más (al menos ocho, como las
	// conexiones de una IP): alguna tiene que cortarse.
	conexiones := max(8, int(s.mem.maxIP/int64(len(ks)*maxValorConfig))+2)
	parados, cortados := 0, 0
	for g := 0; g < conexiones; g++ {
		poner(g) // otra generación de valores: la anterior solo la retiene la respuesta parada
		cli := clientePrueba(s, ip)
		cli.cuota = s.mem.cuotaPara(ip)
		e := nuevoEscritorParado()
		fin := responderParado(s, cli, e, "CONFIG", "GET", "*")
		select {
		case <-e.parado:
			parados++
		case cerrar := <-fin:
			fin = nil
			if !cerrar || !strings.Contains(cli.corte, "respuesta") {
				t.Fatalf("una respuesta que no cabe debería cortar la conexión con su motivo: %v %q", cerrar, cli.corte)
			}
			cortados++
		}
		if usado, _ := s.mem.usado(); usado > s.mem.maxIP {
			t.Fatalf("las respuestas retienen %d bytes, más que la parte de la IP (%d)", usado, s.mem.maxIP)
		}
		esperas, fines = append(esperas, e), append(fines, fin)
	}
	crecio := int64(heapVivo()) - int64(antes)
	for i, e := range esperas {
		close(e.soltar)
		if fines[i] != nil {
			<-fines[i]
		}
	}
	if parados == 0 || cortados == 0 {
		t.Fatalf("deberían quedar respuestas paradas y otras cortadas: %d paradas, %d cortadas", parados, cortados)
	}
	if crecio > s.mem.maxIP+1<<20 {
		t.Fatalf("%d CONFIG GET sin leer dejan %d KB vivos (la parte de la IP es %d KB)", conexiones, crecio>>10, s.mem.maxIP>>10)
	}
	if usado, _ := s.mem.usado(); usado != 0 {
		t.Fatalf("escritas las respuestas, la cuota debería quedar a cero: %d", usado)
	}
}

// Por TCP: un KEYS (o SCAN) cuya lista no cabe en lo que le queda a la IP
// corta la conexión sin contestar y deja un redis.session.tope con el motivo.
// La reserva se hace antes de escribir, así que no depende del socket.
func TestKeysQueNoCabeEnLaCuotaCortaLaConexion(t *testing.T) {
	s, dir, _ := servidorTCP(t, conf{maxMemClientesMb: 1}) // 128 KB por IP
	conn, err := net.Dial("tcp", dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	for i := 0; i < 20; i++ {
		conn.Write(orden("SET", strconv.Itoa(i)+strings.Repeat("k", 10<<10), "x"))
		if l, _ := r.ReadString('\n'); l != "+OK\r\n" {
			t.Fatalf("SET: %q", l)
		}
	}
	for _, o := range [][]string{{"KEYS", "*"}, {"SCAN", "0"}} {
		c := conn
		if o[0] == "SCAN" {
			if c, err = net.Dial("tcp", dir); err != nil {
				t.Fatal(err)
			}
			defer c.Close()
		}
		c.Write(orden(o...))
		c.SetReadDeadline(time.Now().Add(10 * time.Second)) // solo para no colgarse
		if n, err := c.Read(make([]byte, 1)); n != 0 || err != io.EOF {
			t.Fatalf("%s con 200 KB de nombres debería cerrar sin contestar: %d %v", o[0], n, err)
		}
	}
	if m := esperarEvento(t, s.cfg.registro, func(m map[string]any) bool {
		return m["eventid"] == "redis.session.tope" && strings.Contains(fmt.Sprint(m["motivo"]), "respuesta")
	}); m == nil {
		t.Fatal("el corte debería dejar un redis.session.tope con su motivo")
	}
}

// ---- Lo recortado que se guarda no retiene el argumento entero --------------

// Un s[:n] comparte memoria con el argumento: los 4 KB guardados de un CONFIG
// SET de 60 KB retenían los 60 KB (139 parámetros: 7,7 MB vivos por IP con
// 494 KB contados), y lo mismo los 256 bytes de CLIENT SETNAME, SETINFO,
// HELLO SETNAME y el host de SLAVEOF. Ahora lo recortado va en memoria propia.
func TestLoRecortadoNoRetieneElArgumentoEntero(t *testing.T) {
	s := servidorPrueba(t, conf{version: "7.2.4"})
	comparte := func(guardado, arg string) bool {
		return len(guardado) > 0 && unsafe.StringData(guardado) == unsafe.StringData(arg)
	}
	grande := func(c byte) string { return strings.Repeat(string(c), 60<<10) } // cada llamada, memoria nueva

	antes := heapVivo()
	cli := clientePrueba(s, "198.51.100.1")
	for _, k := range modificables(s) {
		arg := grande('v')
		ejecutar(s, cli, "CONFIG", "SET", k, arg)
		var v string
		s.banco.conVista(func() { v = cli.vista.config[s.id.canonico(k)] })
		if len(v) != maxValorConfig || comparte(v, arg) {
			t.Fatalf("CONFIG SET %s: guarda %d bytes compartidos con el argumento: %v", k, len(v), comparte(v, arg))
		}
	}
	var clientes []*cliente
	for i := 0; i < 32; i++ {
		c := clientePrueba(s, ipPrueba(i))
		nombre, lib, ver, hola := grande('n'), grande('l'), grande('r'), grande('h')
		ejecutar(s, c, "CLIENT", "SETNAME", nombre)
		ejecutar(s, c, "CLIENT", "SETINFO", "LIB-NAME", lib)
		ejecutar(s, c, "CLIENT", "SETINFO", "LIB-VER", ver)
		if comparte(c.nombre, nombre) || comparte(c.biblioteca, lib) || comparte(c.libVer, ver) {
			t.Fatal("CLIENT SETNAME/SETINFO guardan un recorte que comparte el argumento entero")
		}
		ejecutar(s, c, "HELLO", "3", "SETNAME", hola)
		host := grande('s')
		ejecutar(s, c, "SLAVEOF", host, "6379")
		var guardado string
		s.banco.conVista(func() { guardado = c.vista.replica[0] })
		if comparte(c.nombre, hola) || comparte(guardado, host) || len(guardado) != maxHostReplica {
			t.Fatal("HELLO SETNAME o el host de SLAVEOF guardan un recorte que comparte el argumento entero")
		}
		clientes = append(clientes, c)
	}
	crecio := int64(heapVivo()) - int64(antes)
	if crecio > 2<<20 {
		t.Fatalf("lo guardado recortado retiene %d KB vivos", crecio>>10)
	}
	_ = clientes // vivos hasta aquí: lo que guardan cuenta en la medida
	if c := cortarC("ab\x00"+grande('z'), -1); c != "ab" || comparte(c, "ab\x00") {
		t.Fatalf("cortarC: %q", c)
	}
	if n := nombreComando(strings.Repeat("X", 60<<10)); len(n) != maxCodComando {
		t.Fatalf("nombreComando: %d bytes", len(n))
	}
}
