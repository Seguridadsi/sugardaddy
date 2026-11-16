package copias

// La prueba de restauración (mensual, o cuando se pide en la consola): bajar la
// última copia del destino y comprobarla sin tocar el nodo. Lo mismo que
// `restaurar.sh --comprobar`, en Go y sin escribir nada descifrado en disco.
//
// Lo que se puede comprobar depende de si la clave privada está en la máquina:
//
//   - Siempre: que lo bajado es byte a byte lo que se subió (su SHA-256 contra el
//     apuntado al subirla) y que tiene la forma de un fichero de age: la cabecera
//     («age-encryption.org/v1», al menos un destinatario X25519, la línea «---»
//     con el MAC) y un cuerpo de trozos STREAM de tamaños posibles.
//   - Solo con la clave privada (clave-copias.age en la carpeta del nodo): que se
//     descifra entera (age comprueba el MAC de la cabecera y el de cada trozo), que
//     el tar se lee y que lleva la base de datos (un volcado de pg_dump), .env y
//     versiones.env.
//
// Sin la clave privada, age no deja comprobar nada criptográfico: el MAC de la
// cabecera y los de los trozos se calculan con la clave del fichero, que solo se
// saca con la privada. Por eso entonces el resultado es «sin-clave», nunca «ok»:
// la copia está entera y bien formada, pero que se pueda descifrar solo lo
// demuestra quien tiene la clave (restaurar.sh --comprobar -i <clave>).

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"strings"
)

// Resultados de la prueba.
const (
	PruebaOK       = "ok"        // descifrada y completa
	PruebaSinClave = "sin-clave" // entera y bien formada; sin la clave privada no se puede descifrar aquí
	PruebaFallo    = "fallo"
)

// Necesarios: lo que restaurar.sh exige en una copia (su bucle «for f in …»; una
// prueba compara las dos listas).
var Necesarios = []string{"consola.dump", ".env", "versiones.env"}

// Comprobacion es el resultado de la prueba.
type Comprobacion struct {
	Resultado string `json:"resultado"`
	Detalle   string `json:"detalle"`
	Nombre    string `json:"nombre"`
	Bytes     int64  `json:"bytes"`
	// Huella: «coincide», «distinta» o «sin-apuntar» (subida antes de llevar la cuenta).
	Huella        string `json:"huella"`
	Destinatarios int    `json:"destinatarios"`
	Descifrada    bool   `json:"descifrada"`
	CA            bool   `json:"ca,omitempty"` // lleva la CA del nodo
}

const (
	cabeceraAge = "age-encryption.org/v1"
	trozoAge    = 64*1024 + 16
)

// Estructura lee la cabecera de age y comprueba el tamaño del cuerpo. Devuelve
// cuántos destinatarios X25519 tiene.
func Estructura(ruta string) (int, error) {
	f, err := os.Open(ruta)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	r := bufio.NewReaderSize(io.LimitReader(f, 1<<20), 4096)
	leidos := int64(0)
	linea := func() (string, error) {
		l, err := r.ReadString('\n')
		leidos += int64(len(l))
		if err != nil {
			return "", errors.New("the age header is cut short")
		}
		return strings.TrimSuffix(l, "\n"), nil
	}
	primera, err := linea()
	if err != nil || primera != cabeceraAge {
		return 0, errors.New("it is not an age file (age-encryption.org/v1)")
	}
	x25519, estrofas := 0, 0
	for {
		l, err := linea()
		if err != nil {
			return 0, err
		}
		if strings.HasPrefix(l, "--- ") {
			mac, err := base64.RawStdEncoding.Strict().DecodeString(strings.TrimPrefix(l, "--- "))
			if err != nil || len(mac) != 32 {
				return 0, errors.New("the age header MAC line is malformed")
			}
			break
		}
		if !strings.HasPrefix(l, "-> ") {
			return 0, errors.New("the age header is malformed")
		}
		estrofas++
		if estrofas > 20 {
			return 0, errors.New("the age header has too many recipients")
		}
		args := strings.Fields(strings.TrimPrefix(l, "-> "))
		if len(args) == 0 {
			return 0, errors.New("the age header has an empty recipient")
		}
		// El cuerpo: líneas de 64 caracteres de base64 y una última más corta (o vacía).
		var cuerpo strings.Builder
		for {
			c, err := linea()
			if err != nil {
				return 0, err
			}
			if len(c) > 64 {
				return 0, errors.New("the age header has a malformed recipient")
			}
			cuerpo.WriteString(c)
			if len(c) < 64 {
				break
			}
		}
		b, err := base64.RawStdEncoding.Strict().DecodeString(cuerpo.String())
		if err != nil {
			return 0, errors.New("the age header has a malformed recipient")
		}
		if args[0] == "X25519" {
			if len(args) != 2 || len(b) != 32 {
				return 0, errors.New("the age header has a malformed X25519 recipient")
			}
			if e, err := base64.RawStdEncoding.Strict().DecodeString(args[1]); err != nil || len(e) != 32 {
				return 0, errors.New("the age header has a malformed X25519 recipient")
			}
			x25519++
		}
	}
	if x25519 == 0 {
		return 0, errors.New("the backup is not encrypted to any age public key (X25519)")
	}
	// El cuerpo: 16 bytes de nonce y los trozos (64 KiB + 16 de etiqueta; el último, más
	// corto pero nunca vacío salvo que sea el único).
	cuerpo := info.Size() - leidos - 16
	if cuerpo < 16 {
		return 0, errors.New("the backup has no encrypted content (it is cut short)")
	}
	if resto := cuerpo % trozoAge; resto != 0 && (resto < 16 || resto == 16 && cuerpo > 16) {
		return 0, errors.New("the encrypted content has an impossible length: the backup is cut short or was changed")
	}
	return x25519, nil
}

// HuellaFichero: el SHA-256 en hexadecimal y el tamaño.
func HuellaFichero(ruta string) (string, int64, error) {
	f, err := os.Open(ruta)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// Comprobar hace la prueba de un fichero ya bajado. esperada: la huella apuntada
// al subirla ("" si no hay). identidad: la clave privada de age, si está en la
// máquina ("" si no). age: el programa (en la imagen del actualizador, «age»).
func Comprobar(ctx context.Context, ruta, nombre, esperada, identidad, age string) Comprobacion {
	c := Comprobacion{Nombre: nombre, Huella: "sin-apuntar"}
	fallo := func(m string) Comprobacion {
		c.Resultado, c.Detalle = PruebaFallo, m
		return c
	}
	suma, n, err := HuellaFichero(ruta)
	if err != nil {
		return fallo("cannot read the downloaded backup: " + err.Error())
	}
	c.Bytes = n
	if esperada != "" {
		if !strings.EqualFold(suma, esperada) {
			c.Huella = "distinta"
			return fallo("the backup in your storage is not the one this node uploaded (its SHA-256 differs): it was changed or damaged there")
		}
		c.Huella = "coincide"
	}
	d, err := Estructura(ruta)
	if err != nil {
		return fallo(err.Error())
	}
	c.Destinatarios = d
	if identidad == "" {
		c.Resultado = PruebaSinClave
		c.Detalle = "Complete and well formed" + map[bool]string{true: ", identical to what this node uploaded", false: ""}[c.Huella == "coincide"] +
			". The private backup key is not on this machine (as recommended), so decryption cannot be verified here: run restaurar.sh --comprobar -i <private key> where you keep it."
		return c
	}
	contenido, ca, err := descifrar(ctx, ruta, identidad, age)
	if err != nil {
		return fallo(err.Error())
	}
	c.Descifrada, c.CA = true, ca
	for _, f := range Necesarios {
		if contenido[f] <= 0 {
			return fallo("the backup decrypts but is incomplete: " + f + " is missing")
		}
	}
	c.Resultado = PruebaOK
	c.Detalle = "Downloaded, decrypted and complete: database, .env and versiones.env are there" + map[bool]string{true: ", and the node CA", false: ""}[ca] + "."
	return c
}

// descifrar pasa la copia por age -d y lee el tar al vuelo: nada descifrado toca el disco.
func descifrar(ctx context.Context, ruta, identidad, age string) (map[string]int64, bool, error) {
	if age == "" {
		age = "age"
	}
	f, err := os.Open(ruta)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	cmd := exec.CommandContext(ctx, age, "-d", "-i", identidad)
	cmd.Stdin = f
	var errores bytes.Buffer
	cmd.Stderr = &errores
	salida, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err := cmd.Start(); err != nil {
		return nil, false, fmt.Errorf("cannot run age: %w", err)
	}
	contenido := map[string]int64{}
	ca, dumpMal := false, false
	tr := tar.NewReader(salida)
	var errTar error
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			errTar = err
			break
		}
		n := strings.TrimPrefix(path.Clean("/"+h.Name), "/")
		if n == "ca-nodo" || strings.HasPrefix(n, "ca-nodo/") {
			ca = true
		}
		if h.Typeflag == tar.TypeReg {
			contenido[n] = h.Size
			if n == "consola.dump" {
				cab := make([]byte, 5)
				if _, err := io.ReadFull(tr, cab); err != nil || string(cab) != "PGDMP" {
					dumpMal = true
				}
			}
		}
	}
	// Hasta el final: age solo da por buena la copia cuando ha comprobado el último trozo.
	_, _ = io.Copy(io.Discard, salida)
	if err := cmd.Wait(); err != nil {
		return nil, false, errors.New("the backup cannot be decrypted with the private key on this machine: wrong key, or the backup was changed or is incomplete")
	}
	if errTar != nil {
		return nil, false, errors.New("the backup decrypts but its tar archive is damaged")
	}
	if dumpMal {
		return nil, false, errors.New("the backup decrypts but its database dump is not a pg_dump file")
	}
	return contenido, ca, nil
}
