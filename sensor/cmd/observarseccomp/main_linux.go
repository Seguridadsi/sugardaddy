//go:build linux

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"syscall"
)

// observador junta lo visto por las dos vías: el grupo de lectura del netlink de
// auditoría (completo, pero solo desde el espacio de red inicial de la máquina) y
// /dev/kmsg (desde cualquier contenedor privilegiado, pero el núcleo deja pasar unos
// diez registros cada cinco segundos: por eso observar-seccomp.sh repite rondas).
type observador struct {
	mu       sync.Mutex
	vistas   map[string]map[string]bool
	perdidos bool
	vias     []string
}

func (o *observador) apuntar(texto string) {
	arq, nombre, ok := Leer(texto)
	if !ok {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.vistas[arq] == nil {
		o.vistas[arq] = map[string]bool{}
	}
	if !o.vistas[arq][nombre] {
		o.vistas[arq][nombre] = true
		fmt.Fprintln(os.Stderr, "vista:", arq, nombre)
	}
}

func (o *observador) perdida(por string) {
	o.mu.Lock()
	if !o.perdidos {
		fmt.Fprintln(os.Stderr, "observarseccomp: se han perdido registros ("+por+"): hará falta otra ronda")
	}
	o.perdidos = true
	o.mu.Unlock()
}

func (o *observador) netlink() error {
	fd, err := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, netlinkAudit)
	if err != nil {
		return err
	}
	if err := syscall.Bind(fd, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK, Groups: grupoReadlog}); err != nil {
		syscall.Close(fd)
		return err
	}
	go func() {
		buf := make([]byte, 1<<16)
		for {
			n, _, err := syscall.Recvfrom(fd, buf, 0)
			if err == syscall.ENOBUFS {
				o.perdida("netlink ENOBUFS")
				continue
			}
			if err != nil {
				if err != syscall.EINTR {
					return
				}
				continue
			}
			msgs, err := syscall.ParseNetlinkMessage(buf[:n])
			if err != nil {
				continue
			}
			for _, m := range msgs {
				if m.Header.Type == auditSeccomp {
					o.apuntar(string(m.Data))
				}
			}
		}
	}()
	return nil
}

func (o *observador) kmsg() error {
	f, err := os.Open("/dev/kmsg")
	if err != nil {
		return err
	}
	// Solo lo de ahora en adelante.
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return err
	}
	go func() {
		r := bufio.NewReaderSize(f, 1<<16)
		for {
			linea, err := r.ReadString('\n')
			if err != nil {
				// EPIPE: el anillo ha dado la vuelta y se ha perdido algo.
				if err == syscall.EPIPE || strings.Contains(err.Error(), "broken pipe") {
					o.perdida("kmsg")
					continue
				}
				return
			}
			switch {
			case strings.Contains(linea, "type=1326"):
				o.apuntar(linea)
			case strings.Contains(linea, "callbacks suppressed"), strings.Contains(linea, "printk limit exceeded"),
				strings.Contains(linea, "audit_lost"):
				o.perdida("tope del registro del núcleo")
			}
		}
	}()
	return nil
}

// topeKmsg: kernel.printk_ratelimit. El núcleo pasa a dmesg los registros de auditoría
// sin auditd con ese tope (10 cada 5 s): para observar se pone a 0 y al terminar se
// deja como estaba. Es de toda la máquina: solo en la del banco.
const topeKmsg = "/proc/sys/kernel/printk_ratelimit"

func quitarTope() (restaurar func()) {
	antes, err := os.ReadFile(topeKmsg)
	if err != nil {
		return func() {}
	}
	if err := os.WriteFile(topeKmsg, []byte("0\n"), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "observarseccomp: no puedo quitar el tope de dmesg (harán falta más rondas):", err)
		return func() {}
	}
	return func() { _ = os.WriteFile(topeKmsg, antes, 0o644) }
}

func main() {
	o := &observador{vistas: map[string]map[string]bool{}}
	restaurar := quitarTope()
	defer restaurar()
	if err := o.netlink(); err == nil {
		o.vias = append(o.vias, "netlink")
	} else {
		fmt.Fprintln(os.Stderr, "observarseccomp: sin el grupo de auditoría:", err)
	}
	if err := o.kmsg(); err == nil {
		o.vias = append(o.vias, "kmsg")
	} else {
		fmt.Fprintln(os.Stderr, "observarseccomp: sin /dev/kmsg:", err)
	}
	if len(o.vias) == 0 {
		fmt.Fprintln(os.Stderr, "observarseccomp: no puede leer los registros del núcleo (hace falta la red de la máquina con CAP_AUDIT_READ, o un contenedor privilegiado)")
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "observarseccomp: escuchando por", strings.Join(o.vias, " y "))
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	o.mu.Lock()
	defer o.mu.Unlock()
	salida := struct {
		Llamadas map[string][]string `json:"llamadas"`
		Perdidos bool                `json:"perdidos"`
		Vias     []string            `json:"vias"`
	}{Llamadas: map[string][]string{}, Perdidos: o.perdidos, Vias: o.vias}
	for arq, m := range o.vistas {
		for n := range m {
			salida.Llamadas[arq] = append(salida.Llamadas[arq], n)
		}
		slices.Sort(salida.Llamadas[arq])
	}
	_ = json.NewEncoder(os.Stdout).Encode(salida)
}
