//go:build linux || darwin

package main

import "syscall"

// libreEn dice cuánto disco libre queda donde está dir (lo que puede usar
// cualquier usuario, sin la reserva de root).
func libreEn(dir string) (int64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, false
	}
	return int64(st.Bavail) * int64(st.Bsize), true
}
