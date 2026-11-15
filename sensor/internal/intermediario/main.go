package intermediario

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/catalogo"
	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// UIDSensor es el usuario con que corre el sensor.
const UIDSensor = discos.UIDSensor

// Main es sd-motor: `sensor motor …` en la imagen del sensor, o cmd/sd-motor.
func Main(args []string) int {
	fs := flag.NewFlagSet("sd-motor", flag.ContinueOnError)
	escucha := fs.String("escucha", "/run/sd-motor/motor.sock", "Unix socket where the sensor talks to sd-motor")
	socket := fs.String("docker", "/var/run/docker.sock", "Docker socket (only sd-motor mounts it)")
	datos := fs.String("datos", "", "sensor folder on the host: decoy binds can only come from it")
	imagen := fs.String("imagen-sensor", os.Getenv("SENSOR_IMAGEN"), "sensor image: the only one for probes and capture companions")
	firmado := fs.String("firmado", "", "signed version left by the updater, whose catalog limits the decoys (empty: no catalog)")
	estado := fs.String("estado", "", "sd-motor's own folder (partner catalog serial); empty: no partner decoys")
	grupo := fs.Int("grupo", UIDSensor, "group that may use the socket (the sensor's)")
	runsc := fs.Bool("runsc", true, "use gVisor (runsc) for decoys when the engine has it")
	apparmor := fs.String("apparmor", os.Getenv("TRAMPAS_APPARMOR"), "AppArmor profile for decoys loaded by the installer (empty: none)")
	buzon := fs.String("buzon-discos", "", "mailbox of the host disk service sd-discos (empty: no disks)")
	migrar := fs.Int("propietario", UIDSensor, "user that owns the sensor folder (the sensor no longer runs as root); 0: do not change it")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *datos == "" {
		slog.Error("sd-motor needs -datos")
		return 2
	}
	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()

	if *migrar > 0 {
		if err := PrepararDatos(*datos, *migrar); err != nil {
			slog.Warn("sd-motor: could not hand the sensor folder to the sensor user", "err", err)
		}
	}
	s := &Servidor{Docker: *socket, UsarRunsc: *runsc, AppArmor: *apparmor,
		Reglas: Reglas{Datos: filepath.Clean(*datos), ImagenSensor: *imagen, Catalogo: reglaCatalogo(*firmado, *estado)}}
	if *buzon != "" {
		s.Discos = &Discos{Buzon: *buzon, Datos: filepath.Clean(*datos)}
	}
	ln, err := escuchar(*escucha, *grupo)
	if err != nil {
		slog.Error("sd-motor socket", "err", err)
		return 1
	}
	if a, err := s.Aislamiento(ctx); err == nil {
		slog.Info("sd-motor running", "aislamiento", a.Valor, "motivo", a.Motivo)
	} else {
		slog.Warn("sd-motor running; the engine does not answer yet", "err", err)
	}
	if err := s.Escuchar(ctx, ln); err != nil {
		slog.Error("sd-motor", "err", err)
		return 1
	}
	return 0
}

// escuchar abre el socket: solo su dueño (root) y el grupo del sensor.
func escuchar(ruta string, grupo int) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(ruta), 0o750); err != nil {
		return nil, err
	}
	if err := os.Remove(ruta); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ln, err := net.Listen("unix", ruta)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(ruta, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	if os.Geteuid() == 0 {
		_ = os.Chown(filepath.Dir(ruta), 0, grupo)
		_ = os.Chmod(filepath.Dir(ruta), 0o750)
		if err := os.Chown(ruta, 0, grupo); err != nil {
			ln.Close()
			return nil, err
		}
	}
	return ln, nil
}

// reglaCatalogo: la misma regla que el sensor (SEN-3), leída por sd-motor de la
// versión firmada que deja el actualizador. Sin -firmado, sin catálogo.
func reglaCatalogo(firmado, estado string) func(plan.Manifiesto) string {
	if firmado == "" {
		return nil
	}
	l := &catalogo.Lector{
		Ruta: firmado, Confianza: actualizador.ConfianzaDelEntorno(os.Getenv),
		Edicion: actualizador.EdicionDelNodo(os.Getenv), Marca: filepath.Join(filepath.Dir(firmado), "exigir"),
	}
	var lp *catalogo.LectorPartner
	if p := strings.TrimSpace(os.Getenv("PARTNER")); p != "" && estado != "" {
		lp = &catalogo.LectorPartner{
			Ruta: filepath.Join(filepath.Dir(firmado), "catalogo-partner.json"), Confianza: actualizador.ConfianzaDelEntorno(os.Getenv),
			Partner: p, RutaSerie: filepath.Join(estado, "catalogo-partner.serie"),
		}
	}
	return func(m plan.Manifiesto) string {
		c, err := l.Leer()
		if err != nil {
			return "cannot check the signed decoy catalog on this machine (" + err.Error() + ")"
		}
		if c == nil {
			return ""
		}
		var p *catalogo.Partner
		var errP error
		if lp != nil {
			p, errP = lp.Leer()
		}
		return catalogo.Regla(c, p, errP, nil)(plan.TrampaPlan{Manifiesto: m})
	}
}
