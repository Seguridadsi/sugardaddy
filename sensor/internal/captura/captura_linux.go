//go:build linux

package captura

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

const (
	soAdjuntarFiltro  = 0x1a // SO_ATTACH_FILTER
	soCandadoFiltro   = 0x2c // SO_LOCK_FILTER
	agregarAfiliacion = 1    // PACKET_ADD_MEMBERSHIP
	promiscuo         = 1    // PACKET_MR_PROMISC
)

func htons(v uint16) uint16 { return v<<8 | v>>8 }

// Main: `captura <BPF>`.
func Main(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: captura <BPF in SD_RED_BPF format>")
		return 2
	}
	ins, err := DecodificarBPF(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	ifz, err := interfazDeLaTrampa()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fd, err := abrir(ifz, ins)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ln, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: Enlace, Net: "unixpacket"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "link socket:", err)
		return 1
	}
	slog.Info("capture companion ready", "interfaz", ifz.Name)
	var mu sync.Mutex
	var actual *net.UnixConn
	// Del segmento a la trampa (a la conexión de ahora; sin ella, se descarta).
	go func() {
		buf := make([]byte, 65536)
		for {
			n, _, err := syscall.Recvfrom(fd, buf, 0)
			if err != nil {
				slog.Error("capture", "err", err)
				os.Exit(1)
			}
			mu.Lock()
			c := actual
			mu.Unlock()
			if c != nil {
				_, _ = c.Write(buf[:n])
			}
		}
	}()
	ll := syscall.SockaddrLinklayer{Protocol: htons(syscall.ETH_P_ALL), Ifindex: ifz.Index}
	for {
		c, err := ln.AcceptUnix()
		if err != nil {
			slog.Error("link socket", "err", err)
			return 1
		}
		mu.Lock()
		if actual != nil {
			actual.Close()
		}
		actual = c
		mu.Unlock()
		go func(c *net.UnixConn) {
			buf := make([]byte, 2048)
			descartadas := 0
			for {
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				if err := TramaPermitida(buf[:n], ifz.HardwareAddr); err != nil {
					if descartadas++; descartadas%1000 == 1 {
						slog.Warn("frame from the decoy not sent", "motivo", err.Error(), "descartadas", descartadas)
					}
					continue
				}
				_ = syscall.Sendto(fd, buf[:n], 0, &ll)
			}
		}(c)
	}
}

// abrir el enchufe crudo: el BPF primero, candado, y promiscuo (mejor esfuerzo).
func abrir(ifz *net.Interface, ins []Instruccion) (int, error) {
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(syscall.ETH_P_ALL)))
	if err != nil {
		return -1, fmt.Errorf("AF_PACKET (the companion needs NET_RAW): %w", err)
	}
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(syscall.ETH_P_ALL), Ifindex: ifz.Index}); err != nil {
		syscall.Close(fd)
		return -1, err
	}
	prog := make([]byte, 16)
	binary.LittleEndian.PutUint16(prog, uint16(len(ins)))
	binary.LittleEndian.PutUint64(prog[8:], uint64(uintptr(unsafe.Pointer(&ins[0]))))
	if err := syscall.SetsockoptString(fd, syscall.SOL_SOCKET, soAdjuntarFiltro, string(prog)); err != nil {
		syscall.Close(fd)
		return -1, fmt.Errorf("could not attach the BPF filter: %w", err)
	}
	if err := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, soCandadoFiltro, 1); err != nil {
		slog.Warn("without SO_LOCK_FILTER (best effort)", "err", err)
	}
	mreq := struct {
		ifindex int32
		tipo    uint16
		alen    uint16
		dir     [8]byte
	}{ifindex: int32(ifz.Index), tipo: promiscuo}
	if err := syscall.SetsockoptString(fd, syscall.SOL_PACKET, agregarAfiliacion,
		string(unsafe.Slice((*byte)(unsafe.Pointer(&mreq)), unsafe.Sizeof(mreq)))); err != nil {
		slog.Warn("without promiscuous mode", "err", err)
	}
	return fd, nil
}
