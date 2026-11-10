package actualizador

// En qué claves de publicación se confía y para qué (docs/diseno/claves-y-catalogo.md,
// SUP-1). Gemelo de paquetes/canal/src/confianza.ts: cuatro usos (cloud, community,
// licencias, delegaciones) en PUBLICACION_CLAVES ("uso:clave,uso:clave,…") y la clave de
// legado en PUBLICACION_CLAVE_PUBLICA, que vale para todos mientras no se retire.

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

var Usos = []string{"cloud", "community", "licencias", "delegaciones"}

const maxClaves = 16

type ClaveDeConfianza struct {
	Uso     string
	Publica crypto.PublicKey
}

type Confianza struct {
	Claves []ClaveDeConfianza
	Legado crypto.PublicKey // nil: retirada
}

// Firma es una de las firmas añadidas de un documento: la huella de la clave y la firma.
type Firma struct {
	Clave string `json:"clave"`
	Firma string `json:"firma"`
}

func esUso(u string) bool {
	for _, x := range Usos {
		if x == u {
			return true
		}
	}
	return false
}

// Huella de una clave pública: sha256 de su spki DER, 16 hex (como huella() en TS).
func Huella(pub crypto.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(der)
	return hex.EncodeToString(h[:])[:16]
}

// MotivoClaves dice qué falla en un texto con el formato de PUBLICACION_CLAVES ("" si vale).
func MotivoClaves(texto string) string {
	if strings.TrimSpace(texto) == "" {
		return ""
	}
	partes := strings.Split(texto, ",")
	if len(partes) > maxClaves {
		return fmt.Sprintf("more than %d trusted keys", maxClaves)
	}
	for _, p := range partes {
		uso, clave, ok := strings.Cut(p, ":")
		uso = strings.TrimSpace(uso)
		if !ok || !esUso(uso) {
			return "unknown key use"
		}
		if _, err := ClaveVerificable(strings.TrimSpace(clave)); err != nil {
			return "the " + uso + " key is not an Ed25519 or ECDSA P-256 public key"
		}
	}
	return ""
}

// LeerConfianza lee las dos variables. Lo que no se entiende se ignora: nunca da más
// confianza de la dicha.
func LeerConfianza(claves, legado string) Confianza {
	var c Confianza
	for _, p := range strings.Split(claves, ",") {
		uso, clave, ok := strings.Cut(p, ":")
		uso = strings.TrimSpace(uso)
		if !ok || !esUso(uso) || len(c.Claves) >= maxClaves {
			continue
		}
		if pub, err := ClaveVerificable(strings.TrimSpace(clave)); err == nil {
			c.Claves = append(c.Claves, ClaveDeConfianza{Uso: uso, Publica: pub})
		}
	}
	if pub, err := ClaveVerificable(strings.TrimSpace(legado)); err == nil {
		c.Legado = pub
	}
	return c
}

// ConfianzaDelEntorno lee PUBLICACION_CLAVES y PUBLICACION_CLAVE_PUBLICA de donde se diga
// (os.Getenv o un .env leído).
func ConfianzaDelEntorno(get func(string) string) Confianza {
	return LeerConfianza(get("PUBLICACION_CLAVES"), get("PUBLICACION_CLAVE_PUBLICA"))
}

// HayClave dice si se confía en algo para ese uso ("": solo la de legado).
func (c Confianza) HayClave(uso string) bool {
	if c.Legado != nil {
		return true
	}
	for _, k := range c.Claves {
		if uso != "" && k.Uso == uso {
			return true
		}
	}
	return false
}

func (c Confianza) candidatas(uso string) []crypto.PublicKey {
	var r []crypto.PublicKey
	if c.Legado != nil {
		r = append(r, c.Legado)
	}
	if uso != "" {
		for _, k := range c.Claves {
			if k.Uso == uso {
				r = append(r, k.Publica)
			}
		}
	}
	return r
}

// firmaBuena: Ed25519 sobre el texto, o ECDSA P-256 con SHA-256 y la firma en r||s de 64 bytes
// (IEEE P1363), como la devuelve el Key Vault (ES256). Igual que firmaValida en TypeScript.
func firmaBuena(pub crypto.PublicKey, texto, firmaB64 string) bool {
	f, err := base64.StdEncoding.DecodeString(firmaB64)
	if err != nil {
		return false
	}
	switch k := pub.(type) {
	case ed25519.PublicKey:
		return len(k) == ed25519.PublicKeySize && ed25519.Verify(k, []byte(texto), f)
	case *ecdsa.PublicKey:
		if len(f) != 64 || k.Curve != elliptic.P256() {
			return false
		}
		h := sha256.Sum256([]byte(texto))
		return ecdsa.Verify(k, h[:], new(big.Int).SetBytes(f[:32]), new(big.Int).SetBytes(f[32:]))
	}
	return false
}

// ClaveVerificable lee una clave pública en DER (spki) base64: Ed25519 (la de legado y las de
// reserva) o ECDSA P-256 (las principales, en el HSM del Key Vault). Cualquier otra, error.
func ClaveVerificable(b64 string) (crypto.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	switch c := k.(type) {
	case ed25519.PublicKey:
		return c, nil
	case *ecdsa.PublicKey:
		if c.Curve == elliptic.P256() {
			return c, nil
		}
	}
	return nil, errors.New("the key is neither Ed25519 nor ECDSA P-256")
}

// FirmadoPor devuelve la huella de la clave en la que se confía que firmó el texto para
// ese uso, o "" si ninguna. `firma` se prueba con todas las candidatas; cada una de
// `firmas`, solo con la clave de su huella.
func (c Confianza) FirmadoPor(uso, texto, firma string, firmas []Firma) string {
	cand := c.candidatas(uso)
	if firma != "" {
		for _, p := range cand {
			if firmaBuena(p, texto, firma) {
				return Huella(p)
			}
		}
	}
	for i, f := range firmas {
		if i >= 8 {
			break
		}
		for _, p := range cand {
			if Huella(p) == f.Clave && firmaBuena(p, texto, f.Firma) {
				return Huella(p)
			}
		}
	}
	return ""
}

// EdicionDeRelease dice de qué edición es una versión por el registro de sus imágenes:
// cloud (todas en *.azurecr.io), community (alguna en ghcr.io) o "" (ni una ni otra).
func EdicionDeRelease(r Release) string {
	var imgs []string
	for _, i := range r.Servicios {
		imgs = append(imgs, i)
	}
	if r.Actualizador != "" {
		imgs = append(imgs, r.Actualizador)
	}
	if len(imgs) == 0 {
		return ""
	}
	host := func(i string) string { return strings.ToLower(strings.SplitN(i, "/", 2)[0]) }
	nube, ghcr := true, true
	for _, i := range imgs {
		if !strings.HasSuffix(host(i), ".azurecr.io") {
			nube = false
		}
		if host(i) != "ghcr.io" {
			ghcr = false
		}
	}
	// Todas de un mismo lado: con registros mezclados no es de ninguna edición (solo el legado).
	switch {
	case nube:
		return "cloud"
	case ghcr:
		return "community"
	}
	return ""
}

// EdicionDelNodo dice de qué edición es este nodo por su propia configuración, no por lo
// que diga la versión: EDICION en .env y, en los nodos de antes, el registro del que
// descarga (el privado de Azure es Cloud). Vacía: no se sabe (desarrollo).
func EdicionDelNodo(get func(string) string) string {
	switch strings.TrimSpace(get("EDICION")) {
	case "cloud":
		return "cloud"
	case "community":
		return "community"
	}
	registro := strings.ToLower(strings.TrimSpace(get("REGISTRO")))
	switch {
	case strings.HasSuffix(registro, ".azurecr.io"):
		return "cloud"
	case registro == "ghcr.io":
		return "community"
	}
	return ""
}

// VerificarEnNodo es Verificar más la edición: un nodo solo acepta versiones de la suya, así
// que la clave de una edición no vale nunca para la otra aunque la versión diga ser de
// ella (A3 de la revisión del 2026-11-09).
func VerificarEnNodo(c Confianza, edicion string, f ReleaseFirmada) (Release, error) {
	r, err := Verificar(c, f)
	if err != nil {
		return r, err
	}
	if edicion != "" && EdicionDeRelease(r) != edicion {
		return Release{}, fmt.Errorf("the version is not for this edition (%s)", edicion)
	}
	return r, nil
}

var errSinClave = errors.New("there is no trusted key to check this version")
