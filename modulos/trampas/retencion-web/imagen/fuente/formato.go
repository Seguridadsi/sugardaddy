// Código propio de SeguridadSI (no viene de go-pot) para la trampa
// retencion-web de Sugardaddy. preparar.sh lo copia a protocol/http/logging/
// y hace que http_access_logger.go lo use.
//
// Formato de las líneas: la hora en RFC 3339 (UTC) y el puerto de origen como
// número. Es lo que entienden todos los sensores, también los 0.12, que no
// leen fechas en segundos desde 1970 ni puertos entre comillas (go-pot
// escribía "ts":1792194417.19 y "src_port":"37396").
package logging

import (
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// horaRFC3339 es el EncodeTime de zap para el registro de accesos.
func horaRFC3339(t time.Time, enc zapcore.PrimitiveArrayEncoder) {
	enc.AppendString(t.UTC().Format(time.RFC3339Nano))
}

// campoDeRegistro: los campos de go-pot son todos texto; el puerto de origen
// va como número.
func campoDeRegistro(campo, valor string) zap.Field {
	if campo == "src_port" {
		if n, err := strconv.Atoi(valor); err == nil {
			return zap.Int(campo, n)
		}
	}
	return zap.String(campo, valor)
}

// camposDeLaPeticion: los que salen de la petición misma. Si fasthttp no la
// ha llegado a leer (basura, un ClientHello de TLS, una cabecera a medias o
// de más) o la ha vaciado al fallar el cuerpo, valdrían lo de por defecto
// («GET», «/», vacío), que el atacante nunca pidió: no se apuntan.
var camposDeLaPeticion = map[string]bool{
	"method": true, "path": true, "qs": true, "host": true, "user_agent": true, "dest_port": true,
	"browser": true, "browser_version": true, "os": true, "os_version": true, "device": true, "device_brand": true,
}

// Rechazada apunta una petición que no llega al tarpit porque la corta Fiber
// antes (otro método, cuerpo de más, cabecera a medias, de más o mal
// formada): go-pot no las apuntaba. Va con phase "error" y el código que se le
// contesta, y con los mismos campos que las demás si la petición se pudo leer
// (legible); si no, sin los de la petición y con "peticion":"ilegible".
func (l *HttpAccessLogger) Rechazada(c *fiber.Ctx, status int, legible bool) {
	if l == nil || l.loggingMode == "none" {
		return
	}
	entry := &HttpAccessLogEntry{Context: c, phase: "error", resolvedFields: map[string]string{}}
	for _, field := range l.fieldsToLog {
		if field == "duration" || !legible && camposDeLaPeticion[field] {
			continue
		}
		if accessor, ok := startFieldAccessors[field]; ok {
			entry.resolvedFields[field] = accessor(entry)
		}
	}
	fields := append(l.getFields(entry), zap.Int("status", status))
	if !legible {
		fields = append(fields, zap.String("peticion", "ilegible"))
	}
	l.logger.Info("", fields...)
}

// SemillaDeLaTrampa da un valor propio de cada trampa, fijo mientras exista:
// de él salen las cosas que no pueden ser iguales en toda la flota (el
// robots.txt). Se guarda la primera vez, al azar, en .semilla junto al
// registro (la carpeta que monta el sensor, una por trampa y que sobrevive a
// reinicios y actualizaciones de la imagen; el sensor solo mira los ficheros
// que empiezan por el nombre del registro). Si no se puede, el nombre del
// contenedor. La imagen no lleva ninguna: sigue siendo reproducible.
func SemillaDeLaTrampa(rutaRegistro string) string {
	if s := strings.TrimSpace(os.Getenv("SD_SEMILLA")); s != "" {
		return s
	}
	ruta := rutaRegistro
	if u, err := url.Parse(rutaRegistro); err == nil && u.Scheme != "" {
		ruta = u.Path
	}
	if ruta != "" && ruta != "stdout" && ruta != "stderr" {
		if s, err := semillaEn(filepath.Join(filepath.Dir(ruta), ".semilla")); err == nil {
			return s
		}
	}
	h, _ := os.Hostname()
	return h
}

func semillaEn(fichero string) (string, error) {
	if b, err := os.ReadFile(fichero); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
		return strings.TrimSpace(string(b)), nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	s := hex.EncodeToString(b)
	f, err := os.OpenFile(fichero, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		// Otro proceso la ha creado a la vez: la suya.
		if b, e := os.ReadFile(fichero); e == nil && len(strings.TrimSpace(string(b))) >= 16 {
			return strings.TrimSpace(string(b)), nil
		}
		return "", err
	}
	defer f.Close()
	if _, err := f.WriteString(s + "\n"); err != nil {
		return "", err
	}
	return s, nil
}
