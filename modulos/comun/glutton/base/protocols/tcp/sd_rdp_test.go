package tcp

// Prueba propia de Sugardaddy para el manejador RDP: comprueba que un marco
// enorme no hace que la sesión guarde en memoria todo lo que mande el atacante
// (el parche recorta cada marco a rdpMaxStoredPayload). Complementa a las
// pruebas de upstream (rdp_test.go), que cubren PDUs partidas, TPKT a medias y
// desconexión temprana. Usa el arném de sd_harness_test.go.

import (
	"context"
	"encoding/hex"
	"io"
	"net"
	"testing"
	"time"

	"github.com/mushorg/glutton/connection"
	"github.com/stretchr/testify/require"
)

// TestHandleRDPTSRequestMalformadoNoTumba reproduce el hallazgo de seguridad: un
// TSRequest con una longitud DER larga y basura (30 88 ff..ff 00 00) llegaba a
// parseLength, que con l negativo no saltaba la comprobación y hacía pánico,
// tumbando TODO el proceso (Docker reiniciaba la trampa y se perdían las
// sesiones en curso). Tras el arreglo de der.go el parser lo rechaza y el
// manejador cierra solo esa conexión y devuelve. La prueba falla con un pánico
// si se regresa el fallo; si pasa, el proceso siguió vivo.
func TestHandleRDPTSRequestMalformadoNoTumba(t *testing.T) {
	tlsClient, _, done, _ := startRDPTLS(t, rdpCRHybridOnly)
	// 30 88 + 8 octetos 0xff (longitud absurda) + relleno: el vector del hallazgo.
	vector, err := hex.DecodeString("308800000000ffffffff0000")
	require.NoError(t, err)
	// Y además el exacto de la evidencia (8 octetos 0xff).
	vector2, err := hex.DecodeString("3088ffffffffffffffff0000")
	require.NoError(t, err)
	for _, v := range [][]byte{vector, vector2} {
		_, _ = tlsClient.Write(v)
	}
	_ = tlsClient.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.Copy(io.Discard, tlsClient)
	select {
	case <-done:
		// El manejador terminó sin tumbar el proceso: correcto.
	case <-time.After(5 * time.Second):
		t.Fatal("el manejador no terminó tras el TSRequest malformado")
	}
}

func TestHandleRDPRecortaMarcoEnorme(t *testing.T) {
	cliente, servidor := net.Pipe()
	defer cliente.Close()

	hp := newFakeHoneypot()
	done := make(chan error, 1)
	go func() {
		done <- HandleRDP(context.Background(), servidor, connection.Metadata{}, &recordingLogger{}, hp)
	}()

	_ = cliente.SetDeadline(time.Now().Add(5 * time.Second))

	// Un TPKT X.224 Data (tipo 0xF0) de 8192 bytes: cabe en rdpMaxReceive pero
	// supera con creces rdpMaxStoredPayload.
	const total = 8192
	pdu := make([]byte, total)
	pdu[0] = 0x03
	pdu[1] = 0x00
	pdu[2] = byte(total >> 8)
	pdu[3] = byte(total & 0xff)
	pdu[4] = 0x02 // X.224 LI
	pdu[5] = 0xf0 // Data TPDU
	for i := 6; i < total; i++ {
		pdu[i] = 0x41
	}
	if _, err := cliente.Write(pdu); err != nil {
		t.Fatalf("no se pudo escribir el PDU: %v", err)
	}
	_ = cliente.Close()

	evento := waitProduced(t, hp)
	marcos, ok := evento.decoded.([]parsedRDP)
	if !ok {
		t.Fatalf("decoded no es []parsedRDP: %T", evento.decoded)
	}
	if len(marcos) == 0 {
		t.Fatal("no se registró ningún marco")
	}
	for i, fr := range marcos {
		if len(fr.Payload) > rdpMaxStoredPayload {
			t.Fatalf("el marco %d guarda %d bytes, por encima del tope %d", i, len(fr.Payload), rdpMaxStoredPayload)
		}
		if len(fr.Payload) >= total {
			t.Fatalf("el marco %d no se recortó", i)
		}
	}
	waitRDPDone(t, done)
}
