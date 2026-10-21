package despliegue

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// motorFalso responde lo justo de la API de Docker y apunta lo que le piden.
type motorFalso struct {
	mu          sync.Mutex
	llamadas    []string
	redes       map[string]map[string]any // nombre → cuerpo de creación
	creados     []map[string]any
	imagenMala  string
	sinSubredes bool
	noSeBorra   bool // DELETE de la trampa retirada falla
}

func (m *motorFalso) apuntar(s string) {
	m.mu.Lock()
	m.llamadas = append(m.llamadas, s)
	m.mu.Unlock()
}

func (m *motorFalso) hizo(s string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.llamadas {
		if l == s {
			return true
		}
	}
	return false
}

func (m *motorFalso) servir(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	m.apuntar(r.Method + " " + p)
	responder := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	noExiste := func() { w.WriteHeader(http.StatusNotFound); responder(map[string]string{"message": "no existe"}) }
	switch {
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/networks/"):
		nombre := strings.TrimPrefix(p, "/networks/")
		if nombre == "sugardaddy-trampas" {
			responder(map[string]any{"Options": map[string]string{}, "Containers": map[string]any{}})
			return
		}
		cuerpo, ok := m.redes[nombre]
		if !ok {
			noExiste()
			return
		}
		responder(map[string]any{"Options": cuerpo["Options"], "Containers": map[string]any{}})
	case r.Method == http.MethodDelete && p == "/containers/c-vieja" && m.noSeBorra:
		w.WriteHeader(http.StatusInternalServerError)
		responder(map[string]string{"message": "device or resource busy"})
	case r.Method == http.MethodGet && p == "/volumes" && strings.Contains(r.URL.RawQuery, "label"):
		responder(map[string]any{"Volumes": []map[string]any{
			{"Name": "sd-s1-huerfana-0", "Labels": map[string]string{etiquetaSensor: "s1", etiquetaTrampa: "huerfana"}},
			{"Name": "sd-s1-t2-0", "Labels": map[string]string{etiquetaSensor: "s1", etiquetaTrampa: "t2"}},
		}})
	case r.Method == http.MethodPost && p == "/networks/create" && m.sinSubredes:
		w.WriteHeader(http.StatusForbidden)
		responder(map[string]string{"message": "could not find an available, non-overlapping IPv4 address pool"})
	case r.Method == http.MethodPost && p == "/networks/create":
		var c map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &c)
		m.redes[c["Name"].(string)] = c
		responder(map[string]string{"Id": "red"})
	case r.Method == http.MethodGet && p == "/containers/json":
		responder([]map[string]any{
			{"Id": "c-t1", "Names": []string{"/sd-s1-t1"}, "State": "running", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaHuella: "vieja"}},
			{"Id": "c-vieja", "Names": []string{"/sd-s1-vieja"}, "State": "running", "Labels": map[string]string{etiquetaTrampa: "vieja", etiquetaSensor: "s1"}},
		})
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/images/"):
		if strings.Contains(p, m.imagenMala) && m.imagenMala != "" {
			noExiste()
			return
		}
		responder(map[string]any{})
	case r.Method == http.MethodPost && p == "/images/create":
		responder(map[string]any{})
	case r.Method == http.MethodGet && p == "/volumes":
		responder(map[string]any{"Volumes": []map[string]string{{"Name": "sd-s1-vieja-0"}, {"Name": "sd-s1-vieja-otra-0"}}})
	case r.Method == http.MethodPost && p == "/containers/create":
		var c map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &c)
		m.creados = append(m.creados, c)
		responder(map[string]string{"Id": "nuevo"})
	default:
		responder(map[string]any{})
	}
}

func preparar(t *testing.T, m *motorFalso) *docker.Cliente {
	t.Helper()
	base, err := os.MkdirTemp("", "dp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(m.servir))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return docker.Nuevo(sock)
}

func trampa(id, imagen string) plan.TrampaPlan {
	return plan.TrampaPlan{ID: id, Manifiesto: plan.Manifiesto{
		Contenedor:  &plan.Contenedor{Imagen: imagen, Registros: "/log"},
		Aislamiento: &plan.Aislamiento{CPU: 0.5, MemoriaMb: 64},
	}}
}

func TestAplicarAislaYAcotaYLimpia(t *testing.T) {
	m := &motorFalso{redes: map[string]map[string]any{}}
	d := preparar(t, m)
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t2", "r/nueva@sha256:2")}}
	if _, err := Aplicar(context.Background(), d, o, p); err != nil {
		t.Fatal(err)
	}
	red := m.redes[redTrampas]
	if red == nil || red["Options"].(map[string]any)["com.docker.network.bridge.enable_icc"] != "false" {
		t.Fatalf("la red de trampas tiene que aislar sus contenedores: %v", red)
	}
	if len(m.creados) != 1 {
		t.Fatalf("contenedores creados: %d", len(m.creados))
	}
	hc := m.creados[0]["HostConfig"].(map[string]any)
	if hc["NetworkMode"] != redTrampas {
		t.Fatalf("red de la trampa: %v", hc["NetworkMode"])
	}
	lc, _ := hc["LogConfig"].(map[string]any)
	if lc["Type"] != "json-file" || lc["Config"].(map[string]any)["max-size"] == nil {
		t.Fatalf("los registros de Docker tienen que tener tope: %v", hc["LogConfig"])
	}
	if !m.hizo("DELETE /volumes/sd-s1-vieja-0") || m.hizo("DELETE /volumes/sd-s1-vieja-otra-0") {
		t.Fatalf("solo se borran los volúmenes de la trampa retirada: %v", m.llamadas)
	}
	if !m.hizo("DELETE /networks/sugardaddy-trampas") {
		t.Fatal("la red antigua, ya vacía, se quita")
	}
}

func TestSinImagenNuevaLaTrampaSigueComoEstaba(t *testing.T) {
	m := &motorFalso{redes: map[string]map[string]any{}, imagenMala: "rota"}
	d := preparar(t, m)
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
	// t1 cambia de imagen (su huella ya no cuadra) y la nueva no se puede descargar.
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/rota@sha256:3"), trampa("vieja", "r/x@sha256:4")}}
	estados, err := Aplicar(context.Background(), d, o, p)
	if err != nil {
		t.Fatal(err)
	}
	descargas.wg.Wait()
	if !strings.Contains(estados[0].Donde, "descargando la imagen nueva; sigue como estaba") {
		t.Fatalf("la descarga va aparte y la trampa sigue: %+v", estados[0])
	}
	estados, _ = Aplicar(context.Background(), d, o, p)
	descargas.wg.Wait()
	if !strings.Contains(estados[0].Donde, "no se pudo descargar la imagen nueva") || !strings.Contains(estados[0].Donde, "sigue como estaba") {
		t.Fatalf("estado tras fallar la descarga: %+v", estados[0])
	}
	if m.hizo("DELETE /containers/c-t1") {
		t.Fatal("sin la imagen nueva no se quita el contenedor que funciona")
	}
}

func TestSinRedAisladaSeRetiraIgualYLoQueFuncionaSigue(t *testing.T) {
	m := &motorFalso{redes: map[string]map[string]any{}, sinSubredes: true}
	d := preparar(t, m)
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:3")}}
	estados, err := Aplicar(context.Background(), d, o, p)
	if err != nil {
		t.Fatal(err)
	}
	if !m.hizo("DELETE /containers/c-vieja") {
		t.Fatal("la trampa que sale del plan se retira aunque falle la red")
	}
	if m.hizo("DELETE /containers/c-t1") || !strings.Contains(estados[0].Donde, "sigue como estaba") {
		t.Fatalf("la que funciona sigue: %+v", estados[0])
	}
}

// motorSinAislamiento: dos trampas del sensor y una sonda (escucha + llama)
// que llega (código 0) o no (código 1).
func motorSinAislamiento(llega bool, creados *[]map[string]any, llamadas *[]string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		*llamadas = append(*llamadas, r.Method+" "+p)
		responder := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case strings.HasPrefix(p, "/networks/"):
			responder(map[string]any{"Options": map[string]string{}, "Containers": map[string]any{}})
		case p == "/containers/json":
			if strings.Contains(r.URL.RawQuery, "sugardaddy.sonda") {
				responder([]map[string]any{})
				return
			}
			responder([]map[string]any{})
		case p == "/containers/escucha/json":
			responder(map[string]any{"NetworkSettings": map[string]any{"Networks": map[string]any{redTrampas: map[string]any{"IPAddress": "10.9.0.9"}}}})
		case p == "/containers/create":
			var c map[string]any
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &c)
			*creados = append(*creados, c)
			id := "trampa"
			if cmd, _ := c["Cmd"].([]any); len(cmd) > 0 {
				id = map[string]string{"escuchar": "escucha", "sondear": "llama"}[cmd[0].(string)]
			}
			responder(map[string]string{"Id": id})
		case p == "/containers/llama/wait":
			codigo := 1
			if llega {
				codigo = 0
			}
			responder(map[string]int{"StatusCode": codigo})
		default:
			responder(map[string]any{})
		}
	}
}

func TestLaSondaAvisaSiLasTrampasSeVen(t *testing.T) {
	for _, llega := range []bool{true, false} {
		sondas = map[string]struct {
			seVen  bool
			cuando time.Time
		}{}
		var creados []map[string]any
		var llamadas []string
		base, _ := os.MkdirTemp("", "dp")
		sock := filepath.Join(base, "d.sock")
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker24, motorSinAislamiento(llega, &creados, &llamadas))}
		go func() { _ = srv.Serve(l) }()
		d := docker.Nuevo(sock)
		o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0", ImagenSonda: "r/sensor@sha256:5"}
		p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("a", "r/x@sha256:1"), trampa("b", "r/x@sha256:1")}}
		estados, err := Aplicar(context.Background(), d, o, p)
		srv.Close()
		os.RemoveAll(base)
		if err != nil {
			t.Fatal(err)
		}
		var escucha, llama map[string]any
		for _, c := range creados {
			if c["Image"] != "r/sensor@sha256:5" {
				continue
			}
			switch c["Cmd"].([]any)[0] {
			case "escuchar":
				escucha = c
			case "sondear":
				llama = c
			}
		}
		if escucha == nil || llama == nil || llama["Cmd"].([]any)[1] != "10.9.0.9:7777" || llama["HostConfig"].(map[string]any)["NetworkMode"] != redTrampas {
			t.Fatalf("la sonda son dos contenedores propios en la red de las trampas: %v %v", escucha, llama)
		}
		for _, c := range llamadas {
			if strings.Contains(c, "/containers/trampa/") && !strings.HasSuffix(c, "/start") {
				t.Fatalf("la sonda no toca las trampas: %s", c)
			}
		}
		for _, e := range estados {
			if strings.Contains(e.Donde, "se ven entre sí") != llega {
				t.Fatalf("llega=%v, estado: %+v", llega, e)
			}
		}
	}
}

func TestUnaRetiradaQueFallaNoParaLoDemas(t *testing.T) {
	m := &motorFalso{redes: map[string]map[string]any{}, noSeBorra: true}
	d := preparar(t, m)
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t2", "r/nueva@sha256:2")}}
	estados, err := Aplicar(context.Background(), d, o, p)
	if err == nil {
		t.Fatal("el fallo al retirar se devuelve")
	}
	if len(m.creados) != 1 || len(estados) != 1 {
		t.Fatalf("la trampa nueva se crea igual y se informa: creados=%d estados=%v", len(m.creados), estados)
	}
	if !m.hizo("DELETE /volumes/sd-s1-huerfana-0") || m.hizo("DELETE /volumes/sd-s1-t2-0") {
		t.Fatal("los volúmenes de trampas retiradas se borran aunque su contenedor ya no esté; los de las que quedan, no")
	}
}

func TestUnaTrampaParadaNoSeArrancaYSeDicePorQue(t *testing.T) {
	m := &motorFalso{redes: map[string]map[string]any{}}
	d := preparar(t, m)
	aviso := "cuota superada (registros.sin-perforar): sus registros pasan de 512 MB"
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0", Paradas: map[string]string{"t1": aviso}}
	// t1 está en marcha y además ha cambiado (su huella ya no cuadra): ni así se rehace.
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:3"), trampa("t2", "r/x@sha256:3")}}
	estados, err := Aplicar(context.Background(), d, o, p)
	if err != nil {
		t.Fatal(err)
	}
	if !m.hizo("POST /containers/c-t1/stop") || m.hizo("DELETE /containers/c-t1") {
		t.Fatalf("la parada en marcha se para, sin quitarla: %v", m.llamadas)
	}
	if len(m.creados) != 1 || m.creados[0]["Labels"].(map[string]any)[etiquetaTrampa] != "t2" {
		t.Fatalf("solo se crea la que no está parada: %v", m.creados)
	}
	if estados[0].Donde != "parada: "+aviso {
		t.Fatalf("el estado dice por qué está parada: %q", estados[0].Donde)
	}
	// Sin la parada, vuelve a crearse.
	o.Paradas = nil
	m.creados = nil
	if _, err := Aplicar(context.Background(), d, o, p); err != nil {
		t.Fatal(err)
	}
	if !m.hizo("DELETE /containers/c-t1") || len(m.creados) != 2 {
		t.Fatalf("al salir de las paradas, la trampa se rehace: %v", m.llamadas)
	}
}

func TestPararSoloTocaLaTrampaPedida(t *testing.T) {
	m := &motorFalso{redes: map[string]map[string]any{}}
	d := preparar(t, m)
	if err := Parar(context.Background(), d, "s1", "t1"); err != nil {
		t.Fatal(err)
	}
	if !m.hizo("POST /containers/c-t1/stop") || m.hizo("POST /containers/c-vieja/stop") {
		t.Fatalf("solo se para la trampa pedida: %v", m.llamadas)
	}
	if !m.hizo("GET /containers/json") {
		t.Fatal("busca sus contenedores por la etiqueta del sensor")
	}
}

// servirMotor levanta h como motor por un socket unix.
func servirMotor(t *testing.T, h http.Handler) *docker.Cliente {
	t.Helper()
	base, err := os.MkdirTemp("", "dp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	if h == nil {
		return docker.Nuevo(sock) // sin nadie escuchando: el motor está parado
	}
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return docker.Nuevo(sock)
}

// Un fallo general del motor llega a la consola como estado de cada trampa
// del plan, con su código. Antes Aplicar no devolvía ninguno y la consola se
// quedaba con el estado anterior, como si todo fuera bien.
func TestUnFalloGeneralDelMotorLlegaACadaTrampa(t *testing.T) {
	error500 := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"failed to connect to containerd"}`))
	})
	for _, c := range []struct {
		nombre string
		motor  http.Handler
		codigo string
	}{
		{"motor parado", nil, docker.MotorInalcanzable},
		{"motor antiguo", motorfalso.Envolver(motorfalso.Docker19, error500), docker.MotorAntiguo},
		{"error de la API", motorfalso.Envolver(motorfalso.Docker27, error500), docker.MotorAPI},
	} {
		t.Run(c.nombre, func(t *testing.T) {
			d := servirMotor(t, c.motor)
			o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0"}
			p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:1"), trampa("t2", "r/y@sha256:2")}}
			estados, err := Aplicar(context.Background(), d, o, p)
			var em *docker.ErrMotor
			if !errors.As(err, &em) || em.Codigo != c.codigo {
				t.Fatalf("tenía que ser un fallo general %s: %v", c.codigo, err)
			}
			if len(estados) != 2 {
				t.Fatalf("cada trampa del plan tiene que llevar el fallo: %+v", estados)
			}
			for _, e := range estados {
				if e.Codigo != c.codigo || !strings.HasPrefix(e.Donde, "error: "+c.codigo+": ") || len(e.Donde) < 40 {
					t.Fatalf("estado sin código o sin explicación: %+v", e)
				}
			}
		})
	}
}

// Con un fallo general del motor, una trampa que ha parado el sensor sigue
// diciendo por qué: con el fallo en su estado, la consola la daría por activa.
func TestUnFalloGeneralDelMotorNoTapaUnaParada(t *testing.T) {
	d := servirMotor(t, nil)
	aviso := "cuota superada (registros.sin-perforar): sus registros pasan de 512 MB"
	o := Opciones{Datos: t.TempDir(), Escucha: "0.0.0.0", Paradas: map[string]string{"t1": aviso}}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:1"), trampa("t2", "r/y@sha256:2")}}
	estados, err := Aplicar(context.Background(), d, o, p)
	var em *docker.ErrMotor
	if !errors.As(err, &em) || em.Codigo != docker.MotorInalcanzable {
		t.Fatalf("el fallo general se devuelve igual: %v", err)
	}
	if len(estados) != 2 {
		t.Fatalf("cada trampa del plan tiene su estado: %+v", estados)
	}
	if estados[0] != (Estado{ID: "t1", Donde: "parada: " + aviso}) {
		t.Fatalf("la parada sigue diciendo por qué, sin el fallo del motor: %+v", estados[0])
	}
	if estados[1].Codigo != docker.MotorInalcanzable || !strings.HasPrefix(estados[1].Donde, "error: "+docker.MotorInalcanzable+": ") {
		t.Fatalf("las demás llevan el fallo del motor: %+v", estados[1])
	}
}
