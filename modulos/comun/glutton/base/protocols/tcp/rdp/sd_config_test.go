package rdp

import (
	"crypto/x509"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNombreNetBIOS(t *testing.T) {
	require.Equal(t, "SRV-RDP01", nombreNetBIOS(" srv-rdp01 "))
	require.Equal(t, "ABCDEFGHIJKLMNO", nombreNetBIOS("abcdefghijklmnopqrstuvwxyz"))
	require.Equal(t, "CORP", nombreNetBIOS("c\x00o;r p$"))
	require.Equal(t, "", nombreNetBIOS("ñ‮"))
}

func TestConfigSDDelEntorno(t *testing.T) {
	t.Setenv("SD_GLUTTON_EQUIPO", "ts01")
	t.Setenv("SD_GLUTTON_DOMINIO", "corp")
	t.Setenv("SD_GLUTTON_LOG_DIR", "/registros")
	t.Setenv("SD_RDP_ACEPTA", "Invierno2026!")
	t.Setenv("SD_RDP_SEGURIDAD", " NLA ")
	c := nuevaConfigSD()
	require.Equal(t, "TS01", c.GetString("rdp.computer_name"))
	require.Equal(t, "CORP", c.GetString("rdp.domain_name"))
	require.Equal(t, "/registros", c.GetString("var-dir"))
	require.Equal(t, "nla", c.GetString("sd.seguridad"))
	var g []string
	require.NoError(t, c.UnmarshalKey("rdp.guess_passwords", &g))
	require.Equal(t, []string{"Invierno2026!"}, g)
	var acc []Account
	require.NoError(t, c.UnmarshalKey("rdp.credentials", &acc))
	require.Empty(t, acc)
	require.Error(t, c.UnmarshalKey("rdp.guess_passwords", &struct{}{}))

	// Una contraseña enorme del entorno no se acepta.
	t.Setenv("SD_RDP_ACEPTA", strings.Repeat("x", maxContrasena+1))
	c = nuevaConfigSD()
	g = nil
	require.NoError(t, c.UnmarshalKey("rdp.guess_passwords", &g))
	require.Empty(t, g)
}

func TestSelectProtocolSegunSeguridad(t *testing.T) {
	t.Cleanup(func() { viper.Set("sd.seguridad", nil) })
	viper.Set("sd.seguridad", "")
	require.Equal(t, ProtocolSSL, SelectProtocol(ProtocolSSL|ProtocolHybrid))
	viper.Set("sd.seguridad", "nla")
	require.Equal(t, ProtocolHybrid, SelectProtocol(ProtocolSSL|ProtocolHybrid))
	// Si el cliente solo habla TLS (o RDP clásico), se le da lo suyo.
	require.Equal(t, ProtocolSSL, SelectProtocol(ProtocolSSL))
	require.Equal(t, ProtocolRDP, SelectProtocol(0))
}

func TestCertificadoSeGuardaYSeReutiliza(t *testing.T) {
	dir := t.TempDir()
	ahora := time.Now()
	c1, err := cargarOCrearCertificado(dir, "WIN-PRUEBA0001", ahora)
	require.NoError(t, err)
	info, err := os.Stat(filepath.Join(dir, ficheroCertificado))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "la clave privada solo la lee la trampa")

	c2, err := cargarOCrearCertificado(dir, "WIN-PRUEBA0001", ahora)
	require.NoError(t, err)
	require.Equal(t, c1.Certificate[0], c2.Certificate[0], "tras reiniciar, el mismo certificado")

	hoja, err := x509.ParseCertificate(c2.Certificate[0])
	require.NoError(t, err)
	require.Equal(t, "WIN-PRUEBA0001", hoja.Subject.CommonName)
	require.Empty(t, hoja.DNSNames, "como un Windows real: sin SAN")

	// Si cambia el nombre de equipo, o está a punto de caducar, uno nuevo.
	_, err = leerCertificado(filepath.Join(dir, ficheroCertificado), "OTRO", ahora)
	require.Error(t, err)
	_, err = leerCertificado(filepath.Join(dir, ficheroCertificado), "WIN-PRUEBA0001", hoja.NotAfter)
	require.Error(t, err)
}

func TestCertificadoGuardadoRotoOEnorme(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, ficheroCertificado)
	require.NoError(t, os.WriteFile(ruta, []byte("-----BEGIN CERTIFICATE-----\nbasura\n-----END CERTIFICATE-----\n"), 0o600))
	c, err := cargarOCrearCertificado(dir, "WIN-ROTO", time.Now())
	require.NoError(t, err)
	require.NotEmpty(t, c.Certificate)

	require.NoError(t, os.WriteFile(ruta, make([]byte, maxPEM+10), 0o600))
	_, err = leerCertificado(ruta, "WIN-ROTO", time.Now())
	require.Error(t, err)

	// Sin carpeta (o de solo lectura) también hay certificado, aunque no se guarde.
	c, err = cargarOCrearCertificado("", "WIN-SINDIR", time.Now())
	require.NoError(t, err)
	require.NotEmpty(t, c.Certificate)
}

// --- Pruebas propias de Sugardaddy: robustez del parser DER de CredSSP/NTLM ---
//
// Reproducen el hallazgo de seguridad "un TSRequest de 12 bytes tumba el
// proceso": parseLength (ntlm/der.go) admitía longitudes de hasta 127 octetos y
// hacía l = l<<8 | b sin control, de modo que 0x88 + ocho 0xff dejaba l = -1, la
// comprobación hdr+l > len(data) no saltaba y el corte entraba en pánico. El
// arreglo rechaza n > 4 y comprueba el desbordamiento. Aquí se cubre por el
// camino exacto del hallazgo (ParseCredSSP → tsRequestFields → der.Value) y con
// un Fuzz, que son las pruebas que lo habrían encontrado.

func TestParseCredSSPDERLargaNoPanic(t *testing.T) {
	vectores := []string{
		"3088ffffffffffffffff0000", // el de la evidencia (8 octetos 0xff)
		"308800000000ffffffff0000",
		"30847fffffff",             // longitud de 4 octetos, mayor que los datos
		"3085ffffffffff",           // 5 octetos de longitud: hay que rechazarlo
		"30ff",                     // 127 octetos anunciados, sin datos
		"a08bffffffffffffffffffff", // tag contextual con longitud larga
	}
	for _, h := range vectores {
		raw, err := hex.DecodeString(h)
		require.NoError(t, err)
		require.NotPanics(t, func() {
			p := ParseCredSSP(raw)
			_ = p
			_ = derValue(raw, 0x30)
			tag, val, rest := derNext(raw)
			_, _, _ = tag, val, rest
		}, "vector %s no debe hacer pánico", h)
	}
}

func FuzzParseCredSSP(f *testing.F) {
	for _, h := range []string{
		"3088ffffffffffffffff0000",
		"305ca003020106",
		"3030a003020106",
	} {
		if raw, err := hex.DecodeString(h); err == nil {
			f.Add(raw)
		}
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		// No debe hacer pánico ni reservar memoria sin control con cualquier
		// entrada (la cubre el tope de n>4 en parseLength).
		_ = ParseCredSSP(raw)
		_ = derValue(raw, 0x30)
		_, _, _ = derNext(raw)
	})
}
