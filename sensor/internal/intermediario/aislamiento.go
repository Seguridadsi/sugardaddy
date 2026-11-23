package intermediario

import (
	"slices"
)

// Valores del hecho motor.aislamiento: con qué se aíslan las trampas en este nodo.
const (
	// gVisor: cada trampa con su propio núcleo en espacio de usuario.
	AislamientoRunsc = "runsc"
	// runc con el seccomp de Sugardaddy y el perfil AppArmor sugardaddy-trampa.
	AislamientoPerfiles = "runc-perfiles"
	// runc con el seccomp de Sugardaddy; la máquina no tiene AppArmor (o no se cargó el perfil).
	AislamientoSeccomp = "runc-seccomp"
)

// Aislamiento es lo que sd-motor aplica a cada trampa, y lo que cuenta al sensor.
type Aislamiento struct {
	// Valor: AislamientoRunsc, AislamientoPerfiles o AislamientoSeccomp (para las
	// trampas sin enlace; las de enlace van siempre en runc, ver Para).
	Valor    string `json:"valor"`
	Runsc    bool   `json:"runsc"`
	AppArmor string `json:"apparmor,omitempty"`
	// Motivo, si no es gVisor: por qué no.
	Motivo string `json:"motivo,omitempty"`
}

// Motivos (códigos estables) de que no haya gVisor.
const (
	MotivoSinRunsc = "aislamiento.sin-runsc"
	MotivoRunscNo  = "aislamiento.runsc-desactivado"
)

// Decidir el aislamiento con los runtimes que dice el motor (GET /info) y el
// perfil AppArmor que el instalador ha cargado ("" si ninguno).
func Decidir(runtimes []string, usarRunsc bool, apparmor string) Aislamiento {
	a := Aislamiento{AppArmor: apparmor}
	switch {
	case slices.Contains(runtimes, "runsc") && usarRunsc:
		a.Runsc, a.Valor = true, AislamientoRunsc
		return a
	case slices.Contains(runtimes, "runsc"):
		a.Motivo = MotivoRunscNo
	default:
		a.Motivo = MotivoSinRunsc
	}
	a.Valor = AislamientoSeccomp
	if apparmor != "" {
		a.Valor = AislamientoPerfiles
	}
	return a
}

// Endurecer añade a la creación de una trampa lo que decide sd-motor: gVisor si
// lo hay (salvo las trampas de enlace, cuyo acompañante tiene que compartir su
// espacio de red, que en gVisor es el del propio sandbox), y si no el seccomp de
// Sugardaddy y su perfil AppArmor. Devuelve con qué ha quedado.
func (a Aislamiento) Endurecer(cfg map[string]any, enlace bool) string {
	return a.EndurecerCon(cfg, enlace, PerfilSeccomp())
}

// EndurecerCon es Endurecer con un perfil seccomp dado (el de la trampa, de
// PerfilSeccompPara, o el de observar en el banco). Con gVisor no se pone ninguno
// (decisión A, docs/diseno/aislamiento-trampas.md §4).
func (a Aislamiento) EndurecerCon(cfg map[string]any, enlace bool, perfil string) string {
	h := cfg["HostConfig"].(map[string]any)
	if a.Runsc && !enlace {
		h["Runtime"] = "runsc"
		return AislamientoRunsc
	}
	opts := lista(h["SecurityOpt"])
	opts = append(opts, "seccomp="+perfil)
	valor := AislamientoSeccomp
	if a.AppArmor != "" {
		opts = append(opts, "apparmor="+a.AppArmor)
		valor = AislamientoPerfiles
	}
	h["SecurityOpt"] = opts
	return valor
}

// Las llamadas al sistema que una trampa puede hacer: la lista del perfil por
// defecto de Docker (Apache-2.0) sin lo que una trampa no necesita y sirve para
// escapar o espiar: ptrace y process_vm_*, personality, mknod, name_to_handle_at,
// io_uring, userfaultfd, bpf, perf, keyctl, mount/umount/pivot_root/chroot,
// unshare/setns y los módulos del núcleo. clone solo sin crear espacios de nombres
// y socket sin AF_PACKET. Lo demás contesta EPERM (clone3, ENOSYS: así la libc
// vuelve a clone, que sí está filtrado).
var llamadasPermitidas = []string{
	"accept", "accept4", "access", "adjtimex", "alarm", "bind", "brk", "cachestat", "capget", "capset",
	"chdir", "chmod", "chown", "clock_adjtime", "clock_getres", "clock_gettime", "clock_nanosleep",
	"close", "close_range", "connect", "copy_file_range", "creat", "dup", "dup2", "dup3",
	"epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_pwait2", "epoll_wait",
	"eventfd", "eventfd2", "execve", "execveat", "exit", "exit_group", "faccessat", "faccessat2",
	"fadvise64", "fallocate", "fchdir", "fchmod", "fchmodat", "fchmodat2", "fchown", "fchownat",
	"fcntl", "fdatasync", "fgetxattr", "flistxattr", "flock", "fork", "fremovexattr", "fsetxattr",
	"fstat", "fstatfs", "fsync", "ftruncate", "futex", "futex_requeue", "futex_wait", "futex_waitv",
	"futex_wake", "futimesat", "getcpu", "getcwd", "getdents", "getdents64", "getegid", "geteuid",
	"getgid", "getgroups", "getitimer", "getpeername", "getpgid", "getpgrp", "getpid", "getppid",
	"getpriority", "getrandom", "getresgid", "getresuid", "getrlimit", "get_robust_list", "getrusage",
	"getsid", "getsockname", "getsockopt", "gettid", "gettimeofday", "getuid", "getxattr",
	"inotify_add_watch", "inotify_init", "inotify_init1", "inotify_rm_watch", "io_cancel", "ioctl",
	"io_destroy", "io_getevents", "io_pgetevents", "ioprio_get", "ioprio_set", "io_setup", "io_submit",
	"kill", "lchown", "lgetxattr", "link", "linkat", "listen", "listxattr", "llistxattr", "lremovexattr",
	"lseek", "lsetxattr", "lstat", "madvise", "membarrier", "memfd_create", "mincore", "mkdir",
	"mkdirat", "mlock", "mlock2", "mlockall", "mmap", "mprotect", "mq_getsetattr", "mq_notify",
	"mq_open", "mq_timedreceive", "mq_timedsend", "mq_unlink", "mremap", "msgctl", "msgget", "msgrcv",
	"msgsnd", "msync", "munlock", "munlockall", "munmap", "nanosleep", "newfstatat", "open", "openat",
	"openat2", "pause", "pidfd_open", "pidfd_send_signal", "pipe", "pipe2", "poll", "ppoll", "prctl",
	"pread64", "preadv", "preadv2", "prlimit64", "pselect6", "pwrite64", "pwritev", "pwritev2", "read",
	"readahead", "readlink", "readlinkat", "readv", "recvfrom", "recvmmsg", "recvmsg", "removexattr",
	"rename", "renameat", "renameat2", "restart_syscall", "rmdir", "rseq", "rt_sigaction",
	"rt_sigpending", "rt_sigprocmask", "rt_sigqueueinfo", "rt_sigreturn", "rt_sigsuspend",
	"rt_sigtimedwait", "rt_tgsigqueueinfo", "sched_getaffinity", "sched_getattr", "sched_getparam",
	"sched_get_priority_max", "sched_get_priority_min", "sched_getscheduler", "sched_rr_get_interval",
	"sched_setaffinity", "sched_setattr", "sched_setparam", "sched_setscheduler", "sched_yield",
	"seccomp", "select", "semctl", "semget", "semop", "semtimedop", "sendfile", "sendmmsg", "sendmsg",
	"sendto", "setfsgid", "setfsuid", "setgid", "setgroups", "setitimer", "setpgid", "setpriority",
	"setregid", "setresgid", "setresuid", "setreuid", "setrlimit", "set_robust_list", "setsid",
	"setsockopt", "set_tid_address", "setuid", "setxattr", "shmat", "shmctl", "shmdt", "shmget",
	"shutdown", "sigaltstack", "signalfd", "signalfd4", "socketpair", "splice", "stat", "statfs",
	"statx", "symlink", "symlinkat", "sync", "sync_file_range", "syncfs", "sysinfo", "tee", "tgkill",
	"time", "timer_create", "timer_delete", "timer_getoverrun", "timer_gettime", "timer_settime",
	"timerfd_create", "timerfd_gettime", "timerfd_settime", "times", "tkill", "truncate", "umask",
	"uname", "unlink", "unlinkat", "utime", "utimensat", "utimes", "vfork", "vmsplice", "wait4",
	"waitid", "write", "writev",
	// Solo amd64 (en arm64 no existen y runc las ignora).
	"arch_prctl",
}

// Banderas de clone que crean espacios de nombres (CLONE_NEWNS, NEWCGROUP, NEWUTS,
// NEWIPC, NEWUSER, NEWPID, NEWNET): con alguna, clone no pasa.
const banderasNamespace = 0x7E020000

// afPacket: AF_PACKET (linux/socket.h).
const afPacket = 17

// PerfilSeccomp es el perfil común de las trampas en el formato de Docker, en
// JSON: el respaldo de las que no traen lista propia en la versión firmada.
func PerfilSeccomp() string {
	return perfil(llamadasPermitidas, true, true, nil)
}
