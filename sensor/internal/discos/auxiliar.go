package discos

// Lo que hace el auxiliar (orden «disco» del actualizador): crear, comprobar,
// montar y retirar los discos de las trampas. Corre en un contenedor privilegiado
// de un solo uso, con la carpeta del sensor montada en la misma ruta y con
// propagación rshared (lo que monta aquí llega a la máquina) y /dev de la máquina
// (los dispositivos loop que se crean al montar).
//
// La carpeta del sensor es del sensor (no es root): puede poner enlaces o cambiar
// carpetas de sitio mientras el auxiliar trabaja. El auxiliar es root, así que nada
// de lo que toca puede depender de ella (F8): la carpeta de los discos es suya (de
// root, 0755) y la abre una vez; todo lo demás va por ese descriptor (os.Root, sin
// salir de ella ni seguir enlaces) y las órdenes reciben una ruta fija a él
// (/proc/<pid>/fd/<n>), que no cambia aunque el sensor mueva la carpeta. mount y
// umount no la cambian por la ruta real (-c), y lo montado se comprueba después: si
// el dispositivo no es el del fichero del disco, se desmonta.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// Ejecutor corre una orden y devuelve lo que escribe (salida y errores juntos). En
// el auxiliar es Exec; en las pruebas, un doble.
type Ejecutor func(ctx context.Context, orden string, args ...string) (string, error)

// Exec es el Ejecutor de verdad. El error envuelve el *exec.ExitError: e2fsck dice
// con su código de salida si ha arreglado algo o no puede.
func Exec(ctx context.Context, orden string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, orden, args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s: %w", orden, err)
	}
	return string(out), nil
}

// Auxiliar aplica un Pedido.
type Auxiliar struct {
	Ejecutar Ejecutor
	// Montado dice si en dir hay otro sistema de ficheros montado (el disco).
	Montado func(dir string) bool
	// Libre: lo que queda libre donde están los discos.
	Libre func(dir string) (int64, error)
	// LoopControl: sin él no hay dispositivos loop (/dev/loop-control).
	LoopControl string
	// Reserva: lo que tiene que seguir libre en la máquina además del disco nuevo.
	Reserva int64
	// Herramientas que tienen que estar en la imagen. Una imagen del actualizador sin
	// ellas (la distroless) no sirve de auxiliar.
	Herramientas []string
	// Fijar da la ruta fija de una carpeta abierta, que sigue llevando a ella aunque
	// la muevan (/proc/<pid>/fd/<n>). nil: su propio nombre (las pruebas).
	Fijar func(f *os.File) (string, error)
	// Respaldo comprueba, tras montar, que en dir está el fichero img y no otro
	// (nil: no se comprueba, las pruebas).
	Respaldo func(ctx context.Context, dir, img string) error
}

// NuevoAuxiliar es el de verdad.
func NuevoAuxiliar() *Auxiliar {
	a := &Auxiliar{Ejecutar: Exec, Montado: Montado, Libre: libre, LoopControl: "/dev/loop-control", Reserva: 1 << 30,
		Herramientas: []string{"mkfs.ext4", "e2fsck", "mount", "umount", "losetup", "cp"}, Fijar: rutaFija}
	a.Respaldo = a.respaldoDe
	return a
}

// carpeta es la de los discos, abierta una vez para toda la pasada.
type carpeta struct {
	raiz  *os.Root // la de los discos
	datos *os.Root // la del sensor (lo de antes del disco, en registros/<id>)
	f     *os.File // la de los discos, para su ruta fija
	base  string   // ruta fija de la de los discos
	fd    string   // ruta fija de la del sensor
	fdat  *os.File
}

func (c *carpeta) ruta(nombre string) string { return c.base + "/" + nombre }

func (c *carpeta) cerrar() {
	for _, f := range []*os.File{c.f, c.fdat} {
		if f != nil {
			_ = f.Close()
		}
	}
	for _, r := range []*os.Root{c.raiz, c.datos} {
		if r != nil {
			_ = r.Close()
		}
	}
}

// abrir la carpeta de los discos sin seguir enlaces y dejarla de root y 0755 (antes
// era del sensor, intermediario.PrepararDatos): así el sensor no puede cambiar lo de
// dentro. Lo que ya hubiera dentro no se sigue nunca: se mira con Lstat antes de usarlo.
func (a *Auxiliar) abrir(datos string) (*carpeta, error) {
	if fi, err := os.Lstat(datos); err != nil {
		return nil, err
	} else if !fi.IsDir() {
		return nil, fmt.Errorf("the sensor folder %s is not a plain folder", datos)
	}
	c := &carpeta{}
	var err error
	if c.datos, err = os.OpenRoot(datos); err != nil {
		return nil, err
	}
	fi, err := c.datos.Lstat(Carpeta)
	if errors.Is(err, os.ErrNotExist) {
		if err = c.datos.Mkdir(Carpeta, 0o755); err == nil || errors.Is(err, os.ErrExist) {
			fi, err = c.datos.Lstat(Carpeta)
		}
	}
	switch {
	case err != nil:
	case !fi.IsDir():
		err = fmt.Errorf("the disks folder %s is not a plain folder", filepath.Join(datos, Carpeta))
	default:
		err = deRoot(c.datos, Carpeta, fi)
	}
	if err == nil {
		c.raiz, err = c.datos.OpenRoot(Carpeta)
	}
	if err == nil {
		c.f, err = c.raiz.Open(".")
	}
	if err == nil {
		// Ya abierta, que sea la suya: si la han cambiado entre medias, no se toca nada.
		if fi, err = c.f.Stat(); err == nil && !propia(fi) {
			err = fmt.Errorf("the disks folder %s changed while it was being opened", filepath.Join(datos, Carpeta))
		}
	}
	if err == nil {
		c.fdat, err = c.datos.Open(".")
	}
	if err == nil {
		c.base, c.fd = filepath.Join(datos, Carpeta), datos
		if a.Fijar != nil {
			if c.base, err = a.Fijar(c.f); err == nil {
				c.fd, err = a.Fijar(c.fdat)
			}
		}
	}
	if err != nil {
		c.cerrar()
		return nil, err
	}
	return c, nil
}

// deRoot deja la carpeta de los discos de quien corre el auxiliar (root) y 0755.
func deRoot(r *os.Root, nombre string, fi os.FileInfo) error {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && os.Geteuid() == 0 && (st.Uid != 0 || st.Gid != 0) {
		if err := r.Lchown(nombre, 0, 0); err != nil {
			return err
		}
	}
	if fi.Mode().Perm() != 0o755 {
		return r.Chmod(nombre, 0o755)
	}
	return nil
}

// propia: de quien corre el auxiliar y sin que nadie más pueda escribir en ella.
func propia(fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return fi.IsDir() && fi.Mode().Perm()&0o022 == 0 && (!ok || int(st.Uid) == os.Geteuid())
}

// carpetaPlana: nombre, dentro de r, es una carpeta (no un enlace a una).
func carpetaPlana(r *os.Root, nombre string) error {
	fi, err := r.Lstat(nombre)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a plain folder", nombre)
	}
	return nil
}

// mkdirPlana crea la carpeta si no existe y comprueba que lo es (sin enlaces).
func mkdirPlana(r *os.Root, nombre string, perm os.FileMode) error {
	if err := r.Mkdir(nombre, perm); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return carpetaPlana(r, nombre)
}

// Aplicar hace lo que pide p y dice cómo ha quedado cada disco. Nunca a medias: un
// disco que no se puede montar entero (con sus carpetas y lo que tenía antes) se
// desmonta y, si era nuevo, se borra.
func (a *Auxiliar) Aplicar(ctx context.Context, p Pedido) Resultado {
	if err := p.Validar(); err != nil {
		return Resultado{Codigo: CodigoError, Detalle: err.Error()}
	}
	r := Resultado{Discos: map[string]Estado{}}
	todos := func(e Estado) Resultado {
		r.Codigo, r.Detalle = e.Codigo, e.Detalle
		for _, m := range p.Montar {
			r.Discos[m.ID] = e
		}
		for _, id := range p.Retirar {
			r.Discos[id] = e
		}
		return r
	}
	// Sin la carpeta de los discos fijada, nada: falla cerrado.
	c, err := a.abrir(p.Datos)
	if err != nil {
		return todos(Estado{Codigo: CodigoError, Detalle: "the disks folder: " + err.Error()})
	}
	defer c.cerrar()
	// Primero lo que sale: deja sitio y no necesita dispositivos loop.
	for _, id := range p.Retirar {
		r.Discos[id] = a.retirar(ctx, c, id)
	}
	if len(p.Montar) == 0 && !p.Probar {
		return r
	}
	todos = func(e Estado) Resultado {
		r.Codigo, r.Detalle = e.Codigo, e.Detalle
		for _, m := range p.Montar {
			r.Discos[m.ID] = e
		}
		return r
	}
	for _, h := range a.Herramientas {
		if _, err := exec.LookPath(h); err != nil {
			return todos(Estado{Codigo: CodigoSinAuxiliar, Detalle: "the updater image lacks " + h})
		}
	}
	if e := a.hayLoop(); e.Codigo != "" {
		return todos(e)
	}
	if p.Probar {
		if e := a.probar(ctx, c); e.Codigo != "" {
			if !DeLaMaquina(e.Codigo) {
				e.Codigo = CodigoError
			}
			return todos(e)
		}
	}
	for i, m := range p.Montar {
		e := a.montar(ctx, c, p, m)
		r.Discos[m.ID] = e
		if DeLaMaquina(e.Codigo) {
			// Lo que falla es la máquina: los demás tampoco se pueden.
			r.Codigo, r.Detalle = e.Codigo, e.Detalle
			for _, resto := range p.Montar[i+1:] {
				r.Discos[resto.ID] = e
			}
			break
		}
	}
	return r
}

// hayLoop: sin /dev/loop-control (un contenedor LXC, por ejemplo) no se puede montar
// ningún fichero.
func (a *Auxiliar) hayLoop() Estado {
	f, err := os.OpenFile(a.LoopControl, os.O_RDWR, 0)
	if err != nil {
		porque := "this machine has no loop devices"
		if !errors.Is(err, os.ErrNotExist) {
			porque = "loop devices are not allowed on this machine"
		}
		return Estado{Codigo: CodigoSinLoop, Detalle: porque + " (" + err.Error() + ")"}
	}
	f.Close()
	return Estado{}
}

func (a *Auxiliar) montar(ctx context.Context, c *carpeta, p Pedido, m Montaje) Estado {
	nombreImg := m.ID + ".img"
	dir, img := c.ruta(m.ID), c.ruta(nombreImg)
	if a.Montado(dir) {
		if err := carpetaPlana(c.raiz, m.ID); err != nil {
			return Estado{Codigo: CodigoError, Detalle: err.Error()}
		}
		if err := subcarpetas(c, m); err != nil {
			return Estado{Codigo: CodigoError, Detalle: "preparing its folders: " + err.Error()}
		}
		return Estado{}
	}
	nuevo := false
	fi, err := c.raiz.Lstat(nombreImg)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if e := a.crear(ctx, c, nombreImg, int64(p.TamMb)<<20); e.Codigo != "" {
			return e
		}
		nuevo = true
	case err != nil:
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	case !fi.Mode().IsRegular():
		return Estado{Codigo: CodigoError, Detalle: nombreImg + " is not a regular file"}
	default:
		if e := a.comprobar(ctx, img); e.Codigo != "" {
			return e
		}
	}
	quitar := func() {
		if nuevo {
			_ = c.raiz.Remove(nombreImg)
		}
	}
	// El punto de montaje, una carpeta de verdad: mount sigue los enlaces.
	if err := mkdirPlana(c.raiz, m.ID, 0o755); err != nil {
		quitar()
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	if e := a.montarEn(ctx, img, dir); e.Codigo != "" {
		quitar()
		return e
	}
	if err := subcarpetas(c, m); err != nil {
		a.desmontar(ctx, dir)
		quitar()
		return Estado{Codigo: CodigoError, Detalle: "preparing its folders: " + err.Error()}
	}
	if nuevo {
		if err := a.migrar(ctx, c, m); err != nil {
			a.desmontar(ctx, dir)
			quitar()
			return Estado{Codigo: CodigoError, Detalle: "could not move its current files into the disk: " + err.Error()}
		}
	}
	return Estado{Nuevo: nuevo}
}

// montarEn monta el fichero img en dir, por sus rutas fijas y sin cambiarlas por la
// real (-c). mount sí cambia la del fichero para el dispositivo loop: después se
// comprueba que lo montado es ese fichero y, si no, se desmonta.
func (a *Auxiliar) montarEn(ctx context.Context, img, dir string) Estado {
	if out, err := a.Ejecutar(ctx, "mount", "-c", "-t", "ext4", "-o", opcionesMontaje, img, dir); err != nil {
		return clasificarMontaje(out, err)
	}
	if a.Respaldo != nil {
		if err := a.Respaldo(ctx, dir, img); err != nil {
			a.desmontar(ctx, dir)
			return Estado{Codigo: CodigoError, Detalle: "the mounted disk is not its file: " + err.Error()}
		}
	}
	return Estado{}
}

// Sin programas ni dispositivos ni setuid: en el disco solo hay registros y estado.
const opcionesMontaje = "loop,nosuid,nodev,noexec"

// crear hace el fichero disperso y su sistema de ficheros. En la máquina solo ocupa
// lo que se escribe, así que tiene que quedar sitio para que la trampa lo llene.
func (a *Auxiliar) crear(ctx context.Context, c *carpeta, nombre string, tam int64) Estado {
	if libre, err := a.Libre(c.base); err == nil && libre < tam+a.Reserva {
		return Estado{Codigo: CodigoSinEspacio, Detalle: fmt.Sprintf(
			"%d MiB free on the sensor's disk; the decoy disk needs %d MiB and %d MiB must stay free", libre>>20, tam>>20, a.Reserva>>20)}
	}
	return a.formatear(ctx, c, nombre, tam)
}

// formatear crea el fichero disperso de ese tamaño con su ext4.
func (a *Auxiliar) formatear(ctx context.Context, c *carpeta, nombre string, tam int64) Estado {
	f, err := c.raiz.OpenFile(nombre, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	err = f.Truncate(tam)
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		_ = c.raiz.Remove(nombre)
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	if out, err := a.Ejecutar(ctx, "mkfs.ext4", argumentosMkfs(c.ruta(nombre))...); err != nil {
		_ = c.raiz.Remove(nombre)
		return Estado{Codigo: CodigoError, Detalle: resumen(out, err)}
	}
	return Estado{}
}

// argumentosMkfs: sin reserva para root (la trampa puede correr como root), un diario
// pequeño (4 MiB en vez de 32: cada disco lo ocuparía en la máquina) y un inodo por
// cada 64 KiB (16.384 en 1 GiB: un tope también para los ficheros vacíos). Sin
// orphan_file ni metadata_csum_seed, que un kernel anterior al 5.15 o al 4.4 no monta.
func argumentosMkfs(img string) []string {
	return []string{"-q", "-F", "-m", "0", "-J", "size=4", "-i", "65536",
		"-O", "^orphan_file,^metadata_csum_seed", "-E", "root_owner=0:0", img}
}

// comprobar un disco que ya existe antes de montarlo (tras un reinicio de la máquina
// puede haberse quedado a medias). Si el fichero sigue en un dispositivo loop (una
// trampa en marcha aún lo tiene, aunque esté desmontado), no se toca: comprobarlo en
// uso lo estropearía, y mount reutiliza ese dispositivo en vez de montarlo dos veces.
func (a *Auxiliar) comprobar(ctx context.Context, img string) Estado {
	out, err := a.Ejecutar(ctx, "losetup", "-n", "-O", "NAME", "-j", img)
	if err != nil {
		return Estado{Codigo: CodigoError, Detalle: resumen(out, err)}
	}
	if strings.TrimSpace(out) != "" {
		return Estado{}
	}
	out, err = a.Ejecutar(ctx, "e2fsck", "-p", img)
	if codigoSalida(err) < 4 {
		return Estado{}
	}
	out, err = a.Ejecutar(ctx, "e2fsck", "-y", img)
	if codigoSalida(err) < 4 {
		return Estado{}
	}
	return Estado{Codigo: CodigoError, Detalle: "the disk is damaged and e2fsck cannot repair it: " + resumen(out, err)}
}

// codigoSalida: 0 sin error; el de la orden si salió con uno; 8 (error de e2fsck) si ni arrancó.
func codigoSalida(err error) int {
	if err == nil {
		return 0
	}
	var x *exec.ExitError
	if errors.As(err, &x) {
		return x.ExitCode()
	}
	return 8
}

// clasificarMontaje: si mount falla por la máquina (sin loop, sin permiso), no vale
// la pena intentarlo con los demás discos.
func clasificarMontaje(out string, err error) Estado {
	d := resumen(out, err)
	m := strings.ToLower(out + " " + err.Error())
	switch {
	case strings.Contains(m, "loop device") || strings.Contains(m, "loop-control"):
		return Estado{Codigo: CodigoSinLoop, Detalle: d}
	case strings.Contains(m, "permission denied") || strings.Contains(m, "operation not permitted") ||
		strings.Contains(m, "must be superuser"):
		return Estado{Codigo: CodigoSinPermiso, Detalle: d}
	}
	return Estado{Codigo: CodigoError, Detalle: d}
}

// subcarpetas del disco montado: la de registros como la deja el sensor sin disco
// (de todos y con el bit pegajoso: el honeypot corre con su usuario), una por cada
// carpeta escribible y una por cada VOLUME de la imagen que la trampa no monta.
// Una carpeta vacía la llena Docker con lo que trae la imagen la primera vez que la
// monta (con su dueño), como un volumen.
func subcarpetas(c *carpeta, m Montaje) error {
	reg := filepath.Join(m.ID, "registros")
	if err := mkdirPlana(c.raiz, reg, 0o755); err != nil {
		return err
	}
	if err := c.raiz.Chmod(reg, 0o777|os.ModeSticky); err != nil {
		return err
	}
	// El sensor ya no es root: su carpeta de registros es suya, para poder borrar
	// los registros rotados que ya ha leído (docs/diseno/aislamiento-trampas.md).
	if os.Geteuid() == 0 {
		_ = c.raiz.Lchown(reg, UIDSensor, UIDSensor)
	}
	for i := 0; i < m.Escribibles; i++ {
		if err := mkdirPlana(c.raiz, filepath.Join(m.ID, fmt.Sprintf("escribible-%d", i)), 0o755); err != nil {
			return err
		}
	}
	for _, x := range m.Carpetas {
		if err := mkdirPlana(c.raiz, filepath.Join(m.ID, x), 0o755); err != nil {
			return err
		}
	}
	return nil
}

// migrar pasa al disco nuevo lo que la trampa tenía antes: su carpeta de registros
// de la máquina (el registro sin leer, su semilla, su certificado), que se vacía, y
// sus volúmenes escribibles (las claves de Cowrie). El sensor reconoce su registro
// por la huella aunque cambie de inodo, así que sigue leyendo por donde iba.
func (a *Auxiliar) migrar(ctx context.Context, c *carpeta, m Montaje) error {
	antes := filepath.Join("registros", m.ID)
	if fi, err := c.datos.Lstat(antes); err == nil && fi.IsDir() && !a.Montado(c.fd+"/"+antes) {
		// Solo el contenido: la carpeta se queda como la deja subcarpetas. Desde un
		// descriptor suyo, sin seguir un enlace que la sustituya.
		f, err := c.datos.Open(antes)
		if err != nil {
			return err
		}
		defer f.Close()
		if fi2, err := f.Stat(); err != nil || !os.SameFile(fi, fi2) {
			return fmt.Errorf("%s changed while it was being copied", antes)
		}
		origen := c.fd + "/" + antes
		if a.Fijar != nil {
			if origen, err = a.Fijar(f); err != nil {
				return err
			}
		}
		if err := a.copiar(ctx, c, origen, filepath.Join(m.ID, "registros")); err != nil {
			return err
		}
		if err := c.datos.RemoveAll(antes); err != nil {
			return err
		}
	}
	for _, i := range m.Viejos {
		destino := filepath.Join(m.ID, fmt.Sprintf("escribible-%d", i))
		if !vacia(c.raiz, destino) {
			continue
		}
		if err := a.copiar(ctx, c, ViejoEn(m.ID, i), destino); err != nil {
			return err
		}
		// Y el dueño y los permisos de la carpeta, que Docker copió de la imagen al volumen.
		if err := mismosAtributos(ViejoEn(m.ID, i), c.raiz, destino); err != nil {
			return err
		}
	}
	return nil
}

// copiar el contenido de una carpeta en otra (destino, dentro de la de los discos),
// con dueños, permisos, fechas y enlaces tal cual (sin seguirlos). La propia carpeta
// destino no cambia.
func (a *Auxiliar) copiar(ctx context.Context, c *carpeta, origen, destino string) error {
	fi, err := c.raiz.Lstat(destino)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a plain folder", destino)
	}
	if out, err := a.Ejecutar(ctx, "cp", "-a", origen+"/.", c.ruta(destino)+"/"); err != nil {
		return errors.New(resumen(out, err))
	}
	if err := c.raiz.Chmod(destino, fi.Mode()&(os.ModePerm|os.ModeSticky)); err != nil {
		return err
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return c.raiz.Lchown(destino, int(st.Uid), int(st.Gid))
	}
	return nil
}

// mismosAtributos: el dueño y los permisos de origen, en destino (dentro de r).
func mismosAtributos(origen string, r *os.Root, destino string) error {
	fi, err := os.Lstat(origen)
	if err != nil {
		return err
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		if err := r.Lchown(destino, int(st.Uid), int(st.Gid)); err != nil {
			return err
		}
	}
	return r.Chmod(destino, fi.Mode()&(os.ModePerm|os.ModeSticky))
}

func vacia(r *os.Root, dir string) bool {
	f, err := r.Open(dir)
	if err != nil {
		return false
	}
	defer f.Close()
	e, err := f.ReadDir(1)
	return len(e) == 0 && errors.Is(err, io.EOF)
}

// retirar el disco de una trampa que ya no está: se desmonta (en diferido: lo suelta
// cuando nadie lo usa) y se borran el fichero y su punto de montaje.
func (a *Auxiliar) retirar(ctx context.Context, c *carpeta, id string) Estado {
	dir := c.ruta(id)
	if a.Montado(dir) {
		if err := carpetaPlana(c.raiz, id); err != nil {
			return Estado{Codigo: CodigoError, Detalle: err.Error()}
		}
		if out, err := a.Ejecutar(ctx, "umount", "-c", "-l", dir); err != nil {
			return Estado{Codigo: CodigoError, Detalle: resumen(out, err)}
		}
		if a.Montado(dir) {
			return Estado{Codigo: CodigoError, Detalle: id + " is still mounted"}
		}
	}
	// Sin seguir enlaces: uno en lugar del fichero o de la carpeta se borra él solo.
	if err := c.raiz.Remove(id + ".img"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	if err := c.raiz.RemoveAll(id); err != nil {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	return Estado{}
}

func (a *Auxiliar) desmontar(ctx context.Context, dir string) {
	_, _ = a.Ejecutar(ctx, "umount", "-c", "-l", dir)
}

// probar que esta máquina puede, con un disco pequeño que no es de ninguna trampa (su
// nombre empieza por un punto, que no cabe en un id).
func (a *Auxiliar) probar(ctx context.Context, c *carpeta) Estado {
	const nombre = ".prueba"
	dir, img := c.ruta(nombre), c.ruta(nombre+".img")
	if a.Montado(dir) {
		a.desmontar(ctx, dir)
	}
	_ = c.raiz.Remove(nombre + ".img")
	defer func() {
		if a.Montado(dir) {
			a.desmontar(ctx, dir)
		}
		_ = c.raiz.Remove(nombre + ".img")
		_ = c.raiz.Remove(nombre)
	}()
	// Sin mirar el sitio libre: eso no dice nada de la máquina, y 16 MiB dispersos no ocupan.
	if e := a.formatear(ctx, c, nombre+".img", 16<<20); e.Codigo != "" {
		return e
	}
	if err := mkdirPlana(c.raiz, nombre, 0o755); err != nil {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	return a.montarEn(ctx, img, dir)
}

// resumen de lo que dijo una orden que ha fallado, sin pasar de 300 caracteres.
func resumen(out string, err error) string {
	t := strings.TrimSpace(out)
	if len(t) > 300 {
		t = "…" + t[len(t)-300:]
	}
	if t == "" {
		return err.Error()
	}
	return err.Error() + ": " + t
}

// Montado dice si en dir hay montado otro sistema de ficheros que el de su carpeta
// madre: un disco de trampa es un ext4 aparte, con su propio dispositivo.
func Montado(dir string) bool {
	fi, err := os.Lstat(dir)
	if err != nil || !fi.IsDir() {
		return false
	}
	// El padre siguiendo el enlace: puede ser la ruta fija de la carpeta (/proc/<pid>/fd/<n>).
	padre, err := os.Stat(filepath.Dir(dir))
	if err != nil {
		return false
	}
	a, ok1 := fi.Sys().(*syscall.Stat_t)
	b, ok2 := padre.Sys().(*syscall.Stat_t)
	return ok1 && ok2 && uint64(a.Dev) != uint64(b.Dev)
}

func libre(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}
