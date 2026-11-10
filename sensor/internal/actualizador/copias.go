package actualizador

// Quitar la CA de Caddy de las copias de seguridad (docs/diseno/ca-nodo.md).
//
// copia.sh guarda la carpeta de datos de Caddy en cada copia, y con ella la
// clave de la CA de antes. Al pasar a la CA propia, esa clave se destruye
// también en las copias: cada una se descifra, se le quitan esos ficheros y
// se vuelve a cifrar con la misma clave y el mismo formato que usa copia.sh
// (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:clave-copias`).
//
// Una copia así ya no tiene ninguna CA con la que arrancar: se le pone la
// propia (ca-nodo/, la raíz en ca-raiz.crt y CA_NODO=nodo en su .env), y al
// restaurarla en otra máquina sigue valiendo la raíz que tienen los equipos.
// El fichero viejo se sobrescribe antes de sustituirlo, y todo se hace con el
// cerrojo de copia.sh (copias/.cerrojo), para que no salga a la vez una copia
// con la CA vieja.

import (
	"archive/tar"
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Lo que usa copia.sh: tiene que coincidir para que restaurar.sh las lea.
const (
	iteracionesCopia = 200000
	cabeceraSal      = "Salted__"
)

// claveDeCopias lee la contraseña como la lee openssl con -pass file: la
// primera línea, sin el salto.
func claveDeCopias(ruta string) (string, error) {
	f, err := os.Open(ruta)
	if err != nil {
		return "", err
	}
	defer f.Close()
	linea, err := bufio.NewReader(io.LimitReader(f, 4096)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	linea = strings.TrimSuffix(linea, "\n")
	if linea == "" {
		return "", errors.New("clave-copias is empty")
	}
	return linea, nil
}

func derivar(clave string, sal []byte) (cipher.Block, []byte, error) {
	km, err := pbkdf2.Key(sha256.New, clave, sal, iteracionesCopia, 32+aes.BlockSize)
	if err != nil {
		return nil, nil, err
	}
	b, err := aes.NewCipher(km[:32])
	if err != nil {
		return nil, nil, err
	}
	return b, km[32:], nil
}

// descifrador lee una copia cifrada como la deja openssl enc y devuelve el
// contenido en claro, quitando el relleno PKCS#7 al final.
type descifrador struct {
	src     io.Reader
	modo    cipher.BlockMode
	listo   []byte // ya descifrado, para entregar
	ultimo  []byte // el último bloque descifrado: lleva el relleno si es el final
	fin     bool
	errFin  error
	entrada []byte
}

func nuevoDescifrador(r io.Reader, clave string) (*descifrador, error) {
	cab := make([]byte, 16)
	if _, err := io.ReadFull(r, cab); err != nil {
		return nil, errors.New("not an encrypted backup")
	}
	if string(cab[:8]) != cabeceraSal {
		return nil, errors.New("not an encrypted backup (no salt header)")
	}
	b, iv, err := derivar(clave, cab[8:])
	if err != nil {
		return nil, err
	}
	return &descifrador{src: r, modo: cipher.NewCBCDecrypter(b, iv), entrada: make([]byte, 64*1024)}, nil
}

func (d *descifrador) Read(p []byte) (int, error) {
	for len(d.listo) == 0 && !d.fin {
		// La entrada mide un múltiplo del bloque: solo la última lectura se queda corta.
		n, err := io.ReadFull(d.src, d.entrada)
		if n%aes.BlockSize != 0 {
			d.fin, d.errFin = true, errors.New("the backup is truncated")
			break
		}
		if n > 0 {
			bloque := d.entrada[:n]
			d.modo.CryptBlocks(bloque, bloque)
			// Se guarda siempre el último bloque: solo al final se sabe si es el del relleno.
			d.listo = append(d.listo, d.ultimo...)
			d.listo = append(d.listo, bloque[:n-aes.BlockSize]...)
			d.ultimo = append(d.ultimo[:0], bloque[n-aes.BlockSize:]...)
		}
		if err == nil {
			continue
		}
		d.fin = true
		if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			d.errFin = err
			break
		}
		if len(d.ultimo) != aes.BlockSize {
			d.errFin = errors.New("the backup is truncated")
			break
		}
		r := int(d.ultimo[aes.BlockSize-1])
		if r == 0 || r > aes.BlockSize || !bytes.Equal(d.ultimo[aes.BlockSize-r:], bytes.Repeat([]byte{byte(r)}, r)) {
			d.errFin = errors.New("wrong backup key, or a damaged backup")
			break
		}
		d.listo = append(d.listo, d.ultimo[:aes.BlockSize-r]...)
		d.ultimo = nil
		d.errFin = io.EOF
	}
	if len(d.listo) == 0 {
		return 0, d.errFin
	}
	n := copy(p, d.listo)
	d.listo = d.listo[n:]
	return n, nil
}

// cifrador escribe en el formato de openssl enc; Close pone el relleno.
type cifrador struct {
	dst       io.Writer
	modo      cipher.BlockMode
	pendiente []byte
}

func nuevoCifrador(w io.Writer, clave string) (*cifrador, error) {
	sal := make([]byte, 8)
	if _, err := rand.Read(sal); err != nil {
		return nil, err
	}
	b, iv, err := derivar(clave, sal)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(append([]byte(cabeceraSal), sal...)); err != nil {
		return nil, err
	}
	return &cifrador{dst: w, modo: cipher.NewCBCEncrypter(b, iv)}, nil
}

func (c *cifrador) Write(p []byte) (int, error) {
	c.pendiente = append(c.pendiente, p...)
	n := len(c.pendiente) - len(c.pendiente)%aes.BlockSize
	if n >= 64*1024 {
		bloque := c.pendiente[:n]
		c.modo.CryptBlocks(bloque, bloque)
		if _, err := c.dst.Write(bloque); err != nil {
			return 0, err
		}
		c.pendiente = append([]byte(nil), c.pendiente[n:]...)
	}
	return len(p), nil
}

func (c *cifrador) Close() error {
	r := aes.BlockSize - len(c.pendiente)%aes.BlockSize
	c.pendiente = append(c.pendiente, bytes.Repeat([]byte{byte(r)}, r)...)
	c.modo.CryptBlocks(c.pendiente, c.pendiente)
	_, err := c.dst.Write(c.pendiente)
	c.pendiente = nil
	return err
}

// deLaCAVieja: lo que copia.sh mete de la CA de Caddy (la «local») en la
// copia, que va bajo caddy/ (la carpeta /data de Caddy): su raíz, su
// intermedia y sus claves, y los certificados que emitió.
func deLaCAVieja(nombre string) bool {
	p := path.Clean("/" + strings.TrimPrefix(nombre, "./"))
	if !strings.HasPrefix(p, "/caddy/") {
		return false
	}
	for _, d := range []string{"/pki/authorities/local", "/certificates/local"} {
		if strings.HasSuffix(p, d) || strings.Contains(p, d+"/") {
			return true
		}
	}
	return false
}

// ResultadoCopias dice cuántas copias se limpiaron y cuáles no se pudieron leer.
type ResultadoCopias struct {
	Limpias   int      `json:"limpias"`
	Ilegibles []string `json:"ilegibles,omitempty"`
}

// caParaCopias son los ficheros de la CA propia que se ponen en una copia
// limpia, con el nombre que les da copia.sh.
type caParaCopias struct {
	ficheros map[string][]byte // ca-nodo/raiz.crt…
	raiz     []byte            // ca-raiz.crt
}

func leerCAParaCopias(dir string) (*caParaCopias, error) {
	c := &caParaCopias{ficheros: map[string][]byte{}}
	for _, n := range []string{"raiz.crt", "intermedia.crt", "intermedia.key"} {
		b, err := os.ReadFile(filepath.Join(dir, DirCA, n))
		if err != nil {
			return nil, err
		}
		c.ficheros[DirCA+"/"+n] = b
	}
	c.raiz = c.ficheros[DirCA+"/raiz.crt"]
	return c, nil
}

// EsperaCerrojoCopias: lo más que se espera a que acabe un copia.sh en marcha.
const EsperaCerrojoCopias = 4 * time.Minute

// cerrojoCopias toma el cerrojo de copia.sh. Devuelve con qué soltarlo.
func cerrojoCopias(dir string, espera time.Duration) (func(), error) {
	if err := os.MkdirAll(filepath.Join(dir, "copias"), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "copias", ".cerrojo"), os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	hasta := time.Now().Add(espera)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) || time.Now().After(hasta) {
			f.Close()
			return nil, errors.New("a backup (copia.sh) is running right now; it will be tried again")
		}
		time.Sleep(time.Second)
	}
}

// LimpiarCopias quita la CA de Caddy de todas las copias de la carpeta del
// nodo y les pone la propia. Una copia que no se puede descifrar no se toca:
// se devuelve su nombre para que se diga en la consola.
func LimpiarCopias(dir string) (ResultadoCopias, error) {
	var r ResultadoCopias
	copias, err := filepath.Glob(filepath.Join(dir, "copias", "sugardaddy-*.tar.enc"))
	if err != nil || len(copias) == 0 {
		return r, err
	}
	ca, err := leerCAParaCopias(dir)
	if err != nil {
		return r, fmt.Errorf("the node CA cannot be read to put it in the backups: %w", err)
	}
	clave, err := claveDeCopias(filepath.Join(dir, "clave-copias"))
	if err != nil {
		for _, c := range copias {
			r.Ilegibles = append(r.Ilegibles, filepath.Base(c))
		}
		return r, nil
	}
	for _, c := range copias {
		quitado, err := limpiarCopia(c, clave, ca)
		if err != nil {
			r.Ilegibles = append(r.Ilegibles, filepath.Base(c))
			continue
		}
		if quitado {
			r.Limpias++
		}
	}
	return r, nil
}

// conCANodo es el .env de una copia con CA_NODO=nodo.
func conCANodo(env []byte) []byte {
	var lineas []string
	for _, l := range strings.Split(strings.TrimRight(string(env), "\n"), "\n") {
		if k, _, ok := strings.Cut(strings.TrimSpace(l), "="); ok && strings.TrimSpace(k) == "CA_NODO" {
			continue
		}
		lineas = append(lineas, l)
	}
	return []byte(strings.Join(append(lineas, "CA_NODO=nodo"), "\n") + "\n")
}

// limpiarCopia reescribe una copia sin la CA vieja y con la propia; si no
// llevaba la vieja, no la toca.
func limpiarCopia(ruta, clave string, ca *caParaCopias) (bool, error) {
	fi, err := os.Lstat(ruta)
	if err != nil {
		return false, err
	}
	if !fi.Mode().IsRegular() {
		return false, fmt.Errorf("%s is not a regular file", filepath.Base(ruta))
	}
	origen, err := os.Open(ruta)
	if err != nil {
		return false, err
	}
	defer origen.Close()
	d, err := nuevoDescifrador(bufio.NewReader(origen), clave)
	if err != nil {
		return false, err
	}
	tmp := ruta + ".tmp"
	_ = os.Remove(tmp)
	salida, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return false, err
	}
	limpiar := func(e error) (bool, error) {
		salida.Close()
		_ = os.Remove(tmp)
		return false, e
	}
	buf := bufio.NewWriterSize(salida, 256*1024)
	cf, err := nuevoCifrador(buf, clave)
	if err != nil {
		return limpiar(err)
	}
	tr := tar.NewReader(d)
	tw := tar.NewWriter(cf)
	quitado, tieneCA := false, false
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return limpiar(err)
		}
		if deLaCAVieja(h.Name) {
			quitado = true
			continue
		}
		nombre := strings.TrimPrefix(path.Clean("/"+strings.TrimPrefix(h.Name, "./")), "/")
		if strings.HasPrefix(nombre, DirCA+"/") || nombre == DirCA {
			tieneCA = true
		}
		var nuevo []byte
		switch {
		case nombre == ".env" && h.Typeflag == tar.TypeReg && h.Size < 1<<20:
			b, err := io.ReadAll(tr)
			if err != nil {
				return limpiar(err)
			}
			nuevo = conCANodo(b)
		case nombre == "ca-raiz.crt" && h.Typeflag == tar.TypeReg:
			nuevo = ca.raiz
		}
		if nuevo != nil {
			h.Size = int64(len(nuevo))
		}
		if err := tw.WriteHeader(h); err != nil {
			return limpiar(err)
		}
		if nuevo != nil {
			_, err = tw.Write(nuevo)
		} else {
			_, err = io.Copy(tw, tr)
		}
		if err != nil {
			return limpiar(err)
		}
	}
	// El final de la copia: también tiene que estar bien el relleno.
	if _, err := io.Copy(io.Discard, d); err != nil {
		return limpiar(err)
	}
	if !quitado {
		return limpiar(nil)
	}
	if !tieneCA {
		ahora := time.Now()
		if err := tw.WriteHeader(&tar.Header{Name: "./" + DirCA + "/", Typeflag: tar.TypeDir, Mode: 0o700, ModTime: ahora}); err != nil {
			return limpiar(err)
		}
		for _, n := range []string{"raiz.crt", "intermedia.crt", "intermedia.key"} {
			b := ca.ficheros[DirCA+"/"+n]
			modo := int64(0o644)
			if n == "intermedia.key" {
				modo = 0o600
			}
			if err := tw.WriteHeader(&tar.Header{Name: "./" + DirCA + "/" + n, Typeflag: tar.TypeReg, Mode: modo, Size: int64(len(b)), ModTime: ahora}); err != nil {
				return limpiar(err)
			}
			if _, err := tw.Write(b); err != nil {
				return limpiar(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		return limpiar(err)
	}
	if err := cf.Close(); err != nil {
		return limpiar(err)
	}
	if err := buf.Flush(); err != nil {
		return limpiar(err)
	}
	if err := salida.Sync(); err != nil {
		return limpiar(err)
	}
	if err := salida.Close(); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	// Lo de antes se sobrescribe antes de sustituirlo: rename solo lo desenlaza.
	if err := sobrescribirTodo(ruta); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	if err := os.Rename(tmp, ruta); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	return true, nil
}

// sobrescribirTodo pasa por encima de un fichero, entero, datos al azar.
func sobrescribirTodo(ruta string) error {
	f, err := os.OpenFile(ruta, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	bloque := make([]byte, 1<<20)
	if _, err := rand.Read(bloque); err != nil {
		return err
	}
	for hecho := int64(0); hecho < fi.Size(); {
		n := min(int64(len(bloque)), fi.Size()-hecho)
		if _, err := f.WriteAt(bloque[:n], hecho); err != nil {
			return err
		}
		hecho += n
	}
	return f.Sync()
}
