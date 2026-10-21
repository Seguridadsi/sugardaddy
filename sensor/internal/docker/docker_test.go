package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
)

// servir levanta un motor falso por un socket unix y devuelve su ruta.
func servir(t *testing.T, h http.Handler) string {
	t.Helper()
	// Ruta corta: macOS no admite rutas de socket de más de 104 caracteres.
	base, err := os.MkdirTemp("", "dk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sock
}

// lista contesta a GET /containers/json; lo demás, 404.
var lista = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/containers/json" {
		_, _ = w.Write([]byte(`[{"Id":"c1","Names":["/sd-s1-t1"],"State":"running","Labels":{"sugardaddy.sensor":"s1"}}]`))
		return
	}
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(`{"message":"no existe"}`))
})

// La matriz: con cada motor se habla la versión que toca y lo que se pide
// llega (el motor falso rechaza, como el de verdad, una versión que no admite).
func TestNegociaConCadaMotor(t *testing.T) {
	for _, c := range []struct {
		nombre      string
		motor       motorfalso.Motor
		api         string
		sinGarantia bool
	}{
		{"Docker 20.10.5 de Debian 11", motorfalso.Docker20_10_5, "1.41", false},
		{"Docker 20.10.7 de Ubuntu 20.04 (clone3 parcheado sin cambiar el número)", motorfalso.Docker20_10_7Ubuntu, "1.41", false},
		{"Docker 20.10.10", motorfalso.Docker20_10_10, "1.41", false},
		{"Docker 24", motorfalso.Docker24, "1.43", false},
		{"Docker 27", motorfalso.Docker27, "1.47", false},
		{"Docker 29.0 (mínima 1.44)", motorfalso.Docker29_0, "1.52", false},
		{"Docker 29.3 (más nueva que la que conocemos)", motorfalso.Docker29_3, APIMaxima, false},
		{"Docker futuro que sube la mínima", motorfalso.DockerFuturo, "1.55", true},
		{"Podman 4", motorfalso.Podman4, "1.41", false},
	} {
		t.Run(c.nombre, func(t *testing.T) {
			d := Nuevo(servir(t, motorfalso.Envolver(c.motor, lista)))
			n, err := d.Negociar(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if n.API != c.api || n.SinGarantia != c.sinGarantia || n.Motor.Version != c.motor.Version {
				t.Fatalf("negociado %+v; se esperaba API %s, sin garantía %v", n, c.api, c.sinGarantia)
			}
			l, err := d.ListarConEtiqueta(context.Background(), "sugardaddy.sensor=s1")
			if err != nil || len(l) != 1 {
				t.Fatalf("la lista no llega: %v %v", l, err)
			}
		})
	}
}

func TestRechazaUnMotorPorDebajoDelMinimo(t *testing.T) {
	for _, c := range []struct {
		nombre string
		motor  motorfalso.Motor
		dice   string
	}{
		{"Docker 19.03", motorfalso.Docker19, "Docker 19.03.15, API 1.40"},
		{"Podman 3", motorfalso.Podman3, "Podman 3.4.4"},
	} {
		t.Run(c.nombre, func(t *testing.T) {
			d := Nuevo(servir(t, motorfalso.Envolver(c.motor, lista)))
			_, err := d.ListarConEtiqueta(context.Background(), "sugardaddy.sensor=s1")
			var em *ErrMotor
			if !errors.As(err, &em) || em.Codigo != MotorAntiguo {
				t.Fatalf("tenía que ser %s: %v", MotorAntiguo, err)
			}
			if !strings.Contains(em.Texto, c.dice) || !strings.Contains(em.Texto, "Docker 20.10 o posterior") {
				t.Fatalf("el mensaje no dice qué motor hay ni qué hace falta: %q", em.Texto)
			}
		})
	}
}

// Un motor que se actualiza mientras el sensor sigue en marcha (live-restore)
// y deja de admitir la versión negociada: se vuelve a negociar sin fallar.
func TestVuelveANegociarSiElMotorCambia(t *testing.T) {
	var mu sync.Mutex
	motor := motorfalso.Docker24
	sock := servir(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		m := motor
		mu.Unlock()
		motorfalso.Envolver(m, lista).ServeHTTP(w, r)
	}))
	d := Nuevo(sock)
	if n, err := d.Negociar(context.Background()); err != nil || n.API != "1.43" {
		t.Fatalf("%+v %v", n, err)
	}
	mu.Lock()
	motor = motorfalso.Docker29_0
	mu.Unlock()
	if _, err := d.ListarConEtiqueta(context.Background(), "sugardaddy.sensor=s1"); err != nil {
		t.Fatal(err)
	}
	if n, _ := d.Negociar(context.Background()); n.API != "1.52" {
		t.Fatalf("no ha vuelto a negociar: %+v", n)
	}
}

func TestClasificaLosFallosGenerales(t *testing.T) {
	ctx := context.Background()
	codigo := func(err error) string {
		var em *ErrMotor
		if !errors.As(err, &em) {
			return "sin clasificar: " + err.Error()
		}
		if em.Texto == "" {
			return "sin texto"
		}
		return em.Codigo
	}
	t.Run("sin socket", func(t *testing.T) {
		base, err := os.MkdirTemp("", "dk")
		if err != nil {
			t.Fatal(err)
		}
		defer os.RemoveAll(base)
		d := Nuevo(filepath.Join(base, "no-esta.sock"))
		_, err = d.ListarConEtiqueta(ctx, "x")
		if c := codigo(d.Clasificar(err)); c != MotorInalcanzable {
			t.Fatal(c)
		}
	})
	t.Run("sin permiso en el socket", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root se salta los permisos del socket")
		}
		sock := servir(t, motorfalso.Envolver(motorfalso.Docker27, lista))
		if err := os.Chmod(sock, 0); err != nil {
			t.Fatal(err)
		}
		d := Nuevo(sock)
		_, err := d.ListarConEtiqueta(ctx, "x")
		if c := codigo(d.Clasificar(err)); c != MotorPermiso {
			t.Fatal(c)
		}
	})
	t.Run("autorización del motor", func(t *testing.T) {
		d := Nuevo(servir(t, motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"authorization denied by plugin opa"}`))
		}))))
		_, err := d.ListarConEtiqueta(ctx, "x")
		if c := codigo(d.Clasificar(err)); c != MotorPermiso {
			t.Fatal(c)
		}
	})
	t.Run("error de la API", func(t *testing.T) {
		d := Nuevo(servir(t, motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"containerd: connection refused"}`))
		}))))
		_, err := d.ListarConEtiqueta(ctx, "x")
		if c := codigo(d.Clasificar(err)); c != MotorAPI {
			t.Fatal(c)
		}
	})
	t.Run("no es un motor", func(t *testing.T) {
		d := Nuevo(servir(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`<html>hola</html>`))
		})))
		_, err := d.ListarConEtiqueta(ctx, "x")
		if c := codigo(d.Clasificar(err)); c != MotorAPI {
			t.Fatal(c)
		}
	})
	t.Run("motor sin versión", func(t *testing.T) {
		d := Nuevo(servir(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{}`))
		})))
		_, err := d.ListarConEtiqueta(ctx, "x")
		if c := codigo(d.Clasificar(err)); c != MotorAPI {
			t.Fatal(c)
		}
	})
}

func TestCompararVersiones(t *testing.T) {
	for _, c := range []struct {
		a, b string
		r    int
	}{
		{"1.9", "1.41", -1},
		{"1.41", "1.41", 0},
		{"1.52", "1.44", 1},
		{"20.10.10", "20.10.9", 1},
		{"20.10.5+dfsg1", "20.10.10", -1},
		{"20.10.25-0ubuntu1~20.04.1", "20.10.10", 1},
		{"v29.0.4", "29.0.4", 0},
		{"dev", "20.10.10", -1},
	} {
		if r := CompararVersiones(c.a, c.b); r != c.r {
			t.Errorf("%s frente a %s: %d, se esperaba %d", c.a, c.b, r, c.r)
		}
	}
}

func TestPasarelasDeUnaRed(t *testing.T) {
	var r Red
	r.IPAM.Config = []struct {
		Subnet  string `json:"Subnet"`
		Gateway string `json:"Gateway"`
	}{
		{Subnet: "172.19.0.0/16", Gateway: "172.19.0.1"},
		// Sin pasarela dicha (algunos Podman): la primera de la subred.
		{Subnet: "fd00:dead:beef::/64"},
		{Subnet: "10.89.3.0/24", Gateway: "::ffff:10.89.3.1"},
	}
	p := r.Pasarelas()
	if strings.Join(p, " ") != "172.19.0.1 fd00:dead:beef::1 10.89.3.1" {
		t.Fatalf("pasarelas: %v", p)
	}
}

// Una sonda corre tan endurecida como una trampa, con el perfil seccomp del
// motor (sin tocarlo), dice cómo ha salido y lo que ha escrito, y no deja
// nada: ni ella ni la que quedara de otra vez.
func TestEjecutarSonda(t *testing.T) {
	sondas := &motorfalso.Sondas{Salida: func(orden []string) (int, string) {
		return 3, "clone3: operation not permitted\n"
	}}
	// La de otra vuelta, cortada a medias, sigue ahí con el mismo nombre.
	sondas.Atender(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/containers/create?name=sd_sonda_s1_prueba", strings.NewReader(`{}`)))
	d := Nuevo(servir(t, motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !sondas.Atender(w, r) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"no existe"}`))
		}
	}))))
	codigo, salida, err := d.EjecutarSonda(context.Background(), Sonda{
		Nombre: "sd_sonda_s1_prueba", Imagen: "r/sensor@sha256:1", Orden: []string{"probar-clone3"}, Red: "none",
		Etiquetas: map[string]string{"sugardaddy.sonda": "s1"},
	})
	if err != nil || codigo != 3 || salida != "clone3: operation not permitted\n" {
		t.Fatalf("código %d, salida %q, error %v", codigo, salida, err)
	}
	if len(sondas.Creadas) != 2 || len(sondas.Borradas) != 2 {
		t.Fatalf("creadas %d y borradas %v: tenía que borrar la vieja y la suya", len(sondas.Creadas), sondas.Borradas)
	}
	hc, _ := sondas.Creadas[1]["HostConfig"].(map[string]any)
	if hc["NetworkMode"] != "none" || hc["ReadonlyRootfs"] != true || fmt.Sprint(hc["CapDrop"]) != "[ALL]" ||
		fmt.Sprint(hc["SecurityOpt"]) != "[no-new-privileges]" || hc["PidsLimit"] == nil || hc["Memory"] == nil {
		t.Fatalf("la sonda no va endurecida como una trampa: %v", hc)
	}
	if sondas.Creadas[1]["Image"] != "r/sensor@sha256:1" || fmt.Sprint(sondas.Creadas[1]["Cmd"]) != "[probar-clone3]" {
		t.Fatalf("sonda: %v", sondas.Creadas[1])
	}
}

// Al borrar una trampa se van también los volúmenes anónimos que declara su
// imagen: si no, cada vez que se rehace quedan en la máquina del cliente.
func TestBorrarQuitaLosVolumenesAnonimos(t *testing.T) {
	var pedido string
	h := motorfalso.Envolver(motorfalso.Docker29_3, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			pedido = r.URL.Path + "?" + r.URL.RawQuery
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	c := Nuevo(servir(t, h))
	if err := c.Borrar(context.Background(), "c1"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(pedido, "/containers/c1?force=1&v=1") {
		t.Fatalf("borrado pedido: %q", pedido)
	}
}
