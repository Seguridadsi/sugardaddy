package actualizador

// El actualizador lanza el auxiliar «anfitrion» (maquina.go) al arrancar y cada
// RepasoMaquina, y le cuenta a la consola lo que ha visto: quién entra por SSH, cómo
// están las reglas de auditd y si Docker va por detrás de la versión que fija la
// versión firmada del nodo. La consola lo enseña, avisa si Docker va por detrás, lo
// apunta en la auditoría cuando cambia y lo lleva en el latido al panel.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// RepasoMaquina: cada cuánto se mira la máquina.
const RepasoMaquina = 30 * time.Minute

// NombreMaquina es el contenedor del auxiliar; su nombre hace de cerrojo.
const NombreMaquina = "sugardaddy-anfitrion"

// InformeMaquina es lo que va a la consola (POST /api/actualizador/anfitrion).
type InformeMaquina struct {
	Maquina *HechosMaquina `json:"maquina,omitempty"`
	Docker  struct {
		Version   string `json:"version"`
		Fijada    string `json:"fijada,omitempty"`
		Desfasada bool   `json:"desfasada"`
	} `json:"docker"`
	Detalle string `json:"detalle,omitempty"`
}

// MaquinaNodo lleva la cuenta entre vueltas.
type MaquinaNodo struct {
	Docker    *docker.Cliente
	Consola   string
	Token     string
	HTTP      *http.Client
	Local     string
	Anfitrion string
	Confianza Confianza
	Edicion   string
	Log       func(string, ...any)
	// Lanzar corre el auxiliar; en las pruebas, un doble.
	Lanzar  func(ctx context.Context, imagen, nodo string, motor *MotorFijado) (HechosMaquina, error)
	Version func(ctx context.Context) (string, error)

	ultima time.Time
}

// MotorDeLaFirmada devuelve el Docker que fija la versión firmada instalada (nil si
// no fija ninguno o no se puede comprobar).
func MotorDeLaFirmada(local string, c Confianza, edicion string) *MotorFijado {
	b, err := os.ReadFile(filepath.Join(local, FicheroFirmada))
	if err != nil {
		return nil
	}
	var f ReleaseFirmada
	if json.Unmarshal(b, &f) != nil {
		return nil
	}
	r, err := VerificarEnNodo(c, edicion, f)
	if err != nil || ValidarMotor(r.Motor) != nil {
		return nil
	}
	return r.Motor
}

// Vuelta mira la máquina si toca y lo cuenta.
func (m *MaquinaNodo) Vuelta(ctx context.Context) error {
	if !m.ultima.IsZero() && time.Since(m.ultima) < RepasoMaquina {
		return nil
	}
	m.ultima = time.Now()
	var inf InformeMaquina
	motor := MotorDeLaFirmada(m.Local, m.Confianza, m.Edicion)
	version := m.Version
	if version == nil {
		version = func(ctx context.Context) (string, error) {
			i, err := m.Docker.Info(ctx)
			return i.ServerVersion, err
		}
	}
	if v, err := version(ctx); err == nil {
		inf.Docker.Version = v
	}
	if motor != nil {
		inf.Docker.Fijada = motor.Docker
		inf.Docker.Desfasada = inf.Docker.Version != "" && CompararVersiones(inf.Docker.Version, motor.Docker) < 0
	}
	env, _ := LeerEnv(filepath.Join(m.Local, ".env"))
	if env["AISLAMIENTO_ANFITRION"] == "no" {
		inf.Detalle = "AISLAMIENTO_ANFITRION=no: the node does not look into this machine"
	} else {
		lanzar := m.Lanzar
		if lanzar == nil {
			lanzar = m.lanzar
		}
		versiones, _ := LeerEnv(filepath.Join(m.Local, "versiones.env"))
		if img := versiones["ACTUALIZADOR_IMAGEN"]; img == "" {
			inf.Detalle = "versiones.env does not say which updater image to use"
		} else if h, err := lanzar(ctx, img, m.Anfitrion, motor); err != nil {
			inf.Detalle = "host helper: " + err.Error()
		} else {
			inf.Maquina = &h
		}
	}
	if m.Log != nil && inf.Docker.Desfasada {
		m.Log("Docker is older than the version pinned by the signed release", "docker", inf.Docker.Version, "fijada", inf.Docker.Fijada)
	}
	return m.informar(ctx, inf)
}

func (m *MaquinaNodo) lanzar(ctx context.Context, imagen, nodo string, motor *MotorFijado) (HechosMaquina, error) {
	if !RutaDatosValida(nodo) {
		return HechosMaquina{}, errors.New("NODO_DIR is not a plain path")
	}
	if err := m.Docker.AsegurarImagen(ctx, imagen); err != nil {
		return HechosMaquina{}, err
	}
	_, salida, err := ejecutarUnInstante(ctx, m.Docker, NombreMaquina, ConfigMaquina(imagen, nodo, motor), 5*time.Minute)
	if err != nil {
		return HechosMaquina{}, err
	}
	h, ok := LeerHechosMaquina(salida)
	if !ok {
		return HechosMaquina{}, fmt.Errorf("the host helper said nothing: %s", recortarSalida([]byte(salida)))
	}
	return h, nil
}

func (m *MaquinaNodo) informar(ctx context.Context, inf InformeMaquina) error {
	b, _ := json.Marshal(inf)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, m.Consola+"/api/actualizador/anfitrion", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+m.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.HTTP.Do(req)
	if err != nil {
		m.ultima = time.Time{} // se repite en la próxima vuelta
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		m.ultima = time.Time{}
		return fmt.Errorf("consola: %s", resp.Status)
	}
	return nil
}
