package intermediario

import (
	"encoding/json"
	"regexp"
	"slices"
)

// Seccomp por trampa (docs/diseno/aislamiento-trampas.md §4c). La versión firmada
// trae, por módulo y arquitectura, las llamadas que se le vieron a la trampa en el
// banco (herramientas/observar-seccomp.sh). sd-motor se queda con las que además
// están en el perfil común: la lista solo puede estrechar, nunca abrir lo que el
// común cierra, venga de donde venga. Sin lista para esa trampa y esa
// arquitectura, el perfil común.

// llamadasSiempre: lo que cualquier proceso puede necesitar en un camino raro que
// el banco no recorre (una señal, salir, esperar, memoria). Se añaden a la lista
// observada si el perfil común las deja.
var llamadasSiempre = []string{
	"brk", "clock_gettime", "clock_nanosleep", "close", "exit", "exit_group", "futex",
	"getpid", "gettid", "madvise", "mmap", "mprotect", "munmap", "nanosleep", "restart_syscall",
	"rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "sched_yield", "sigaltstack", "tgkill",
}

var nombreLlamada = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)

// LlamadasValidas dice si una lista de la versión firmada tiene buena forma.
func LlamadasValidas(l []string) bool {
	if len(l) == 0 || len(l) > 400 {
		return false
	}
	for _, n := range l {
		if !nombreLlamada.MatchString(n) {
			return false
		}
	}
	return true
}

// PerfilSeccompPara da el perfil de una trampa con su lista observada (nil o mal
// formada: el común) y si ha quedado propio.
func PerfilSeccompPara(observadas []string) (string, bool) {
	if !LlamadasValidas(observadas) {
		return PerfilSeccomp(), false
	}
	quiere := func(n string) bool { return slices.Contains(observadas, n) || slices.Contains(llamadasSiempre, n) }
	var permitidas []string
	for _, n := range llamadasPermitidas {
		if quiere(n) {
			permitidas = append(permitidas, n)
		}
	}
	return perfil(permitidas, quiere("clone"), quiere("socket"), nil), true
}

// PerfilObservacion es el del banco: lo mismo que el común, pero cada llamada que
// el común deja se apunta en el registro del núcleo (SCMP_ACT_LOG) en vez de pasar
// en silencio, salvo las ya vistas. Lo que el común cierra sigue cerrado: la lista
// que sale nunca es más ancha que él.
func PerfilObservacion(vistas []string) string {
	return perfil(llamadasPermitidas, true, true, vistas)
}

// perfil arma el JSON de Docker: permitidas (y clone y socket, con su filtro de
// argumentos, si se piden). Con observar != nil, las que no están en observar van
// con SCMP_ACT_LOG.
func perfil(permitidas []string, clone, socket bool, observar []string) string {
	type arg struct {
		Index    int    `json:"index"`
		Value    uint64 `json:"value"`
		ValueTwo uint64 `json:"valueTwo"`
		Op       string `json:"op"`
	}
	type regla struct {
		Names    []string `json:"names"`
		Action   string   `json:"action"`
		Args     []arg    `json:"args,omitempty"`
		ErrnoRet *int     `json:"errnoRet,omitempty"`
	}
	accion := func(n string) string {
		if observar != nil && !slices.Contains(observar, n) {
			return "SCMP_ACT_LOG"
		}
		return "SCMP_ACT_ALLOW"
	}
	var reglas []regla
	porAccion := map[string][]string{}
	for _, n := range permitidas {
		porAccion[accion(n)] = append(porAccion[accion(n)], n)
	}
	for _, a := range []string{"SCMP_ACT_ALLOW", "SCMP_ACT_LOG"} {
		if len(porAccion[a]) > 0 {
			reglas = append(reglas, regla{Names: porAccion[a], Action: a})
		}
	}
	if clone {
		reglas = append(reglas, regla{Names: []string{"clone"}, Action: accion("clone"), Args: []arg{{Index: 0, Value: banderasNamespace, ValueTwo: 0, Op: "SCMP_CMP_MASKED_EQ"}}})
	}
	if socket {
		reglas = append(reglas, regla{Names: []string{"socket"}, Action: accion("socket"), Args: []arg{{Index: 0, Value: afPacket, Op: "SCMP_CMP_NE"}}})
	}
	enosys := 38
	reglas = append(reglas, regla{Names: []string{"clone3"}, Action: "SCMP_ACT_ERRNO", ErrnoRet: &enosys})
	p := map[string]any{
		"defaultAction":   "SCMP_ACT_ERRNO",
		"defaultErrnoRet": 1,
		// Solo la arquitectura nativa: ni binarios de 32 bits ni socketcall, que
		// se saltarían el filtro de socket.
		"archMap": []map[string]any{
			{"architecture": "SCMP_ARCH_X86_64"},
			{"architecture": "SCMP_ARCH_AARCH64"},
		},
		"syscalls": reglas,
	}
	b, _ := json.Marshal(p)
	return string(b)
}

// LlamadasComunes: las del perfil común (sin clone ni socket, que van con filtro).
func LlamadasComunes() []string { return slices.Clone(llamadasPermitidas) }
