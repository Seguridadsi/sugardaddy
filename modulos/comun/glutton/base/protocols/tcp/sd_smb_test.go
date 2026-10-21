package tcp

import (
	"context"
	"encoding/binary"
	"net"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/mushorg/glutton/connection"
	"github.com/stretchr/testify/require"
)

// honeyBloqueo es un honeypot de prueba que se detiene en ProduceTCP hasta que
// el test lo suelta, para poder medir la memoria mientras el manejador todavía
// retiene sus marcos (ss.events) de la conexión.
type honeyBloqueo struct {
	*fakeHoneypot
	llegada   chan struct{}
	continuar chan struct{}
}

func (h *honeyBloqueo) ProduceTCP(string, net.Conn, connection.Metadata, []byte, interface{}) error {
	h.llegada <- struct{}{}
	<-h.continuar
	return nil
}

// marcoNBSS arma un marco NBSS que no es "session message" (tipo 0x85): el
// manejador lo registra pero no contesta, así el test puede empujar muchos
// marcos por una tubería síncrona sin que el manejador se bloquee escribiendo.
func marcoNBSS(tam int) []byte {
	f := make([]byte, 4+tam)
	f[0] = 0x85
	f[1] = byte(tam >> 16)
	f[2] = byte(tam >> 8)
	f[3] = byte(tam)
	return f
}

// TestHandleSMBMemoriaAcotada reproduce el abuso del hallazgo de OOM: 8
// conexiones × 128 marcos de 256 KiB. Como la trampa recorta lo que guarda,
// baja maxSMBMessage y corta cada conexión al superar su presupuesto, el montón
// retenido mientras los 8 manejadores siguen vivos queda muy por debajo de
// 32 MiB (antes se tumbaba por OOM con mucho menos).
func TestHandleSMBMemoriaAcotada(t *testing.T) {
	const conns = 8
	const marcos = 128
	const tam = 256 * 1024

	marco := marcoNBSS(tam)
	llegada := make(chan struct{}, conns)
	continuar := make(chan struct{})
	var wg sync.WaitGroup

	runtime.GC()
	var m0 runtime.MemStats
	runtime.ReadMemStats(&m0)

	for c := 0; c < conns; c++ {
		client, server := net.Pipe()
		hp := &honeyBloqueo{fakeHoneypot: newFakeHoneypot(), llegada: llegada, continuar: continuar}
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = HandleSMB(context.Background(), server, connection.Metadata{}, &recordingLogger{}, hp)
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer client.Close()
			_ = client.SetWriteDeadline(time.Now().Add(10 * time.Second))
			for i := 0; i < marcos; i++ {
				if _, err := client.Write(marco); err != nil {
					return // el manejador cortó por presupuesto: dejamos de empujar
				}
			}
		}()
	}

	// Esperar a que los 8 manejadores lleguen a ProduceTCP (aún reteniendo sus
	// marcos) y medir el montón en ese momento.
	for i := 0; i < conns; i++ {
		select {
		case <-llegada:
		case <-time.After(20 * time.Second):
			t.Fatal("un manejador no llegó a producir (¿bloqueado?)")
		}
	}
	runtime.GC()
	var m1 runtime.MemStats
	runtime.ReadMemStats(&m1)
	var retenido uint64
	if m1.HeapAlloc > m0.HeapAlloc {
		retenido = m1.HeapAlloc - m0.HeapAlloc
	}
	close(continuar)
	wg.Wait()

	if retenido > 32<<20 {
		t.Fatalf("montón retenido %d MiB con 8×128×256KiB; debería ir muy por debajo de 32 MiB", retenido>>20)
	}
}

// TestHandleSMBPresupuestoPorConexion comprueba que una sola conexión que manda
// basura sin parar se corta al superar su presupuesto de bytes, en vez de leer
// sin fin.
func TestHandleSMBPresupuestoPorConexion(t *testing.T) {
	anterior := maxSMBConnBytes
	maxSMBConnBytes = 512 * 1024
	defer func() { maxSMBConnBytes = anterior }()

	client, server := net.Pipe()
	hp := newFakeHoneypot()
	done := make(chan error, 1)
	go func() { done <- HandleSMB(context.Background(), server, connection.Metadata{}, &recordingLogger{}, hp) }()

	marco := marcoNBSS(64 * 1024)
	go func() {
		_ = client.SetWriteDeadline(time.Now().Add(10 * time.Second))
		for {
			if _, err := client.Write(marco); err != nil {
				return
			}
		}
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("el manejador no debería devolver error al cortar: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("el manejador no cortó la conexión al superar el presupuesto")
	}
	_ = client.Close()
}

// TestHandleSMBLongitudesEnormesYMalformado: una longitud declarada por encima
// del máximo o un marco truncado no deben tumbar la trampa ni reservar memoria
// sin límite.
func TestHandleSMBLongitudesEnormesYMalformado(t *testing.T) {
	casos := [][]byte{
		{0x00, 0xff, 0xff, 0xff}, // session message que dice ~16 MiB y no manda nada más
		{0x85, 0x10, 0x00, 0x01}, // NBSS que dice >16 MiB (rechazado en read)
		append([]byte{0x00, 0x00, 0x00, 0x10}, []byte("\xffSMBxxxxxx")...), // SMB1 cortado
	}
	for i, pdu := range casos {
		client, server := net.Pipe()
		hp := newFakeHoneypot()
		done := make(chan error, 1)
		go func() { done <- HandleSMB(context.Background(), server, connection.Metadata{}, &recordingLogger{}, hp) }()
		go func(b []byte) {
			_ = client.SetWriteDeadline(time.Now().Add(2 * time.Second))
			_, _ = client.Write(b)
			_ = client.Close()
		}(pdu)
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("caso %d: el manejador devolvió error en vez de cerrar limpio: %v", i, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("caso %d: el manejador no terminó", i)
		}
	}
}

// TestHandleSMBPeekNamedPipeMarcado comprueba que una SMB_COM_TRANSACTION
// PeekNamedPipe (la sonda de MS17-010) se marca con su subcomando, para que el
// mapeador la convierta en smb.exploit. Guarda el desplazamiento del Setup.
func TestHandleSMBPeekNamedPipeMarcado(t *testing.T) {
	client, hp, done := startHandleSMB(t)

	body := make([]byte, 1+32+2)                       // WordCount + 16 words + ByteCount
	body[0] = 16                                       // WordCount = 14 + 2 setup
	body[27] = 2                                       // SetupCount
	binary.LittleEndian.PutUint16(body[29:31], 0x0023) // Setup[0] = PeekNamedPipe
	writeSMBFrame(t, client, append(smbHeaderBytes(t, smbReqHeader(0x25, 1, 1, 1)), body...))
	_ = readSMBFrame(t, client)

	ev := finishHandleSMB(t, client, done, hp)
	frames, ok := ev.decoded.([]parsedSMB)
	require.True(t, ok)
	var marcado bool
	for _, f := range frames {
		if f.Direction == "read" && f.Command == "SMB_COM_TRANSACTION" && f.Setup == "TRANS_PEEK_NMPIPE" {
			marcado = true
		}
	}
	require.True(t, marcado, "la PeekNamedPipe debía quedar marcada como TRANS_PEEK_NMPIPE")
}
