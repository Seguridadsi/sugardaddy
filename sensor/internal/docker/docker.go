// Package docker habla con el motor de Docker por su socket, con la API HTTP
// y sin dependencias: el sensor solo necesita crear, arrancar, listar y borrar.
package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Cada motor habla un tramo de versiones de la API (de MinAPIVersion a
// ApiVersion) y lo dice en GET /version, que contesta sin prefijo de versión.
// No se fija ninguna: se habla la más alta que conocen los dos.
const (
	// APIMinima: la de Docker 20.10. Un motor por debajo no sirve.
	APIMinima = "1.41"
	// APIMaxima: la más alta con la que se ha comprobado todo lo que el
	// sensor y el actualizador piden al motor (Docker 29.0).
	APIMaxima = "1.52"
	// DockerMinimo: la primera versión de Docker que habla la APIMinima.
	// Por el número de versión no se rechaza nada más: lo que dependa de
	// cada motor (como clone3 en las 20.10 anteriores a la 20.10.10, que
	// muchas distribuciones ya traen arreglado) se mide con una sonda.
	DockerMinimo = "20.10"
)

// Códigos estables (fase.causa) de un fallo general del motor: no depende de
// ninguna trampa y las tumba todas.
const (
	MotorInalcanzable = "motor.inalcanzable"
	MotorPermiso      = "motor.permiso"
	MotorAPI          = "motor.api"
	MotorAntiguo      = "motor.antiguo"
)

// ErrMotor es un fallo general del motor, con su código estable y el texto
// que ve el cliente.
type ErrMotor struct {
	Codigo string
	Texto  string
	Causa  error
}

func (e *ErrMotor) Error() string { return e.Codigo + ": " + e.Texto }
func (e *ErrMotor) Unwrap() error { return e.Causa }

// Motor es lo que el motor dice de sí mismo en GET /version.
type Motor struct {
	Version       string `json:"Version"`
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
	Os            string `json:"Os"`
	Arch          string `json:"Arch"`
	KernelVersion string `json:"KernelVersion"`
	Platform      struct {
		Name string `json:"Name"`
	} `json:"Platform"`
	Components []struct {
		Name    string `json:"Name"`
		Version string `json:"Version"`
	} `json:"Components"`
}

// Podman: el motor es Podman con su API compatible con la de Docker. Su
// número de versión es el de Podman, no el de Docker.
func (m Motor) Podman() bool {
	for _, c := range m.Components {
		if strings.EqualFold(c.Name, "Podman Engine") {
			return true
		}
	}
	return strings.Contains(strings.ToLower(m.Platform.Name), "podman")
}

// Nombre del motor para los mensajes al cliente.
func (m Motor) Nombre() string {
	if m.Podman() {
		return "Podman"
	}
	return "Docker"
}

// Negociado es la versión de la API con la que se habla al motor.
type Negociado struct {
	API string
	// SinGarantia: el motor ya no admite ninguna versión de las que
	// conocemos y se le habla con la más baja que admite.
	SinGarantia bool
	Motor       Motor
}

type Cliente struct {
	http   *http.Client
	socket string
	// Credenciales por registro (p. ej. ghcr.io), para descargar imágenes privadas.
	credenciales map[string]Credencial

	mu        sync.Mutex
	negociado Negociado
}

type Credencial struct{ Usuario, Token string }

// ConCredencial añade una credencial de solo lectura para un registro.
func (c *Cliente) ConCredencial(registro string, cr Credencial) *Cliente {
	if c.credenciales == nil {
		c.credenciales = map[string]Credencial{}
	}
	c.credenciales[registro] = cr
	return c
}

// authPara devuelve la cabecera X-Registry-Auth si la imagen es de un registro con credencial.
func (c *Cliente) authPara(imagen string) string {
	registro := strings.SplitN(imagen, "/", 2)[0]
	cr, ok := c.credenciales[registro]
	if !ok {
		return ""
	}
	b, _ := json.Marshal(map[string]string{"username": cr.Usuario, "password": cr.Token, "serveraddress": registro})
	return base64.URLEncoding.EncodeToString(b)
}

func Nuevo(socket string) *Cliente {
	return &Cliente{socket: socket, http: &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}}
}

// Lo que tarda como mucho el motor en decir qué versión habla: si no contesta
// en este tiempo, es que no responde.
const esperaVersion = 30 * time.Second

// Negociar pregunta al motor qué versiones de la API habla (solo la primera
// vez: luego la recuerda) y elige con cuál hablarle. Un motor por debajo del
// mínimo es un ErrMotor con el código motor.antiguo.
func (c *Cliente) Negociar(ctx context.Context) (Negociado, error) {
	c.mu.Lock()
	n := c.negociado
	c.mu.Unlock()
	if n.API != "" {
		return n, nil
	}
	ctx, cancelar := context.WithTimeout(ctx, esperaVersion)
	defer cancelar()
	var m Motor
	if err := c.pedir(ctx, http.MethodGet, "/version", nil, &m, nil); err != nil {
		return Negociado{}, c.Clasificar(err)
	}
	n, err := negociar(m)
	if err != nil {
		return Negociado{}, err
	}
	c.mu.Lock()
	c.negociado = n
	c.mu.Unlock()
	return n, nil
}

// olvidar la versión negociada: el motor ha cambiado (se ha actualizado sin
// reiniciar el sensor) y hay que volver a preguntarle.
func (c *Cliente) olvidar() {
	c.mu.Lock()
	c.negociado = Negociado{}
	c.mu.Unlock()
}

// negociar elige la versión: la más alta del motor, sin pasar de la más alta
// que conocemos. Si el motor ya no admite esa (un motor futuro que suba su
// mínimo), la más baja que admite: es la más parecida a lo que conocemos.
func negociar(m Motor) (Negociado, error) {
	api := m.APIVersion
	if !esVersion(api) {
		return Negociado{}, &ErrMotor{Codigo: MotorAPI, Texto: "el motor de contenedores no dice qué versión de su API habla; puede que no sea Docker ni Podman"}
	}
	antiguo := func(que string) error {
		return &ErrMotor{Codigo: MotorAntiguo, Texto: fmt.Sprintf("el motor de contenedores es demasiado antiguo (%s): Sugardaddy necesita Docker %s o posterior, o Podman 4 o posterior", que, DockerMinimo)}
	}
	if CompararVersiones(api, APIMinima) < 0 {
		return Negociado{}, antiguo(fmt.Sprintf("%s %s, API %s", m.Nombre(), m.Version, api))
	}
	n := Negociado{API: api, Motor: m}
	if CompararVersiones(n.API, APIMaxima) > 0 {
		n.API = APIMaxima
	}
	if esVersion(m.MinAPIVersion) && CompararVersiones(n.API, m.MinAPIVersion) < 0 {
		n.API, n.SinGarantia = m.MinAPIVersion, true
	}
	return n, nil
}

var numeroDeVersion = regexp.MustCompile(`^v?(\d+)\.(\d+)(?:\.(\d+))?`)

// esVersion: empieza por un número de versión («20.10.21+dfsg1» vale).
func esVersion(v string) bool { return numeroDeVersion.MatchString(v) }

// CompararVersiones compara dos versiones por sus números («1.9» < «1.41»;
// lo que sigue a los números, como «+dfsg1» o «-ce», no cuenta). Una que no
// empieza por números va antes que cualquier otra.
func CompararVersiones(a, b string) int {
	na, nb := numeros(a), numeros(b)
	for i := range 3 {
		if na[i] != nb[i] {
			if na[i] < nb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func numeros(v string) [3]int {
	var n [3]int
	m := numeroDeVersion.FindStringSubmatch(v)
	if m == nil {
		return [3]int{-1, -1, -1}
	}
	for i := range 3 {
		n[i], _ = strconv.Atoi(m[i+1])
	}
	return n
}

// versionRechazada: el motor no admite la versión de la API con la que se le
// ha hablado (Docker dice «client version 1.43 is too new» o «too old»).
var versionRechazada = regexp.MustCompile(`(?i)client version .* is too (new|old)`)

// Clasificar dice qué fallo general del motor hay detrás de un error al
// hablar con él, con su código estable y un texto claro para el cliente.
func (c *Cliente) Clasificar(err error) *ErrMotor {
	var em *ErrMotor
	if errors.As(err, &em) {
		return em
	}
	var ea *ErrAPI
	switch {
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM), errors.Is(err, os.ErrPermission):
		return &ErrMotor{Codigo: MotorPermiso, Causa: err, Texto: fmt.Sprintf("el sensor no tiene permiso para usar el motor de contenedores por %s: revisa los permisos del socket y si SELinux o AppArmor lo impiden", c.socket)}
	case errors.As(err, &ea) && (ea.Codigo == http.StatusUnauthorized || ea.Codigo == http.StatusForbidden):
		return &ErrMotor{Codigo: MotorPermiso, Causa: err, Texto: fmt.Sprintf("el motor de contenedores no deja al sensor ver ni crear contenedores (%s): revisa si tiene un complemento de autorización", recortar(ea.Mensaje, 200))}
	case errors.As(err, &ea):
		return &ErrMotor{Codigo: MotorAPI, Causa: err, Texto: fmt.Sprintf("el motor de contenedores contesta con un error (%d: %s)", ea.Codigo, recortar(ea.Mensaje, 200))}
	case errors.Is(err, syscall.ENOENT), errors.Is(err, os.ErrNotExist), errors.Is(err, syscall.ECONNREFUSED),
		errors.Is(err, syscall.ECONNRESET), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF),
		errors.Is(err, context.DeadlineExceeded), esEspera(err):
		return &ErrMotor{Codigo: MotorInalcanzable, Causa: err, Texto: fmt.Sprintf("no se puede hablar con el motor de contenedores por %s: está parado, no responde o el socket no está montado en el sensor", c.socket)}
	default:
		return &ErrMotor{Codigo: MotorAPI, Causa: err, Texto: "el motor de contenedores contesta algo que no se entiende (" + recortar(err.Error(), 200) + ")"}
	}
}

func esEspera(err error) bool {
	var t interface{ Timeout() bool }
	return errors.As(err, &t) && t.Timeout()
}

func recortar(t string, n int) string {
	if len(t) <= n {
		return t
	}
	return strings.ToValidUTF8(t[:n], "") + "…"
}

type ErrAPI struct {
	Codigo  int
	Mensaje string
}

func (e *ErrAPI) Error() string { return fmt.Sprintf("docker %d: %s", e.Codigo, e.Mensaje) }

func NoExiste(err error) bool {
	e, ok := err.(*ErrAPI)
	return ok && e.Codigo == http.StatusNotFound
}

func (c *Cliente) llamar(ctx context.Context, metodo, ruta string, cuerpo, salida any) error {
	return c.llamarCon(ctx, metodo, ruta, cuerpo, salida, nil)
}

// llamarCon habla con el motor en la versión negociada. Si el motor la
// rechaza (se ha actualizado mientras el sensor seguía en marcha), se vuelve
// a negociar y se repite una vez.
func (c *Cliente) llamarCon(ctx context.Context, metodo, ruta string, cuerpo, salida any, cabeceras map[string]string) error {
	for intento := 0; ; intento++ {
		n, err := c.Negociar(ctx)
		if err != nil {
			return err
		}
		err = c.pedir(ctx, metodo, "/v"+n.API+ruta, cuerpo, salida, cabeceras)
		var ea *ErrAPI
		if intento == 0 && errors.As(err, &ea) && ea.Codigo == http.StatusBadRequest && versionRechazada.MatchString(ea.Mensaje) {
			c.olvidar()
			continue
		}
		return err
	}
}

// pedir hace una petición tal cual, con la ruta completa.
func (c *Cliente) pedir(ctx context.Context, metodo, ruta string, cuerpo, salida any, cabeceras map[string]string) error {
	var r io.Reader
	if cuerpo != nil {
		b, err := json.Marshal(cuerpo)
		if err != nil {
			return err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, metodo, "http://docker"+ruta, r)
	if err != nil {
		return err
	}
	if cuerpo != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range cabeceras {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		var m struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return &ErrAPI{Codigo: resp.StatusCode, Mensaje: m.Message}
	}
	if salida != nil {
		return json.NewDecoder(resp.Body).Decode(salida)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// ImagenPresente dice si la imagen ya está en la máquina.
func (c *Cliente) ImagenPresente(ctx context.Context, imagen string) bool {
	return c.llamar(ctx, http.MethodGet, "/images/"+url.PathEscape(imagen)+"/json", nil, nil) == nil
}

// AsegurarImagen descarga la imagen si no está. Se pide siempre por digest.
func (c *Cliente) AsegurarImagen(ctx context.Context, imagen string) error {
	if c.ImagenPresente(ctx, imagen) {
		return nil
	}
	return c.Descargar(ctx, imagen)
}

// Descargar baja la imagen del registro (con su credencial, si la hay).
func (c *Cliente) Descargar(ctx context.Context, imagen string) error {
	var cab map[string]string
	if a := c.authPara(imagen); a != "" {
		cab = map[string]string{"X-Registry-Auth": a}
	}
	if err := c.llamarCon(ctx, http.MethodPost, "/images/create?fromImage="+url.QueryEscape(imagen), nil, nil, cab); err != nil {
		return err
	}
	// Un fallo de descarga llega dentro del flujo con estado 200: solo cuenta si la imagen está.
	if err := c.llamar(ctx, http.MethodGet, "/images/"+url.PathEscape(imagen)+"/json", nil, nil); err != nil {
		return fmt.Errorf("no se pudo descargar %s (¿credencial del registro?)", imagen)
	}
	return nil
}

// Info es lo que el motor cuenta de la máquina y de cómo corre (GET /info).
type Info struct {
	ServerVersion   string   `json:"ServerVersion"`
	OperatingSystem string   `json:"OperatingSystem"`
	OSType          string   `json:"OSType"`
	Architecture    string   `json:"Architecture"`
	KernelVersion   string   `json:"KernelVersion"`
	CgroupVersion   string   `json:"CgroupVersion"`
	CgroupDriver    string   `json:"CgroupDriver"`
	SecurityOptions []string `json:"SecurityOptions"`
	MemTotal        int64    `json:"MemTotal"`
	NCPU            int      `json:"NCPU"`
	Driver          string   `json:"Driver"`
	Labels          []string `json:"Labels"`
}

func (c *Cliente) Info(ctx context.Context) (Info, error) {
	var r Info
	err := c.llamar(ctx, http.MethodGet, "/info", nil, &r)
	return r, err
}

// Esperar bloquea hasta que el contenedor termine y devuelve su código de salida.
func (c *Cliente) Esperar(ctx context.Context, id string) (int, error) {
	var r struct {
		StatusCode int `json:"StatusCode"`
	}
	err := c.llamar(ctx, http.MethodPost, "/containers/"+id+"/wait", nil, &r)
	return r.StatusCode, err
}

// RegistrosAcotados es la configuración de registros de los contenedores que
// crea Sugardaddy: con tope, porque por defecto Docker los deja crecer sin
// fin en la máquina del cliente.
func RegistrosAcotados() map[string]any {
	return map[string]any{"Type": "json-file", "Config": map[string]string{"max-size": "10m", "max-file": "3"}}
}

type Red struct {
	// Driver: "bridge", "macvlan"… (la inspección lo dice).
	Driver     string            `json:"Driver"`
	Options    map[string]string `json:"Options"`
	Containers map[string]any    `json:"Containers"`
	IPAM       struct {
		Config []struct {
			Subnet  string `json:"Subnet"`
			Gateway string `json:"Gateway"`
		} `json:"Config"`
	} `json:"IPAM"`
}

// TieneSubred: si la red gestiona esa subred entre las suyas.
func (r Red) TieneSubred(p netip.Prefix) bool {
	for _, c := range r.IPAM.Config {
		if s, err := netip.ParsePrefix(c.Subnet); err == nil && s == p {
			return true
		}
	}
	return false
}

// Pasarelas son las direcciones del propio motor en la red, una por subred.
// Lo que llega a una trampa desde ellas no viene del atacante, sino del motor.
// Si el motor no la dice, se toma la primera de la subred: la que ponen
// Docker y Podman.
func (r Red) Pasarelas() []string {
	var p []string
	for _, c := range r.IPAM.Config {
		if ip, err := netip.ParseAddr(c.Gateway); err == nil {
			p = append(p, ip.Unmap().String())
		} else if s, err := netip.ParsePrefix(c.Subnet); err == nil {
			p = append(p, s.Masked().Addr().Next().Unmap().String())
		}
	}
	return p
}

// InspeccionarRed devuelve las opciones de una red y los contenedores que tiene conectados.
func (c *Cliente) InspeccionarRed(ctx context.Context, nombre string) (Red, error) {
	var r Red
	err := c.llamar(ctx, http.MethodGet, "/networks/"+url.PathEscape(nombre), nil, &r)
	return r, err
}

func (c *Cliente) BorrarRed(ctx context.Context, nombre string) error {
	return c.llamar(ctx, http.MethodDelete, "/networks/"+url.PathEscape(nombre), nil, nil)
}

// AsegurarRed crea, si no existe, una red puente para trampas: sin NAT de
// salida si salida es false (los puertos publicados siguen llegando, pero el
// contenedor no puede salir) y siempre sin tráfico entre sus contenedores,
// para que una trampa tomada no llegue a las demás. Una red con ese nombre y
// otro valor en esas opciones se rehace si está vacía; si no, es un error.
// Si las opciones no aparecen (Podman las acepta y no las guarda), la red
// vale pero no está garantizada (garantizada = false): el motor no confirma
// ni el aislamiento entre trampas ni que no salgan a Internet.
func (c *Cliente) AsegurarRed(ctx context.Context, nombre string, salida bool) (garantizada bool, err error) {
	opciones := map[string]string{
		"com.docker.network.bridge.enable_ip_masquerade": fmt.Sprint(salida),
		"com.docker.network.bridge.enable_icc":           "false",
	}
	if r, err := c.InspeccionarRed(ctx, nombre); err == nil {
		distinta, todas := false, true
		for k, v := range opciones {
			actual, ok := r.Options[k]
			todas = todas && ok
			if ok && actual != v {
				distinta = true
			}
		}
		if !distinta {
			return todas, nil
		}
		if len(r.Containers) > 0 {
			return false, fmt.Errorf("la red %s existe sin aislar sus contenedores y está en uso", nombre)
		}
		if err := c.BorrarRed(ctx, nombre); err != nil {
			return false, err
		}
	} else if !NoExiste(err) {
		return false, err
	}
	if err := c.llamar(ctx, http.MethodPost, "/networks/create", map[string]any{
		"Name":    nombre,
		"Driver":  "bridge",
		"Options": opciones,
		"Labels":  map[string]string{"sugardaddy": "red"},
	}, nil); err != nil {
		return false, err
	}
	// Recién creada: se mira si el motor ha guardado las opciones.
	r, err := c.InspeccionarRed(ctx, nombre)
	if err != nil {
		return false, nil
	}
	for k, v := range opciones {
		if r.Options[k] != v {
			return false, nil
		}
	}
	return true, nil
}

// AsegurarRedPropia crea, si no existe, la red macvlan del modo «IP propia»
// (docs/diseno/red.md): cada trampa va con su propia IP en el segmento del
// cliente, sobre la interfaz física que ha elegido quien instala el sensor.
//
// Lo que esta red NO da, a propósito:
//   - sin NAT y sin publicar puertos (macvlan no publica: la trampa ES la IP);
//   - sin pasarela viva: la pasarela de la subred es la primera IP del rango
//     propio, que nadie tiene, así que la trampa no tiene ruta a Internet
//     (y cambiarla exigiría NET_ADMIN, que las trampas jamás reciben);
//   - el anfitrión no ve a sus macvlan: sin macvlan propia, el sensor y las
//     trampas del mismo anfitrión no se hablan entre sí (y el vigilante ARP
//     solo oye lo que llega a la interfaz física, en difusión).
//
// No hay aquí opciones de puente que confirmar (ni icc ni masquerade: el
// aislamiento lo da el propio enlace), así que garantizada = true si la red
// existe con su padre y su subred; distinta y en uso, es error.
func (c *Cliente) AsegurarRedPropia(ctx context.Context, nombre, interfaz string, rango netip.Prefix) (garantizada bool, err error) {
	deseada := map[string]any{
		"Name":   nombre,
		"Driver": "macvlan",
		"Options": map[string]string{
			"parent": interfaz,
		},
		"IPAM": map[string]any{
			"Config": []map[string]any{
				// La pasarela es la primera IP del rango propio: una IP que
				// nadie tiene (el rango está reservado): la ruta por defecto
				// de la trampa no lleva a ningún sitio.
				{"Subnet": rango.String(), "Gateway": pasarelaNadie(rango)},
			},
		},
		"Labels": map[string]string{"sugardaddy": "red-propia"},
	}
	if r, err := c.InspeccionarRed(ctx, nombre); err == nil {
		if r.Driver == "macvlan" && r.Options["parent"] == interfaz && r.TieneSubred(rango) {
			return true, nil
		}
		if len(r.Containers) > 0 {
			return false, fmt.Errorf("la red %s existe con otra interfaz o subred y está en uso", nombre)
		}
		if err := c.BorrarRed(ctx, nombre); err != nil {
			return false, err
		}
	} else if !NoExiste(err) {
		return false, err
	}
	if err := c.llamar(ctx, http.MethodPost, "/networks/create", deseada, nil); err != nil {
		return false, err
	}
	r, err := c.InspeccionarRed(ctx, nombre)
	if err != nil {
		return false, nil
	}
	return r.Driver == "macvlan" && r.Options["parent"] == interfaz && r.TieneSubred(rango), nil
}

// AsegurarRedBanco crea, si no existe, la red de banco del modo «IP propia»:
// un puente propio con la subred fija de la prueba, donde la trampa y el
// atacante coinciden en capa 2 (los enchufes crudos ven las mismas tramas,
// y el multicast del LLMNR pasa de uno al otro). Sin el aislamiento entre
// trampas del puente de producción: en el banco solo están la trampa en
// prueba y su atacante, y han de verse (docs/diseno/red.md §5).
func (c *Cliente) AsegurarRedBanco(ctx context.Context, nombre string, subred netip.Prefix) error {
	if r, err := c.InspeccionarRed(ctx, nombre); err == nil {
		if r.Driver == "bridge" && r.TieneSubred(subred) {
			return nil
		}
		if len(r.Containers) > 0 {
			return fmt.Errorf("la red de banco %s existe con otra subred y está en uso", nombre)
		}
		if err := c.BorrarRed(ctx, nombre); err != nil {
			return err
		}
	} else if !NoExiste(err) {
		return err
	}
	return c.llamar(ctx, http.MethodPost, "/networks/create", map[string]any{
		"Name":   nombre,
		"Driver": "bridge",
		"IPAM": map[string]any{
			"Config": []map[string]any{{"Subnet": subred.String()}},
		},
		"Labels": map[string]string{"sugardaddy": "red-banco"},
	}, nil)
}

// pasarelaNadie: la primera IP del rango propio, la pasarela que ninguna
// máquina tiene. Si el rango es tan pequeño que no hay primera libre, la
// propia dirección de red hace el papel (y menos trampas caben).
func pasarelaNadie(r netip.Prefix) string {
	if siguiente := r.Masked().Addr().Next(); r.Contains(siguiente) {
		return siguiente.String()
	}
	return r.Masked().Addr().String()
}

type Volumen struct {
	Name   string            `json:"Name"`
	Labels map[string]string `json:"Labels"`
}

// Volumenes lista los volúmenes que cumplen los filtros de Docker (p. ej.
// {"label": ["sugardaddy.sensor=s1"]} o {"name": ["sd-s1-"]}).
func (c *Cliente) Volumenes(ctx context.Context, filtros map[string][]string) ([]Volumen, error) {
	filtro, _ := json.Marshal(filtros)
	var r struct {
		Volumes []Volumen `json:"Volumes"`
	}
	err := c.llamar(ctx, http.MethodGet, "/volumes?filters="+url.QueryEscape(string(filtro)), nil, &r)
	return r.Volumes, err
}

// BorrarVolumen quita un volumen; si ya no está, no es un error.
func (c *Cliente) BorrarVolumen(ctx context.Context, nombre string) error {
	if err := c.llamar(ctx, http.MethodDelete, "/volumes/"+url.PathEscape(nombre), nil, nil); err != nil && !NoExiste(err) {
		return err
	}
	return nil
}

type Contenedor struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	State  string            `json:"State"`
	Labels map[string]string `json:"Labels"`
	Ports  []PuertoPublicado `json:"Ports"`
}

// PuertoPublicado es un puerto del contenedor publicado en el anfitrión
// (PublicPort 0: expuesto, sin publicar).
type PuertoPublicado struct {
	IP         string `json:"IP"`
	PublicPort int    `json:"PublicPort"`
	Type       string `json:"Type"`
}

func (c *Cliente) ListarConEtiqueta(ctx context.Context, etiqueta string) ([]Contenedor, error) {
	filtro, _ := json.Marshal(map[string][]string{"label": {etiqueta}})
	var lista []Contenedor
	err := c.llamar(ctx, http.MethodGet, "/containers/json?all=1&filters="+url.QueryEscape(string(filtro)), nil, &lista)
	return lista, err
}

func (c *Cliente) Crear(ctx context.Context, nombre string, config map[string]any) (string, error) {
	var r struct {
		ID string `json:"Id"`
	}
	err := c.llamar(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(nombre), config, &r)
	return r.ID, err
}

func (c *Cliente) Arrancar(ctx context.Context, id string) error {
	return c.llamar(ctx, http.MethodPost, "/containers/"+id+"/start", nil, nil)
}

// Inspeccionar devuelve la descripción completa del contenedor, tal cual la da Docker.
func (c *Cliente) Inspeccionar(ctx context.Context, id string) (map[string]any, error) {
	var r map[string]any
	err := c.llamar(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/json", nil, &r)
	return r, err
}

// InspeccionarImagen devuelve la descripción de una imagen local.
func (c *Cliente) InspeccionarImagen(ctx context.Context, ref string) (map[string]any, error) {
	var r map[string]any
	err := c.llamar(ctx, http.MethodGet, "/images/"+url.PathEscape(ref)+"/json", nil, &r)
	return r, err
}

// Conectar une un contenedor ya creado a otra red, con sus alias.
func (c *Cliente) Conectar(ctx context.Context, red, id string, endpoint map[string]any) error {
	return c.llamar(ctx, http.MethodPost, "/networks/"+url.PathEscape(red)+"/connect",
		map[string]any{"Container": id, "EndpointConfig": endpoint}, nil)
}

func (c *Cliente) Renombrar(ctx context.Context, id, nombre string) error {
	return c.llamar(ctx, http.MethodPost, "/containers/"+id+"/rename?name="+url.QueryEscape(nombre), nil, nil)
}

func (c *Cliente) Parar(ctx context.Context, id string) error {
	err := c.llamar(ctx, http.MethodPost, "/containers/"+id+"/stop?t=10", nil, nil)
	if e, ok := err.(*ErrAPI); ok && e.Codigo == http.StatusNotModified {
		return nil
	}
	return err
}

func (c *Cliente) Borrar(ctx context.Context, id string) error {
	// v=1 quita también los volúmenes anónimos que declara la imagen (Cowrie
	// declara dos): sin él, cada vez que se rehace una trampa se quedan en la
	// máquina del cliente. Los volúmenes con nombre y los registros (montados
	// desde el anfitrión) no se tocan.
	return c.llamar(ctx, http.MethodDelete, "/containers/"+id+"?force=1&v=1", nil, nil)
}

// Salida devuelve lo que un contenedor ha escrito por su salida estándar y de
// errores (las últimas líneas), para explicar por qué ha fallado.
func (c *Cliente) Salida(ctx context.Context, id string, lineas int) (string, error) {
	n, err := c.Negociar(ctx)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://docker/v%s/containers/%s/logs?stdout=1&stderr=1&tail=%d", n.API, url.PathEscape(id), lineas), nil)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	// Sin terminal, cada trozo lleva una cabecera de 8 bytes (flujo y tamaño).
	var out bytes.Buffer
	for len(b) >= 8 {
		n := int(b[4])<<24 | int(b[5])<<16 | int(b[6])<<8 | int(b[7])
		if 8+n > len(b) {
			break
		}
		out.Write(b[8 : 8+n])
		b = b[8+n:]
	}
	return out.String(), nil
}

// LeerDeContenedor saca un fichero del sistema de ficheros de un contenedor por
// la API de archivo del motor (GET /containers/<id>/archive?path=<ruta>): el
// motor devuelve un tar con ese fichero. Es la única forma de que el sensor lea
// lo que una trampa guardó en su /tmp (tmpfs) o en un volumen aislado, que el
// anfitrión no ve. Extrae el único fichero regular del tar, hasta `tope` bytes;
// si pasa del tope, es error (no se trae malware sin límite). La ruta se pasa
// al motor tal cual: quien pide la captura la tomó del propio evento.
func (c *Cliente) LeerDeContenedor(ctx context.Context, id, ruta string, tope int64) ([]byte, error) {
	n, err := c.Negociar(ctx)
	if err != nil {
		return nil, err
	}
	u := fmt.Sprintf("http://docker/v%s/containers/%s/archive?path=%s", n.API, url.PathEscape(id), url.QueryEscape(ruta))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		var m struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&m)
		return nil, &ErrAPI{Codigo: resp.StatusCode, Mensaje: m.Message}
	}
	// Tope del cuerpo entero, no solo del fichero: el tar lleva cabeceras de 512
	// bytes y relleno, así que un poco de holgura basta para no leer en memoria
	// un tar enorme que el motor (o un contenedor tomado) devolviera.
	return primerFicheroTar(io.LimitReader(resp.Body, tope+1<<16), tope)
}

// primerFicheroTar extrae el primer fichero regular de un tar, hasta `tope`
// bytes. Error si no trae ninguno o si pasa del tope. La API de archivo de
// Docker devuelve un tar con una sola entrada cuando el path es un fichero.
func primerFicheroTar(r io.Reader, tope int64) ([]byte, error) {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, errors.New("el contenedor no devolvió ningún fichero")
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		if h.Size > tope {
			return nil, fmt.Errorf("el fichero del contenedor pasa del tope (%d > %d bytes)", h.Size, tope)
		}
		b, err := io.ReadAll(io.LimitReader(tr, tope+1))
		if err != nil {
			return nil, err
		}
		if int64(len(b)) > tope {
			return nil, fmt.Errorf("el fichero del contenedor pasa del tope (%d bytes)", tope)
		}
		return b, nil
	}
}

// Sonda es un contenedor efímero con la imagen del propio sensor que mide
// algo de la máquina que el motor no dice de sí mismo, y sale.
type Sonda struct {
	// Nombre: con «_», que no cabe en el id de un sensor ni de una trampa,
	// para que nunca coincida con el de un contenedor de trampa.
	Nombre    string
	Imagen    string
	Orden     []string
	Red       string // NetworkMode: none, host o una red
	Etiquetas map[string]string
}

// Lo que puede tardar una sonda en total, desde que se crea hasta que sale.
const esperaSonda = time.Minute

// EjecutarSonda crea la sonda tan endurecida como una trampa (con el mismo
// perfil seccomp del motor, sin capacidades y sin poder escribir), espera a
// que salga y devuelve su código de salida y lo que ha escrito. La borra
// siempre, también la que quedara de una vez anterior.
func (c *Cliente) EjecutarSonda(ctx context.Context, s Sonda) (codigo int, salida string, err error) {
	ctx, cancelar := context.WithTimeout(ctx, esperaSonda)
	defer cancelar()
	if err := c.Borrar(ctx, s.Nombre); err != nil && !NoExiste(err) {
		return 0, "", err
	}
	id, err := c.Crear(ctx, s.Nombre, map[string]any{
		"Image":  s.Imagen,
		"Cmd":    s.Orden,
		"Labels": s.Etiquetas,
		"HostConfig": map[string]any{
			"NetworkMode":    s.Red,
			"ReadonlyRootfs": true,
			"CapDrop":        []string{"ALL"},
			"SecurityOpt":    []string{"no-new-privileges"},
			"Memory":         int64(32) << 20,
			"PidsLimit":      16,
			"LogConfig":      RegistrosAcotados(),
		},
	})
	if id != "" {
		defer func() { _ = c.Borrar(context.WithoutCancel(ctx), id) }()
	}
	if err != nil {
		return 0, "", err
	}
	if err := c.Arrancar(ctx, id); err != nil {
		return 0, "", err
	}
	if codigo, err = c.Esperar(ctx, id); err != nil {
		return 0, "", err
	}
	salida, _ = c.Salida(ctx, id, 20)
	return codigo, salida, nil
}
