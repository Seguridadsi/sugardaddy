// Pruebas de cupos.go (código propio de SeguridadSI). Corren al construir la
// imagen (Dockerfile): si fallan, no hay imagen.
package logging

import (
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// conRotador pone un registro de prueba como el activo mientras dura la prueba.
func conRotador(t *testing.T) (*rotador, string) {
	t.Helper()
	ruta := filepath.Join(t.TempDir(), "go-pot.json")
	r, err := nuevoRotador(ruta, 1<<20, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	antes := rotadorActivo.Swap(r)
	t.Cleanup(func() {
		rotadorActivo.Store(antes)
		r.Close()
	})
	return r, ruta
}

// Una IP no pasa de porIP conexiones abiertas: las demás se cierran sin una
// palabra (ni el texto de fasthttp), salen en el resumen y, al irse una, el
// hueco vuelve a estar libre.
func TestCuposPorIP(t *testing.T) {
	_, ruta := conRotador(t)
	base, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln := LimitarConexiones(base, 2, 100, 1, time.Hour, time.Hour).(*limitador)
	defer ln.Close()
	aceptadas := make(chan net.Conn, 10)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			aceptadas <- c
		}
	}()
	var clientes []net.Conn
	for range 5 {
		c, err := net.Dial("tcp4", base.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		clientes = append(clientes, c)
	}
	var dentro []net.Conn
	for range 2 {
		select {
		case c := <-aceptadas:
			dentro = append(dentro, c)
		case <-time.After(2 * time.Second):
			t.Fatal("no se aceptan las dos primeras")
		}
	}
	// Las tres de más: cerradas sin que les llegue nada.
	cerradas := 0
	for _, c := range clientes {
		c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		b, err := io.ReadAll(c)
		if err == nil && len(b) == 0 {
			cerradas++
		} else if len(b) > 0 {
			t.Fatalf("a una rechazada le ha llegado algo: %q", b)
		}
	}
	if cerradas != 3 {
		t.Fatalf("cerradas: %d de 3", cerradas)
	}
	ln.resumir()
	res := conPhase(objetos(t, ruta), "rechazos")
	if len(res) != 1 || res[0]["rechazadas"] != float64(3) || res[0]["por_tope_ip"] != float64(3) ||
		res[0]["por_tope_global"] != float64(0) || res[0]["src_ip"] != "127.0.0.1" || res[0]["activas"] != float64(2) {
		t.Fatalf("resumen: %v", res)
	}
	if _, ok := res[0]["ts"].(string); !ok {
		t.Fatalf("ts: %v", res[0])
	}
	// Se va una: entra otra.
	dentro[0].Close()
	dentro[0].Close() // dos veces: el hueco se devuelve una sola
	c, err := net.Dial("tcp4", base.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	select {
	case <-aceptadas:
	case <-time.After(2 * time.Second):
		t.Fatal("el hueco no se libera")
	}
	if ln.activas != 2 {
		t.Fatalf("activas: %d", ln.activas)
	}
}

// admitirSinRed: admitir una conexión de ip sin red (para las pruebas que
// llaman a admitir directamente). Devuelve la conexión si entra.
func admitirSinRed(t *testing.T, l *limitador, ip string) (*conexionLimitada, *conexionLimitada) {
	t.Helper()
	c := &conexionLimitada{l: l, ip: ip}
	dentro, desalojada := l.admitir(c)
	invariantes(t, l)
	if !dentro {
		return nil, desalojada
	}
	return c, desalojada
}

// invariantes: las cuentas del limitador cuadran entre sí.
func invariantes(t *testing.T, l *limitador) {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	suma, mayor := 0, 0
	for ip, d := range l.deIP {
		n := len(d.conns)
		if n == 0 || n > l.porIP || d.ip != ip {
			t.Fatalf("%s con %d conexiones", ip, n)
		}
		if _, ok := l.porCuenta[n][d]; !ok {
			t.Fatalf("%s no está entre las de %d", ip, n)
		}
		for _, c := range d.conns {
			if c.fuera || c.desalojada.Load() {
				t.Fatalf("%s cuenta una que ya no tiene hueco", ip)
			}
		}
		suma += n
		mayor = max(mayor, n)
	}
	enCuentas := 0
	for _, m := range l.porCuenta {
		enCuentas += len(m)
	}
	if suma != l.activas || l.activas > l.total || mayor != l.maxCuenta || enCuentas != len(l.deIP) {
		t.Fatalf("activas %d (suma %d, total %d), maxCuenta %d (mayor %d), %d IP en porCuenta de %d",
			l.activas, suma, l.total, l.maxCuenta, mayor, enCuentas, len(l.deIP))
	}
}

// El tope total y el resumen con muchas IP (sin red: admitir directamente).
// Sin conexiones garantizadas, con todo lleno no entra nadie.
func TestCuposTotalYResumen(t *testing.T) {
	_, ruta := conRotador(t)
	l := nuevoLimitador(nil, 2, 3, 0, time.Minute, time.Hour)
	a1, _ := admitirSinRed(t, l, "10.0.0.1")
	a2, _ := admitirSinRed(t, l, "10.0.0.1")
	if a1 == nil || a2 == nil {
		t.Fatal("las dos primeras de una IP entran")
	}
	if c, _ := admitirSinRed(t, l, "10.0.0.1"); c != nil {
		t.Fatal("pasa del tope por IP")
	}
	b, _ := admitirSinRed(t, l, "10.0.0.2")
	if b == nil {
		t.Fatal("otra IP entra mientras quede sitio")
	}
	if c, _ := admitirSinRed(t, l, "10.0.0.3"); c != nil {
		t.Fatal("pasa del tope total")
	}
	for i := range maxIPsResumen + 10 {
		admitirSinRed(t, l, net.IPv4(10, 1, byte(i>>8), byte(i)).String())
	}
	l.resumir()
	res := conPhase(objetos(t, ruta), "rechazos")
	if len(res) != 1 || res[0]["por_tope_global"] != float64(maxIPsResumen+11) || res[0]["por_tope_ip"] != float64(1) ||
		res[0]["ips_distintas"] != float64(maxIPsResumen) || res[0]["ips_sin_contar"] != float64(12) || res[0]["periodo_s"] != float64(60) ||
		res[0]["desalojadas"] != float64(0) {
		t.Fatalf("resumen: %v", res)
	}
	// Vacío el periodo, no hay resumen.
	l.resumir()
	if n := len(conPhase(objetos(t, ruta), "rechazos")); n != 1 {
		t.Fatalf("resúmenes: %d", n)
	}
	l.soltar(b)
	l.soltar(b) // dos veces: el hueco se devuelve una sola
	if c, _ := admitirSinRed(t, l, "10.0.0.3"); c == nil {
		t.Fatal("al irse una, entra otra")
	}
	if l.activas != 3 {
		t.Fatalf("activas: %d", l.activas)
	}
}

// Hallazgo: con ReduceMemoryUsage, fasthttp espera el primer byte sin plazo y
// el limitador solo devolvía el hueco al cerrar: 64 conexiones calladas por
// IP lo ocupaban para siempre (con 63 IP, la trampa ciega). Ahora cada una
// sale del Accept con un plazo de lectura para su primer byte: a quien lee
// (fasthttp) le da error al vencer, la cierra y el hueco vuelve. La prueba
// con el servidor de verdad es TestServidorCalladaCaduca.
func TestCuposCalladaCaduca(t *testing.T) {
	conRotador(t)
	base, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	const plazo = 300 * time.Millisecond
	ln := LimitarConexiones(base, 2, 100, 1, time.Hour, plazo).(*limitador)
	defer ln.Close()
	cerradas := make(chan time.Duration, 10)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// Lo que hace fasthttp: leer el primer byte y, si falla, cerrar.
			go func() {
				ini := time.Now()
				_, err := c.Read(make([]byte, 1))
				if err == nil {
					t.Error("una conexión callada ha mandado algo")
				}
				c.Close()
				cerradas <- time.Since(ini)
			}()
		}
	}()
	var calladas []net.Conn
	for range 2 {
		c, err := net.Dial("tcp4", base.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		calladas = append(calladas, c)
	}
	for range 2 {
		select {
		case d := <-cerradas:
			if d < plazo/2 || d > 3*plazo {
				t.Fatalf("cerrada a los %v; el plazo es %v", d, plazo)
			}
		case <-time.After(5 * plazo):
			t.Fatal("una conexión callada sigue dentro pasado su plazo")
		}
	}
	// Su IP vuelve a tener sitio: entra otra (y también caduca).
	c, err := net.Dial("tcp4", base.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	select {
	case <-cerradas:
	case <-time.After(5 * plazo):
		t.Fatal("no entra ninguna más desde la IP de las calladas")
	}
	ln.mu.Lock()
	activas, rechazadas := ln.activas, ln.rech.total
	ln.mu.Unlock()
	if activas != 0 || rechazadas != 0 {
		t.Fatalf("activas %d, rechazadas %d", activas, rechazadas)
	}
}

// Hallazgo: con solo los dos topes, total/porIP IP (20 con 120 MiB) que
// mantuvieran vivas sus conexiones ocupaban todo el sitio, y las de cualquier
// otra IP se cerraban sin apuntar nada: la trampa, ciega. Ahora, con todo
// lleno, una IP con menos de garantizadas entra desalojando una de la IP que
// más tiene (la más antigua sin petición en curso), si esa tiene al menos dos
// más. Solo cuando cada hueco es de una IP distinta deja de entrar una nueva.
func TestCuposRepartoJusto(t *testing.T) {
	_, ruta := conRotador(t)
	l := nuevoLimitador(nil, 3, 4, 2, time.Minute, time.Hour)
	var a [3]*conexionLimitada
	for i := range a {
		if a[i], _ = admitirSinRed(t, l, "10.0.0.1"); a[i] == nil {
			t.Fatal("no se llena")
		}
	}
	if b, _ := admitirSinRed(t, l, "10.0.0.2"); b == nil {
		t.Fatal("no se llena")
	}
	// La más antigua de la que acapara está a media petición: se desaloja la
	// siguiente, que espera.
	a[0].activa.Store(true)
	c1, fuera := admitirSinRed(t, l, "10.0.0.3")
	if c1 == nil || fuera != a[1] {
		t.Fatalf("con todo lleno, una IP nueva no entra desalojando la más antigua que espera: %v %v", c1, fuera)
	}
	if !a[1].fuera || !Desalojada(a[1]) || Desalojada(a[0]) || Desalojada(c1) {
		t.Fatal("la desalojada no queda marcada")
	}
	// Su Read y su Write fallan sin tocar el socket (aquí no lo hay): para
	// fasthttp, el cliente se ha ido.
	if n, err := a[1].Read(make([]byte, 8)); n != 0 || err != io.EOF {
		t.Fatalf("Read de una desalojada: %d %v", n, err)
	}
	if n, err := a[1].Write([]byte("x")); n != 0 || err != errDesalojada {
		t.Fatalf("Write de una desalojada: %d %v", n, err)
	}
	// Cuando fasthttp la cierra, su hueco no se devuelve otra vez.
	l.soltar(a[1])
	invariantes(t, l)
	if l.activas != 4 {
		t.Fatalf("activas: %d", l.activas)
	}
	// La segunda de la nueva no: la que más tiene ya no le saca dos (2 y 1).
	if c, fuera := admitirSinRed(t, l, "10.0.0.3"); c != nil || fuera != nil {
		t.Fatal("desaloja sin que la otra tenga al menos dos más")
	}
	// Otra nueva sí: se va la otra de la que acaparaba que espera.
	d1, fuera := admitirSinRed(t, l, "10.0.0.4")
	if d1 == nil || fuera != a[2] {
		t.Fatalf("la segunda IP nueva: %v %v", d1, fuera)
	}
	// Cada hueco, de una IP distinta: ya no entra nadie.
	if c, fuera := admitirSinRed(t, l, "10.0.0.5"); c != nil || fuera != nil {
		t.Fatal("con cada hueco en una IP distinta, sigue desalojando")
	}
	l.resumir()
	res := conPhase(objetos(t, ruta), "rechazos")
	if len(res) != 1 || res[0]["desalojadas"] != float64(2) || res[0]["rechazadas"] != float64(2) ||
		res[0]["por_tope_global"] != float64(2) || res[0]["src_ip"] != "10.0.0.1" || res[0]["de_su_ip"] != float64(2) ||
		res[0]["ips_distintas"] != float64(3) || res[0]["activas"] != float64(4) {
		t.Fatalf("resumen: %v", res)
	}
	// Con solo desalojadas en el periodo, también hay resumen.
	l.soltar(d1)
	l.soltar(c1)
	if f, _ := admitirSinRed(t, l, "10.0.0.6"); f == nil {
		t.Fatal("con sitio, entra")
	}
	if f, _ := admitirSinRed(t, l, "10.0.0.6"); f == nil {
		t.Fatal("con sitio, entra")
	}
	if c, fuera := admitirSinRed(t, l, "10.0.0.7"); c == nil || fuera == nil || fuera.ip != "10.0.0.6" {
		t.Fatal("no desaloja a la que tiene dos")
	}
	l.resumir()
	if res := conPhase(objetos(t, ruta), "rechazos"); len(res) != 2 || res[1]["desalojadas"] != float64(1) ||
		res[1]["rechazadas"] != float64(0) || res[1]["src_ip"] != "10.0.0.6" {
		t.Fatalf("resumen solo de desalojadas: %v", res)
	}
}

// Si todas las de la IP que más tiene están a media petición, se va la más
// antigua. Y una IP que ya tiene sus garantizadas no desaloja a nadie.
func TestCuposDesalojoTodasOcupadas(t *testing.T) {
	conRotador(t)
	l := nuevoLimitador(nil, 4, 5, 1, time.Minute, time.Hour)
	var x [4]*conexionLimitada
	for i := range x {
		x[i], _ = admitirSinRed(t, l, "10.0.0.1")
		x[i].activa.Store(true)
	}
	admitirSinRed(t, l, "10.0.0.2")
	if y, fuera := admitirSinRed(t, l, "10.0.0.3"); y == nil || fuera != x[0] {
		t.Fatalf("todas ocupadas: %v %v", y, fuera)
	}
	if y, fuera := admitirSinRed(t, l, "10.0.0.3"); y != nil || fuera != nil {
		t.Fatal("con sus garantizadas, desaloja")
	}
}

// conIP: una conexión de verdad que dice venir de otra IP (las pruebas no
// pueden conectar desde varias IP en todos los sistemas).
type conIP struct {
	net.Conn
	ip net.IP
}

func (c conIP) RemoteAddr() net.Addr { return &net.TCPAddr{IP: c.ip, Port: 40000} }

// ipsDePrueba: cada conexión aceptada viene de la siguiente IP de ips (se
// conecta de una en una, en ese orden).
type ipsDePrueba struct {
	net.Listener
	ips chan net.IP
}

func (l ipsDePrueba) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return conIP{c, <-l.ips}, nil
}

// Con sockets de verdad: la desalojada se despierta aunque esté esperando
// (su plazo era de una hora), su lector ve io.EOF, no se le manda nada y,
// al cerrarla quien la sirve, el hueco no se cuenta dos veces. Las demás
// siguen como estaban. Y al cerrar el limitador, su último resumen ya está
// escrito (antes salía después, en el registro de lo siguiente).
func TestCuposDesalojoConRed(t *testing.T) {
	_, ruta := conRotador(t)
	base, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ips := ipsDePrueba{base, make(chan net.IP, 16)}
	ln := LimitarConexiones(ips, 8, 4, 2, time.Hour, time.Hour).(*limitador)
	defer ln.Close()
	type fin struct {
		ip        string
		leido     error
		escrito   error
		esperando time.Duration
	}
	aceptadas, fines := make(chan net.Conn, 8), make(chan fin, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			aceptadas <- c
			// Lo que hace fasthttp: leer y contestar hasta que falle, y cerrar.
			go func() {
				ini := time.Now()
				b := make([]byte, 16)
				for {
					n, err := c.Read(b)
					if err != nil {
						_, werr := c.Write([]byte("adios"))
						fines <- fin{ipDe(c.RemoteAddr()), err, werr, time.Since(ini)}
						c.Close()
						return
					}
					c.Write(b[:n])
				}
			}()
		}
	}()
	conectar := func(ip net.IP) net.Conn {
		ips.ips <- ip
		c, err := net.Dial("tcp4", base.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		select {
		case <-aceptadas:
		case <-time.After(2 * time.Second):
			t.Fatalf("no entra la de %v", ip)
		}
		return c
	}
	var llenas []net.Conn
	for range 4 {
		llenas = append(llenas, conectar(net.IPv4(10, 0, 0, 1)))
	}
	nueva := conectar(net.IPv4(10, 0, 0, 2))
	select {
	case f := <-fines:
		if f.ip != "10.0.0.1" || f.leido != io.EOF || f.escrito != errDesalojada || f.esperando > time.Minute {
			t.Fatalf("la desalojada: %+v", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("la desalojada sigue esperando")
	}
	// La más antigua, cerrada sin recibir nada.
	if !cerradaSinNada(t, llenas[0]) {
		t.Fatal("la más antigua sigue abierta")
	}
	// Las demás y la nueva, como estaban.
	for _, c := range append(llenas[1:], nueva) {
		c.SetDeadline(time.Now().Add(2 * time.Second))
		io.WriteString(c, "hola")
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err != nil || string(b) != "hola" {
			t.Fatalf("una que no se desaloja: %q %v", b, err)
		}
	}
	ln.mu.Lock()
	activas, desalojadas := ln.activas, ln.rech.desalojadas
	ln.mu.Unlock()
	if activas != 4 || desalojadas != 1 {
		t.Fatalf("activas %d, desalojadas %d", activas, desalojadas)
	}
	ln.Close()
	if res := conPhase(objetos(t, ruta), "rechazos"); len(res) != 1 || res[0]["desalojadas"] != float64(1) ||
		res[0]["src_ip"] != "10.0.0.1" || res[0]["rechazadas"] != float64(0) {
		t.Fatalf("último resumen: %v", res)
	}
}

// cerradaSinNada: el otro lado la ha cerrado sin mandar ni un byte.
func cerradaSinNada(t *testing.T, c net.Conn) bool {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	b, err := io.ReadAll(c)
	if len(b) > 0 {
		t.Fatalf("le ha llegado algo: %q", b)
	}
	return err == nil
}
