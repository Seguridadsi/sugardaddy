package main

import (
	"crypto/sha256"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// persona: lo que hace que cada trampa parezca una impresora de oficina
// distinta y coherente consigo misma. Lo que cambia con la instalación (modelo,
// número de serie, versión de firmware, MAC, páginas impresas, UUID, IP de la
// interfaz) sale de una semilla propia, así que se mantiene entre reinicios y
// es distinto en cada cliente, y la imagen sigue siendo la misma para todos.
//
// NOTA DE MARCAS: no se suplanta a ningún fabricante real ni se usan sus
// logotipos (regla de docs/diseno/tpot.md §5). Los nombres de fabricante son
// genéricos e inventados; a un escáner (nmap -sV, PRET) le basta con que el ID
// PJL y las páginas tengan la forma de una impresora de red real.
type persona struct {
	fabricante string
	modelo     string // lo que devuelve @PJL INFO ID, p. ej. "Novaprint LaserMFP M4720"
	serie      string // número de serie
	firmware   string // versión de firmware
	mac        string
	uuid       string // printer-uuid (IPP)
	nombre     string // printer-name / hostname
	ubicacion  string // printer-location
	ipLocal    string
	puertoIpp  int
	puertoWeb  int
	paginas    int64 // contador de páginas (PAGECOUNT)
	nivelToner int   // 0-100
	arranque   time.Time
}

// modelos: fabricantes y gamas inventados pero con forma realista. No son
// marcas registradas conocidas; a propósito, para no suplantar a nadie.
var fabricantes = []string{"Novaprint", "OfficeCore", "Printech", "Duratek", "Imprenet", "Zentek"}
var gamas = []string{"LaserMFP", "ColorJet", "WorkPrint", "PageMaster", "OfficeLaser"}

// nombreSemilla: el fichero, junto al registro, donde se guarda la semilla. No
// empieza por el nombre del registro: el sensor no lo lee ni lo poda.
const nombreSemilla = ".semilla-impresora"

// cargarSemilla: la de SD_IMPRESORA_SEMILLA; si no, la guardada junto al
// registro; si no, una nueva al azar que se guarda ahí. Si la carpeta no se
// puede escribir, el nombre del equipo (el del contenedor), que al menos es
// distinto en cada trampa.
func cargarSemilla(c conf) string {
	if c.semilla != "" {
		return c.semilla
	}
	ruta := filepath.Join(filepath.Dir(c.registro), nombreSemilla)
	if b, err := os.ReadFile(ruta); err == nil {
		if s := strings.TrimSpace(string(b)); len(s) >= 16 && len(s) <= 128 {
			return s
		}
	}
	s := aleatorioHex(16)
	if err := os.WriteFile(ruta, []byte(s+"\n"), 0o600); err != nil {
		if h, err := os.Hostname(); err == nil && h != "" {
			return "equipo:" + h
		}
	}
	return s
}

func generador(partes ...string) *rand.Rand {
	h := sha256.Sum256([]byte(strings.Join(partes, "\x00")))
	return rand.New(rand.NewChaCha8(h))
}

func entre(r *rand.Rand, a, b int) int { return a + r.IntN(b-a+1) }

// nuevaPersona deriva la impresora de la semilla y la configuración.
func nuevaPersona(c conf, semilla string, arranque time.Time) *persona {
	r := generador("sugardaddy-impresora", semilla)
	fab := fabricantes[r.IntN(len(fabricantes))]
	gama := gamas[r.IntN(len(gamas))]
	modelo := c.modelo
	if modelo == "" || strings.EqualFold(modelo, "auto") {
		// Gama + número de modelo con letra de serie, como una impresora real.
		modelo = fmt.Sprintf("%s %s M%d%s", fab, gama, entre(r, 2000, 8900), string(rune('a'+r.IntN(6))))
	} else {
		// El cliente ha fijado el texto del modelo; el fabricante se deja el
		// derivado solo para las etiquetas internas.
		modelo = prefijo(modelo, 80)
	}

	p := &persona{
		fabricante: fab,
		modelo:     modelo,
		serie:      fmt.Sprintf("%s%d%s", strings.ToUpper(fab[:2]), entre(r, 100000, 999999), string(rune('A'+r.IntN(26)))),
		firmware:   fmt.Sprintf("%d.%d.%d.%d", entre(r, 2, 8), entre(r, 0, 40), entre(r, 0, 9), entre(r, 100, 999)),
		paginas:    int64(entre(r, 1200, 480000)),
		nivelToner: entre(r, 8, 96),
		puertoIpp:  c.puertoIpp,
		puertoWeb:  c.puertoWeb,
		arranque:   arranque,
	}
	// MAC con un OUI sin asignar por la IEEE (prefijo del bloque CF:xx:xx,
	// reservado y nunca repartido a fabricantes): unicast y administrada
	// globalmente, SIN el bit de administración local (0x02) que delataba la
	// trampa, porque ninguna impresora real lo lleva. No suplanta a nadie: el
	// OUI no pertenece a ningún fabricante. (La MAC mostrada nunca coincidirá
	// con la que el atacante ve en su ARP; por eso solo se enseña en la web,
	// como dato de catálogo, no como prueba de identidad.)
	p.mac = fmt.Sprintf("cf:%02x:%02x:%02x:%02x:%02x",
		r.IntN(256), r.IntN(256), r.IntN(256), r.IntN(256), r.IntN(256))
	p.uuid = "urn:uuid:" + uuidSemilla(r)

	p.nombre = c.nombreEquipo
	if p.nombre == "" {
		p.nombre = fmt.Sprintf("%s%06X", []string{"PRN", "IMP", "MFP", "HPR", "NPI"}[r.IntN(5)], entre(r, 0, 0xffffff))
	}
	p.nombre = prefijo(p.nombre, 63)

	p.ubicacion = c.ubicacion
	if p.ubicacion == "" {
		pisos := []string{"Planta 1", "Planta 2", "Planta 3", "Sótano", "Recepción", "Administración", "Almacén"}
		p.ubicacion = fmt.Sprintf("%s - Sala %d", pisos[r.IntN(len(pisos))], entre(r, 1, 40))
	}
	p.ubicacion = prefijo(p.ubicacion, 120)

	switch r.IntN(3) {
	case 0:
		p.ipLocal = fmt.Sprintf("10.%d.%d.%d", r.IntN(256), r.IntN(256), entre(r, 4, 250))
	case 1:
		p.ipLocal = fmt.Sprintf("172.%d.%d.%d", entre(r, 16, 31), r.IntN(256), entre(r, 4, 250))
	default:
		p.ipLocal = fmt.Sprintf("192.168.%d.%d", r.IntN(256), entre(r, 2, 250))
	}
	return p
}

// uuidSemilla: un UUID versión 4 derivado de la semilla (fijo por trampa).
func uuidSemilla(r *rand.Rand) string {
	var b [16]byte
	for i := range b {
		b[i] = byte(r.IntN(256))
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (p *persona) uptime(ahora time.Time) int64 {
	s := int64(ahora.Sub(p.arranque) / time.Second)
	if s < 0 {
		s = 0
	}
	return s
}
