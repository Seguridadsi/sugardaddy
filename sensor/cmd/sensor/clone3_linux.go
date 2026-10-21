package main

import "syscall"

// sysClone3: clone3 tiene el mismo número, 435, en todas las arquitecturas
// de Linux (amd64, arm64, arm, 386…).
const sysClone3 = 435

// llamarClone3 llama a clone3(NULL, 0): el núcleo lo rechaza con EINVAL
// antes de hacer nada, y un perfil seccomp lo para antes que el núcleo.
func llamarClone3() syscall.Errno {
	_, _, e := syscall.RawSyscall(sysClone3, 0, 0, 0)
	return e
}
