package main

import (
	"slices"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/intermediario"
)

func TestLeerRegistro(t *testing.T) {
	r := `audit(1795084341.998:9): auid=4294967295 uid=0 gid=0 ses=4294967295 pid=535986 comm="runc:[2:INIT]" exe=2F6D sig=0 arch=c00000b7 syscall=56 compat=0 ip=0xaaaac3433cd0 code=0x7ffc0000`
	if arq, n, ok := Leer(r); !ok || arq != "arm64" || n != "openat" {
		t.Fatalf("%s %s %v", arq, n, ok)
	}
	r2 := `audit(1.0:1): pid=1 arch=c000003e syscall=2 compat=0 code=0x7ffc0000`
	if arq, n, ok := Leer(r2); !ok || arq != "amd64" || n != "open" {
		t.Fatalf("%s %s %v", arq, n, ok)
	}
	// Una denegación (ERRNO) no es una llamada vista.
	if _, _, ok := Leer(`arch=c000003e syscall=2 code=0x50001`); ok {
		t.Fatal("ERRNO no cuenta")
	}
}

// Cada llamada del perfil común tiene que poder traducirse: en amd64 todas, y en arm64
// todas menos las antiguas que esa arquitectura no tiene.
func TestTablasCubrenElPerfilComun(t *testing.T) {
	soloAmd64 := []string{"access", "alarm", "arch_prctl", "chmod", "chown", "creat", "dup2", "epoll_create", "epoll_wait",
		"eventfd", "fork", "futimesat", "getdents", "getpgrp", "inotify_init", "lchown", "link", "lstat", "mkdir", "open",
		"pause", "pipe", "poll", "readlink", "rename", "rmdir", "select", "signalfd", "stat", "symlink", "time", "unlink",
		"utime", "utimes", "vfork"}
	nombres := func(arq string) []string {
		var r []string
		for _, n := range llamadas[arq] {
			r = append(r, n)
		}
		return r
	}
	amd, arm := nombres("amd64"), nombres("arm64")
	for _, n := range append(intermediario.LlamadasComunes(), "clone", "socket") {
		if !slices.Contains(amd, n) {
			t.Errorf("amd64 no traduce %s", n)
		}
		if !slices.Contains(arm, n) && !slices.Contains(soloAmd64, n) {
			t.Errorf("arm64 no traduce %s", n)
		}
	}
}
