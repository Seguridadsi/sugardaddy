package actualizador

// Acceso a la consola por IP de origen (docs/diseno/acceso-consola.md): el
// actualizador pregunta a la consola por la lista y, cuando cambia, al arrancar
// y cada cinco minutos, lanza un auxiliar con --network host que pone la regla
// en el cortafuegos de la máquina. El resultado vuelve a la consola.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/cortafuegos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// FicheroAbrir: si existe en la carpeta del nodo, el puerto de la consola se
// abre a todos y la consola queda «abierta» hasta que alguien guarde la lista.
// Es la salida de emergencia: sudo touch /opt/sugardaddy/abrir-consola.
const FicheroAbrir = "abrir-consola"

// NombreCortafuegos: el nombre del auxiliar hace de cerrojo.
const NombreCortafuegos = "sugardaddy-cortafuegos"

// RepasoCortafuegos: cada cuánto se vuelve a poner la regla aunque no cambie,
// porque no sobrevive a un reinicio de la máquina ni a quien vacíe el
// cortafuegos. Cada repaso se informa: la consola deja de dar la lista por
// aplicada si pasan diez minutos sin noticias.
const RepasoCortafuegos = 2 * time.Minute

// Acceso lleva la cuenta de lo aplicado entre vueltas.
type Acceso struct {
	Docker  *docker.Cliente
	Consola string // dirección de la consola, p. ej. http://consola:3000
	Token   string
	HTTP    *http.Client
	Local   string // la carpeta del nodo dentro del contenedor del actualizador
	Log     func(string, ...any)
	// Lanzar corre el auxiliar. Por defecto, un contenedor; en las pruebas, un doble.
	Lanzar func(ctx context.Context, imagen string, p cortafuegos.Pedido) cortafuegos.Resultado

	huella      string    // del pedido aplicado
	cuando      time.Time // cuándo se aplicó
	ultimo      cortafuegos.Resultado
	lista       string // la huella de la consola para la lista aplicada, que se le devuelve
	sinInformar bool
	registrado  string // lo último escrito en el registro, para no repetirlo cada repaso
	copia       bool   // ya se puso la última lista guardada, sin consola
}

// listaConsola es lo que contesta GET /api/actualizador/acceso.
type listaConsola struct {
	Estado string   `json:"estado"` // pendiente, restringida o abierta
	Redes  []string `json:"redes"`
	Huella string   `json:"huella"`
}

// errSinRuta: la consola es anterior a esto y no tiene la ruta.
var errSinRuta = errors.New("the console does not manage access yet")

// FicheroUltima: la última lista aplicada, en la carpeta del nodo. Tras un
// reinicio de la máquina se vuelve a poner en cuanto arranca el actualizador,
// sin esperar a que conteste la consola, que tarda más en arrancar.
const FicheroUltima = "acceso-aplicado.json"

// Vuelta mira si hay algo que aplicar y, si toca, lo aplica.
func (a *Acceso) Vuelta(ctx context.Context) error {
	l, err := a.pedirLista(ctx)
	if err != nil {
		switch {
		case a.hayEmergencia():
			// La salida de emergencia no depende de la consola: se abre ya y se
			// le dirá cuando conteste (una consola sin la ruta no se entera).
			_ = a.aplicar(ctx, listaConsola{Estado: "abierta"}, false)
		case errors.Is(err, errSinRuta):
		case a.huella == "" && !a.copia:
			a.copia = true
			if u, ok := a.leerUltima(); ok {
				_ = a.aplicar(ctx, u, false)
			}
		}
		if errors.Is(err, errSinRuta) {
			return nil
		}
		return err
	}
	return a.aplicar(ctx, l, true)
}

func (a *Acceso) hayEmergencia() bool {
	_, err := os.Stat(filepath.Join(a.Local, FicheroAbrir))
	return err == nil
}

// aplicar pone la lista si cambió o toca repasarla y, si se puede, informa a la consola.
func (a *Acceso) aplicar(ctx context.Context, l listaConsola, informar bool) error {
	emergencia := a.hayEmergencia()
	env, _ := LeerEnv(filepath.Join(a.Local, ".env"))
	puerto := 443
	if p, err := strconv.Atoi(strings.TrimSpace(env["CONSOLA_PUERTO"])); err == nil {
		puerto = p
	}
	p := cortafuegos.Pedido{
		Abierta: emergencia || l.Estado != "restringida",
		Redes:   l.Redes,
		Puerto:  puerto,
		Escucha: strings.TrimSpace(env["CONSOLA_ESCUCHA"]),
	}
	if p.Abierta {
		p.Redes = nil
	}
	b, _ := json.Marshal(p)
	h := sha256.Sum256(b)
	huella := hex.EncodeToString(h[:])
	if informar && huella == a.huella && a.lista != l.Huella {
		// Lo aplicado sale de esta misma lista (por ejemplo, la guardada tras un
		// reinicio, que no traía su huella): se le dice a la consola cuál es.
		a.lista, a.sinInformar = l.Huella, true
	}
	if huella != a.huella || (!p.Abierta && time.Since(a.cuando) >= RepasoCortafuegos) {
		versiones, err := LeerEnv(filepath.Join(a.Local, "versiones.env"))
		imagen := versiones["ACTUALIZADOR_IMAGEN"]
		if err != nil || imagen == "" {
			return errors.New("versiones.env does not say which updater image to use for the firewall helper")
		}
		lanzar := a.Lanzar
		if lanzar == nil {
			lanzar = a.lanzar
		}
		r := lanzar(ctx, imagen, p)
		a.huella, a.cuando, a.ultimo, a.lista, a.sinInformar = huella, time.Now(), r, l.Huella, true
		if a.Log != nil && r.Estado+r.Detalle != a.registrado {
			a.registrado = r.Estado + r.Detalle
			a.Log("console access", "estado", r.Estado, "detalle", r.Detalle)
		}
		if r.Estado == cortafuegos.Aplicada || r.Estado == cortafuegos.Abierta {
			u := listaConsola{Estado: "restringida", Redes: p.Redes, Huella: l.Huella}
			if p.Abierta {
				u.Estado = "abierta"
			}
			a.guardarUltima(u)
		}
	}
	if !informar || !a.sinInformar {
		return nil
	}
	if err := a.informar(ctx, a.ultimo, emergencia, a.lista); err != nil {
		return err // se repite en la próxima vuelta, sin volver a aplicar
	}
	a.sinInformar = false
	if emergencia && a.ultimo.Estado == cortafuegos.Abierta {
		_ = os.Remove(filepath.Join(a.Local, FicheroAbrir))
	}
	return nil
}

func (a *Acceso) leerUltima() (listaConsola, bool) {
	var l listaConsola
	b, err := os.ReadFile(filepath.Join(a.Local, FicheroUltima))
	if err != nil || json.Unmarshal(b, &l) != nil || l.Estado == "" {
		return l, false
	}
	return l, true
}

func (a *Acceso) guardarUltima(l listaConsola) {
	b, _ := json.Marshal(l)
	f := filepath.Join(a.Local, FicheroUltima)
	if err := os.WriteFile(f+".tmp", b, 0o600); err == nil {
		_ = os.Rename(f+".tmp", f)
	}
}

func (a *Acceso) pedirLista(ctx context.Context) (listaConsola, error) {
	var l listaConsola
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, a.Consola+"/api/actualizador/acceso", nil)
	req.Header.Set("Authorization", "Bearer "+a.Token)
	resp, err := a.HTTP.Do(req)
	if err != nil {
		return l, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return l, errSinRuta
	}
	if resp.StatusCode != http.StatusOK {
		return l, fmt.Errorf("consola: %s", resp.Status)
	}
	return l, json.NewDecoder(resp.Body).Decode(&l)
}

func (a *Acceso) informar(ctx context.Context, r cortafuegos.Resultado, emergencia bool, lista string) error {
	b, _ := json.Marshal(map[string]any{"estado": r.Estado, "detalle": r.Detalle, "emergencia": emergencia, "huella": lista})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, a.Consola+"/api/actualizador/acceso", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+a.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.HTTP.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	return nil
}

// lanzar corre el auxiliar y devuelve lo que dijo. Lleva lo justo para tocar
// el cortafuegos de la máquina: su red y NET_ADMIN, nada más.
func (a *Acceso) lanzar(ctx context.Context, imagen string, p cortafuegos.Pedido) cortafuegos.Resultado {
	fallo := func(m string, err error) cortafuegos.Resultado {
		return cortafuegos.Resultado{Estado: cortafuegos.ConError, Detalle: m + ": " + err.Error()}
	}
	if err := a.Docker.Borrar(ctx, NombreCortafuegos); err != nil && !docker.NoExiste(err) {
		return fallo("previous firewall helper", err)
	}
	if err := a.Docker.AsegurarImagen(ctx, imagen); err != nil {
		return fallo("updater image", err)
	}
	abierta := "0"
	if p.Abierta {
		abierta = "1"
	}
	id, err := a.Docker.Crear(ctx, NombreCortafuegos, map[string]any{
		"Image": imagen,
		"Cmd":   []string{"cortafuegos"},
		"Env": []string{
			"ACCESO_ABIERTA=" + abierta,
			"ACCESO_REDES=" + strings.Join(p.Redes, ","),
			"ACCESO_PUERTO=" + strconv.Itoa(p.Puerto),
			"ACCESO_ESCUCHA=" + p.Escucha,
		},
		"Labels": map[string]string{"sugardaddy.auxiliar": "cortafuegos"},
		"HostConfig": map[string]any{
			"NetworkMode":    "host",
			"CapDrop":        []string{"ALL"},
			"CapAdd":         []string{"NET_ADMIN", "NET_RAW"},
			"ReadonlyRootfs": true,
			"SecurityOpt":    []string{"no-new-privileges"},
			"Tmpfs":          map[string]string{"/run": "rw,nosuid,size=1m", "/tmp": "rw,nosuid,size=1m"},
			"RestartPolicy":  map[string]string{"Name": "no"},
			"LogConfig":      docker.RegistrosAcotados(),
		},
	})
	if err != nil {
		return fallo("firewall helper", err)
	}
	defer func() { _ = a.Docker.Borrar(context.WithoutCancel(ctx), id) }()
	if err := a.Docker.Arrancar(ctx, id); err != nil {
		return fallo("firewall helper", err)
	}
	espera, cancelar := context.WithTimeout(ctx, 2*time.Minute)
	defer cancelar()
	codigo, err := a.Docker.Esperar(espera, id)
	if err != nil {
		return fallo("firewall helper", err)
	}
	salida, _ := a.Docker.Salida(ctx, id, 20)
	return LeerResultadoCortafuegos(salida, codigo)
}

// LeerResultadoCortafuegos saca el resultado de la última línea JSON del
// auxiliar; si no la hay, lo que diga su código de salida.
func LeerResultadoCortafuegos(salida string, codigo int) cortafuegos.Resultado {
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	for i := len(lineas) - 1; i >= 0; i-- {
		var r cortafuegos.Resultado
		if json.Unmarshal([]byte(lineas[i]), &r) == nil && r.Estado != "" {
			return r
		}
	}
	return cortafuegos.Resultado{Estado: cortafuegos.ConError, Detalle: fmt.Sprintf("the firewall helper ended with code %d and said nothing", codigo)}
}
