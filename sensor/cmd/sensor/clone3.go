package main

import (
	"fmt"
	"runtime"
	"syscall"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/motor"
)

// Lo que se espera a que vuelva clone3: si no vuelve, el perfil seccomp ha
// matado el hilo que la llamó.
const esperaClone3 = 5 * time.Second

// probarClone3 es la sonda de clone3 (ver motor.Clone3): llama a clone3 con
// argumentos que no valen, así que nunca crea nada. Si el núcleo contesta
// (EINVAL) o el motor la rechaza con ENOSYS, glibc 2.34 o posterior crea sus
// hilos sin problema; si el perfil seccomp contesta EPERM, o mata el hilo,
// no puede.
func probarClone3() int {
	r := make(chan syscall.Errno, 1)
	go func() {
		// En su propio hilo: si el perfil lo mata, el resto del programa
		// sigue y lo puede decir.
		runtime.LockOSThread()
		r <- llamarClone3()
	}()
	select {
	case e := <-r:
		fmt.Println("clone3:", e.Error())
		return salidaClone3(e)
	case <-time.After(esperaClone3):
		fmt.Println("clone3: el perfil seccomp ha matado el hilo")
		return motor.SalidaClone3Bloqueado
	}
}

func salidaClone3(e syscall.Errno) int {
	if e == syscall.EPERM || e == syscall.EACCES {
		return motor.SalidaClone3Bloqueado
	}
	return motor.SalidaClone3Disponible
}
