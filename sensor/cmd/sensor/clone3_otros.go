//go:build !linux

package main

import "syscall"

// Fuera de Linux no hay clone3: la sonda solo corre en un contenedor.
func llamarClone3() syscall.Errno { return syscall.ENOSYS }
