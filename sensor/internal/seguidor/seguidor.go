// Package seguidor lee lo nuevo de un fichero de registro desde donde se
// quedó la última vez. Solo entrega líneas completas: lo que va detrás del
// último salto de línea se lee en la siguiente vuelta.
package seguidor

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const maxLectura = 4 << 20

const (
	// tamHuella: bytes del principio de un fichero que forman su huella.
	tamHuella = 256
	// quietud: un rotado escrito hace menos que esto puede seguir creciendo
	// (el honeypot aún no ha abierto el nuevo). Hasta entonces no se da por
	// acabado ni cuenta su última línea sin salto.
	quietud = 2 * time.Second
)

const (
	avisoPerdido      = "el registro anterior ya no está: puede faltar lo que hubiera sin leer"
	avisoDesaparecido = "un registro rotado ha desaparecido antes de acabarlo: puede faltar lo que tuviera"
	avisoSalto        = "%s: se saltan %d bytes sin salto de línea desde el byte %d (línea gigante o fichero disperso)"
)

// comprimidos: lo que deja logrotate con compress no es texto y no se lee.
var comprimidos = []string{".gz", ".bz2", ".xz", ".zst", ".zip"}

// trasAbrir corre justo después de abrir el registro activo. Solo para las
// pruebas: simula una rotación en ese momento.
var trasAbrir func()

// Leer devuelve las líneas completas nuevas y el offset donde seguir. Si el
// fichero es más corto que el offset, lo han rotado o truncado y se empieza
// desde el principio.
func Leer(ruta string, desde int64) ([][]byte, int64, error) {
	f, err := abrirRegistro(ruta)
	if errors.Is(err, os.ErrNotExist) {
		return nil, desde, nil
	}
	if err != nil {
		return nil, desde, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, desde, err
	}
	if info.Size() < desde {
		desde = 0
	}
	if _, err := f.Seek(desde, io.SeekStart); err != nil {
		return nil, desde, err
	}
	datos, err := io.ReadAll(io.LimitReader(f, maxLectura))
	if err != nil {
		return nil, desde, err
	}
	fin := bytes.LastIndexByte(datos, '\n')
	if fin < 0 {
		return nil, desde, nil
	}
	var lineas [][]byte
	for _, l := range bytes.Split(datos[:fin], []byte("\n")) {
		if len(bytes.TrimSpace(l)) > 0 {
			lineas = append(lineas, l)
		}
	}
	return lineas, desde + int64(fin) + 1, nil
}

// Posicion es por dónde va la lectura de un registro: en qué fichero (su
// inodo y su huella) y en qué byte. Puede ser un rotado a medias.
type Posicion struct {
	Inodo  uint64
	Offset int64
	// Huella del principio del fichero: "n:sha256 corto" de sus primeros n
	// bytes (hasta 256). Lo reconoce aunque cambie de inodo (carpeta
	// copiada) y delata un inodo reutilizado. Vacía si aún no se sabe.
	Huella string
	// Modif: fecha de modificación (UnixNano) del fichero cuando se leyó. Si
	// ese fichero desaparece, los rotados posteriores a esa fecha son los que
	// quedan por leer.
	Modif int64
}

// Seguir lee lo nuevo de un registro que el honeypot rota (lo renombra,
// cowrie.json → cowrie.json.2026_10_16, y empieza otro con el mismo nombre)
// desde la posición p. Devuelve las líneas, la posición donde seguir y, si
// algo se ha podido perder o se ha saltado, un aviso para el registro.
//
// Si el fichero ya no es el de p, primero acaba el anterior (lo busca entre
// los rotados de la carpeta), después lee enteros, de antiguo a nuevo, los
// rotados que vinieron detrás y solo entonces sigue con el nuevo. Cada
// llamada lee como mucho 4 MB: si no da, la posición se queda en el rotado a
// medias y la siguiente llamada sigue desde ahí.
//
// Cómo llamarla, en cada vuelta y por cada registro:
//
//	p := seguidor.Posicion{Inodo: e.Inodos[id], Offset: e.Leido[id], Huella: e.Huellas[id]}
//	lineas, p, aviso, err := seguidor.Seguir(ruta, p)
//	if err != nil { ...; continue } // la posición guardada no cambia
//	if aviso != "" { slog.Warn(aviso, "trampa", id) }
//	// Primero las líneas a la cola de salida; después la posición entera,
//	// aunque no haya líneas (puede haber acabado un rotado o saltado un trozo).
//	e.Leido[id], e.Inodos[id], e.Huellas[id] = p.Offset, p.Inodo, p.Huella
//
// La posición vacía, o la de antes de la 0.12.1 (solo offset), vale: se toma
// el fichero activo sin perder el offset. El inodo guardado puede ser el de un
// rotado a medias: no hay que borrarlo, ni los rotados más nuevos que él.
func Seguir(ruta string, p Posicion) ([][]byte, Posicion, string, error) {
	f, err := abrirRegistro(ruta)
	if errors.Is(err, os.ErrNotExist) {
		return nil, p, "", nil
	}
	if err != nil {
		return nil, p, "", err
	}
	defer f.Close()
	// El inodo, del mismo descriptor que se va a leer: si lo rotan ahora, se
	// sigue leyendo el que se ha abierto.
	fi, err := f.Stat()
	if err != nil {
		return nil, p, "", err
	}
	if trasAbrir != nil {
		trasAbrir()
	}
	l := &lector{ruta: ruta, cupo: maxLectura, pos: p}
	if err := l.seguir(f, fi, p); err != nil {
		return nil, p, "", err
	}
	return l.lineas, l.pos, strings.Join(l.avisos, "; "), nil
}

// LeerRotado es la API de la 0.12.1, ahora sobre Seguir. Obsoleta: no guarda
// la huella (no reconoce un registro copiado) ni devuelve los avisos.
func LeerRotado(ruta string, desde int64, inodo uint64) ([][]byte, int64, uint64, error) {
	lineas, p, _, err := Seguir(ruta, Posicion{Inodo: inodo, Offset: desde})
	return lineas, p.Offset, p.Inodo, err
}

// lector junta lo leído en una llamada a Seguir.
type lector struct {
	ruta   string
	cupo   int // bytes que aún se pueden leer en esta llamada
	pos    Posicion
	lineas [][]byte
	avisos []string
}

func (l *lector) avisar(a string) { l.avisos = append(l.avisos, a) }

// seguir decide de dónde se lee: del activo f o de los rotados.
func (l *lector) seguir(f *os.File, fi os.FileInfo, p Posicion) error {
	activo := InodoDe(fi)
	switch {
	case p.Inodo == 0 && p.Huella == "":
		// Primera vez, o estado de antes de la 0.12.1: el activo es el que se
		// leía; se toma su inodo sin perder el offset.
		return l.activo(f, fi, p.Offset)
	case p.Inodo != 0 && activo == p.Inodo:
		if fi.Size() >= p.Offset && coincide(f, p.Huella) {
			return l.activo(f, fi, p.Offset)
		}
		// El mismo, pero más corto o con otro principio: lo han vaciado
		// (copytruncate). Si su copia está entre los rotados, se acaba antes;
		// si no, se empieza desde el principio, como siempre.
		rs, err := rotadosDe(l.ruta)
		if err != nil {
			return err
		}
		if i := porHuella(rs, p); i >= 0 {
			return l.rotados(rs, i, p.Offset, f, fi)
		}
		return l.activo(f, fi, 0)
	case p.Huella != "" && fi.Size() >= p.Offset && coincide(f, p.Huella):
		// Otro inodo y el mismo principio. Si el de antes está entre los
		// rotados, es una rotación de un registro con cabecera fija; si no, el
		// mismo fichero copiado (rsync, cp -a), o un sistema sin inodos.
		if p.Inodo != 0 {
			rs, err := rotadosDe(l.ruta)
			if err != nil {
				return err
			}
			if i := porInodo(rs, p); i >= 0 {
				return l.rotados(rs, i, p.Offset, f, fi)
			}
		}
		return l.activo(f, fi, p.Offset)
	}
	// Lo han rotado: se busca por su inodo o, si además se ha copiado la
	// carpeta, por su huella.
	rs, err := rotadosDe(l.ruta)
	if err != nil {
		return err
	}
	i := porInodo(rs, p)
	if i < 0 {
		i = porHuella(rs, p)
	}
	if i >= 0 {
		return l.rotados(rs, i, p.Offset, f, fi)
	}
	l.avisar(avisoPerdido)
	// El de la posición ya no está, pero los rotados que vinieron detrás sí
	// pueden estar: los posteriores a cuando se leyó, enteros y en orden.
	if p.Modif != 0 {
		for i, c := range rs {
			if c.modif.UnixNano() > p.Modif {
				return l.rotados(rs, i, 0, f, fi)
			}
		}
	}
	return l.activo(f, fi, 0)
}

// rotados acaba rs[i] desde off, lee enteros los rotados que vinieron detrás
// y, si el cupo da, sigue con el activo desde el principio.
func (l *lector) rotados(rs []candidato, i int, off int64, f *os.File, fi os.FileInfo) error {
	activo := InodoDe(fi)
	desde := off
	for _, c := range rs[i:] {
		if activo != 0 && c.inodo == activo {
			// Han rotado el activo después de abrirlo: se lee como activo y lo
			// que vino detrás queda para la siguiente vuelta.
			break
		}
		acabado, err := l.rotado(c, desde)
		if err != nil || !acabado {
			return err
		}
		desde = 0
	}
	return l.activo(f, fi, desde)
}

// rotado lee un rotado desde desde. Dice si se ha acabado y se puede pasar al
// siguiente.
func (l *lector) rotado(c candidato, desde int64) (bool, error) {
	f, err := abrirRegistro(c.ruta)
	if errors.Is(err, os.ErrNotExist) {
		l.avisar(avisoDesaparecido)
		return true, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return false, err
	}
	if InodoDe(fi) != c.inodo {
		// Los nombres han cambiado desde que se listaron: se sigue en la
		// siguiente vuelta, con la lista nueva.
		return false, nil
	}
	edad := time.Since(fi.ModTime())
	quieto := edad >= quietud || edad < 0
	off, alFinal, err := l.leer(f, fi.Size(), min(desde, fi.Size()), quieto)
	if err != nil {
		return false, err
	}
	l.pos = Posicion{Inodo: c.inodo, Offset: off, Huella: huella(f), Modif: fi.ModTime().UnixNano()}
	return alFinal && quieto, nil
}

// activo lee el registro activo desde desde, o desde el principio si ahora es
// más corto (lo han vaciado).
func (l *lector) activo(f *os.File, fi os.FileInfo, desde int64) error {
	if fi.Size() < desde {
		desde = 0
	}
	off, _, err := l.leer(f, fi.Size(), desde, false)
	if err != nil {
		return err
	}
	l.pos = Posicion{Inodo: InodoDe(fi), Offset: off, Huella: huella(f), Modif: fi.ModTime().UnixNano()}
	return nil
}

// leer saca las líneas de f (de tam bytes) desde desde, sin pasarse del cupo.
// final: el fichero ya no crece y su última línea cuenta aunque no acabe en
// salto. Devuelve dónde seguir y si lo ha leído hasta el final.
func (l *lector) leer(f *os.File, tam, desde int64, final bool) (int64, bool, error) {
	// Lo normal es empezar detrás de un salto de línea. Si no, se está en la
	// cola de una línea gigante que ya se saltó.
	amitad := false
	if desde > 0 {
		var b [1]byte
		if _, err := f.ReadAt(b[:], desde-1); err != nil {
			if errors.Is(err, io.EOF) {
				return desde, false, nil // lo han vaciado mientras tanto
			}
			return desde, false, err
		}
		amitad = b[0] != '\n'
	}
	buf := make([]byte, min(int64(l.cupo), tam-desde+1))
	n, err := f.ReadAt(buf, desde)
	if err != nil && !errors.Is(err, io.EOF) {
		return desde, false, err
	}
	l.cupo -= n
	alFinal := n < len(buf)
	corte := bytes.LastIndexByte(buf[:n], '\n') + 1
	if alFinal && final {
		corte = n
	}
	if corte == 0 && n == maxLectura {
		// Un trozo entero sin salto de línea: esperar no lo arregla.
		l.avisar(fmt.Sprintf(avisoSalto, filepath.Base(f.Name()), n, desde))
		return desde + int64(n), false, nil
	}
	trozo := buf[:corte]
	if amitad {
		// Se descarta la cola de la línea saltada. Si era el hueco de un
		// fichero disperso (ceros), lo que va tras el último cero es una línea.
		cola := trozo
		if i := bytes.IndexByte(trozo, '\n'); i >= 0 {
			cola = trozo[:i]
		}
		if k := bytes.LastIndexByte(cola, 0); k >= 0 {
			trozo = trozo[k+1:]
		} else {
			trozo = trozo[len(cola):]
		}
	}
	for _, linea := range bytes.Split(trozo, []byte("\n")) {
		linea = bytes.TrimLeft(linea, "\x00")
		if len(bytes.TrimSpace(linea)) > 0 {
			l.lineas = append(l.lineas, linea)
		}
	}
	return desde + int64(corte), alFinal && corte == n, nil
}

// candidato es un rotado de la carpeta del registro.
type candidato struct {
	ruta  string
	inodo uint64
	tam   int64
	modif time.Time
}

// rotadosDe lista los rotados de ruta (su nombre empieza por el de ruta y no
// es él; ficheros normales sin comprimir) de antiguo a nuevo: por fecha de
// modificación y, si empatan, por nombre.
func rotadosDe(ruta string) ([]candidato, error) {
	dir, base := filepath.Dir(ruta), filepath.Base(ruta)
	entradas, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var rs []candidato
	for _, e := range entradas {
		n := e.Name()
		if n == base || !strings.HasPrefix(n, base) || !e.Type().IsRegular() || comprimido(n) {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue // se ha ido mientras se listaba
		}
		rs = append(rs, candidato{ruta: filepath.Join(dir, n), inodo: InodoDe(fi), tam: fi.Size(), modif: fi.ModTime()})
	}
	slices.SortFunc(rs, func(a, b candidato) int {
		if c := a.modif.Compare(b.modif); c != 0 {
			return c
		}
		return strings.Compare(a.ruta, b.ruta)
	})
	return rs, nil
}

func comprimido(nombre string) bool {
	return slices.ContainsFunc(comprimidos, func(ext string) bool { return strings.HasSuffix(nombre, ext) })
}

// porInodo busca entre los rotados el de p por su inodo (y su huella: el
// inodo puede ser reutilizado de un fichero ya borrado).
func porInodo(rs []candidato, p Posicion) int {
	if p.Inodo == 0 {
		return -1
	}
	for i, c := range rs {
		if c.inodo == p.Inodo && empiezaComo(c.ruta, p.Huella) {
			return i
		}
	}
	return -1
}

// porHuella busca entre los rotados una copia del de p: el mismo principio y
// al menos su offset. Si hay varias, la más nueva.
func porHuella(rs []candidato, p Posicion) int {
	if p.Huella == "" {
		return -1
	}
	for i := len(rs) - 1; i >= 0; i-- {
		if rs[i].tam >= p.Offset && empiezaComo(rs[i].ruta, p.Huella) {
			return i
		}
	}
	return -1
}

// huella resume el principio de f (ver Posicion.Huella). Vacía mientras no
// tenga ni una línea entera: lo que aún se escribe no sirve para reconocerlo.
func huella(f *os.File) string {
	b := make([]byte, tamHuella)
	n, err := f.ReadAt(b, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	if n < tamHuella && bytes.IndexByte(b[:n], '\n') < 0 {
		return ""
	}
	return resumir(b[:n])
}

func resumir(b []byte) string {
	s := sha256.Sum256(b)
	return strconv.Itoa(len(b)) + ":" + hex.EncodeToString(s[:8])
}

// coincide dice si f empieza como dice la huella h. Sin huella (o ilegible)
// no se sabe: vale.
func coincide(f *os.File, h string) bool {
	ns, _, ok := strings.Cut(h, ":")
	n, err := strconv.Atoi(ns)
	if !ok || err != nil || n <= 0 || n > tamHuella {
		return true
	}
	b := make([]byte, n)
	if _, err := f.ReadAt(b, 0); err != nil {
		return false
	}
	return resumir(b) == h
}

// empiezaComo es coincide para un fichero aún sin abrir.
func empiezaComo(ruta, h string) bool {
	if h == "" {
		return true
	}
	f, err := abrirRegistro(ruta)
	if err != nil {
		return false
	}
	defer f.Close()
	return coincide(f, h)
}
