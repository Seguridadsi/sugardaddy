package rdp

// Configuración de la trampa RDP de Sugardaddy. El upstream lee su
// configuración con viper (rdp.computer_name, rdp.domain_name, var-dir,
// rdp.credentials y rdp.guess_passwords); la base glutton de Sugardaddy no
// enlaza viper (ni su árbol de dependencias): sugardaddy-rdp.patch solo quita
// el import, y este fichero da un sustituto mínimo con el mismo nombre que lee
// del entorno que pone el manifiesto. Así el código de glutton queda igual y
// sus pruebas siguen valiendo (usan viper.Set).
//
// Además: la preferencia de protocolo (TLS o NLA, ver SelectProtocol) y el
// certificado TLS por instancia, que se guarda junto al registro para que no
// cambie en cada reinicio (un servidor Windows real mantiene el suyo meses).

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mushorg/glutton/protocols/helpers"
)

// ConfigSD guarda los valores que el upstream leía de viper.
type ConfigSD struct {
	mu      sync.RWMutex
	valores map[string]any
}

// viper sustituye al paquete del mismo nombre en este paquete.
var viper = nuevaConfigSD()

// Config devuelve la configuración (las pruebas del paquete tcp la usan como
// su viper).
func Config() *ConfigSD { return viper }

const (
	// maxNombre es la longitud máxima de un nombre NetBIOS.
	maxNombre = 15
	// maxContrasena acota la contraseña aceptada que llega del entorno.
	maxContrasena = 128
)

func nuevaConfigSD() *ConfigSD {
	c := &ConfigSD{valores: map[string]any{}}
	if v := nombreNetBIOS(os.Getenv("SD_GLUTTON_EQUIPO")); v != "" {
		c.valores["rdp.computer_name"] = v
	}
	if v := nombreNetBIOS(os.Getenv("SD_GLUTTON_DOMINIO")); v != "" {
		c.valores["rdp.domain_name"] = v
	}
	// Sin carpeta, el nombre generado y el certificado no se guardan (cambian
	// en cada arranque); la imagen y el manifiesto la ponen en /registros.
	if v := strings.TrimSpace(os.Getenv("SD_GLUTTON_LOG_DIR")); v != "" {
		c.valores["var-dir"] = v
	}
	// Una contraseña que la trampa acepta en NLA (p. ej. una credencial
	// sembrada en otra parte): quien la use "entra" y la trampa ve lo que hace
	// después. Vacía: ningún NLA se acepta.
	if v := os.Getenv("SD_RDP_ACEPTA"); v != "" && len(v) <= maxContrasena {
		c.valores["rdp.guess_passwords"] = []string{v}
	}
	c.valores["sd.seguridad"] = strings.ToLower(strings.TrimSpace(os.Getenv("SD_RDP_SEGURIDAD")))
	// Dominio DNS (FQDN) opcional que se anuncia en el reto NTLM
	// (DnsDomainName/DnsComputerName). Vacío: en grupo de trabajo se anuncia el
	// propio equipo; con dominio NetBIOS, ese mismo nombre. Se valida como un
	// nombre DNS para no colar texto del entorno sin control.
	if v := nombreDNS(os.Getenv("SD_RDP_DOMINIO_DNS")); v != "" {
		c.valores["rdp.dns_domain"] = v
	}
	return c
}

// nombreDNS deja un dominio DNS (FQDN) en minúsculas, solo con letras, cifras,
// guiones y puntos, y como mucho 253 caracteres; descarta lo demás.
func nombreDNS(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		if b.Len() >= 253 {
			break
		}
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '.' {
			b.WriteRune(r)
		}
	}
	return strings.Trim(b.String(), ".")
}

// DominioDNS devuelve el FQDN configurado (SD_RDP_DOMINIO_DNS) o "".
func DominioDNS() string { return viper.GetString("rdp.dns_domain") }

// nombreNetBIOS deja un nombre de equipo o dominio como lo anuncia Windows:
// en mayúsculas, solo letras, cifras y guiones, y como mucho 15 caracteres.
func nombreNetBIOS(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		if b.Len() >= maxNombre {
			break
		}
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// GetString devuelve un valor de texto, o "" si no está.
func (c *ConfigSD) GetString(clave string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	s, _ := c.valores[clave].(string)
	return s
}

// UnmarshalKey copia en out ([]Account o []string) el valor de la clave.
func (c *ConfigSD) UnmarshalKey(clave string, out any) error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.valores[clave]
	if !ok {
		return nil
	}
	switch dst := out.(type) {
	case *[]Account:
		if src, ok := v.([]Account); ok {
			*dst = append([]Account(nil), src...)
		}
	case *[]string:
		if src, ok := v.([]string); ok {
			*dst = append([]string(nil), src...)
		}
	default:
		return errors.New("rdp: tipo no soportado en la configuración")
	}
	return nil
}

// Set fija (o con nil, borra) un valor.
func (c *ConfigSD) Set(clave string, v any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v == nil {
		delete(c.valores, clave)
		return
	}
	c.valores[clave] = v
}

// preferirNLA dice si se elige CredSSP (NLA) antes que TLS cuando el cliente
// ofrece los dos (SD_RDP_SEGURIDAD=nla).
func preferirNLA() bool { return viper.GetString("sd.seguridad") == "nla" }

var certSD struct {
	once sync.Once
	cert tls.Certificate
	err  error
}

// ficheroCertificado es el nombre del certificado de la instancia, junto al
// registro (clave privada incluida, solo legible por la trampa).
const ficheroCertificado = "rdp-certificado.pem"

// CertificadoSD devuelve el certificado TLS de la instancia: el guardado junto
// al registro si sigue valiendo para este nombre de equipo, o uno nuevo con la
// forma del de un Windows real (helpers.SelfSignedCertificateRDP), que se
// guarda para el siguiente arranque. Se calcula una vez por proceso.
func CertificadoSD(equipo string) (tls.Certificate, error) {
	certSD.once.Do(func() {
		certSD.cert, certSD.err = cargarOCrearCertificado(viper.GetString("var-dir"), equipo, time.Now())
	})
	return certSD.cert, certSD.err
}

func cargarOCrearCertificado(dir, equipo string, ahora time.Time) (tls.Certificate, error) {
	if dir == "" {
		return helpers.SelfSignedCertificateRDP(equipo)
	}
	ruta := filepath.Join(dir, ficheroCertificado)
	if c, err := leerCertificado(ruta, equipo, ahora); err == nil {
		return c, nil
	}
	c, err := helpers.SelfSignedCertificateRDP(equipo)
	if err != nil {
		return c, err
	}
	// Si no se puede guardar (carpeta de solo lectura), se sigue con el nuevo.
	_ = guardarCertificado(ruta, c)
	return c, nil
}

// maxPEM acota lo que se lee del fichero del certificado.
const maxPEM = 64 << 10

func leerCertificado(ruta, equipo string, ahora time.Time) (tls.Certificate, error) {
	f, err := os.Open(ruta)
	if err != nil {
		return tls.Certificate{}, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxPEM+1))
	if err != nil {
		return tls.Certificate{}, err
	}
	if len(b) == 0 || len(b) > maxPEM {
		return tls.Certificate{}, errors.New("rdp: certificado guardado vacío o demasiado grande")
	}
	var certPEM, clavePEM []byte
	for {
		var bloque *pem.Block
		bloque, b = pem.Decode(b)
		if bloque == nil {
			break
		}
		switch bloque.Type {
		case "CERTIFICATE":
			certPEM = pem.EncodeToMemory(bloque)
		case "PRIVATE KEY":
			clavePEM = pem.EncodeToMemory(bloque)
		}
	}
	c, err := tls.X509KeyPair(certPEM, clavePEM)
	if err != nil {
		return tls.Certificate{}, err
	}
	hoja, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		return tls.Certificate{}, err
	}
	// Otro nombre de equipo o a punto de caducar: se hace uno nuevo.
	if hoja.Subject.CommonName != equipo || ahora.Add(24*time.Hour).After(hoja.NotAfter) {
		return tls.Certificate{}, errors.New("rdp: el certificado guardado ya no vale")
	}
	return c, nil
}

func guardarCertificado(ruta string, c tls.Certificate) error {
	if len(c.Certificate) == 0 || c.PrivateKey == nil {
		return errors.New("rdp: certificado incompleto")
	}
	clave, err := x509.MarshalPKCS8PrivateKey(c.PrivateKey)
	if err != nil {
		return err
	}
	datos := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Certificate[0]})
	datos = append(datos, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: clave})...)
	tmp, err := os.CreateTemp(filepath.Dir(ruta), ".rdp-certificado-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(datos); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), ruta)
}
