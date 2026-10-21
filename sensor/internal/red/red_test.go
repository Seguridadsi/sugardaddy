package red

import (
	"encoding/base64"
	"encoding/binary"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

// ——— la máquina virtual del BPF clásico ———
//
// La misma que ejecuta el kernel (el conjunto de instrucciones de
// linux/filter.h, solo lo que CompilarBPF emite), para probar el filtro sin
// NET_RAW y sin red: tramas sintéticas que pasan o no pasan.
func ejecutar(ins []instruccion, trama []byte) uint32 {
	var a uint32
	for i := 0; i < len(ins); i++ {
		in := ins[i]
		switch in.Codigo {
		case cargarMitad:
			if int(in.K+2) > len(trama) {
				return 0
			}
			a = uint32(binary.BigEndian.Uint16(trama[in.K:]))
		case cargarPal:
			if int(in.K+4) > len(trama) {
				return 0
			}
			a = binary.BigEndian.Uint32(trama[in.K:])
		case saltoIgual:
			if a == in.K {
				i += int(in.Jt)
			} else {
				i += int(in.Jf)
			}
		case yLogico:
			a &= in.K
		case devolver:
			return in.K
		default:
			return 0
		}
	}
	return 0
}

// deserializar: el camino de vuelta de CompilarBPF, el mismo que hace la
// darknet con SD_RED_BPF (base64 → instrucciones de 8 bytes en little
// endian). Probar el filtro ES probar el contrato del entorno.
func deserializar(t *testing.T, filtro string) []instruccion {
	t.Helper()
	bruto, err := base64.StdEncoding.DecodeString(filtro)
	if err != nil {
		t.Fatalf("el filtro no es base64: %v", err)
	}
	if len(bruto) == 0 || len(bruto)%8 != 0 {
		t.Fatalf("el filtro mide %d bytes: no son instrucciones de 8", len(bruto))
	}
	if len(bruto)/8 > 512 {
		t.Fatalf("el filtro trae %d instrucciones: el tope del kernel es 512", len(bruto)/8)
	}
	ins := make([]instruccion, len(bruto)/8)
	for i := range ins {
		b := bruto[i*8:]
		ins[i] = instruccion{
			Codigo: binary.LittleEndian.Uint16(b),
			Jt:     b[2], Jf: b[3],
			K: binary.LittleEndian.Uint32(b[4:]),
		}
	}
	return ins
}

// tramaIPv4: una trama DIX IPv4 sintética hacia una destino y con el
// protocolo que se pida (la cabecera mínima, que el filtro no mira más allá
// de la dirección de destino).
func tramaIPv4(destino [4]byte, siguiente byte) []byte {
	t := make([]byte, 34)
	copy(t[0:6], []byte{0x02, 0, 0, 0, 0, 0x01})
	copy(t[6:12], []byte{0x02, 0, 0, 0, 0, 0x02})
	t[12], t[13] = 0x08, 0x00
	copy(t[26:30], []byte{10, 20, 0, 99}) // origen
	copy(t[30:34], destino[:])
	t[23] = siguiente
	return t
}

func tramaARPPrueba(sha [4]byte) []byte {
	t := make([]byte, 42)
	t[12], t[13] = 0x08, 0x06
	copy(t[28:32], sha[:]) // spa: quien dice tener la IP
	return t
}

// ——— CompilarBPF ———

func TestCompilarBPFRangos(t *testing.T) {
	filtro, err := CompilarBPF("172.31.201.0/24, 10.20.0.0/16")
	if err != nil {
		t.Fatal(err)
	}
	ins := deserializar(t, filtro)

	aprueba := func(trama []byte, quiere bool, que string) {
		t.Helper()
		if pasa := ejecutar(ins, trama) != 0; pasa != quiere {
			t.Errorf("%s: pasa=%v, quería %v", que, pasa, quiere)
		}
	}
	oscura := [4]byte{172, 31, 201, 30}
	clara := [4]byte{192, 168, 1, 10}
	hijo := [4]byte{10, 20, 5, 5}

	aprueba(tramaIPv4(oscura, 6), true, "IPv4 al rango /24 oscuro")
	aprueba(tramaIPv4(hijo, 17), true, "IPv4 al segundo rango /16")
	aprueba(tramaIPv4(clara, 6), false, "IPv4 fuera de los rangos")
	aprueba(tramaARPPrueba(oscura), true, "ARP pasa siempre (la charla del segmento)")
	aprueba(tramaARPPrueba(clara), true, "ARP fuera de los rangos también pasa")
	otro := tramaIPv4(oscura, 6)
	otro[12], otro[13] = 0x86, 0xdd // IPv6
	aprueba(otro, false, "IPv6 no pasa")
	corto := tramaIPv4(oscura, 6)[:20]
	aprueba(corto, false, "trama corta no pasa")
}

func TestCompilarBPFRangosMalos(t *testing.T) {
	for _, lista := range []string{
		"", "   ", "no-es-cidr", "10.20.0.0", "172.31.201.0/24,",
		"0.0.0.0/0", "10.0.0.0/7", "::1/128", "fe80::/16",
		"10.20.0.300/24",
	} {
		if _, err := CompilarBPF(lista); err == nil {
			t.Errorf("capturar %q se aceptó y no debía", lista)
		}
	}
}

func TestCompilarBPFSinCasiTodo(t *testing.T) {
	// Un rango menor que /8 o el cero absoluto no vale: acotar es la mitad
	// de la seguridad del NET_RAW (docs/diseno/red.md).
	if _, err := CompilarBPF("10.0.0.0/8"); err != nil {
		t.Fatalf("un /8 exacto sí vale: %v", err)
	}
}

func TestCompilarBPFCadaRangoRechazaAlFinal(t *testing.T) {
	// El último rango que no coincide cae en REJECT: probarlo con un solo
	// rango es donde más fácil se rompe.
	filtro, err := CompilarBPF("172.31.201.0/24")
	if err != nil {
		t.Fatal(err)
	}
	ins := deserializar(t, filtro)
	if pasa := ejecutar(ins, tramaIPv4([4]byte{10, 0, 0, 1}, 6)) != 0; pasa {
		t.Error("con un solo rango, una IP ajena pasó el filtro")
	}
	if pasa := ejecutar(ins, tramaIPv4([4]byte{172, 31, 201, 1}, 6)) != 0; !pasa {
		t.Error("con un solo rango, la IP del rango no pasó el filtro")
	}
}

// ——— Rangos ———

func TestRangos(t *testing.T) {
	rs, err := Rangos("10.20.0.0/24, 10.30.0.0/16")
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 2 || rs[0] != netip.MustParsePrefix("10.20.0.0/24") || rs[1] != netip.MustParsePrefix("10.30.0.0/16") {
		t.Fatalf("rangos mal analizados: %v", rs)
	}
}

// ——— Capa2 ———

// sysPrueba fabrica una raíz /sys con la interfaz dada (y su phy80211 si se
// pide) y el DMI que se diga; devuelve su ruta y la deja apuntada en sys.
func sysPrueba(t *testing.T, interfaz string, wifi bool, dmi map[string]string) {
	t.Helper()
	raiz := t.TempDir()
	dir := filepath.Join(raiz, "class", "net", interfaz)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if wifi {
		if err := os.Mkdir(filepath.Join(dir, "phy80211"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if dmi != nil {
		d := filepath.Join(raiz, "devices", "virtual", "dmi", "id")
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		for k, v := range dmi {
			if err := os.WriteFile(filepath.Join(d, k), []byte(v), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	anterior := sys
	sys = raiz
	t.Cleanup(func() { sys = anterior })
}

func TestCapa2SinInterfazNoInforma(t *testing.T) {
	if h := Capa2(Opciones{}); h != nil {
		t.Fatalf("sin interfaz elegida el hecho no se informa: %+v", h)
	}
}

func TestCapa2InterfazQueNoHay(t *testing.T) {
	sysPrueba(t, "eth0", false, nil)
	h := Capa2(Opciones{Interfaz: "eno1", Rango: "10.0.0.240/28"})
	if h == nil || h.Valor {
		t.Fatalf("una interfaz que no existe dio por buena la capa 2: %+v", h)
	}
}

func TestCapa2WiFi(t *testing.T) {
	sysPrueba(t, "wlan0", true, nil)
	h := Capa2(Opciones{Interfaz: "wlan0", Rango: "10.0.0.240/28"})
	if h == nil || h.Valor {
		t.Fatalf("el Wi-Fi dio por buena la capa 2: %+v", h)
	}
	if h.Motivo == "" {
		t.Error("el Wi-Fi false vino sin su motivo")
	}
}

// DMI real de un guest Hyper-V de la LAN del cliente (las dos cadenas de
// Microsoft): NO es nube (hallazgo 4 — antes el OR lo marcaba y el elector
// descartaba una máquina legítima con un motivo engañoso).
var dmiHyperVLocal = map[string]string{
	"sys_vendor":     "Microsoft Corporation",
	"product_name":   "Virtual Machine",
	"product_family": "Virtual Machine",
	"board_vendor":   "Microsoft Corporation",
}

func TestCapa2Nube(t *testing.T) {
	for _, dmi := range []map[string]string{
		// AWS EC2: el fabricante lo dice solo.
		{"sys_vendor": "Amazon EC2"},
		// Azure: el asset tag del chasis con el prefijo documentado de MSFT.
		{"sys_vendor": "Microsoft Corporation", "product_name": "Virtual Machine",
			"chassis_asset_tag": "7783-7084-3265-9085-8269-3286-77"},
		// GCP: fabricante y producto juntos.
		{"sys_vendor": "Google", "product_name": "Google Compute Engine"},
		// OCI: fabricante y producto juntos.
		{"sys_vendor": "Oracle Corporation", "product_name": "Virtual Machine"},
	} {
		sysPrueba(t, "eth0", false, dmi)
		h := Capa2(Opciones{Interfaz: "eth0", Rango: "10.0.0.240/28"})
		if h == nil || h.Valor {
			t.Fatalf("la nube %v dio por buena la capa 2: %+v", dmi, h)
		}
	}
}

func TestCapa2HyperVEnLaLANVale(t *testing.T) {
	// Hyper-V en la LAN del cliente no es nube: con que acepte MAC ajenas
	// (tpot.md §4.2), las trampas con IP propia sí pueden ir. El DMI es el
	// REAL de un guest Hyper-V — el mismo que una MV de Azure en esos campos:
	// sin el asset tag de Azure no hay forma (ni hace falta) de distinguirlas
	// por esas dos cadenas.
	sysPrueba(t, "eth0", false, dmiHyperVLocal)
	h := Capa2(Opciones{Interfaz: "eth0", Rango: "10.0.0.240/28"})
	if h == nil || !h.Valor {
		t.Fatalf("una MV Hyper-V en la LAN del cliente no es nube: %+v", h)
	}

	// Y el mismo DMI con el asset tag de Azure ES nube: el marcador manda.
	azure := map[string]string{}
	for k, v := range dmiHyperVLocal {
		azure[k] = v
	}
	azure["chassis_asset_tag"] = "7783-7084-3265-9085-8269-3286-77"
	sysPrueba(t, "eth0", false, azure)
	h = Capa2(Opciones{Interfaz: "eth0", Rango: "10.0.0.240/28"})
	if h == nil || h.Valor {
		t.Fatalf("el asset tag de Azure no marcó la MV de Azure como nube: %+v", h)
	}
}

func TestCapa2SinRango(t *testing.T) {
	sysPrueba(t, "eth0", false, nil)
	h := Capa2(Opciones{Interfaz: "eth0"})
	if h == nil || h.Valor || h.Motivo == "" {
		t.Fatalf("sin rango propio el hecho no es false con motivo: %+v", h)
	}
}

func TestCapa2RangoMalo(t *testing.T) {
	sysPrueba(t, "eth0", false, nil)
	h := Capa2(Opciones{Interfaz: "eth0", Rango: "10.0.0.0/33"})
	if h == nil || h.Valor || h.Motivo == "" {
		t.Fatalf("un rango malo dio por buena la capa 2: %+v", h)
	}
}

func TestCapa2Cable(t *testing.T) {
	// Una VM KVM en la LAN del cliente (el banco de desarrollo) es cable a
	// todos los efectos: no es nube pública.
	sysPrueba(t, "eth0", false, map[string]string{"sys_vendor": "QEMU", "product_name": "Standard PC"})
	h := Capa2(Opciones{Interfaz: "eth0", Rango: "10.0.0.240/28"})
	if h == nil || !h.Valor {
		t.Fatalf("el enlace por cable con rango propio no dio red.capa2 true: %+v", h)
	}
}
