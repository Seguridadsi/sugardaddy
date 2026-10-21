package actualizador

// Aplicar la configuración firmada de una versión: el trabajo del auxiliar.
//
// El auxiliar es un contenedor de un solo uso, con la imagen del actualizador
// (que lleva docker-compose), lanzado por el actualizador o, la primera vez,
// por el sensor. Monta el socket y la carpeta del nodo en la MISMA ruta que en
// el anfitrión, para que las rutas del compose signifiquen lo mismo dentro y
// fuera. Hace lo que antes solo hacía una reinstalación: escribir compose.yml
// (y el Caddyfile), añadir a .env las variables que falten y levantar todo
// con compose, esperando a que cada servicio esté sano. Si algo falla, deja
// los ficheros como estaban y vuelve a levantar lo anterior.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Modos: el nodo completo (consola, sensor, actualizador…) o un sensor remoto.
const (
	ModoNodo         = "nodo"
	ModoSensorRemoto = "sensorRemoto"
)

// Aplicacion es un trabajo del auxiliar sobre la carpeta de un nodo o de un sensor remoto.
type Aplicacion struct {
	Dir      string // carpeta en el anfitrión (y, montada, la misma dentro)
	Modo     string // ModoNodo o ModoSensorRemoto
	Proyecto string // proyecto de compose: sugardaddy o sugardaddy-sensor
	Compose  string // ruta del binario de docker-compose
	Docker   *docker.Cliente
	Log      func(msg string, args ...any)
	// Para las pruebas: en producción, time.Now y un segundo.
	Ahora func() time.Time
	Pausa time.Duration // unidad de las esperas (cero: un segundo)
}

// Resultado es lo que se informa a la consola y queda en .aplicacion.json.
type Resultado struct {
	Version   string `json:"version"`
	Estado    string `json:"estado"` // aplicada o fallida
	Detalle   string `json:"detalle"`
	Cuando    string `json:"cuando"`
	Informado bool   `json:"informado"`
	// Solo mientras se aplica (estado «aplicando»): la copia a la que volver.
	Copia string `json:"copia,omitempty"`
}

// Ficheros que se copian antes de tocar nada y se restauran si algo falla.
var respaldados = []string{"compose.yml", "Caddyfile", ".env", "versiones.env", "ca-consola.crt"}

const copiasQueSeGuardan = 3

func (a *Aplicacion) ruta(nombre string) string { return filepath.Join(a.Dir, nombre) }

func (a *Aplicacion) ahora() time.Time {
	if a.Ahora != nil {
		return a.Ahora()
	}
	return time.Now()
}

// esperar n unidades de Pausa; false si se cancela antes.
func (a *Aplicacion) esperar(ctx context.Context, n int) bool {
	p := a.Pausa
	if p == 0 {
		p = time.Second
	}
	select {
	case <-ctx.Done():
		return false
	case <-time.After(time.Duration(n) * p):
		return true
	}
}

// Aplicar verifica la versión firmada con la clave fijada en .env y aplica su
// configuración. Devuelve siempre un Resultado: fallida lleva el motivo.
func (a *Aplicacion) Aplicar(ctx context.Context, f ReleaseFirmada) Resultado {
	r, err := a.verificar(f)
	if err != nil {
		return a.resultado("", "fallida", err.Error())
	}
	c := r.Nodo
	if a.Modo == ModoSensorRemoto {
		c = r.SensorRemoto
	}
	if c == nil {
		return a.resultado(r.Version, "fallida", "la versión no trae configuración para "+a.Modo)
	}
	if err := a.comprobarMotor(ctx); err != nil {
		return a.resultado(r.Version, "fallida", err.Error())
	}
	copia, retomada, err := a.copiaBuena()
	if err != nil {
		return a.resultado(r.Version, "fallida", "copia de seguridad: "+err.Error())
	}
	// El diario: si este auxiliar muere a mitad (se reinicia Docker o la
	// máquina), el siguiente sabe que los ficheros están a medias y cuál es la
	// copia buena. Y el actualizador no reenvía el resultado de otra pasada.
	diario := a.resultado(r.Version, "aplicando", "")
	diario.Copia = copia
	if err := GuardarResultado(a.Dir, diario); err != nil {
		return a.resultado(r.Version, "fallida", "diario: "+err.Error())
	}
	if err := a.guardaPostgres(c); err != nil {
		return a.resultado(r.Version, "fallida", err.Error())
	}
	// Compose no reinicia un servicio porque cambie un fichero montado: si el
	// Caddyfile cambia, se reinicia https y se comprueba que aguanta.
	nuevoCaddy, hayCaddy := c.Ficheros["Caddyfile"]
	caddyCambia := a.Modo == ModoNodo && hayCaddy && hashDe(filepath.Join(copia, "Caddyfile")) != hashTexto(nuevoCaddy)
	// https se reinicia otra vez al volver atrás solo si llegó a arrancar con
	// el Caddyfile nuevo (aquí o en la pasada que se retoma).
	reiniciado := caddyCambia && retomada
	salida, err := a.escribirYLevantar(ctx, r, c)
	if err == nil && caddyCambia {
		reiniciado = true
		salida, err = a.reiniciarHttps(ctx)
	}
	if err == nil {
		if a.Modo == ModoNodo {
			a.exportarRaiz(ctx)
		}
		return a.resultado(r.Version, "aplicada", "")
	}
	detalle := fmt.Sprintf("%v\n%s", err, cola(salida, 20))
	a.Log("la configuración no ha quedado sana; vuelvo a la anterior", "err", err)
	if e := a.restaurar(copia); e != nil {
		detalle += "\nno se pudieron restaurar los ficheros: " + e.Error()
	} else if out, e := a.levantar(ctx); e != nil {
		detalle += "\nla configuración anterior tampoco quedó sana: " + e.Error() + "\n" + cola(out, 10)
	} else if reiniciado {
		if out, e := a.reiniciarHttps(ctx); e != nil {
			detalle += "\nhttps tampoco quedó sano con el Caddyfile anterior: " + e.Error() + "\n" + cola(out, 5)
		}
	}
	return a.resultado(r.Version, "fallida", detalle)
}

// copiaBuena es la copia a la que volver si algo falla. Si una pasada
// anterior murió a medias (su diario sigue en «aplicando»), los ficheros de
// ahora no son buenos: vale la copia que hizo ella.
func (a *Aplicacion) copiaBuena() (copia string, retomada bool, err error) {
	if d, ok := LeerResultado(a.Dir); ok && d.Estado == "aplicando" && d.Copia != "" && filepath.Dir(d.Copia) == a.ruta(".respaldo") {
		if fi, err := os.Stat(d.Copia); err == nil && fi.IsDir() {
			a.Log("una aplicación anterior quedó a medias: si algo falla, se vuelve a su copia", "copia", d.Copia)
			return d.Copia, true, nil
		}
	}
	copia, err = a.respaldar()
	return copia, false, err
}

func (a *Aplicacion) reiniciarHttps(ctx context.Context) (string, error) {
	if out, err := a.compose(ctx, "restart", "https"); err != nil {
		return out, fmt.Errorf("no se pudo reiniciar https: %w", err)
	}
	return "", a.aguanta(ctx, "https")
}

// aguanta comprueba que un servicio sigue en marcha unos segundos después de
// arrancar: Caddy con un Caddyfile que no entiende arranca y se cae
// enseguida, en bucle, y `restart` no se entera.
func (a *Aplicacion) aguanta(ctx context.Context, servicio string) error {
	estado := func() (bool, float64, error) {
		lista, err := a.Docker.ListarConEtiqueta(ctx, "com.docker.compose.project="+a.Proyecto)
		if err != nil {
			return false, 0, err
		}
		for _, c := range lista {
			if c.Labels["com.docker.compose.service"] != servicio || c.Labels["com.docker.compose.oneoff"] == "True" {
				continue
			}
			i, err := a.Docker.Inspeccionar(ctx, c.ID)
			if err != nil {
				return false, 0, err
			}
			st, _ := i["State"].(map[string]any)
			corriendo, _ := st["Running"].(bool)
			reiniciando, _ := st["Restarting"].(bool)
			n, _ := i["RestartCount"].(float64)
			return corriendo && !reiniciando, n, nil
		}
		return false, 0, fmt.Errorf("no hay contenedor de %s", servicio)
	}
	_, antes, err := estado()
	if err != nil {
		return err
	}
	if !a.esperar(ctx, 8) {
		return ctx.Err()
	}
	ok, despues, err := estado()
	if err != nil {
		return err
	}
	if !ok || despues != antes {
		return fmt.Errorf("%s no aguanta en marcha con la configuración nueva", servicio)
	}
	return nil
}

func (a *Aplicacion) resultado(version, estado, detalle string) Resultado {
	if len(detalle) > 4000 {
		detalle = detalle[len(detalle)-4000:]
	}
	return Resultado{Version: version, Estado: estado, Detalle: strings.TrimSpace(detalle), Cuando: a.ahora().UTC().Format(time.RFC3339)}
}

func (a *Aplicacion) verificar(f ReleaseFirmada) (Release, error) {
	env, err := LeerEnv(a.ruta(".env"))
	if err != nil {
		return Release{}, fmt.Errorf("no se puede leer .env: %w", err)
	}
	clave, err := ClavePublica(env["PUBLICACION_CLAVE_PUBLICA"])
	if err != nil {
		return Release{}, errors.New("falta una PUBLICACION_CLAVE_PUBLICA válida en .env")
	}
	return Verificar(clave, f)
}

// comprobarMotor: antes de tocar nada, el motor tiene que contestar y no ser
// más antiguo que el mínimo (docker-compose negocia su versión por su cuenta;
// el auxiliar, con la misma que el sensor).
func (a *Aplicacion) comprobarMotor(ctx context.Context) error {
	_, err := a.Docker.Negociar(ctx)
	return err
}

// respaldar copia los ficheros del nodo en .respaldo/<UTC>/ y deja solo las últimas copias.
func (a *Aplicacion) respaldar() (string, error) {
	base := a.ruta(".respaldo")
	dir := filepath.Join(base, a.ahora().UTC().Format("20060102T150405Z"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	for _, n := range respaldados {
		b, err := os.ReadFile(a.ruta(n))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(dir, n), b, permisoDe(a.ruta(n))); err != nil {
			return "", err
		}
	}
	if copias, err := os.ReadDir(base); err == nil && len(copias) > copiasQueSeGuardan {
		nombres := make([]string, 0, len(copias))
		for _, c := range copias {
			nombres = append(nombres, c.Name())
		}
		slices.Sort(nombres)
		for _, n := range nombres[:len(nombres)-copiasQueSeGuardan] {
			_ = os.RemoveAll(filepath.Join(base, n))
		}
	}
	return dir, nil
}

// restaurar devuelve los ficheros a como estaban en la copia; los que no
// existían antes se quitan.
func (a *Aplicacion) restaurar(copia string) error {
	for _, n := range respaldados {
		b, err := os.ReadFile(filepath.Join(copia, n))
		if errors.Is(err, os.ErrNotExist) {
			if n != ".env" {
				_ = os.Remove(a.ruta(n))
			}
			continue
		}
		if err != nil {
			return err
		}
		if err := escribirAtomico(a.ruta(n), b, permisoDe(filepath.Join(copia, n))); err != nil {
			return err
		}
	}
	return nil
}

var postgresMayor = regexp.MustCompile(`image:\s*["']?postgres:(\d+)`)

// guardaPostgres impide cambiar de versión mayor de Postgres: sus datos no
// se migran solos y volver atrás no sería posible.
func (a *Aplicacion) guardaPostgres(c *Configuracion) error {
	if a.Modo != ModoNodo {
		return nil
	}
	actual, err := os.ReadFile(a.ruta("compose.yml"))
	if err != nil {
		return nil
	}
	antes := postgresMayor.FindSubmatch(actual)
	despues := postgresMayor.FindStringSubmatch(c.Ficheros["compose.yml"])
	if antes != nil && despues != nil && string(antes[1]) != despues[1] {
		return fmt.Errorf("la versión cambia Postgres de %s a %s: no se aplica sola (los datos no se migran)", antes[1], despues[1])
	}
	return nil
}

func (a *Aplicacion) escribirYLevantar(ctx context.Context, r Release, c *Configuracion) (string, error) {
	if err := a.borrarAnteriores(ctx); err != nil {
		return "", err
	}
	for nombre, texto := range c.Ficheros {
		// Lo que no cambia no se toca: reescribirlo cambiaría el inodo de un
		// fichero que un contenedor tiene montado.
		if actual, err := os.ReadFile(a.ruta(nombre)); err == nil && string(actual) == texto {
			continue
		}
		if err := escribirAtomico(a.ruta(nombre), []byte(texto), 0o644); err != nil {
			return "", err
		}
	}
	if err := a.completarEnv(c); err != nil {
		return "", fmt.Errorf(".env: %w", err)
	}
	if err := EscribirVersiones(a.ruta("versiones.env"), r, true); err != nil {
		return "", fmt.Errorf("versiones.env: %w", err)
	}
	// Ficheros que el compose monta: tienen que existir, o Docker crearía un
	// directorio en su lugar. Vacíos hasta que haya algo que poner.
	montado := "ca-raiz.crt"
	if a.Modo == ModoSensorRemoto {
		montado = "ca-consola.crt"
	}
	if _, err := os.Stat(a.ruta(montado)); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(a.ruta(montado), nil, 0o644); err != nil {
			return "", err
		}
	}
	if out, err := a.compose(ctx, "config", "-q"); err != nil {
		return out, fmt.Errorf("compose.yml no es válido: %w", err)
	}
	if err := a.descargarImagenes(ctx); err != nil {
		return "", err
	}
	if _, ok := c.Ficheros["Caddyfile"]; ok && a.Modo == ModoNodo {
		// Antes de levantar nada: que Caddy, con su imagen de esta versión, lo acepte.
		if out, err := a.compose(ctx, "run", "--rm", "--no-deps", "-T", "--pull", "never",
			"--entrypoint", "caddy", "https", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"); err != nil {
			return out, fmt.Errorf("Caddy no acepta el Caddyfile de la versión: %w", err)
		}
	}
	return a.levantar(ctx)
}

func (a *Aplicacion) levantar(ctx context.Context) (string, error) {
	return a.compose(ctx, "up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", "--remove-orphans")
}

// borrarAnteriores quita los contenedores «-anterior» parados que pudo dejar
// un actualizador viejo: compose los vería como réplicas del mismo servicio.
func (a *Aplicacion) borrarAnteriores(ctx context.Context) error {
	lista, err := a.Docker.ListarConEtiqueta(ctx, "com.docker.compose.project="+a.Proyecto)
	if err != nil {
		return err
	}
	for _, c := range lista {
		for _, n := range c.Names {
			if strings.HasSuffix(n, "-anterior") && c.State != "running" {
				if err := a.Docker.Borrar(ctx, c.ID); err != nil {
					return err
				}
				a.Log("contenedor anterior retirado", "nombre", n)
			}
		}
	}
	return nil
}

// completarEnv añade a .env las variables que falten. Nunca cambia una que ya exista.
func (a *Aplicacion) completarEnv(c *Configuracion) error {
	if c.Entorno == nil {
		return nil
	}
	env, err := LeerEnv(a.ruta(".env"))
	if err != nil {
		return err
	}
	var nuevas []string
	claves := make([]string, 0, len(c.Entorno.Nuevas))
	for k := range c.Entorno.Nuevas {
		claves = append(claves, k)
	}
	slices.Sort(claves)
	for _, k := range claves {
		if _, ya := env[k]; !ya {
			nuevas = append(nuevas, k+"="+c.Entorno.Nuevas[k])
		}
	}
	for _, k := range c.Entorno.Generar {
		if _, ya := env[k]; !ya {
			b := make([]byte, 32)
			if _, err := rand.Read(b); err != nil {
				return err
			}
			nuevas = append(nuevas, k+"="+hex.EncodeToString(b))
		}
	}
	if len(nuevas) == 0 {
		return nil
	}
	actual, err := os.ReadFile(a.ruta(".env"))
	if err != nil {
		return err
	}
	if len(actual) > 0 && !bytes.HasSuffix(actual, []byte("\n")) {
		actual = append(actual, '\n')
	}
	actual = append(actual, []byte(strings.Join(nuevas, "\n")+"\n")...)
	return escribirAtomico(a.ruta(".env"), actual, 0o600)
}

func (a *Aplicacion) descargarImagenes(ctx context.Context) error {
	out, err := a.compose(ctx, "config", "--images")
	if err != nil {
		return fmt.Errorf("no se pueden listar las imágenes: %w", err)
	}
	for _, img := range strings.Fields(out) {
		if err := a.Docker.AsegurarImagen(ctx, img); err != nil {
			return fmt.Errorf("imagen %s: %w", img, err)
		}
	}
	return nil
}

func (a *Aplicacion) compose(ctx context.Context, args ...string) (string, error) {
	base := []string{
		"-p", a.Proyecto, "--project-directory", a.Dir,
		"-f", a.ruta("compose.yml"),
		"--env-file", a.ruta(".env"), "--env-file", a.ruta("versiones.env"),
	}
	cmd := exec.CommandContext(ctx, a.Compose, append(base, args...)...)
	cmd.Env = append(os.Environ(), "HOME=/tmp", "DOCKER_HOST=unix:///var/run/docker.sock")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func hashDe(ruta string) string {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return ""
	}
	return hashTexto(string(b))
}

func hashTexto(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// GuardarResultado deja el resultado en <dir>/.aplicacion.json, para que el
// actualizador lo vuelva a informar si la consola no lo recibió.
func GuardarResultado(dir string, r Resultado) error {
	b, _ := json.MarshalIndent(r, "", "\t")
	return escribirAtomico(filepath.Join(dir, ".aplicacion.json"), b, 0o600)
}

// LeerResultado lee el último resultado del auxiliar; ok=false si no hay.
func LeerResultado(dir string) (Resultado, bool) {
	var r Resultado
	b, err := os.ReadFile(filepath.Join(dir, ".aplicacion.json"))
	if err != nil || json.Unmarshal(b, &r) != nil {
		return r, false
	}
	return r, true
}

// LeerEnv lee un fichero .env de compose: CLAVE=valor por línea, con
// comentarios y comillas dobles o simples opcionales alrededor del valor.
func LeerEnv(ruta string) (map[string]string, error) {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		k, v, ok := strings.Cut(l, "=")
		if !ok {
			continue
		}
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		env[strings.TrimSpace(k)] = v
	}
	return env, nil
}

func escribirAtomico(ruta string, b []byte, permiso os.FileMode) error {
	tmp := ruta + ".tmp"
	if err := os.WriteFile(tmp, b, permiso); err != nil {
		return err
	}
	if err := os.Chmod(tmp, permiso); err != nil {
		return err
	}
	return os.Rename(tmp, ruta)
}

func permisoDe(ruta string) os.FileMode {
	if fi, err := os.Stat(ruta); err == nil {
		return fi.Mode().Perm()
	}
	return 0o644
}

// cola devuelve las últimas n líneas de un texto.
func cola(s string, n int) string {
	l := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(l) > n {
		l = l[len(l)-n:]
	}
	return strings.Join(l, "\n")
}

// exportarRaiz copia la raíz (pública) de la CA interna del nodo a
// ca-raiz.crt, legible: la consola la necesita para las líneas de
// instalación de sensores remotos, y la carpeta de Caddy solo la lee root.
// Lo que sale de Caddy no se escribe tal cual: solo un certificado de CA
// válido, encima del fichero que la consola ya monta. Si falla no pasa nada
// grave: la consola lo explica y se reintenta en la próxima versión.
func (a *Aplicacion) exportarRaiz(ctx context.Context) {
	env, err := LeerEnv(a.ruta(".env"))
	if err != nil || (env["TLS_MODO"] != "" && env["TLS_MODO"] != "interno") {
		return
	}
	tmp, err := os.MkdirTemp("", "raiz")
	if err != nil {
		a.Log("no se pudo copiar la raíz de la CA del nodo", "err", err)
		return
	}
	defer os.RemoveAll(tmp)
	copia := filepath.Join(tmp, "raiz.crt")
	var raiz []byte
	for i := 0; i < 5 && raiz == nil; i++ {
		// Caddy crea su CA al arrancar: puede tardar unos segundos.
		if i > 0 && !a.esperar(ctx, 3) {
			return
		}
		_ = os.RemoveAll(copia)
		out, err := a.compose(ctx, "cp", "https:/data/caddy/pki/authorities/local/root.crt", copia)
		if err == nil {
			raiz, err = raizDeCA(copia)
		}
		if err != nil && i == 4 {
			a.Log("no se pudo copiar la raíz de la CA del nodo", "err", err, "salida", cola(out, 3))
		}
	}
	if raiz == nil {
		// Al menos, que la que ya hubiera (de un instalador anterior) sea legible.
		if raiz, err = raizDeCA(a.ruta("ca-raiz.crt")); err != nil {
			return
		}
	}
	nuevo, err := escribirEnSuSitio(a.ruta("ca-raiz.crt"), raiz, 0o644)
	if err != nil {
		a.Log("no se pudo escribir ca-raiz.crt", "err", err)
		return
	}
	if nuevo {
		// Es otro fichero: la consola sigue viendo el que montó hasta que se reinicie.
		if out, err := a.compose(ctx, "restart", "consola"); err != nil {
			a.Log("no se pudo reiniciar la consola tras escribir ca-raiz.crt", "err", err, "salida", cola(out, 3))
		}
	}
}

// raizDeCA solo da por bueno un fichero normal (no un enlace) con un único
// certificado de CA, y devuelve ese certificado recodificado, nada más.
func raizDeCA(ruta string) ([]byte, error) {
	fi, err := os.Lstat(ruta)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > 64<<10 {
		return nil, fmt.Errorf("%s no es un fichero normal", filepath.Base(ruta))
	}
	b, err := os.ReadFile(ruta)
	if err != nil {
		return nil, err
	}
	bloque, resto := pem.Decode(b)
	if bloque == nil || bloque.Type != "CERTIFICATE" || len(bytes.TrimSpace(resto)) > 0 {
		return nil, fmt.Errorf("%s no es un único certificado", filepath.Base(ruta))
	}
	cert, err := x509.ParseCertificate(bloque.Bytes)
	if err != nil || !cert.IsCA {
		return nil, fmt.Errorf("%s no es el certificado de una CA", filepath.Base(ruta))
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: bloque.Bytes}), nil
}

// escribirEnSuSitio escribe encima del fichero que ya hay, sin cambiarle el
// inodo: un contenedor que lo monta suelto sigue viendo el mismo fichero y
// lee el contenido nuevo. Nunca sigue un enlace: si en su lugar hay un enlace
// u otra cosa, se quita y se crea un fichero nuevo (nuevo = true).
func escribirEnSuSitio(ruta string, b []byte, permiso os.FileMode) (nuevo bool, err error) {
	fi, err := os.Lstat(ruta)
	if err == nil && fi.Mode().IsRegular() {
		if actual, e := os.ReadFile(ruta); e == nil && bytes.Equal(actual, b) && fi.Mode().Perm() == permiso {
			return false, nil
		}
		f, err := os.OpenFile(ruta, os.O_WRONLY|os.O_TRUNC|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return false, err
		}
		_, err = f.Write(b)
		if e := f.Chmod(permiso); err == nil {
			err = e
		}
		if e := f.Close(); err == nil {
			err = e
		}
		return false, err
	}
	if err == nil {
		if err := os.RemoveAll(ruta); err != nil {
			return false, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return true, escribirAtomico(ruta, b, permiso)
}
