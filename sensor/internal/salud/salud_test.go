package salud

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const stat1 = `cpu  100 0 100 700 100 0 0 0 0 0
cpu0 50 0 50 350 50 0 0 0 0 0
cpu1 50 0 50 350 50 0 0 0 0 0
intr 1
`

const stat2 = `cpu  200 0 200 1300 300 0 0 0 0 0
cpu0 100 0 100 650 150 0 0 0 0 0
cpu1 100 0 100 650 150 0 0 0 0 0
`

func TestCPU(t *testing.T) {
	a, ok := LeerStat([]byte(stat1))
	if !ok || a.Total != 1000 || a.Ocupado != 200 {
		t.Fatalf("stat1: %+v %v", a, ok)
	}
	b, _ := LeerStat([]byte(stat2))
	u, ok := UsoCPU(a, b)
	// 200 ocupado más de 1000 más: 20 %.
	if !ok || u != 20 {
		t.Fatalf("uso: %v %v", u, ok)
	}
	if _, ok := UsoCPU(b, a); ok {
		t.Fatal("contadores hacia atrás no dan uso")
	}
	if n := ContarCPUs([]byte(stat1)); n != 2 {
		t.Fatalf("cpus: %d", n)
	}
	if _, ok := LeerStat([]byte("cpu x y z w\n")); ok {
		t.Fatal("una línea rota no vale")
	}
}

func TestMeminfoYCarga(t *testing.T) {
	m, ok := LeerMeminfo([]byte("MemTotal:       2048 kB\nMemFree:  10 kB\nMemAvailable:   1024 kB\n"))
	if !ok || m.Total != 2048*1024 || m.Libre != 1024*1024 {
		t.Fatalf("meminfo: %+v %v", m, ok)
	}
	if _, ok := LeerMeminfo([]byte("MemTotal: 2048 kB\n")); ok {
		t.Fatal("sin MemAvailable no se informa")
	}
	c, ok := LeerCarga([]byte("0.57 0.40 0.30 1/200 1234\n"))
	if !ok || c != 0.6 {
		t.Fatalf("carga: %v %v", c, ok)
	}
}

func TestMedidor(t *testing.T) {
	dir := t.TempDir()
	escribir := func(n, s string) {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	escribir("stat", stat1)
	escribir("loadavg", "1.00 0 0 1/1 1\n")
	escribir("meminfo", "MemTotal: 100 kB\nMemAvailable: 50 kB\n")
	d := Medidor{Proc: dir, Datos: dir}
	var m Muestra
	d.Maquina(&m, time.Unix(0, 0))
	if m.CPU != nil {
		t.Fatal("la primera muestra no tiene uso de CPU")
	}
	if m.CPUs != 2 || m.Carga1 == nil || m.Memoria == nil || m.Disco == nil || m.Disco.Total <= 0 {
		t.Fatalf("muestra: %+v", m)
	}
	escribir("stat", stat2)
	m = Muestra{}
	d.Maquina(&m, time.Unix(60, 0))
	if m.CPU == nil || *m.CPU != 20 {
		t.Fatalf("segunda muestra: %+v", m.CPU)
	}
	// Sin /proc (fuera de Linux) no se inventa nada.
	m = Muestra{}
	(&Medidor{Proc: filepath.Join(dir, "no")}).Maquina(&m, time.Unix(0, 0))
	if m.CPU != nil || m.Memoria != nil || m.Disco != nil || m.V != Version {
		t.Fatalf("sin proc: %+v", m)
	}
}

func TestAgrupar(t *testing.T) {
	inicio := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	r := Agrupar([]Contenedor{
		{Trampa: "b", Principal: true, Estado: "running", Reinicios: 1, Desde: inicio},
		{Trampa: "a", Principal: true, Estado: "running", Saludable: "unhealthy"},
		{Trampa: "a", Estado: "exited", Reinicios: 2},
		{Trampa: "", Estado: "running"},
		{Trampa: "c", Principal: true, Estado: "restarting", Reinicios: 5},
	})
	if len(r) != 3 || r[0].ID != "a" || r[1].ID != "b" || r[2].ID != "c" {
		t.Fatalf("orden: %+v", r)
	}
	if r[0].EnMarcha || r[0].Estado != "exited" || r[0].Reinicios != 2 {
		t.Fatalf("a: %+v", r[0])
	}
	if !r[1].EnMarcha || r[1].Desde != "2026-11-24T10:00:00Z" || r[1].Reinicios != 1 {
		t.Fatalf("b: %+v", r[1])
	}
	if r[2].EnMarcha || r[2].Estado != "restarting" {
		t.Fatalf("c: %+v", r[2])
	}
	if r := Agrupar([]Contenedor{{Trampa: "x", Estado: "running", Saludable: "unhealthy"}}); r[0].Estado != "unhealthy" || r[0].EnMarcha {
		t.Fatalf("sin salud: %+v", r)
	}
}
