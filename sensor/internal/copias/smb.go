package copias

// Una carpeta compartida SMB (Windows, un NAS, Samba), sin instalar nada: la
// monta el propio Docker de la máquina como un volumen «local» de tipo cifs
// (el cliente SMB del núcleo de Linux) y la usa un auxiliar de un instante, el
// actualizador de la versión con la orden «copias-smb»:
//
//   - sin red (el montaje lo hace Docker en el anfitrión, no el contenedor);
//   - sin capacidades, con la raíz de solo lectura y no-new-privileges;
//   - con la carpeta copias/ del nodo de solo lectura y, solo para bajar una
//     copia a la prueba mensual, copias/.prueba.
//
// La contraseña va en las opciones del volumen, que Docker guarda mientras el
// volumen existe (en su carpeta, solo para root): el volumen se crea para cada
// operación y se borra en cuanto acaba. Los errores de montaje de Docker
// repiten esas opciones: se tapan antes de contarlos. Con Cifrado se pide SMB 3
// con cifrado («seal»): sin él, el servidor ve pasar las copias (cifradas con
// age de todos modos) y la sesión sin cifrar.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// SMBCfg: la carpeta compartida y su usuario.
type SMBCfg struct {
	Servidor string `json:"servidor"` // nombre o IP
	Recurso  string `json:"recurso"`  // el nombre del recurso compartido
	Carpeta  string `json:"carpeta"`  // dentro del recurso (vacía: la raíz)
	Usuario  string `json:"usuario"`
	Clave    string `json:"clave"`
	Dominio  string `json:"dominio"`
	Cifrado  bool   `json:"cifrado"`
}

var (
	servidorValido = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	recursoValido  = regexp.MustCompile(`^[A-Za-z0-9 ._$-]{1,80}$`)
	usuarioValido  = regexp.MustCompile(`^[A-Za-z0-9 ._@$-]{1,104}$`)
)

func (c *SMBCfg) validar() error {
	if _, err := netip.ParseAddr(c.Servidor); err != nil && !servidorValido.MatchString(c.Servidor) {
		return errors.New("smb: invalid server (a name or an IP address)")
	}
	if !recursoValido.MatchString(c.Recurso) {
		return errors.New("smb: invalid share name")
	}
	if c.Usuario == "" || !usuarioValido.MatchString(c.Usuario) {
		return errors.New("smb: invalid user name")
	}
	if c.Dominio != "" && !usuarioValido.MatchString(c.Dominio) {
		return errors.New("smb: invalid domain")
	}
	if c.Clave == "" || strings.ContainsAny(c.Clave, "\x00\n\r") || len(c.Clave) > 256 {
		return errors.New("smb: invalid password")
	}
	_, err := Prefijo(c.Carpeta)
	return err
}

// OpcionesMontaje son las opciones del volumen cifs. addr es la IP del servidor
// (el núcleo no resuelve nombres). Una coma en la contraseña va doblada, que es
// como la entiende el núcleo.
func (c *SMBCfg) OpcionesMontaje(addr string) map[string]string {
	o := []string{
		"addr=" + addr,
		"username=" + c.Usuario,
		"password=" + strings.ReplaceAll(c.Clave, ",", ",,"),
	}
	if c.Dominio != "" {
		o = append(o, "domain="+c.Dominio)
	}
	if c.Cifrado {
		o = append(o, "vers=3", "seal")
	}
	// Todo de root y solo para root: el auxiliar es root sin capacidades.
	o = append(o, "uid=0", "gid=0", "file_mode=0600", "dir_mode=0700", "nobrl")
	return map[string]string{
		"type":   "cifs",
		"device": "//" + c.Servidor + "/" + c.Recurso,
		"o":      strings.Join(o, ","),
	}
}

// opcionPassword: la opción entera en un error de montaje de Docker, también con las
// comas dobladas (Docker tapa solo hasta la primera coma: «password=****,,resto»).
var opcionPassword = regexp.MustCompile(`password=(?:[^,\s]|,,)*`)

// TaparMontaje quita la contraseña de un error de montaje: la opción entera y,
// por si sale suelta, la contraseña y cada trozo suyo entre comas.
func TaparMontaje(texto, clave string) string {
	texto = opcionPassword.ReplaceAllString(texto, "password=••••")
	secretos := []string{clave, strings.ReplaceAll(clave, ",", ",,")}
	secretos = append(secretos, strings.Split(clave, ",")...)
	return Tapar(texto, secretos)
}

// Direccion resuelve el servidor a una IP (la primera IPv4 si la hay).
func (c *SMBCfg) Direccion(ctx context.Context) (string, error) {
	if a, err := netip.ParseAddr(c.Servidor); err == nil {
		return a.String(), nil
	}
	ips, err := net.DefaultResolver.LookupHost(ctx, c.Servidor)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("smb: cannot resolve %s", c.Servidor)
	}
	for _, ip := range ips {
		if a, err := netip.ParseAddr(ip); err == nil && a.Is4() {
			return ip, nil
		}
	}
	return ips[0], nil
}

// MotorSMB es lo que necesita de Docker (docker.Cliente lo cumple).
type MotorSMB interface {
	CrearVolumen(ctx context.Context, nombre, driver string, opciones, etiquetas map[string]string) error
	BorrarVolumen(ctx context.Context, nombre string) error
	AsegurarImagen(ctx context.Context, imagen string) error
	Crear(ctx context.Context, nombre string, config map[string]any) (string, error)
	Arrancar(ctx context.Context, id string) error
	Esperar(ctx context.Context, id string) (int, error)
	Salida(ctx context.Context, id string, lineas int) (string, error)
	Borrar(ctx context.Context, id string) error
}

// SMB es el destino SMB.
type SMB struct {
	C      SMBCfg
	Motor  MotorSMB
	Imagen string // la del actualizador de la versión (versiones.env)
	// La carpeta copias/ del nodo en el anfitrión y dentro del actualizador.
	CopiasAnfitrion string
	CopiasLocal     string
	// Registros: la configuración de registros de los auxiliares (docker.RegistrosAcotados).
	Registros map[string]any
	// Direccion, para las pruebas; por defecto resuelve C.Servidor.
	Direccion func(ctx context.Context) (string, error)
}

// NombreAuxiliarSMB: el nombre del auxiliar hace de cerrojo; hay uno a la vez.
const NombreAuxiliarSMB = "sugardaddy-copias-smb"

// Prueba: la carpeta, dentro de copias/, donde el auxiliar deja la copia que se comprueba.
const Prueba = ".prueba"

// RespuestaSMB es la última línea que escribe el auxiliar.
type RespuestaSMB struct {
	Remotas   []Remota `json:"remotas,omitempty"`
	Error     string   `json:"error,omitempty"`
	Bloqueada bool     `json:"bloqueada,omitempty"`
}

// ConfigAuxiliarSMB es el contenedor de cada operación.
func ConfigAuxiliarSMB(imagen, volumen, copiasAnfitrion, carpeta, op, nombre string, registros map[string]any) map[string]any {
	binds := []string{copiasAnfitrion + ":/copias:ro"}
	if op == "bajar" {
		binds = append(binds, filepath.Join(copiasAnfitrion, Prueba)+":/prueba")
	}
	h := map[string]any{
		"NetworkMode":    "none",
		"CapDrop":        []string{"ALL"},
		"ReadonlyRootfs": true,
		"SecurityOpt":    []string{"no-new-privileges"},
		"Binds":          binds,
		"Mounts":         []map[string]any{{"Type": "volume", "Source": volumen, "Target": "/destino"}},
		"Tmpfs":          map[string]string{"/tmp": "rw,nosuid,size=1m"},
		"RestartPolicy":  map[string]string{"Name": "no"},
	}
	if registros != nil {
		h["LogConfig"] = registros
	}
	return map[string]any{
		"Image":      imagen,
		"Cmd":        []string{"copias-smb", op, nombre},
		"Env":        []string{"COPIAS_CARPETA=" + carpeta},
		"Labels":     map[string]string{"sugardaddy.auxiliar": "copias"},
		"HostConfig": h,
	}
}

// operar monta la carpeta, lanza el auxiliar con la operación y lee su respuesta.
func (s *SMB) operar(ctx context.Context, op, nombre string) (RespuestaSMB, error) {
	var r RespuestaSMB
	dir := s.Direccion
	if dir == nil {
		dir = s.C.Direccion
	}
	addr, err := dir(ctx)
	if err != nil {
		return r, err
	}
	tapar := func(e error) error { return errors.New(TaparMontaje(e.Error(), s.C.Clave)) }
	if err := s.Motor.AsegurarImagen(ctx, s.Imagen); err != nil {
		return r, fmt.Errorf("updater image: %w", err)
	}
	_ = s.Motor.Borrar(ctx, NombreAuxiliarSMB)
	vol := fmt.Sprintf("sugardaddy-copias-smb-%d", time.Now().UnixNano())
	if err := s.Motor.CrearVolumen(ctx, vol, "local", s.C.OpcionesMontaje(addr), map[string]string{"sugardaddy.auxiliar": "copias"}); err != nil {
		return r, tapar(err)
	}
	defer func() { _ = s.Motor.BorrarVolumen(context.WithoutCancel(ctx), vol) }()
	carpeta, _ := Prefijo(s.C.Carpeta)
	id, err := s.Motor.Crear(ctx, NombreAuxiliarSMB, ConfigAuxiliarSMB(s.Imagen, vol, s.CopiasAnfitrion, strings.TrimSuffix(carpeta, "/"), op, nombre, s.Registros))
	if err != nil {
		return r, tapar(err)
	}
	defer func() { _ = s.Motor.Borrar(context.WithoutCancel(ctx), id) }()
	if err := s.Motor.Arrancar(ctx, id); err != nil {
		// Aquí llega el error del montaje: «permission denied», «host is down»…
		return r, fmt.Errorf("smb: mounting the share: %w", tapar(err))
	}
	espera, cancelar := context.WithTimeout(ctx, 30*time.Minute)
	defer cancelar()
	codigo, err := s.Motor.Esperar(espera, id)
	if err != nil {
		return r, tapar(err)
	}
	salida, _ := s.Motor.Salida(ctx, id, 5)
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	for i := len(lineas) - 1; i >= 0; i-- {
		if json.Unmarshal([]byte(lineas[i]), &r) == nil && (r.Error != "" || codigo == 0) {
			if r.Error != "" {
				if r.Bloqueada {
					return r, fmt.Errorf("%w (%s)", ErrBloqueada, r.Error)
				}
				return r, errors.New("smb: " + Tapar(r.Error, []string{s.C.Clave}))
			}
			return r, nil
		}
	}
	return r, fmt.Errorf("smb: the helper ended with code %d and said nothing", codigo)
}

func (s *SMB) Subir(ctx context.Context, nombre, _, _ string, _ int64) error {
	_, err := s.operar(ctx, "subir", nombre)
	return err
}

func (s *SMB) Listar(ctx context.Context) ([]Remota, error) {
	r, err := s.operar(ctx, "listar", "")
	return r.Remotas, err
}

func (s *SMB) Borrar(ctx context.Context, nombre string) error {
	_, err := s.operar(ctx, "borrar", nombre)
	return err
}

func (s *SMB) Bajar(ctx context.Context, nombre string, w io.Writer) error {
	local := filepath.Join(s.CopiasLocal, Prueba)
	if err := os.MkdirAll(local, 0o700); err != nil {
		return err
	}
	defer os.Remove(filepath.Join(local, nombre))
	if _, err := s.operar(ctx, "bajar", nombre); err != nil {
		return err
	}
	f, err := os.Open(filepath.Join(local, nombre))
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}

// Raices: dónde ve el auxiliar el recurso, las copias del nodo y la carpeta de la prueba.
type Raices struct{ Destino, Copias, Prueba string }

// RaicesAuxiliar: las del contenedor (ConfigAuxiliarSMB).
var RaicesAuxiliar = Raices{Destino: "/destino", Copias: "/copias", Prueba: "/prueba"}

// Auxiliar es lo que corre dentro del contenedor (orden «copias-smb»): una
// operación sobre <destino>/<carpeta> y una línea JSON con el resultado.
func Auxiliar(ctx context.Context, args []string, carpeta string, raices Raices, w io.Writer) int {
	responder := func(r RespuestaSMB) int {
		b, _ := json.Marshal(r)
		fmt.Fprintln(w, string(b))
		if r.Error != "" {
			return 1
		}
		return 0
	}
	if len(args) < 1 {
		return responder(RespuestaSMB{Error: "missing operation"})
	}
	p, err := Prefijo(carpeta)
	if err != nil {
		return responder(RespuestaSMB{Error: err.Error()})
	}
	c := Carpeta{Raiz: filepath.Join(raices.Destino, p)}
	nombre := ""
	if len(args) > 1 {
		nombre = args[1]
	}
	switch args[0] {
	case "listar":
		r, err := c.Listar(ctx)
		if err != nil {
			return responder(RespuestaSMB{Error: err.Error()})
		}
		return responder(RespuestaSMB{Remotas: r})
	case "subir":
		if !NombreCopia.MatchString(nombre) {
			return responder(RespuestaSMB{Error: "not a backup name"})
		}
		if err := c.Subir(ctx, nombre, filepath.Join(raices.Copias, nombre), "", 0); err != nil {
			return responder(RespuestaSMB{Error: err.Error()})
		}
		return responder(RespuestaSMB{})
	case "borrar":
		if err := c.Borrar(ctx, nombre); err != nil {
			return responder(RespuestaSMB{Error: err.Error(), Bloqueada: errors.Is(err, ErrBloqueada)})
		}
		return responder(RespuestaSMB{})
	case "bajar":
		if !NombreCopia.MatchString(nombre) {
			return responder(RespuestaSMB{Error: "not a backup name"})
		}
		f, err := os.OpenFile(filepath.Join(raices.Prueba, nombre), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return responder(RespuestaSMB{Error: err.Error()})
		}
		err = c.Bajar(ctx, nombre, f)
		if e := f.Close(); err == nil {
			err = e
		}
		if err != nil {
			return responder(RespuestaSMB{Error: err.Error()})
		}
		return responder(RespuestaSMB{})
	}
	return responder(RespuestaSMB{Error: "unknown operation " + args[0]})
}
