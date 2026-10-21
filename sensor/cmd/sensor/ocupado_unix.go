//go:build unix

package main

import (
	"os"
	"syscall"
)

// ocupado es lo que un fichero ocupa de verdad en el disco (un fichero
// perforado o disperso ocupa menos que su tamaño).
func ocupado(fi os.FileInfo) int64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int64(st.Blocks) * 512
	}
	return fi.Size()
}
