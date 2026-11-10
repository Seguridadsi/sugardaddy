package actualizador

// La CA propia del nodo (docs/diseno/ca-nodo.md).
//
// Un nodo instalado antes que ella firma el HTTPS de la consola con la CA que
// Caddy crea en su volumen, sin límite de nombres. El actualizador le prepara
// una propia (canodo), se la cuenta a la consola y espera: el administrador
// instala la raíz nueva en los equipos y lo confirma en la consola. Entonces
// lanza un auxiliar que pasa Caddy a la nueva, comprueba que el 443 contesta
// con ella y destruye la vieja, en el volumen de Caddy y en las copias. Si la
// comprobación falla, vuelve a la vieja, que aún existe.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/canodo"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

const (
	// DirCA es la carpeta de la CA propia dentro de la del nodo.
	DirCA = "ca-nodo"
	// FicheroCambioCA existe mientras un cambio de CA no ha acabado: el
	// siguiente auxiliar lo remata (comprobar, destruir la vieja, copias).
	FicheroCambioCA = ".ca-cambio.json"
	// DatosCaddyEnAuxiliar: dónde monta el auxiliar el volumen de Caddy.
	DatosCaddyEnAuxiliar = "/caddy-datos"
	// EsperaCambioCA: lo más que puede tardar el auxiliar.
	EsperaCambioCA = 8 * time.Minute
	// RepasoCA: cada cuánto se repite el informe a la consola aunque no cambie.
	RepasoCA = 10 * time.Minute
)

// Estados del resultado de un cambio de CA.
const (
	CAAplicada = "aplicada"
	CAFallida  = "fallida"
)

// ResultadoCA es lo que deja el auxiliar en su última línea y se informa a la consola.
type ResultadoCA struct {
	Estado  string          `json:"estado"`
	Detalle string          `json:"detalle"`
	Huella  string          `json:"huella"`
	Copias  ResultadoCopias `json:"copias"`
	Cuando  string          `json:"cuando"`
}

// NombreAuxiliarCA: el nombre del contenedor hace de cerrojo.
func NombreAuxiliarCA(proyecto string) string { return proyecto + "-ca" }

// AuxiliarCAEnMarcha dice si hay un auxiliar cambiando la CA del nodo.
func AuxiliarCAEnMarcha(ctx context.Context, d *docker.Cliente, proyecto string) bool {
	c, err := d.Inspeccionar(ctx, NombreAuxiliarCA(proyecto))
	if err != nil {
		return false
	}
	estado, _ := c["State"].(map[string]any)
	corriendo, _ := estado["Running"].(bool)
	return corriendo
}

// mismaHuella compara huellas sin fijarse en mayúsculas ni separadores.
func mismaHuella(a, b string) bool {
	limpia := func(s string) string {
		return strings.NewReplacer(":", "", " ", "", "-", "").Replace(strings.ToUpper(strings.TrimSpace(s)))
	}
	return a != "" && limpia(a) == limpia(b)
}

type cambioEnCurso struct {
	Huella string `json:"huella"`
	Desde  string `json:"desde"`
}

func leerCambio(dir string) (cambioEnCurso, bool) {
	var c cambioEnCurso
	b, err := os.ReadFile(filepath.Join(dir, FicheroCambioCA))
	if err != nil || json.Unmarshal(b, &c) != nil || c.Huella == "" {
		return c, false
	}
	return c, true
}

// fijarEnv pone (o quita, con valor vacío) una variable en .env sin tocar el resto.
func fijarEnv(ruta, clave, valor string) error {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return err
	}
	var lineas []string
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if k, _, ok := strings.Cut(strings.TrimSpace(l), "="); ok && strings.TrimSpace(k) == clave {
			continue
		}
		lineas = append(lineas, l)
	}
	if valor != "" {
		lineas = append(lineas, clave+"="+valor)
	}
	return escribirAtomico(ruta, []byte(strings.Join(lineas, "\n")+"\n"), 0o600)
}

// CambioCA es el trabajo del auxiliar: pasar el nodo a la CA propia, o rematar
// un cambio que se cortó.
type CambioCA struct {
	Dir      string // carpeta del nodo, en la misma ruta que en el anfitrión
	Datos    string // el volumen de Caddy, montado
	Proyecto string
	Red      string // la red del proyecto, para comprobar el 443 desde dentro
	Huella   string // la raíz que confirmó el administrador
	Docker   *docker.Cliente
	Binario  string // docker-compose
	Log      func(string, ...any)
	// Comprobar mira que https contesta con un certificado de la CA nueva para
	// la dirección de la consola. Por defecto, desde la red del proyecto; en
	// las pruebas, un doble.
	Comprobar func(ctx context.Context, raiz *x509.Certificate, direccion string) error
	Ahora     func() time.Time
	Pausa     time.Duration
	// Cuánto esperar a un copia.sh en marcha (cero: EsperaCerrojoCopias).
	EsperaCerrojo time.Duration
}

func (c *CambioCA) ruta(n string) string { return filepath.Join(c.Dir, n) }

func (c *CambioCA) log(m string, args ...any) {
	if c.Log != nil {
		c.Log(m, args...)
	}
}

func (c *CambioCA) resultado(estado, detalle, huella string, copias ResultadoCopias) ResultadoCA {
	ahora := time.Now
	if c.Ahora != nil {
		ahora = c.Ahora
	}
	return ResultadoCA{Estado: estado, Detalle: strings.TrimSpace(detalle), Huella: huella, Copias: copias, Cuando: ahora().UTC().Format(time.RFC3339)}
}

func (c *CambioCA) app() *Aplicacion {
	return &Aplicacion{Dir: c.Dir, Modo: ModoNodo, Proyecto: c.Proyecto, Compose: c.Binario, Docker: c.Docker, Log: c.Log, Ahora: c.Ahora, Pausa: c.Pausa}
}

// recrearHttps vuelve a crear Caddy con el .env de ahora y mira que aguanta.
func (c *CambioCA) recrearHttps(ctx context.Context) (string, error) {
	a := c.app()
	if out, err := a.compose(ctx, "up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "https"); err != nil {
		return out, fmt.Errorf("could not recreate https: %w", err)
	}
	return "", a.aguanta(ctx, "https")
}

// Aplicar hace el cambio. Siempre devuelve un resultado; «fallida» deja el
// nodo con la CA que tenía (si la vieja aún existe) y dice por qué.
func (c *CambioCA) Aplicar(ctx context.Context) ResultadoCA {
	var nada ResultadoCopias
	env, err := LeerEnv(c.ruta(".env"))
	if err != nil {
		return c.resultado(CAFallida, "cannot read .env: "+err.Error(), "", nada)
	}
	if m := env["TLS_MODO"]; m != "" && m != "interno" {
		return c.resultado(CAFallida, "the console uses a certificate from your organization (TLS_MODO="+m+"): there is no node CA to change", "", nada)
	}
	direccion := env["CONSOLA_DOMINIO"]
	ca, err := canodo.Leer(c.ruta(DirCA))
	if err != nil {
		return c.resultado(CAFallida, "the new CA of the node is not valid: "+err.Error(), "", nada)
	}
	huella := ca.Huella()
	if !ca.Cubre(direccion) {
		return c.resultado(CAFallida, "the new root does not cover the console address "+direccion, huella, nada)
	}
	if !mismaHuella(c.Huella, huella) {
		return c.resultado(CAFallida, "the root confirmed in the console is not the one prepared on the node: confirm it again", huella, nada)
	}
	hayVieja, err := c.hayCAVieja()
	if err != nil {
		return c.resultado(CAFallida, err.Error(), huella, nada)
	}
	cambiada := false
	if env["CA_NODO"] != "nodo" {
		b, _ := json.Marshal(cambioEnCurso{Huella: huella, Desde: c.resultado("", "", "", nada).Cuando})
		if err := escribirAtomico(c.ruta(FicheroCambioCA), b, 0o600); err != nil {
			return c.resultado(CAFallida, err.Error(), huella, nada)
		}
		if err := fijarEnv(c.ruta(".env"), "CA_NODO", "nodo"); err != nil {
			_ = os.Remove(c.ruta(FicheroCambioCA))
			return c.resultado(CAFallida, ".env: "+err.Error(), huella, nada)
		}
		cambiada = true
		c.log("switching the console HTTPS to the node CA", "huella", huella)
		if out, err := c.recrearHttps(ctx); err != nil {
			return c.volver(ctx, huella, fmt.Sprintf("%v\n%s", err, cola(out, 10)))
		}
	}
	comprobar := c.Comprobar
	if comprobar == nil {
		comprobar = c.comprobarDesdeLaRed
	}
	if err := comprobar(ctx, ca.Raiz, direccion); err != nil {
		if cambiada || hayVieja {
			return c.volver(ctx, huella, "the console did not answer with a certificate from the new root: "+err.Error())
		}
		return c.resultado(CAFallida, "the console does not answer with a certificate from the node root: "+err.Error(), huella, nada)
	}
	// La consola sirve la raíz nueva y la pone en las líneas de los sensores remotos.
	if nuevo, err := escribirEnSuSitio(c.ruta("ca-raiz.crt"), ca.RaizPEM(), 0o644); err != nil {
		c.log("could not write ca-raiz.crt", "err", err)
	} else if nuevo {
		if out, err := c.app().compose(ctx, "restart", "consola"); err != nil {
			c.log("could not restart the console after writing ca-raiz.crt", "err", err, "salida", cola(out, 3))
		}
	}
	// Con el cerrojo de copia.sh: que no salga a la vez una copia con la CA vieja.
	espera := c.EsperaCerrojo
	if espera == 0 {
		espera = EsperaCerrojoCopias
	}
	soltar, err := cerrojoCopias(c.Dir, espera)
	if err != nil {
		return c.resultado(CAFallida, "the node now uses the new root, but the previous CA could not be destroyed yet: "+err.Error(), huella, nada)
	}
	defer soltar()
	if err := DestruirCAVieja(c.Datos); err != nil {
		// El cambio queda pendiente: el siguiente auxiliar lo vuelve a intentar.
		return c.resultado(CAFallida, "the node now uses the new root, but the previous CA could not be destroyed: "+err.Error(), huella, nada)
	}
	copias, err := LimpiarCopias(c.Dir)
	if err != nil {
		return c.resultado(CAFallida, "the node now uses the new root and the previous CA was destroyed, but the backups could not be cleaned: "+err.Error(), huella, copias)
	}
	_ = os.Remove(c.ruta(FicheroCambioCA))
	// Las copias que no se pudieron leer van aparte (copias.ilegibles): la consola las enseña.
	detalle := "the previous CA was destroyed on this machine"
	switch {
	case copias.Limpias == 1:
		detalle += " and in 1 backup"
	case copias.Limpias > 1:
		detalle += fmt.Sprintf(" and in %d backups", copias.Limpias)
	}
	c.log("console HTTPS on the node CA", "huella", huella, "detalle", detalle)
	return c.resultado(CAAplicada, detalle, huella, copias)
}

// volver deja Caddy con la CA de antes, que aún no se ha destruido.
func (c *CambioCA) volver(ctx context.Context, huella, motivo string) ResultadoCA {
	c.log("going back to the previous CA", "motivo", motivo)
	if c.Docker != nil && c.Red != "" {
		_ = c.Docker.Desconectar(context.WithoutCancel(ctx), c.Red, NombreAuxiliarCA(c.Proyecto))
	}
	detalle := motivo + "\nThe node went back to the previous root: nothing changed on the computers."
	if err := fijarEnv(c.ruta(".env"), "CA_NODO", ""); err != nil {
		detalle += "\n.env could not be restored: " + err.Error()
	} else if out, err := c.recrearHttps(context.WithoutCancel(ctx)); err != nil {
		detalle += "\nhttps did not come up with the previous root either: " + err.Error() + "\n" + cola(out, 5)
	}
	_ = os.Remove(c.ruta(FicheroCambioCA))
	return c.resultado(CAFallida, detalle, huella, ResultadoCopias{})
}

// conservarCA lee la CA de ahora antes de que una versión vuelva atrás y la
// pone otra vez después (docs/diseno/ca-nodo.md). La copia a la que se vuelve
// puede ser de antes del cambio de CA (la de una pasada que se quedó a
// medias): sin esto, devolvería un .env sin CA_NODO=nodo, Caddy crearía otra
// CA «local» sin límite de nombres y los equipos dejarían de entrar; o, en un
// sensor remoto, un ca-consola.crt con solo la raíz vieja, y el sensor
// perdería la consola. Ni lo uno ni lo otro lo cambia nunca una versión.
func (a *Aplicacion) conservarCA() func() error {
	env, _ := LeerEnv(a.ruta(".env"))
	propia := env["CA_NODO"] == "nodo"
	raices, err := os.ReadFile(a.ruta("ca-consola.crt"))
	if err != nil || raicesValidas(raices) != nil {
		raices = nil
	}
	return func() error {
		var errs []error
		if e, err := LeerEnv(a.ruta(".env")); propia && err == nil && e["CA_NODO"] != "nodo" {
			errs = append(errs, fijarEnv(a.ruta(".env"), "CA_NODO", "nodo"))
		}
		if b, _ := os.ReadFile(a.ruta("ca-consola.crt")); raices != nil && !bytes.Equal(b, raices) {
			_, err := escribirEnSuSitio(a.ruta("ca-consola.crt"), raices, 0o644)
			errs = append(errs, err)
		}
		return errors.Join(errs...)
	}
}

// Lo que se destruye de la CA de Caddy, dentro de su carpeta de datos: la CA
// (raíz, intermedia y sus claves) y los certificados que emitió.
var carpetasCAVieja = []string{"caddy/pki/authorities/local", "caddy/certificates/local"}

func (c *CambioCA) hayCAVieja() (bool, error) {
	if fi, err := os.Stat(c.Datos); err != nil || !fi.IsDir() {
		return false, fmt.Errorf("the Caddy data volume is not mounted at %s", c.Datos)
	}
	_, err := os.Lstat(filepath.Join(c.Datos, carpetasCAVieja[0]))
	return err == nil, nil
}

// DestruirCAVieja sobrescribe con datos al azar y borra la CA de Caddy y los
// certificados que emitió. Sobrescribir es lo que se puede hacer: en un disco
// SSD o un sistema de ficheros con diario, los bloques viejos pueden quedar.
func DestruirCAVieja(datos string) error {
	for _, d := range carpetasCAVieja {
		raiz := filepath.Join(datos, d)
		if _, err := os.Lstat(raiz); errors.Is(err, fs.ErrNotExist) {
			continue
		}
		err := filepath.WalkDir(raiz, func(p string, e fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if e.Type().IsRegular() {
				return sobrescribir(p)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if err := os.RemoveAll(raiz); err != nil {
			return err
		}
		if _, err := os.Lstat(raiz); !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("%s is still there", d)
		}
	}
	return nil
}

func sobrescribir(ruta string) error {
	f, err := os.OpenFile(ruta, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	b := make([]byte, fi.Size())
	if _, err := rand.Read(b); err != nil {
		return err
	}
	if _, err := f.WriteAt(b, 0); err != nil {
		return err
	}
	return f.Sync()
}

// comprobarDesdeLaRed entra en la red del proyecto y abre el 443 de Caddy
// como lo haría un navegador que solo confía en la raíz nueva. Caddy puede
// tardar en sacar el certificado: se reintenta un rato.
func (c *CambioCA) comprobarDesdeLaRed(ctx context.Context, raiz *x509.Certificate, direccion string) error {
	if err := c.Docker.Conectar(ctx, c.Red, NombreAuxiliarCA(c.Proyecto), nil); err != nil {
		var e *docker.ErrAPI
		if !errors.As(err, &e) || e.Codigo != http.StatusForbidden {
			return fmt.Errorf("cannot join %s: %w", c.Red, err)
		}
	}
	defer func() { _ = c.Docker.Desconectar(context.WithoutCancel(ctx), c.Red, NombreAuxiliarCA(c.Proyecto)) }()
	var ultimo error
	for i := 0; i < 30; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(3 * time.Second):
			}
		}
		if ultimo = ProbarTLS(ctx, "https:443", raiz, direccion); ultimo == nil {
			return nil
		}
	}
	return ultimo
}

// ProbarTLS abre una conexión TLS a destino con la raíz como única de
// confianza y el nombre (o la IP) de la consola.
func ProbarTLS(ctx context.Context, destino string, raiz *x509.Certificate, direccion string) error {
	raices := x509.NewCertPool()
	raices.AddCert(raiz)
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: &tls.Config{RootCAs: raices, ServerName: direccion, MinVersion: tls.VersionTLS12}}
	cx, cancelar := context.WithTimeout(ctx, 10*time.Second)
	defer cancelar()
	conn, err := d.DialContext(cx, "tcp", destino)
	if err != nil {
		return err
	}
	return conn.Close()
}

// LeerResultadoCA saca el resultado de la última línea JSON del auxiliar.
func LeerResultadoCA(salida string, codigo int) ResultadoCA {
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	for i := len(lineas) - 1; i >= 0; i-- {
		var r ResultadoCA
		if json.Unmarshal([]byte(lineas[i]), &r) == nil && r.Estado != "" {
			return r
		}
	}
	return ResultadoCA{Estado: CAFallida, Detalle: fmt.Sprintf("the CA helper ended with code %d and said nothing", codigo), Cuando: time.Now().UTC().Format(time.RFC3339)}
}

// PedidoCA es lo que necesita el actualizador para lanzar el auxiliar.
type PedidoCA struct {
	Imagen    string
	Anfitrion string // carpeta del nodo en el anfitrión
	Volumen   string // volumen de datos de Caddy
	Huella    string
}

// CANodo es la parte del actualizador: preparar la CA propia, contársela a la
// consola y, cuando el administrador lo confirma, lanzar el auxiliar.
type CANodo struct {
	Docker    *docker.Cliente
	Consola   string // p. ej. http://consola:3000
	Token     string
	HTTP      *http.Client
	Local     string // la carpeta del nodo dentro del contenedor del actualizador
	Anfitrion string // la misma, en el anfitrión (NODO_DIR)
	Proyecto  string
	Red       string
	Log       func(string, ...any)
	// Lanzar corre el auxiliar y espera su resultado. Por defecto, un
	// contenedor; en las pruebas, un doble.
	Lanzar func(ctx context.Context, p PedidoCA) ResultadoCA
	Ahora  func() time.Time

	informado string // lo último que recibió la consola
	cuando    time.Time
	resultado *ResultadoCA // del último auxiliar, hasta que la consola lo recibe
	// Tras un auxiliar que falla, el siguiente espera: 1 min, 2, 4… hasta 1 h.
	// Si no, un cambio a medias que no se puede rematar (la clave vieja no se
	// deja borrar) lanzaría un contenedor cada 30 s.
	espera    time.Duration
	reintento time.Time
}

func (c *CANodo) puedeLanzar() bool { return !c.ahora().Before(c.reintento) }

func (c *CANodo) apuntarResultado(r ResultadoCA) {
	c.resultado = &r
	if r.Estado == CAAplicada {
		c.espera, c.reintento = 0, time.Time{}
		return
	}
	c.espera = min(max(2*c.espera, time.Minute), time.Hour)
	c.reintento = c.ahora().Add(c.espera)
}

// informeCA es lo que el actualizador cuenta a la consola en POST /api/actualizador/ca.
type informeCA struct {
	// caddy: la CA de Caddy de antes, con la propia preparada en Raiz;
	// propia: la CA propia en uso; ficheros: el certificado de la empresa.
	Modo      string       `json:"modo"`
	Raiz      string       `json:"raiz,omitempty"`
	Huella    string       `json:"huella,omitempty"`
	Direccion string       `json:"direccion,omitempty"`
	Error     string       `json:"error,omitempty"`
	Resultado *ResultadoCA `json:"resultado,omitempty"`
}

func (c *CANodo) log(m string, args ...any) {
	if c.Log != nil {
		c.Log(m, args...)
	}
}

func (c *CANodo) ahora() time.Time {
	if c.Ahora != nil {
		return c.Ahora()
	}
	return time.Now()
}

// Vuelta mira en qué está la CA del nodo, lo cuenta y, si toca, cambia. Con
// una consola anterior a esto (sin la ruta) no hace nada más que preparar.
func (c *CANodo) Vuelta(ctx context.Context) error {
	if err := c.vuelta(ctx); !errors.Is(err, errSinRuta) {
		return err
	}
	return nil
}

func (c *CANodo) vuelta(ctx context.Context) error {
	if c.Docker != nil && (AuxiliarEnMarcha(ctx, c.Docker, c.Proyecto) || AuxiliarCAEnMarcha(ctx, c.Docker, c.Proyecto)) {
		return nil
	}
	if r, ok := c.recogerAnterior(ctx); ok {
		c.resultado = &r
	}
	// Los copia.sh y restaurar.sh de esta versión, que guardan ca-nodo/ (docs/diseno/ca-nodo.md).
	scripts, errScripts := PonerScriptsDeCopias(c.Local)
	if len(scripts) > 0 {
		c.log("backup scripts updated", "scripts", scripts)
	}
	env, err := LeerEnv(filepath.Join(c.Local, ".env"))
	if err != nil {
		return err
	}
	if m := env["TLS_MODO"]; m != "" && m != "interno" {
		return c.informar(ctx, informeCA{Modo: "ficheros"})
	}
	direccion := env["CONSOLA_DOMINIO"]
	dir := filepath.Join(c.Local, DirCA)
	if env["CA_NODO"] == "nodo" {
		inf := informeCA{Modo: "propia", Direccion: direccion}
		ca, err := canodo.Leer(dir)
		if err != nil {
			inf.Error = "the node CA cannot be read: " + err.Error()
		} else {
			inf.Raiz, inf.Huella = string(ca.RaizPEM()), ca.Huella()
			if !ca.Cubre(direccion) {
				inf.Error = "the node root does not cover the console address " + direccion + ": run the installer again"
			} else if _, ok := leerCambio(c.Local); ok && c.puedeLanzar() {
				// Un cambio que se cortó a medias: se remata.
				c.apuntarResultado(c.lanzar(ctx, ca.Huella()))
			}
		}
		return c.informar(ctx, inf)
	}
	// Con la CA de Caddy: la propia se prepara y espera a que la confirmen.
	ca, err := canodo.Leer(dir)
	if err != nil || !ca.Cubre(direccion) {
		if ca, err = canodo.Generar(dir, direccion, env["NODO_ID"], c.ahora()); err != nil {
			return c.informar(ctx, informeCA{Modo: "caddy", Direccion: direccion, Error: "could not prepare the node CA: " + err.Error()})
		}
		c.log("node CA prepared", "huella", ca.Huella())
	}
	inf := informeCA{Modo: "caddy", Raiz: string(ca.RaizPEM()), Huella: ca.Huella(), Direccion: direccion}
	switch d, ok := LeerResultado(c.Local); {
	case errScripts != nil:
		// Sin los scripts nuevos, las copias no guardarían la CA propia.
		inf.Error = "could not update copia.sh and restaurar.sh in the node folder: " + errScripts.Error()
	case ok && d.Estado == "aplicando":
		// Una versión que se quedó a medias: si la siguiente falla, vuelve a la
		// copia de entonces, que podría ser anterior a la CA propia. No se cambia
		// hasta que se aplique una versión entera.
		inf.Error = "an update of the node was left half-done: the switch waits until the next version is applied"
	}
	if err := c.informar(ctx, inf); err != nil || inf.Error != "" {
		return err
	}
	pedida, err := c.pedir(ctx)
	if err != nil || !mismaHuella(pedida, ca.Huella()) || !c.puedeLanzar() {
		return err
	}
	r := c.lanzar(ctx, ca.Huella())
	c.apuntarResultado(r)
	if r.Estado == CAAplicada {
		inf = informeCA{Modo: "propia", Raiz: inf.Raiz, Huella: inf.Huella, Direccion: direccion}
	}
	return c.informar(ctx, inf)
}

func (c *CANodo) informar(ctx context.Context, inf informeCA) error {
	inf.Resultado = c.resultado
	b, _ := json.Marshal(inf)
	if string(b) == c.informado && time.Since(c.cuando) < RepasoCA {
		return nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.Consola+"/api/actualizador/ca", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return errSinRuta
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	// Recibido: el resultado ya no se repite; lo guarda la consola.
	c.resultado = nil
	inf.Resultado = nil
	b, _ = json.Marshal(inf)
	c.informado, c.cuando = string(b), time.Now()
	return nil
}

// pedir devuelve la huella de la raíz que el administrador ha confirmado, si hay.
func (c *CANodo) pedir(ctx context.Context) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Consola+"/api/actualizador/ca", nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", errSinRuta
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("consola: %s", resp.Status)
	}
	var p struct {
		Cambiar string `json:"cambiar"`
	}
	return p.Cambiar, json.NewDecoder(resp.Body).Decode(&p)
}

func (c *CANodo) lanzar(ctx context.Context, huella string) ResultadoCA {
	lanzar := c.Lanzar
	if lanzar == nil {
		lanzar = c.lanzarContenedor
	}
	versiones, err := LeerEnv(filepath.Join(c.Local, "versiones.env"))
	if err != nil || versiones["ACTUALIZADOR_IMAGEN"] == "" {
		return ResultadoCA{Estado: CAFallida, Detalle: "versiones.env does not say which updater image to use for the CA helper", Huella: huella, Cuando: c.ahora().UTC().Format(time.RFC3339)}
	}
	return lanzar(ctx, PedidoCA{Imagen: versiones["ACTUALIZADOR_IMAGEN"], Anfitrion: c.Anfitrion, Huella: huella})
}

// recogerAnterior: un auxiliar que acabó sin que nadie leyera su resultado
// (el actualizador se reinició mientras tanto). Se lee y se quita.
func (c *CANodo) recogerAnterior(ctx context.Context) (ResultadoCA, bool) {
	if c.Docker == nil || c.Lanzar != nil {
		return ResultadoCA{}, false
	}
	nombre := NombreAuxiliarCA(c.Proyecto)
	i, err := c.Docker.Inspeccionar(ctx, nombre)
	if err != nil {
		return ResultadoCA{}, false
	}
	estado, _ := i["State"].(map[string]any)
	codigo, _ := estado["ExitCode"].(float64)
	salida, _ := c.Docker.Salida(ctx, nombre, 30)
	_ = c.Docker.Borrar(ctx, nombre)
	return LeerResultadoCA(salida, int(codigo)), true
}

// volumenCaddy busca el volumen de datos de Caddy del proyecto por sus etiquetas de compose.
func (c *CANodo) volumenCaddy(ctx context.Context) (string, error) {
	vs, err := c.Docker.Volumenes(ctx, map[string][]string{"label": {
		"com.docker.compose.project=" + c.Proyecto, "com.docker.compose.volume=datos-caddy",
	}})
	if err != nil {
		return "", err
	}
	if len(vs) != 1 {
		return "", fmt.Errorf("found %d Caddy data volumes for %s", len(vs), c.Proyecto)
	}
	return vs[0].Name, nil
}

// lanzarContenedor corre el auxiliar con lo justo: el socket (para compose),
// la carpeta del nodo en su ruta y el volumen de Caddy.
func (c *CANodo) lanzarContenedor(ctx context.Context, p PedidoCA) ResultadoCA {
	fallo := func(m string, err error) ResultadoCA {
		return ResultadoCA{Estado: CAFallida, Detalle: m + ": " + err.Error(), Huella: p.Huella, Cuando: c.ahora().UTC().Format(time.RFC3339)}
	}
	if c.Anfitrion == "" {
		return fallo("CA helper", errors.New("NODO_DIR is not set"))
	}
	volumen, err := c.volumenCaddy(ctx)
	if err != nil {
		return fallo("Caddy data volume", err)
	}
	nombre := NombreAuxiliarCA(c.Proyecto)
	if err := c.Docker.Borrar(ctx, nombre); err != nil && !docker.NoExiste(err) {
		return fallo("previous CA helper", err)
	}
	if err := c.Docker.AsegurarImagen(ctx, p.Imagen); err != nil {
		return fallo("updater image", err)
	}
	id, err := c.Docker.Crear(ctx, nombre, map[string]any{
		"Image": p.Imagen,
		"Cmd":   []string{"ca"},
		"Env": []string{
			"CA_DIR=" + p.Anfitrion,
			"CA_PROYECTO=" + c.Proyecto,
			"CA_RED=" + c.Red,
			"CA_HUELLA=" + p.Huella,
		},
		"Labels": map[string]string{"sugardaddy.auxiliar": "ca"},
		"HostConfig": map[string]any{
			"Binds": []string{
				"/var/run/docker.sock:/var/run/docker.sock",
				p.Anfitrion + ":" + p.Anfitrion,
				volumen + ":" + DatosCaddyEnAuxiliar,
			},
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges"},
			"Tmpfs":          map[string]string{"/tmp": "rw,nosuid,size=64m"},
			// Fuera de la red del proyecto mientras compose recrea Caddy; entra
			// en ella solo para comprobar el 443.
			"NetworkMode":   "bridge",
			"RestartPolicy": map[string]string{"Name": "no"},
			"LogConfig":     docker.RegistrosAcotados(),
		},
	})
	if err != nil {
		return fallo("CA helper", err)
	}
	if err := c.Docker.Arrancar(ctx, id); err != nil {
		_ = c.Docker.Borrar(context.WithoutCancel(ctx), id)
		return fallo("CA helper", err)
	}
	espera, cancelar := context.WithTimeout(ctx, EsperaCambioCA+time.Minute)
	defer cancelar()
	codigo, err := c.Docker.Esperar(espera, id)
	if err != nil {
		// Sigue trabajando: su resultado se recoge en otra vuelta.
		return fallo("CA helper", err)
	}
	salida, _ := c.Docker.Salida(ctx, id, 30)
	_ = c.Docker.Borrar(context.WithoutCancel(ctx), id)
	return LeerResultadoCA(salida, codigo)
}
