//go:build linux

package discos

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// rutaFija de una carpeta abierta: la de su descriptor en /proc, que lleva siempre a
// ella aunque la muevan o pongan un enlace en su sitio. Con el pid y no «self»: la
// usan también las órdenes que lanza el auxiliar. Sin /proc no se fija (falla cerrado).
func rutaFija(f *os.File) (string, error) {
	r := fmt.Sprintf("/proc/%d/fd/%d", os.Getpid(), f.Fd())
	a, err := os.Stat(r)
	if err != nil {
		return "", fmt.Errorf("cannot pin %s: %w", f.Name(), err)
	}
	b, err := f.Stat()
	if err != nil || !os.SameFile(a, b) {
		return "", fmt.Errorf("cannot pin %s", f.Name())
	}
	return r, nil
}

// respaldoDe comprueba que lo montado en dir es un dispositivo loop cuyo fichero es img
// (mismo inodo y mismo dispositivo): mount busca el fichero por su ruta real, que el
// sensor podría cambiar entre medias.
func (a *Auxiliar) respaldoDe(ctx context.Context, dir, img string) error {
	d, err := os.Stat(dir)
	if err != nil {
		return err
	}
	i, err := os.Lstat(img)
	if err != nil {
		return err
	}
	sd, ok1 := d.Sys().(*syscall.Stat_t)
	si, ok2 := i.Sys().(*syscall.Stat_t)
	if !ok1 || !ok2 || !i.Mode().IsRegular() {
		return fmt.Errorf("cannot read %s", img)
	}
	if mayor(uint64(sd.Dev)) != 7 {
		return fmt.Errorf("%s is not on a loop device", dir)
	}
	dev := fmt.Sprintf("/dev/loop%d", menor(uint64(sd.Dev)))
	out, err := a.Ejecutar(ctx, "losetup", "-n", "-O", "BACK-INO,BACK-MAJ:MIN", dev)
	if err != nil {
		return fmt.Errorf("%s", resumen(out, err))
	}
	c := strings.Fields(out)
	quiere := []string{strconv.FormatUint(uint64(si.Ino), 10), fmt.Sprintf("%d:%d", mayor(uint64(si.Dev)), menor(uint64(si.Dev)))}
	if len(c) != 2 || c[0] != quiere[0] || c[1] != quiere[1] {
		return fmt.Errorf("%s holds %q, not %s", dev, strings.TrimSpace(out), strings.Join(quiere, " "))
	}
	return nil
}

// mayor y menor de un dev_t de Linux (como gnu_dev_major y gnu_dev_minor).
func mayor(d uint64) uint64 { return (d>>8)&0xfff | (d>>32)&^uint64(0xfff) }
func menor(d uint64) uint64 { return d&0xff | (d>>12)&^uint64(0xff) }
