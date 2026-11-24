//go:build linux || darwin

package salud

import "syscall"

// disco: el tamaño del sistema de ficheros de dir y lo que queda libre para
// cualquiera (sin la reserva de root).
func disco(dir string) *Capacidad {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil || st.Blocks == 0 {
		return nil
	}
	bs := int64(st.Bsize)
	return &Capacidad{Total: int64(st.Blocks) * bs, Libre: int64(st.Bavail) * bs}
}
