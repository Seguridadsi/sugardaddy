package salud

import (
	"os"
	"path/filepath"
	"time"
)

// Medidor guarda la lectura anterior de la CPU para calcular el uso entre dos
// muestras. No es seguro entre goroutines: lo usa solo el bucle del sensor.
type Medidor struct {
	// Proc: dónde está /proc (en las pruebas, una carpeta con ficheros falsos).
	Proc string
	// Datos: la carpeta del sensor; se mide su sistema de ficheros.
	Datos string
	antes *TiemposCPU
}

// Maquina mide la máquina y deja lo que sabe en m. Lo que no se puede leer
// (fuera de Linux, un /proc raro) no va.
func (d *Medidor) Maquina(m *Muestra, ahora time.Time) {
	m.V = Version
	m.Cuando = ahora.UTC().Format(time.RFC3339)
	proc := d.Proc
	if proc == "" {
		proc = "/proc"
	}
	if b, err := os.ReadFile(filepath.Join(proc, "stat")); err == nil {
		if t, ok := LeerStat(b); ok {
			if d.antes != nil {
				if u, ok := UsoCPU(*d.antes, t); ok {
					m.CPU = &u
				}
			}
			d.antes = &t
		}
		if n := ContarCPUs(b); n > 0 {
			m.CPUs = n
		}
	}
	if b, err := os.ReadFile(filepath.Join(proc, "loadavg")); err == nil {
		if c, ok := LeerCarga(b); ok {
			m.Carga1 = &c
		}
	}
	if b, err := os.ReadFile(filepath.Join(proc, "meminfo")); err == nil {
		if c, ok := LeerMeminfo(b); ok {
			m.Memoria = c
		}
	}
	if d.Datos != "" {
		m.Disco = disco(d.Datos)
	}
}
