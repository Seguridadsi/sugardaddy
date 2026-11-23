// observarseccomp escucha los registros de auditoría SECCOMP del núcleo y dice qué
// llamadas al sistema ha apuntado una trampa con el perfil de observar de sd-motor
// (SCMP_ACT_LOG, docs/diseno/aislamiento-trampas.md §4c). Solo para el banco
// (herramientas/observar-seccomp.sh): corre en un contenedor con la red de la máquina
// y CAP_AUDIT_READ, y se une al grupo de solo lectura del netlink de auditoría
// (AUDIT_NLGRP_READLOG): no le quita nada al auditd de la máquina, si lo hay, y no
// sufre el tope de mensajes por segundo del registro del núcleo (dmesg).
//
// Si no puede (OrbStack y otros que meten Docker en un espacio de red propio), lee
// /dev/kmsg desde un contenedor privilegiado. Al recibir SIGTERM o SIGINT escribe en
// la salida estándar {"llamadas": {"<arq>": ["llamada", …]}, "perdidos": …} con lo
// visto, ordenado; «perdidos» dice que el núcleo se ha callado registros y hace falta
// otra ronda con lo visto ya permitido.
package main

import (
	"regexp"
	"strconv"
)

const (
	netlinkAudit    = 9    // NETLINK_AUDIT
	auditSeccomp    = 1326 // AUDIT_SECCOMP
	grupoReadlog    = 1    // AUDIT_NLGRP_READLOG
	codigoRetLog    = "0x7ffc0000"
	arquitecturaX86 = "c000003e"
	arquitecturaArm = "c00000b7"
)

var (
	campoArch    = regexp.MustCompile(`\barch=([0-9a-f]+)`)
	campoSyscall = regexp.MustCompile(`\bsyscall=([0-9]+)`)
	campoCode    = regexp.MustCompile(`\bcode=(0x[0-9a-f]+)`)
)

// Leer saca de un registro AUDIT_SECCOMP la arquitectura y el nombre de la llamada, si
// es de SCMP_ACT_LOG.
func Leer(texto string) (arq, nombre string, ok bool) {
	c := campoCode.FindStringSubmatch(texto)
	a := campoArch.FindStringSubmatch(texto)
	s := campoSyscall.FindStringSubmatch(texto)
	if c == nil || a == nil || s == nil || c[1] != codigoRetLog {
		return "", "", false
	}
	switch a[1] {
	case arquitecturaX86:
		arq = "amd64"
	case arquitecturaArm:
		arq = "arm64"
	default:
		return "", "", false
	}
	n, _ := strconv.Atoi(s[1])
	nombre, ok = llamadas[arq][n]
	if !ok {
		nombre = "#" + s[1]
	}
	return arq, nombre, true
}
