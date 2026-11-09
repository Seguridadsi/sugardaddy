// Actualizador del nodo de Sugardaddy. Pregunta a la consola local si hay una
// versión firmada pendiente, la verifica con la clave de publicación fijada,
// cambia las imágenes de los servicios y dice cómo ha ido. Si el cambio no
// arranca sano, vuelve atrás solo.
//
// El token (ACTUALIZADOR_TOKEN) y la clave pública (PUBLICACION_CLAVE_PUBLICA)
// van por entorno, no por argumentos.
//
// Desde la 0.12 la versión trae también la configuración del nodo (compose,
// Caddyfile, variables). Entonces no cambia imágenes una a una: lanza un
// auxiliar de un solo uso que la aplica con compose (orden «aplicar»).
//
//	actualizador [flags]        el servicio de siempre
//	actualizador aplicar        el auxiliar (lo lanza el propio actualizador)
//	actualizador salud <url>    comprobación de salud para el healthcheck de compose
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/confianza"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "aplicar":
			os.Exit(aplicar())
		case "salud":
			os.Exit(comprobarSalud(os.Args[2:]))
		}
	}
	consola := flag.String("consola", "http://localhost:5180", "address of the local console")
	socket := flag.String("docker", "/var/run/docker.sock", "Docker socket")
	cada := flag.Duration("cada", 30*time.Second, "how often it checks for a pending version")
	espera := flag.Duration("espera-salud", 90*time.Second, "how long it waits for a changed service to respond healthy")
	versiones := flag.String("versiones", "", "versiones.env file of the node compose project, rewritten after installing (empty: none)")
	modo := flag.String("modo", "nodo", "node (next to the console) or sensor (a sensor on another machine: only the sensor and updater change)")
	ca := flag.String("ca", "", "root of the console CA, if the system does not trust it")
	salud := flag.String("salud", "", "address of the health endpoint for the healthcheck, e.g. :9101 (empty: none)")
	proyecto := flag.String("proyecto", "", "compose project (default: sugardaddy or sugardaddy-sensor, depending on the mode)")
	flag.Parse()

	// Para el auxiliar: la carpeta del nodo vista desde el anfitrión y desde
	// dentro de este contenedor, el proyecto y la red desde la que llegar a la consola.
	cfg := configDeAuxiliar{modo: actualizador.ModoNodo, proyecto: "sugardaddy", red: "sugardaddy_nodo", anfitrion: os.Getenv("NODO_DIR")}
	if *modo == "sensor" {
		cfg = configDeAuxiliar{modo: actualizador.ModoSensorRemoto, proyecto: "sugardaddy-sensor", red: "sugardaddy-sensor_sensor", anfitrion: os.Getenv("CARPETA_ANFITRION")}
	}
	if *proyecto != "" {
		cfg.proyecto = *proyecto
	}
	if *versiones != "" {
		cfg.local = filepath.Dir(*versiones)
	}
	if *salud != "" {
		go servirSalud(*salud)
	}

	// En una máquina con solo un sensor no hay token propio del actualizador:
	// usa el del sensor y pregunta por la versión en la que está el nodo.
	rutas := rutasNodo
	variable := "ACTUALIZADOR_TOKEN"
	if *modo == "sensor" {
		rutas, variable = rutasSensor, "SUGARDADDY_TOKEN"
	}
	token := os.Getenv(variable)
	clave, err := actualizador.ClavePublica(os.Getenv("PUBLICACION_CLAVE_PUBLICA"))
	if token == "" || err != nil {
		slog.Error("missing "+variable+" or a valid PUBLICACION_CLAVE_PUBLICA", "err", err)
		os.Exit(2)
	}

	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()
	d := docker.Nuevo(*socket)
	// Imágenes privadas: credencial de solo lectura (REGISTRO_USUARIO/REGISTRO_TOKEN) para el registro de las versiones.
	if t := os.Getenv("REGISTRO_TOKEN"); t != "" {
		d.ConCredencial(envO("REGISTRO", "ghcr.io"), docker.Credencial{Usuario: os.Getenv("REGISTRO_USUARIO"), Token: t})
	}
	a := &actualizador.Aplicador{
		Docker:      d,
		EsperaSalud: *espera,
		Log:         func(m string, args ...any) { slog.Info(m, args...) },
	}
	if *modo == "sensor" {
		a.Solo = map[string]bool{"sensor": true, "actualizador": true}
	}
	http, err := confianza.Cliente(*ca, 15*time.Second)
	if err != nil {
		slog.Error("console CA", "err", err)
		os.Exit(2)
	}
	slog.Info("updater running", "version", version)
	cfg.docker = d
	cfg.informe = actualizador.Informe{URL: *consola + rutas.resultado, Token: token, HTTP: http}
	var pendiente *resultado

	for {
		// Un resultado que no llegó a la consola (porque se estaba reiniciando)
		// se reintenta antes que nada: si no, el nodo se quedaría en "aplicando".
		if pendiente != nil && informar(ctx, http, *consola, rutas, token, pendiente.version, pendiente.estado, pendiente.detalle) == nil {
			pendiente = nil
		}
		if actualizador.AuxiliarEnMarcha(ctx, d, cfg.proyecto) {
			slog.Info("a helper is applying the configuration; waiting")
		} else {
			// El auxiliar recrea también este contenedor: lo que no llegó a
			// informar a la consola se reintenta en cada vuelta.
			cfg.reinformar(ctx)
			r, err := vuelta(ctx, http, *consola, rutas, token, clave, a, *versiones, cfg)
			if r != nil {
				pendiente = r
			}
			if err != nil {
				slog.Warn("round", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(*cada):
		}
	}
}

type resultado struct{ version, estado, detalle string }

// rutas de la consola: dónde se pregunta por la versión y dónde se informa.
type rutas struct{ pendiente, resultado string }

var (
	rutasNodo   = rutas{"/api/actualizador/pendiente", "/api/actualizador/resultado"}
	rutasSensor = rutas{"/api/sensor/version", "/api/sensor/version"}
)

// vuelta devuelve el resultado final solo si no se pudo entregar a la consola.
func vuelta(ctx context.Context, c *http.Client, base string, ru rutas, token string, clave []byte, a *actualizador.Aplicador, versiones string, cfg configDeAuxiliar) (*resultado, error) {
	pregunta := base + ru.pendiente
	if versiones != "" {
		// La consola solo contesta con una versión si es más nueva que esta.
		pregunta += "?actual=" + url.QueryEscape(actualizador.VersionInstalada(versiones))
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, pregunta, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("consola: %s", resp.Status)
	}
	var p *struct {
		Version string                      `json:"version"`
		Release actualizador.ReleaseFirmada `json:"release"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil || p == nil {
		return nil, err
	}

	r, err := actualizador.Verificar(clave, p.Release)
	if err != nil || r.Version != p.Version {
		// Ni se intenta: la consola ha entregado algo que no es una versión auténtica.
		d := fmt.Sprintf("verification: %v", err)
		return final(ctx, c, base, ru, token, p.Version, "fallida", d), fmt.Errorf("version rejected: %v", err)
	}
	if versiones != "" {
		if inst := actualizador.VersionInstalada(versiones); actualizador.VueltaAtras(inst, r.Version) {
			// Firmada, pero más antigua que la instalada: no se vuelve atrás aunque la consola lo pida.
			d := fmt.Sprintf("version %s is older than the installed %s: not applied", r.Version, inst)
			return final(ctx, c, base, ru, token, r.Version, "fallida", d), errors.New(d)
		}
	}
	slog.Info("installing", "version", r.Version)
	_ = informar(ctx, c, base, ru, token, r.Version, "aplicando", "")
	if cfg.puede(r) {
		// Versión con configuración: la aplica el auxiliar, que informa él mismo.
		return nil, cfg.aplicarConAuxiliar(ctx, r, p.Release)
	}
	if err := a.Aplicar(ctx, r); err != nil {
		return final(ctx, c, base, ru, token, r.Version, "fallida", err.Error()), err
	}
	if versiones != "" {
		// Para que un `docker compose up` posterior no devuelva el nodo a las imágenes viejas.
		if err := actualizador.EscribirVersiones(versiones, r, false); err != nil {
			slog.Error("could not rewrite versiones.env", "err", err)
		}
	}
	slog.Info("version installed", "version", r.Version)
	return final(ctx, c, base, ru, token, r.Version, "aplicada", ""), nil
}

// final informa del resultado y, si la consola no lo recibe, lo devuelve para reintentarlo.
func final(ctx context.Context, c *http.Client, base string, ru rutas, token, version, estado, detalle string) *resultado {
	if informar(ctx, c, base, ru, token, version, estado, detalle) == nil {
		return nil
	}
	return &resultado{version, estado, detalle}
}

func informar(ctx context.Context, c *http.Client, base string, ru rutas, token, version, estado, detalle string) error {
	b, _ := json.Marshal(map[string]string{"version": version, "estado": estado, "detalle": detalle})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+ru.resultado, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		slog.Warn("could not report to the console; will retry", "err", err)
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusConflict {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	return nil
}

func envO(k, porDefecto string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return porDefecto
}

// configDeAuxiliar es lo que el actualizador necesita para lanzar el auxiliar.
type configDeAuxiliar struct {
	modo, proyecto, red string
	anfitrion           string // carpeta del nodo en el anfitrión (NODO_DIR o CARPETA_ANFITRION)
	local               string // la misma carpeta, montada en este contenedor
	docker              *docker.Cliente
	informe             actualizador.Informe
}

// puede: la versión trae configuración para este modo y este actualizador sabe dónde está la carpeta.
func (c configDeAuxiliar) puede(r actualizador.Release) bool {
	conf := r.Nodo
	if c.modo == actualizador.ModoSensorRemoto {
		conf = r.SensorRemoto
	}
	return conf != nil && r.Actualizador != "" && c.anfitrion != "" && c.local != ""
}

func (c configDeAuxiliar) aplicarConAuxiliar(ctx context.Context, r actualizador.Release, f actualizador.ReleaseFirmada) error {
	id, err := actualizador.Lanzar(ctx, c.docker, actualizador.Pedido{
		Imagen: r.Actualizador, Dir: c.anfitrion, Modo: c.modo, Proyecto: c.proyecto, Red: c.red, Firmada: f,
	})
	if err != nil {
		res := actualizador.Resultado{Version: r.Version, Estado: "fallida", Detalle: "could not start the helper: " + err.Error()}
		_ = c.informe.Informar(ctx, res, 3, 5*time.Second)
		return err
	}
	slog.Info("helper started", "version", r.Version)
	// Lo normal es que compose recree este contenedor antes de que el auxiliar
	// acabe. Si no (falló antes), se mira su resultado.
	_, _ = c.docker.Esperar(ctx, id)
	c.reinformar(ctx)
	return nil
}

// reinformar manda a la consola el último resultado del auxiliar si aún no le llegó.
func (c configDeAuxiliar) reinformar(ctx context.Context) {
	if c.local == "" {
		return
	}
	r, ok := actualizador.LeerResultado(c.local)
	// «aplicando»: un auxiliar que murió a mitad. No hay resultado que dar;
	// el siguiente auxiliar retoma desde su copia.
	if !ok || r.Informado || r.Estado == "aplicando" {
		return
	}
	if err := c.informe.Informar(ctx, r, 1, 0); err != nil {
		slog.Warn("could not report the helper result; will retry", "err", err)
		return
	}
	r.Informado = true
	_ = actualizador.GuardarResultado(c.local, r)
}

// aplicar es el auxiliar: aplica la versión firmada que le pasan por entorno.
func aplicar() int {
	dir, modo, proyecto, red := os.Getenv("APLICAR_DIR"), os.Getenv("APLICAR_MODO"), os.Getenv("APLICAR_PROYECTO"), os.Getenv("APLICAR_RED")
	var f actualizador.ReleaseFirmada
	b, err := base64.StdEncoding.DecodeString(os.Getenv("APLICAR_VERSION"))
	if err == nil {
		err = json.Unmarshal(b, &f)
	}
	if dir == "" || proyecto == "" || err != nil {
		slog.Error("missing APLICAR_DIR, APLICAR_PROYECTO or a valid APLICAR_VERSION", "err", err)
		return 2
	}
	env, err := actualizador.LeerEnv(filepath.Join(dir, ".env"))
	if err != nil {
		slog.Error("cannot read .env", "err", err)
		return 2
	}
	d := docker.Nuevo("/var/run/docker.sock")
	if t := env["REGISTRO_TOKEN"]; t != "" {
		d.ConCredencial(env["REGISTRO"], docker.Credencial{Usuario: env["REGISTRO_USUARIO"], Token: t})
	}
	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()
	app := &actualizador.Aplicacion{
		Dir: dir, Modo: modo, Proyecto: proyecto, Compose: "/docker-compose", Docker: d,
		Log: func(m string, args ...any) { slog.Info(m, args...) },
	}
	res := app.Aplicar(ctx, f)
	slog.Info("configuration", "version", res.Version, "estado", res.Estado, "detalle", res.Detalle)
	if err := actualizador.GuardarResultado(dir, res); err != nil {
		slog.Error("could not save the result", "err", err)
	}
	// Hasta ahora fuera de la red del proyecto; para informar, dentro.
	if err := actualizador.UnirseARed(ctx, d, proyecto, red); err != nil {
		slog.Warn("could not join the project network", "red", red, "err", err)
	}
	inf := actualizador.Informe{URL: "http://consola:3000/api/actualizador/resultado", Token: env["ACTUALIZADOR_TOKEN"]}
	ca := ""
	if modo == actualizador.ModoSensorRemoto {
		inf = actualizador.Informe{URL: env["CONSOLA_URL"] + "/api/sensor/version", Token: env["SUGARDADDY_TOKEN"]}
		// Sin el fichero (un remoto de una consola con certificado propio):
		// las raíces del sistema, igual que con el fichero vacío.
		if _, err := os.Stat(filepath.Join(dir, "ca-consola.crt")); err == nil {
			ca = filepath.Join(dir, "ca-consola.crt")
		}
	}
	if inf.HTTP, err = confianza.Cliente(ca, 15*time.Second); err == nil {
		// Mientras compose recrea la consola, no contesta: unos minutos de reintentos.
		if err = inf.Informar(ctx, res, 18, 10*time.Second); err == nil {
			res.Informado = true
			_ = actualizador.GuardarResultado(dir, res)
		}
	}
	if err != nil {
		slog.Warn("could not report to the console; the updater will retry", "err", err)
	}
	if res.Estado != "aplicada" {
		return 1
	}
	return 0
}

// servirSalud responde 200 mientras el proceso esté vivo: es lo que mira el healthcheck de compose.
func servirSalud(dir string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/salud", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	srv := &http.Server{Addr: dir, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("health endpoint", "err", err)
	}
}

// comprobarSalud es el healthcheck: la imagen no tiene shell ni curl.
func comprobarSalud(args []string) int {
	if len(args) != 1 {
		return 2
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(args[0])
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
