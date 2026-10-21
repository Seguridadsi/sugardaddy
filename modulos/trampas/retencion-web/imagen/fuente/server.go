// protocol/http/server.go de go-pot v1.1.2 (https://github.com/ryanolee/go-pot,
// MIT, Copyright (c) 2024 Ryan Lee), modificado por SeguridadSI para la trampa
// retencion-web de Sugardaddy. preparar.sh comprueba que el original no ha
// cambiado (su suma SHA-256) antes de sustituirlo por este. Los cambios:
//   - Fiber inmutable: lo que el registro guarda al empezar (ruta, host,
//     User-Agent) salía cambiado en la línea de fin, escrita minutos después.
//   - Topes de memoria y de tiempo por conexión (abajo, en las constantes) y
//     un limitador de conexiones por IP y en total (cupos.go), con el total
//     sacado del límite de memoria (conexionesParaMemoria) y repartido de
//     forma justa cuando se llena (conexionesGarantizadas). go-pot no lee
//     nunca el cuerpo: no pasa de 4 KiB y, si la cabecera es de las que
//     fasthttp guarda caras o el cuerpo va troceado, ni se espera.
//   - Respuestas de error de un servidor web normal: go-pot contestaba «200
//     {}» a todo lo que no era un GET (un POST, con Allow: GET, HEAD) y a las
//     peticiones mal formadas, y Fiber «Invalid http method» a un método
//     raro. Ahora el código que corresponde (405, 400, 408, 413, 431, 501,
//     503) con su texto estándar. Y se apuntan (phase "error"): go-pot no las
//     veía. Si fasthttp no ha llegado a leer la petición, sin inventar método
//     ni ruta.
//   - robots.txt propio de cada trampa (robots.go), no el mismo en toda la flota.
package http

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"runtime/debug"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/utils"
	"github.com/valyala/fasthttp"
	"go.uber.org/fx"
	"go.uber.org/zap"

	"github.com/ryanolee/go-pot/config"
	"github.com/ryanolee/go-pot/protocol/http/logging"
	"github.com/ryanolee/go-pot/protocol/http/stall"
)

const (
	// limiteCuerpo: go-pot no lee el cuerpo. Con más, fasthttp corta en
	// cuanto lee la cabecera (Content-Length): 413 sin esperar nada.
	limiteCuerpo = 4096
	// tamCabecera: la cabecera entera, con la línea de petición, cabe en el
	// búfer de lectura (el valor de Fiber). Más, 431. No se baja: es lo que
	// deja ver las rutas largas de los ataques (inyecciones, recorridos).
	tamCabecera = 4096
	// maxSeparadores: fasthttp guarda cada línea de la cabecera, y cada
	// nombre de la de Trailer, en una entrada propia (56 bytes más dos
	// reservas). Con 4 KiB de líneas o comas sueltas eran 85-130 KiB por
	// petición, retenidos mientras llegaba el cuerpo o mientras el tarpit la
	// tenía. Una petición normal no pasa de 40 entre saltos de línea y comas;
	// con más de 128 se contesta 431 al momento, sin esperar el cuerpo.
	maxSeparadores = 128

	// Plazos. Ninguna conexión espera sin fin: el primer byte (cupos.go), la
	// cabecera desde ese byte (ReadTimeout), el cuerpo desde la cabecera
	// (HeaderReceived) y la siguiente petición (IdleTimeout). Una petición
	// tarda como mucho 15 s en llegar entera.
	plazoPrimerByte = 15 * time.Second
	plazoCabecera   = 10 * time.Second
	plazoCuerpo     = 5 * time.Second
	plazoInactiva   = 15 * time.Second

	// Conexiones abiertas a la vez: por IP (las 50 que retiene el tarpit y
	// algunas más) y, en total, las que caben en memoria
	// (conexionesParaMemoria), siempre por debajo de concurrencia para que
	// fasthttp no conteste nunca con su texto de tope. Con todo lleno, una IP
	// con menos de conexionesGarantizadas abiertas entra igualmente: se
	// desaloja una de la IP que más tiene (cupos.go). Para dejar fuera a una
	// IP nueva hacen falta tantas IP como huecos (1.228), no 20.
	conexionesPorIP        = 64
	conexionesGarantizadas = 4
	concurrencia           = 4096
	periodoRechazos        = time.Minute

	// Cuentas de memoria (bytes de Go: lo que limita GOMEMLIMIT).
	//   memoriaPorDefecto: el GOMEMLIMIT de trampa.yaml, por si falta.
	//   memoriaBase: go-pot en reposo (39 MiB de montón vivo medidos en
	//     Linux), lo que añaden las 200 retenidas del tarpit (unos 4 MiB),
	//     las cachés por IP llenas (cache_acotada.go, 7,5 MiB) y margen.
	//   margenRecolector: lo que se deja libre bajo el límite para que el
	//     recolector no entre en bucle.
	//   costePorConexion: el peor caso de una conexión abierta, montón y
	//     pila, con margen: lo medido son 32,8 KiB (una cabecera ya leída de
	//     casi maxSeparadores líneas y nombres de Trailer, esperando un cuerpo
	//     de 4 KiB). Si fasthttp cambia y cuesta más,
	//     TestServidorMemoriaPeorCaso falla y no hay imagen.
	memoriaPorDefecto = 120 << 20
	memoriaBase       = 56 << 20
	margenRecolector  = 16 << 20
	costePorConexion  = 40 << 10
	minimoConexiones  = 4 * conexionesPorIP
	maximoConexiones  = concurrencia - 96
)

// conexionesParaMemoria: cuántas conexiones abiertas a la vez caben en el
// límite de memoria de Go (GOMEMLIMIT) en el peor caso. Con 120 MiB, 1.228.
// Si se sube memoriaMb y GOMEMLIMIT en proporción, sube con ellos.
func conexionesParaMemoria(limite int64) int {
	if limite <= 0 || limite == math.MaxInt64 {
		limite = memoriaPorDefecto
	}
	n := (limite - memoriaBase - margenRecolector) / costePorConexion
	return int(min(max(n, minimoConexiones), maximoConexiones))
}

// cabeceraCostosa: demasiadas entradas para fasthttp (ver maxSeparadores).
func cabeceraCostosa(h *fasthttp.RequestHeader) bool {
	raw := h.RawHeaders()
	return bytes.Count(raw, []byte{'\n'})+bytes.Count(raw, []byte{','}) > maxSeparadores
}

// cabeceraRecibida (HeaderReceived de fasthttp) decide qué se hace con el
// cuerpo, que go-pot nunca lee:
//   - Más de limiteCuerpo: fasthttp contesta 413 sin leerlo.
//   - Troceado (chunked), o con una cabecera costosa: no se espera. Se
//     contesta en cuanto se tiene la cabecera y se cierra la conexión. El
//     troceado, porque fasthttp 1.54 vuelve a añadir todo el tráiler cada vez
//     que le llega un trozo sin acabar: un tráiler mandado línea a línea eran
//     28 MiB de una sola conexión en medio segundo.
//   - Lo demás tiene plazoCuerpo para llegar entero; si no, 408.
func (s *Server) cabeceraRecibida(h *fasthttp.RequestHeader) fasthttp.RequestConfig {
	cfg := fasthttp.RequestConfig{ReadTimeout: s.plazoCuerpo}
	if h.ContentLength() > limiteCuerpo {
		return cfg
	}
	if h.ContentLength() == -1 || cabeceraCostosa(h) {
		h.Del(fasthttp.HeaderExpect)
		h.SetContentLength(0)
		h.SetConnectionClose()
	}
	return cfg
}

// claveIlegible marca (en el RequestCtx) una petición que fasthttp no ha
// llegado a leer o que ha vaciado al fallar la lectura.
type claveIlegible struct{}

type (
	Server struct {
		App        *fiber.App
		ListenPort int
		ListenHost string
		Logger     *zap.Logger

		stallerFactory *stall.HttpStallerFactory
		accessLogger   *logging.HttpAccessLogger
		robots         string

		conexionesEnTotal int
		plazoPrimerByte   time.Duration
		plazoCuerpo       time.Duration
	}
)

func NewServer(
	lf fx.Lifecycle,
	shutdown fx.Shutdowner,
	cfg *config.Config,
	serverLogger logging.IServerLogger,
	stallerFactory *stall.HttpStallerFactory,
	accessLogger *logging.HttpAccessLogger,
) *Server {
	// Only enable the trusted proxy check if we have trusted proxies
	trustedProxyCheck := len(cfg.Server.TrustedProxies) > 0

	server := &Server{
		ListenPort: cfg.Server.Port,
		ListenHost: cfg.Server.Host,

		stallerFactory: stallerFactory,
		accessLogger:   accessLogger,
		robots:         robotsDeLaTrampa(logging.SemillaDeLaTrampa(cfg.Server.AccessLog.Path)),

		conexionesEnTotal: conexionesParaMemoria(debug.SetMemoryLimit(-1)),
		plazoPrimerByte:   plazoPrimerByte,
		plazoCuerpo:       plazoCuerpo,
	}
	server.App = fiber.New(fiber.Config{
		IdleTimeout:                  plazoInactiva,
		ReadTimeout:                  plazoCabecera,
		Concurrency:                  concurrencia,
		BodyLimit:                    limiteCuerpo,
		ReadBufferSize:               tamCabecera,
		DisablePreParseMultipartForm: true,
		ReduceMemoryUsage:            true,
		DisableStartupMessage:        true,
		Network:                      cfg.Server.Network,
		EnableIPValidation:           true,
		Immutable:                    true,
		ProxyHeader:                  cfg.Server.ProxyHeader,
		TrustedProxies:               cfg.Server.TrustedProxies,
		EnableTrustedProxyCheck:      trustedProxyCheck,
		ErrorHandler:                 server.responderError,
	})

	srv := server.App.Server()
	srv.HeaderReceived = server.cabeceraRecibida
	// Para el limitador (cupos.go): de una IP que acapara, se desaloja antes
	// la conexión que espera (su primer byte o la siguiente petición) que la
	// que está a media petición.
	srv.ConnState = func(c net.Conn, st fasthttp.ConnState) {
		logging.MarcarActiva(c, st == fasthttp.StateActive)
	}

	// Antes de Fiber: una cabecera costosa (431, sin llegar al tarpit) y un
	// método que no conoce («FOO / HTTP/1.1»), al que Fiber contesta con su
	// propio texto antes de llegar a ErrorHandler.
	fiberHandler := srv.Handler
	srv.Handler = func(rctx *fasthttp.RequestCtx) {
		var err error
		switch {
		case cabeceraCostosa(&rctx.Request.Header):
			err = fiber.ErrRequestHeaderFieldsTooLarge
		case !metodoConocido(rctx.Method()):
			err = fiber.ErrNotImplemented
		default:
			fiberHandler(rctx)
			return
		}
		c := server.App.AcquireCtx(rctx)
		defer server.App.ReleaseCtx(c)
		_ = server.responderError(c, err)
	}

	// fasthttp solo llama a su ErrorHandler cuando falla la lectura de la
	// petición. Si ya no le queda cabecera (no la pudo leer, o la vació al
	// fallar el cuerpo), su método y su ruta serían los de por defecto
	// («GET /»): se marca para no apuntarlos. Con la cabecera entera (un 413
	// por Content-Length) sí se apuntan.
	//
	// Una conexión desalojada (cupos.go) a media petición falla aquí: ni se
	// contesta (ya no se puede escribir en ella) ni se apunta como un error
	// de la petición. Sale en el resumen de rechazos.
	fiberError := srv.ErrorHandler
	srv.ErrorHandler = func(rctx *fasthttp.RequestCtx, err error) {
		if logging.Desalojada(rctx.Conn()) {
			return
		}
		if len(rctx.Request.Header.RawHeaders()) == 0 {
			rctx.SetUserValue(claveIlegible{}, true)
		}
		fiberError(rctx, err)
	}

	lf.Append(fx.Hook{
		OnStop: func(ctx context.Context) error {
			zap.L().Sugar().Info("Shutting down server")
			return server.App.Shutdown()
		},
	})

	return server
}

// responderError contesta a lo que no acaba en el tarpit. Los errores de
// Fiber (otro método, cuerpo de más, cabecera a medias o mal formada) llegan
// sin haber pasado por el registro: se apuntan aquí. Lo demás (el tarpit
// lleno: tope de conexiones retenidas, en total o de su IP) ya tiene su línea
// de inicio y se contesta como un servidor ocupado.
func (s *Server) responderError(c *fiber.Ctx, err error) error {
	code := fiber.StatusServiceUnavailable
	var fe *fiber.Error
	if errors.As(err, &fe) {
		code = fe.Code
		ilegible, _ := c.Context().UserValue(claveIlegible{}).(bool)
		s.accessLogger.Rechazada(c, code, !ilegible)
	} else {
		zap.L().Debug("Error in request", zap.Error(err))
	}
	if code == fiber.StatusMethodNotAllowed {
		c.Set(fiber.HeaderAllow, "GET, HEAD")
	}
	c.Response().ResetBody()
	return c.Status(code).SendString(utils.StatusMessage(code))
}

func metodoConocido(m []byte) bool {
	switch string(m) {
	case fiber.MethodGet, fiber.MethodHead, fiber.MethodPost, fiber.MethodPut, fiber.MethodDelete,
		fiber.MethodConnect, fiber.MethodOptions, fiber.MethodTrace, fiber.MethodPatch:
		return true
	}
	return false
}

func (s *Server) Start() error {
	// Setup routes
	s.App.Get("/robots.txt", func(c *fiber.Ctx) error {
		return c.SendString(s.robots)
	})

	s.App.Get("/*", func(c *fiber.Ctx) error {
		staller, err := s.stallerFactory.FromFiberContext(c)
		if err != nil {
			return err
		}

		// Set the correct content type based on the context
		c.Response().Header.SetContentType(staller.GetContentType())

		return staller.StallContextBuffer(c)
	})

	ln, err := net.Listen(s.App.Config().Network, fmt.Sprintf("%s:%d", s.ListenHost, s.ListenPort))
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	return s.App.Listener(logging.LimitarConexiones(ln, conexionesPorIP, s.conexionesEnTotal, conexionesGarantizadas,
		periodoRechazos, s.plazoPrimerByte))
}
