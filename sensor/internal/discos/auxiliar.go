package discos

// Lo que hace el auxiliar (orden «disco» del actualizador): crear, comprobar,
// montar y retirar los discos de las trampas. Corre en un contenedor privilegiado
// de un solo uso, con la carpeta del sensor montada en la misma ruta y con
// propagación rshared (lo que monta aquí llega a la máquina) y /dev de la máquina
// (los dispositivos loop que se crean al montar).

import (
	"context"
	"errors"
	"fmt"
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
}

// NuevoAuxiliar es el de verdad.
func NuevoAuxiliar() *Auxiliar {
	return &Auxiliar{Ejecutar: Exec, Montado: Montado, Libre: libre, LoopControl: "/dev/loop-control", Reserva: 1 << 30,
		Herramientas: []string{"mkfs.ext4", "e2fsck", "mount", "umount", "losetup", "cp"}}
}

// Aplicar hace lo que pide p y dice cómo ha quedado cada disco. Nunca a medias: un
// disco que no se puede montar entero (con sus carpetas y lo que tenía antes) se
// desmonta y, si era nuevo, se borra.
func (a *Auxiliar) Aplicar(ctx context.Context, p Pedido) Resultado {
	if err := p.Validar(); err != nil {
		return Resultado{Codigo: CodigoError, Detalle: err.Error()}
	}
	r := Resultado{Discos: map[string]Estado{}}
	// Primero lo que sale: deja sitio y no necesita dispositivos loop.
	for _, id := range p.Retirar {
		r.Discos[id] = a.retirar(ctx, p.Datos, id)
	}
	if len(p.Montar) == 0 && !p.Probar {
		return r
	}
	todos := func(e Estado) Resultado {
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
	if err := os.MkdirAll(filepath.Join(p.Datos, Carpeta), 0o700); err != nil {
		return todos(Estado{Codigo: CodigoError, Detalle: "the disks folder: " + err.Error()})
	}
	if e := a.hayLoop(); e.Codigo != "" {
		return todos(e)
	}
	if p.Probar {
		if e := a.probar(ctx, p.Datos); e.Codigo != "" {
			if !DeLaMaquina(e.Codigo) {
				e.Codigo = CodigoError
			}
			return todos(e)
		}
	}
	for i, m := range p.Montar {
		e := a.montar(ctx, p, m)
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

func (a *Auxiliar) montar(ctx context.Context, p Pedido, m Montaje) Estado {
	dir, img := Dir(p.Datos, m.ID), Fichero(p.Datos, m.ID)
	if a.Montado(dir) {
		if err := subcarpetas(p.Datos, m); err != nil {
			return Estado{Codigo: CodigoError, Detalle: "preparing its folders: " + err.Error()}
		}
		return Estado{}
	}
	nuevo := false
	fi, err := os.Lstat(img)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if e := a.crear(ctx, img, int64(p.TamMb)<<20); e.Codigo != "" {
			return e
		}
		nuevo = true
	case err != nil:
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	case !fi.Mode().IsRegular():
		return Estado{Codigo: CodigoError, Detalle: img + " is not a regular file"}
	default:
		if e := a.comprobar(ctx, img); e.Codigo != "" {
			return e
		}
	}
	quitar := func() {
		if nuevo {
			_ = os.Remove(img)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		quitar()
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	if out, err := a.Ejecutar(ctx, "mount", "-t", "ext4", "-o", opcionesMontaje, img, dir); err != nil {
		quitar()
		return clasificarMontaje(out, err)
	}
	if err := subcarpetas(p.Datos, m); err != nil {
		a.desmontar(ctx, dir)
		quitar()
		return Estado{Codigo: CodigoError, Detalle: "preparing its folders: " + err.Error()}
	}
	if nuevo {
		if err := a.migrar(ctx, p.Datos, m); err != nil {
			a.desmontar(ctx, dir)
			quitar()
			return Estado{Codigo: CodigoError, Detalle: "could not move its current files into the disk: " + err.Error()}
		}
	}
	return Estado{Nuevo: nuevo}
}

// Sin programas ni dispositivos ni setuid: en el disco solo hay registros y estado.
const opcionesMontaje = "loop,nosuid,nodev,noexec"

// crear hace el fichero disperso y su sistema de ficheros. En la máquina solo ocupa
// lo que se escribe, así que tiene que quedar sitio para que la trampa lo llene.
func (a *Auxiliar) crear(ctx context.Context, img string, tam int64) Estado {
	if libre, err := a.Libre(filepath.Dir(img)); err == nil && libre < tam+a.Reserva {
		return Estado{Codigo: CodigoSinEspacio, Detalle: fmt.Sprintf(
			"%d MiB free on the sensor's disk; the decoy disk needs %d MiB and %d MiB must stay free", libre>>20, tam>>20, a.Reserva>>20)}
	}
	return a.formatear(ctx, img, tam)
}

// formatear crea el fichero disperso de ese tamaño con su ext4.
func (a *Auxiliar) formatear(ctx context.Context, img string, tam int64) Estado {
	f, err := os.OpenFile(img, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	err = f.Truncate(tam)
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		_ = os.Remove(img)
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	if out, err := a.Ejecutar(ctx, "mkfs.ext4", argumentosMkfs(img)...); err != nil {
		_ = os.Remove(img)
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
func subcarpetas(datos string, m Montaje) error {
	reg := Registros(datos, m.ID)
	if err := os.MkdirAll(reg, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(reg, 0o777|os.ModeSticky); err != nil {
		return err
	}
	for i := 0; i < m.Escribibles; i++ {
		if err := os.Mkdir(Escribible(datos, m.ID, i), 0o755); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
	}
	for _, c := range m.Carpetas {
		if err := os.Mkdir(filepath.Join(Dir(datos, m.ID), c), 0o755); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
	}
	return nil
}

// migrar pasa al disco nuevo lo que la trampa tenía antes: su carpeta de registros
// de la máquina (el registro sin leer, su semilla, su certificado), que se vacía, y
// sus volúmenes escribibles (las claves de Cowrie). El sensor reconoce su registro
// por la huella aunque cambie de inodo, así que sigue leyendo por donde iba.
func (a *Auxiliar) migrar(ctx context.Context, datos string, m Montaje) error {
	antes := filepath.Join(datos, "registros", m.ID)
	if fi, err := os.Lstat(antes); err == nil && fi.IsDir() && !a.Montado(antes) {
		// Solo el contenido: la carpeta se queda como la deja subcarpetas.
		if err := a.copiar(ctx, antes, Registros(datos, m.ID)); err != nil {
			return err
		}
		if err := os.RemoveAll(antes); err != nil {
			return err
		}
	}
	for _, i := range m.Viejos {
		destino := Escribible(datos, m.ID, i)
		if !vacia(destino) {
			continue
		}
		if err := a.copiar(ctx, ViejoEn(m.ID, i), destino); err != nil {
			return err
		}
		// Y el dueño y los permisos de la carpeta, que Docker copió de la imagen al volumen.
		if err := mismosAtributos(ViejoEn(m.ID, i), destino); err != nil {
			return err
		}
	}
	return nil
}

// copiar el contenido de una carpeta en otra, con dueños, permisos, fechas y enlaces
// tal cual (sin seguirlos). La propia carpeta destino no cambia.
func (a *Auxiliar) copiar(ctx context.Context, origen, destino string) error {
	fi, err := os.Lstat(destino)
	if err != nil {
		return err
	}
	if out, err := a.Ejecutar(ctx, "cp", "-a", origen+"/.", destino+"/"); err != nil {
		return errors.New(resumen(out, err))
	}
	if err := os.Chmod(destino, fi.Mode()&(os.ModePerm|os.ModeSticky)); err != nil {
		return err
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return os.Lchown(destino, int(st.Uid), int(st.Gid))
	}
	return nil
}

// mismosAtributos: el dueño y los permisos de origen, en destino.
func mismosAtributos(origen, destino string) error {
	fi, err := os.Lstat(origen)
	if err != nil {
		return err
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		if err := os.Lchown(destino, int(st.Uid), int(st.Gid)); err != nil {
			return err
		}
	}
	return os.Chmod(destino, fi.Mode()&(os.ModePerm|os.ModeSticky))
}

func vacia(dir string) bool {
	e, err := os.ReadDir(dir)
	return err == nil && len(e) == 0
}

// retirar el disco de una trampa que ya no está: se desmonta (en diferido: lo suelta
// cuando nadie lo usa) y se borran el fichero y su punto de montaje.
func (a *Auxiliar) retirar(ctx context.Context, datos, id string) Estado {
	dir, img := Dir(datos, id), Fichero(datos, id)
	if a.Montado(dir) {
		if out, err := a.Ejecutar(ctx, "umount", "-l", dir); err != nil {
			return Estado{Codigo: CodigoError, Detalle: resumen(out, err)}
		}
		if a.Montado(dir) {
			return Estado{Codigo: CodigoError, Detalle: dir + " is still mounted"}
		}
	}
	if err := os.Remove(img); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	if err := os.RemoveAll(dir); err != nil {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	return Estado{}
}

func (a *Auxiliar) desmontar(ctx context.Context, dir string) {
	_, _ = a.Ejecutar(ctx, "umount", "-l", dir)
}

// probar que esta máquina puede, con un disco pequeño que no es de ninguna trampa (su
// nombre empieza por un punto, que no cabe en un id).
func (a *Auxiliar) probar(ctx context.Context, datos string) Estado {
	dir := filepath.Join(datos, Carpeta, ".prueba")
	img := dir + ".img"
	if a.Montado(dir) {
		a.desmontar(ctx, dir)
	}
	_ = os.Remove(img)
	defer func() {
		if a.Montado(dir) {
			a.desmontar(ctx, dir)
		}
		_ = os.Remove(img)
		_ = os.Remove(dir)
	}()
	// Sin mirar el sitio libre: eso no dice nada de la máquina, y 16 MiB dispersos no ocupan.
	if e := a.formatear(ctx, img, 16<<20); e.Codigo != "" {
		return e
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Estado{Codigo: CodigoError, Detalle: err.Error()}
	}
	if out, err := a.Ejecutar(ctx, "mount", "-t", "ext4", "-o", opcionesMontaje, img, dir); err != nil {
		return clasificarMontaje(out, err)
	}
	return Estado{}
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
	padre, err := os.Lstat(filepath.Dir(dir))
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
