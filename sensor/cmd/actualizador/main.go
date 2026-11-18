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
//	actualizador cortafuegos    el auxiliar del acceso a la consola por IP (docs/diseno/acceso-consola.md)
//	actualizador cortafuegos-trampas
//	                            el auxiliar que impide a las trampas llegar a la máquina por su pasarela (SEN-5)
//	actualizador cortafuegos-anfitrion
//	                            el auxiliar del cortafuegos estricto de la máquina, nftables (docs/diseno/cortafuegos-anfitrion.md)
//	actualizador anfitrion      el auxiliar que mira la máquina (SSH, Docker), pone las reglas de auditd y,
//	                            en el appliance, sube Docker a la versión firmada (docs/diseno/cortafuegos-anfitrion.md)
//	actualizador disco          el auxiliar de los discos de las trampas, que lanza el sensor (docs/diseno/discos-trampa.md)
//	actualizador ca             el auxiliar que pasa el nodo a su CA propia (docs/diseno/ca-nodo.md)
//	actualizador aislar-anfitrion
//	                            pone en la máquina el perfil AppArmor de las trampas y sd-discos
//	                            (lo lanza el auxiliar de cada versión; docs/diseno/aislamiento-trampas.md)
//	actualizador ca-generar <carpeta> <dirección> [nodo]
//	                            crea la CA propia si falta o no cubre la dirección (lo llama instalar.sh)
//	actualizador copias-smb <op> [copia]
//	                            el auxiliar de las copias en una carpeta compartida SMB (docs/diseno/copias-fuera.md)
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
	"io"
	"log/slog"
	"net/http"
	stdhttp "net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/catalogo"
	"github.com/kinomakino/sugardaddy/sensor/internal/confianza"
	"github.com/kinomakino/sugardaddy/sensor/internal/copias"
	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "aplicar":
			os.Exit(aplicar())
		case "cortafuegos":
			os.Exit(cortafuegosAuxiliar())
		case "cortafuegos-trampas":
			os.Exit(cortafuegosTrampas())
		case "cortafuegos-anfitrion":
			os.Exit(cortafuegosAnfitrion())
		case "anfitrion":
			os.Exit(anfitrionAuxiliar())
		case "disco":
			os.Exit(discoAuxiliar())
		case "ca":
			os.Exit(caAuxiliar())
		case "ca-sensores":
			os.Exit(caSensoresAuxiliar())
		case "aislar-anfitrion":
			os.Exit(aislarAnfitrion())
		case "ca-generar":
			os.Exit(caGenerar(os.Args[2:]))
		case "copias-smb":
			os.Exit(copias.Auxiliar(context.Background(), os.Args[2:], os.Getenv("COPIAS_CARPETA"), copias.RaicesAuxiliar, os.Stdout))
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
	certificado := flag.String("certificado", "", "client certificate and key (one PEM) of the sensor on another machine, which it presents and renews (docs/diseno/mtls-sensores.md)")
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
	clave := actualizador.ConfianzaDelEntorno(os.Getenv)
	if token == "" || (clave.Legado == nil && len(clave.Claves) == 0) {
		slog.Error("missing " + variable + " or a valid PUBLICACION_CLAVES / PUBLICACION_CLAVE_PUBLICA")
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
	http, err := confianza.ClienteConCertificado(*ca, *certificado, 15*time.Second)
	if err != nil {
		slog.Error("console CA", "err", err)
		os.Exit(2)
	}
	slog.Info("updater running", "version", version)
	cfg.docker = d
	cfg.informe = actualizador.Informe{URL: *consola + rutas.resultado, Token: token, HTTP: http}
	var pendiente *resultado
	// Solo en el nodo: el puerto de la consola, abierto solo a las IP de su lista.
	var acceso *actualizador.Acceso
	// Solo en el nodo: la CA propia del HTTPS de la consola (docs/diseno/ca-nodo.md).
	var caNodo *actualizador.CANodo
	if *modo != "sensor" && cfg.local != "" {
		acceso = &actualizador.Acceso{Docker: d, Consola: *consola, Token: token, HTTP: http, Local: cfg.local,
			Log: func(m string, args ...any) { slog.Info(m, args...) }}
		caNodo = &actualizador.CANodo{Docker: d, Consola: *consola, Token: token, HTTP: http, Local: cfg.local,
			Anfitrion: cfg.anfitrion, Proyecto: cfg.proyecto, Red: cfg.red,
			Log: func(m string, args ...any) { slog.Info(m, args...) }}
	}
	// Solo en el nodo: que Caddy pida certificado de cliente a los sensores remotos
	// con la raíz de la CA de sensores de la consola (docs/diseno/mtls-sensores.md).
	var caSensores *actualizador.CASensores
	if *modo != "sensor" && cfg.local != "" {
		caSensores = &actualizador.CASensores{Docker: d, Consola: *consola, Token: token, HTTP: http, Local: cfg.local,
			Anfitrion: cfg.anfitrion, Proyecto: cfg.proyecto,
			Log: func(m string, args ...any) { slog.Info(m, args...) }}
	}
	// Solo en el nodo: las copias de copia.sh, al almacén del cliente (docs/diseno/copias-fuera.md).
	// En su propia goroutine: una subida larga no frena las actualizaciones.
	if *modo != "sensor" && cfg.local != "" {
		fuera := &actualizador.CopiasFuera{Docker: d, Consola: *consola, Token: token, HTTP: http,
			Local: cfg.local, Anfitrion: cfg.anfitrion,
			Log: func(m string, args ...any) { slog.Info(m, args...) }}
		go func() {
			for {
				if err := fuera.Vuelta(ctx); err != nil {
					slog.Warn("off-machine backups", "err", err)
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Minute):
				}
			}
		}()
	}
	// Solo en el nodo: comparar la máquina con su versión firmada y contarlo (integridad.desviacion).
	var integridad *actualizador.Integridad
	if *modo != "sensor" && cfg.local != "" {
		integridad = &actualizador.Integridad{Docker: d, Local: cfg.local, Confianza: clave,
			Edicion: actualizador.EdicionDelNodo(os.Getenv), Consola: *consola, Token: token, HTTP: http,
			Log: func(m string, args ...any) { slog.Warn(m, args...) }}
	}
	// En el nodo y en un sensor remoto: que las trampas no lleguen a la máquina por la
	// pasarela de su puente (SEN-5).
	var pasarela *actualizador.PasarelaTrampas
	if cfg.local != "" {
		pasarela = &actualizador.PasarelaTrampas{Docker: d, Local: cfg.local,
			Log: func(m string, args ...any) { slog.Info(m, args...) }}
	}
	// En el nodo y en un sensor remoto: el cortafuegos estricto de la máquina, lo que se
	// mira de ella (SSH, auditd, Docker) y sus eventos de auditd
	// (docs/diseno/cortafuegos-anfitrion.md). El sensor remoto pregunta y cuenta por las
	// rutas del sensor, con su token, y en su máquina no hay puerto de la consola.
	estatica := strings.TrimRight(envO("MARCA_URL", actualizador.URLMarcaEstatica), "/")
	// La copia estática (marca de tiempo e imágenes retiradas) no es la consola: sin su CA ni
	// su certificado de cliente, por el proxy del entorno si lo hay.
	fuera := &stdhttp.Client{Timeout: 15 * time.Second}
	var estricto *actualizador.EstrictoNodo
	var maquina *actualizador.MaquinaNodo
	var auditd *actualizador.AuditdNodo
	if cfg.local != "" {
		ruta := actualizador.RutaAnfitrionNodo
		propios := []string{actualizador.DestinoDeURL(estatica)}
		if *modo == "sensor" {
			ruta = actualizador.RutaAnfitrionSensor
			propios = append(propios, actualizador.DestinoDeURL(*consola))
		}
		estricto = &actualizador.EstrictoNodo{Docker: d, Consola: *consola, Token: token, HTTP: http,
			Local: cfg.local, Anfitrion: cfg.anfitrion, Ruta: ruta, SinConsola: *modo == "sensor",
			Propios: propios, Proxy: actualizador.DestinoDeURL(envO("HTTPS_PROXY", os.Getenv("https_proxy"))),
			Log: func(m string, args ...any) { slog.Info(m, args...) }}
		maquina = &actualizador.MaquinaNodo{Docker: d, Consola: *consola, Token: token, HTTP: http,
			Local: cfg.local, Anfitrion: cfg.anfitrion, Confianza: clave, Edicion: actualizador.EdicionDelNodo(os.Getenv),
			Ruta: ruta, Log: func(m string, args ...any) { slog.Warn(m, args...) }}
		auditd = &actualizador.AuditdNodo{Consola: *consola, Token: token, HTTP: http, Local: cfg.local,
			Ruta: ruta, Logf: func(m string, args ...any) { slog.Warn(m, args...) }}
	}
	// En un sensor remoto: las raíces en las que confía para hablar con la consola.
	var raices *actualizador.RaizRemota
	if *modo == "sensor" && *ca != "" && cfg.local != "" {
		raices = &actualizador.RaizRemota{Consola: *consola, Token: token, HTTP: http,
			Fichero: filepath.Join(cfg.local, "ca-consola.crt"),
			Log:     func(m string, args ...any) { slog.Info(m, args...) }}
	}

	// En un sensor remoto: su certificado de cliente, renovado antes de caducar
	// (docs/diseno/mtls-sensores.md). Solo con un compose que lo monta.
	var certificadoSensor *actualizador.CertificadoSensor
	if *modo == "sensor" && *certificado != "" {
		certificadoSensor = &actualizador.CertificadoSensor{Consola: *consola, Token: token, HTTP: http,
			Fichero: *certificado, Log: func(m string, args ...any) { slog.Info(m, args...) }}
	}

	// Trampas de partner (docs/diseno/trampas-de-partner.md): solo si esta máquina tiene
	// PARTNER. Trae su catálogo de la consola, lo comprueba y lo deja para el sensor.
	var partner *catalogo.Traedor
	if p := strings.TrimSpace(os.Getenv("PARTNER")); p != "" && cfg.local != "" {
		partner = &catalogo.Traedor{URL: *consola + rutas.partner, Token: token, HTTP: http, Dir: cfg.local,
			Partner: p, Confianza: clave, Log: func(m string, args ...any) { slog.Info(m, args...) }}
	}

	// La marca de tiempo (docs/diseno/firmas-raiz.md): solo en el nodo, que tiene su carpeta.
	var vigia *actualizador.Vigia
	if *modo != "sensor" && cfg.local != "" {
		vigia = &actualizador.Vigia{
			Estatica: estatica,
			Consola:  *consola + "/api/actualizador/marca", Token: token, HTTP: http,
			Fuera: fuera, Dir: cfg.local,
			Edicion: actualizador.EdicionDelNodo(os.Getenv), Versiones: *versiones,
			Log: func(m string, args ...any) { slog.Info(m, args...) },
			// Del .env en cada vuelta: una versión puede haber cambiado las claves.
			Claves: func() (actualizador.Confianza, []string) {
				env, _ := actualizador.LeerEnv(filepath.Join(cfg.local, ".env"))
				get := func(k string) string {
					if v, ok := env[k]; ok {
						return v
					}
					return os.Getenv(k)
				}
				return actualizador.ConfianzaDelEntorno(get), actualizador.LeerClavesMarca(get("PUBLICACION_MARCAS"))
			},
		}
		cfg.vigia = vigia
	}

	var ultimaFirmada, ultimoPartner, ultimaMarca, ultimasRetiradas time.Time
	for {
		// Un resultado que no llegó a la consola (porque se estaba reiniciando)
		// se reintenta antes que nada: si no, el nodo se quedaría en "aplicando".
		if pendiente != nil && informar(ctx, http, *consola, rutas, token, pendiente.version, pendiente.estado, pendiente.detalle) == nil {
			pendiente = nil
		}
		if actualizador.AuxiliarEnMarcha(ctx, d, cfg.proyecto) {
			slog.Info("a helper is applying the configuration; waiting")
		} else if actualizador.AuxiliarCAEnMarcha(ctx, d, cfg.proyecto) {
			slog.Info("a helper is changing the node CA; waiting")
		} else {
			// El auxiliar recrea también este contenedor: lo que no llegó a
			// informar a la consola se reintenta en cada vuelta.
			cfg.reinformar(ctx)
			if cfg.local != "" && time.Since(ultimaFirmada) > 10*time.Minute {
				ultimaFirmada = time.Now()
				traerFirmadaInstalada(ctx, http, *consola+rutas.firmada, token, clave, *versiones, cfg.local)
			}
			if partner != nil && time.Since(ultimoPartner) > 5*time.Minute {
				ultimoPartner = time.Now()
				if err := partner.Vuelta(ctx); err != nil {
					slog.Warn("partner catalog", "err", err)
				}
			}
			if vigia != nil && time.Since(ultimaMarca) > time.Hour {
				ultimaMarca = time.Now()
				e, err := vigia.Vuelta(ctx, time.Now())
				if err != nil {
					slog.Warn("timestamp", "err", err)
				}
				if e.Estado == "caducada" || e.Estado == "retenida" {
					slog.Warn("timestamp", "estado", e.Estado, "detalle", e.Detalle)
				}
			}
			// Las imágenes retiradas por SeguridadSI (manual 3 de respuesta a incidentes), de la
			// misma copia estática que la marca de tiempo: el panel no las controla. También en
			// un sensor remoto, que no tiene marca de tiempo propia.
			if cfg.local != "" && time.Since(ultimasRetiradas) > time.Hour {
				ultimasRetiradas = time.Now()
				if cambio, err := actualizador.TraerRetiradas(ctx, fuera, estatica, actualizador.CarpetaRetiradas(cfg.local), clavesRetiradas(cfg.local, clave), actualizador.EdicionDelNodo(os.Getenv)); err != nil {
					slog.Warn("retired images", "err", err)
				} else if cambio {
					slog.Warn("SeguridadSI has retired images: this machine will not start them")
				}
			}
			r, err := vuelta(ctx, http, *consola, rutas, token, clave, a, *versiones, cfg)
			if r != nil {
				pendiente = r
			}
			if err != nil {
				slog.Warn("round", "err", err)
			}
			if acceso != nil {
				if err := acceso.Vuelta(ctx); err != nil {
					slog.Warn("console access", "err", err)
				}
			}
			if caNodo != nil {
				if err := caNodo.Vuelta(ctx); err != nil {
					slog.Warn("node CA", "err", err)
				}
			}
			if caSensores != nil {
				if err := caSensores.Vuelta(ctx); err != nil {
					slog.Warn("remote sensor CA", "err", err)
				}
			}
			if pasarela != nil {
				if err := pasarela.Vuelta(ctx); err != nil {
					slog.Warn("decoy bridge firewall", "err", err)
				}
			}
			if estricto != nil {
				if err := estricto.Vuelta(ctx); err != nil {
					slog.Warn("strict host firewall", "err", err)
				}
			}
			if maquina != nil {
				if err := maquina.Vuelta(ctx); err != nil {
					slog.Warn("host facts", "err", err)
				}
			}
			if auditd != nil {
				if err := auditd.Vuelta(ctx); err != nil {
					slog.Warn("host audit", "err", err)
				}
			}
			if integridad != nil {
				if err := integridad.Vuelta(ctx); err != nil {
					slog.Warn("node integrity", "err", err)
				}
			}
			if raices != nil {
				if err := raices.Vuelta(ctx); err != nil {
					slog.Warn("console CA roots", "err", err)
				}
			}
			if certificadoSensor != nil {
				if err := certificadoSensor.Vuelta(ctx); err != nil {
					slog.Warn("client certificate", "err", err)
				}
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
type rutas struct{ pendiente, resultado, firmada, partner string }

var (
	rutasNodo   = rutas{"/api/actualizador/pendiente", "/api/actualizador/resultado", "/api/actualizador/version-firmada", "/api/actualizador/catalogo-partner"}
	rutasSensor = rutas{"/api/sensor/version", "/api/sensor/version", "/api/sensor/version-firmada", "/api/sensor/catalogo-partner"}
)

// vuelta devuelve el resultado final solo si no se pudo entregar a la consola.
func vuelta(ctx context.Context, c *http.Client, base string, ru rutas, token string, clave actualizador.Confianza, a *actualizador.Aplicador, versiones string, cfg configDeAuxiliar) (*resultado, error) {
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
		// La política que eligió el cliente en su consola y su aprobación de esta versión
		// (docs/diseno/politica-cambios.md). Las consolas anteriores no lo mandan.
		Politica   *actualizador.Politica   `json:"politica"`
		Aprobacion *actualizador.Aprobacion `json:"aprobacion"`
	}
	// Con tope, como traerFirmadaInstalada (auditoría 2026-11-14, §5 h08).
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&p); err != nil || p == nil {
		return nil, err
	}

	r, err := actualizador.VerificarEnNodo(clave, actualizador.EdicionDelNodo(os.Getenv), p.Release)
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
	// Una versión que lleve una imagen retirada por SeguridadSI (registro comprometido) no se
	// instala, aunque venga firmada.
	if cfg.local != "" {
		retiradas, err := actualizador.RetiradasGuardadas(actualizador.CarpetaRetiradas(cfg.local), clave, actualizador.EdicionDelNodo(os.Getenv))
		if err != nil {
			return nil, fmt.Errorf("cannot read the retired image list on this machine: %w", err)
		}
		if img := retiradas.EnRelease(r); img != "" {
			d := fmt.Sprintf("version %s uses an image retired by SeguridadSI (%s): not applied", r.Version, img)
			return final(ctx, c, base, ru, token, r.Version, "fallida", d), errors.New(d)
		}
	}
	// La política de cambios del cliente: la decide este actualizador, no la consola ni el
	// panel. Esperar no es fallar: no se informa nada y se vuelve a mirar en la vuelta siguiente.
	politica := cfg.politicaLocal()
	if p.Politica != nil {
		politica = actualizador.MasEstricta(politica, *p.Politica)
	}
	if e := actualizador.ComprobarPolitica(r, politica, p.Aprobacion, cfg.modo != actualizador.ModoSensorRemoto, time.Now()); e.Motivo != "" {
		return nil, errors.New(e.String())
	}
	// El registro de transparencia (docs/diseno/firmas-raiz.md §4): una versión que no está en
	// él no se instala. No se da por fallida (la consola no la volvería a ofrecer): se espera,
	// se avisa y se vuelve a mirar, por si la copia pública aún no la tiene.
	if cfg.vigia != nil {
		estado, detalle := cfg.vigia.ComprobarRegistro(ctx, actualizador.EdicionDelNodo(os.Getenv), p.Release.Release, time.Now())
		exigir := os.Getenv("REGISTRO_EXIGIR") == "1"
		if estado == actualizador.RegistroAusente || (estado == actualizador.RegistroSinPrueba && exigir) {
			_ = cfg.vigia.Informar(ctx, time.Now())
			return nil, errors.New(detalle)
		}
		if estado == actualizador.RegistroSinPrueba {
			slog.Warn("installing without a transparency log proof", "detalle", detalle)
			_ = cfg.vigia.Informar(ctx, time.Now())
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
	// El catálogo firmado para el sensor (SEN-3), también en una versión solo de imágenes.
	if cfg.local != "" && r.Catalogo != nil {
		if err := actualizador.GuardarFirmada(cfg.local, p.Release); err != nil {
			slog.Error("could not leave the signed version for the sensor", "err", err)
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

// clavesRetiradas: las claves en las que se confía, del .env de la carpeta en cada vuelta
// (una versión puede haberlas cambiado) y, si no están allí, las del entorno.
func clavesRetiradas(local string, deEntorno actualizador.Confianza) actualizador.Confianza {
	env, err := actualizador.LeerEnv(filepath.Join(local, ".env"))
	if err != nil {
		return deEntorno
	}
	c := actualizador.ConfianzaDelEntorno(func(k string) string {
		if v, ok := env[k]; ok {
			return v
		}
		return os.Getenv(k)
	})
	if c.Legado == nil && len(c.Claves) == 0 {
		return deEntorno
	}
	return c
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
	vigia               *actualizador.Vigia // la marca y el registro de transparencia (solo en el nodo)
}

// politicaLocal es el suelo de la política de cambios: el .env de la carpeta del nodo (se lee
// en cada vuelta) y, si no hay carpeta, el entorno del proceso.
func (c configDeAuxiliar) politicaLocal() actualizador.Politica {
	if c.local == "" {
		return actualizador.PoliticaDelEntorno(os.Getenv)
	}
	env, err := actualizador.LeerEnv(filepath.Join(c.local, ".env"))
	if err != nil {
		return actualizador.PoliticaDelEntorno(os.Getenv)
	}
	return actualizador.MasEstricta(actualizador.PoliticaDelEntorno(func(k string) string { return env[k] }),
		actualizador.PoliticaDelEntorno(os.Getenv))
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
	// La consola en una IP fijada al instalar (un sensor que no resuelve su nombre).
	env, _ := actualizador.LeerEnv(filepath.Join(c.local, ".env"))
	id, err := actualizador.Lanzar(ctx, c.docker, actualizador.Pedido{
		Imagen: r.Actualizador, Dir: c.anfitrion, Modo: c.modo, Proyecto: c.proyecto, Red: c.red, Firmada: f,
		Hosts: actualizador.HostsFijos(env),
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

// aplicar es el auxiliar: aplica la versión firmada que le pasan por entorno (en trozos si
// no cabe en una variable: VariablesVersion).
func aplicar() int {
	dir, modo, proyecto, red := os.Getenv("APLICAR_DIR"), os.Getenv("APLICAR_MODO"), os.Getenv("APLICAR_PROYECTO"), os.Getenv("APLICAR_RED")
	var f actualizador.ReleaseFirmada
	b64, err := actualizador.LeerVariablesVersion(os.Getenv)
	var b []byte
	if err == nil {
		b, err = base64.StdEncoding.DecodeString(b64)
	}
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
	cert := ""
	if modo == actualizador.ModoSensorRemoto {
		cert = filepath.Join(dir, actualizador.FicheroCertificadoSensor)
	}
	if inf.HTTP, err = confianza.ClienteConCertificado(ca, cert, 15*time.Second); err == nil {
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

// cortafuegosAuxiliar es el auxiliar del acceso a la consola: pone (o quita) la
// regla en el cortafuegos de la máquina y escribe el resultado en una línea JSON.
func cortafuegosAuxiliar() int {
	puerto, _ := strconv.Atoi(os.Getenv("ACCESO_PUERTO"))
	var redes []string
	for _, r := range strings.Split(os.Getenv("ACCESO_REDES"), ",") {
		if r = strings.TrimSpace(r); r != "" {
			redes = append(redes, r)
		}
	}
	p := cortafuegos.Pedido{Abierta: os.Getenv("ACCESO_ABIERTA") == "1", Redes: redes, Puerto: puerto, Escucha: os.Getenv("ACCESO_ESCUCHA")}
	ctx, cancelar := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancelar()
	r := cortafuegos.Aplicar(ctx, p, cortafuegos.Exec)
	b, _ := json.Marshal(r)
	fmt.Println(string(b))
	switch r.Estado {
	case cortafuegos.Aplicada, cortafuegos.Abierta:
		return 0
	case cortafuegos.SinDockerUser:
		return 3
	}
	return 1
}

// cortafuegosTrampas pone la regla de SEN-5 en el cortafuegos de la máquina y
// escribe el resultado en una línea JSON.
func cortafuegosTrampas() int {
	ctx, cancelar := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancelar()
	r := cortafuegos.AplicarTrampas(ctx, cortafuegos.Exec)
	b, _ := json.Marshal(r)
	fmt.Println(string(b))
	if r.Estado != cortafuegos.Aplicada {
		return 1
	}
	return 0
}

// cortafuegosAnfitrion es el auxiliar del cortafuegos estricto: aplica la tabla
// nftables (o la quita) y escribe el resultado en una línea JSON. Al aplicar, espera
// a que el actualizador confirme la huella en /confirmar/confirmado; si no llega en
// ESTRICTO_PLAZO segundos, vuelve a la tabla de antes.
func cortafuegosAnfitrion() int {
	ctx, cancelar := context.WithTimeout(context.Background(), 11*time.Minute)
	defer cancelar()
	var r cortafuegos.ResultadoEstricto
	if os.Getenv("ESTRICTO_QUITAR") == "1" {
		r = cortafuegos.QuitarEstricto(ctx, cortafuegos.Exec)
	} else if e, err := cortafuegos.LeerEstricto(os.Getenv("ESTRICTO")); err != nil {
		r = cortafuegos.ResultadoEstricto{Estado: cortafuegos.ConError, Detalle: err.Error()}
	} else {
		plazo, _ := strconv.Atoi(os.Getenv("ESTRICTO_PLAZO"))
		if plazo < 30 || plazo > 600 {
			plazo = 90
		}
		confirmado := func(h string) bool {
			b, err := os.ReadFile("/confirmar/confirmado")
			return err == nil && strings.TrimSpace(string(b)) == h
		}
		r = cortafuegos.AplicarEstricto(ctx, e, cortafuegos.Exec, confirmado, time.Duration(plazo)*time.Second)
	}
	b, _ := json.Marshal(r)
	fmt.Println(string(b))
	switch r.Estado {
	case cortafuegos.EstrictoAplicado, cortafuegos.EstrictoQuitado:
		return 0
	}
	return 1
}

// discoAuxiliar es el auxiliar de los discos de las trampas: lo lanza el sensor con
// su pedido en DISCO_PEDIDO y escribe el resultado en una línea JSON marcada. Sale
// con 0 siempre que la escribe: lo que haya pasado va en ella.
func discoAuxiliar() int {
	var p discos.Pedido
	b, err := base64.StdEncoding.DecodeString(os.Getenv("DISCO_PEDIDO"))
	if err == nil {
		err = json.Unmarshal(b, &p)
	}
	var r discos.Resultado
	if err != nil {
		r = discos.Resultado{Codigo: discos.CodigoError, Detalle: "invalid DISCO_PEDIDO: " + err.Error()}
	} else {
		ctx, cancelar := context.WithTimeout(context.Background(), 9*time.Minute)
		defer cancelar()
		r = discos.NuevoAuxiliar().Aplicar(ctx, p)
	}
	salida, _ := json.Marshal(discos.LineaResultado{V: discos.VersionResultado, Resultado: r})
	fmt.Println(string(salida))
	return 0
}

// aislarAnfitrion entra en la raíz de la máquina (la de su PID 1: el contenedor
// corre privilegiado y con el PID de la máquina) y pone allí el perfil AppArmor de
// las trampas y sd-discos, como instalar.sh. Escribe el resultado en una línea JSON
// y sale con 0 siempre que la escribe.
func aislarAnfitrion() int {
	datos := os.Getenv("AISLAR_DATOS")
	var r actualizador.ResultadoAnfitrion
	switch {
	case !actualizador.RutaDatosValida(datos):
		r = actualizador.ResultadoAnfitrion{AppArmor: actualizador.PiezaFallo, Discos: actualizador.PiezaFallo,
			Detalle: []string{"invalid AISLAR_DATOS"}}
	default:
		if err := entrarEnLaMaquina(); err != nil {
			r = actualizador.ResultadoAnfitrion{AppArmor: actualizador.PiezaFallo, Discos: actualizador.PiezaFallo,
				Detalle: []string{"cannot enter the machine root: " + err.Error()}}
			break
		}
		r = actualizador.Anfitrion{Raiz: "/", Ejecutar: ejecutarEnLaMaquina, Hay: hayEnLaMaquina}.Preparar(datos)
	}
	b, _ := json.Marshal(map[string]any{"aislamiento": r})
	fmt.Println(string(b))
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

// traerFirmadaInstalada: si la máquina no tiene la versión firmada de lo que lleva instalado
// (una instalación nueva cuyo instalador no la dejó), se la pide a la consola, la comprueba
// con sus propias claves y su edición, y la deja para el sensor (SEN-3, A1 de la revisión).
// La consola no puede hacer nada con esto que no esté firmado: solo entrega.
func traerFirmadaInstalada(ctx context.Context, c *http.Client, url, token string, clave actualizador.Confianza, versiones, dir string) {
	if _, err := os.Stat(filepath.Join(dir, actualizador.FicheroFirmada)); err == nil {
		return
	}
	inst := actualizador.VersionInstalada(versiones)
	if inst == "" {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"?version="+inst, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	var p *struct {
		Release actualizador.ReleaseFirmada `json:"release"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&p); err != nil || p == nil {
		return
	}
	r, err := actualizador.VerificarEnNodo(clave, actualizador.EdicionDelNodo(os.Getenv), p.Release)
	if err != nil || r.Version != inst || r.Catalogo == nil {
		slog.Warn("the console did not deliver a usable signed version of the installed one", "err", err)
		return
	}
	if err := actualizador.GuardarFirmada(dir, p.Release); err != nil {
		slog.Error("could not leave the signed version for the sensor", "err", err)
		return
	}
	slog.Info("signed version of the installed one left for the sensor", "version", inst)
}
