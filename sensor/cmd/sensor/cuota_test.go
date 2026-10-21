package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/kinomakino/sugardaddy/sensor/internal/estado"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
	"github.com/kinomakino/sugardaddy/sensor/internal/seguidor"
)

// sensorConRegistro prepara un sensor con una trampa t1 cuyo registro activo
// (cowrie.json) tiene kb kilobytes de líneas enteras, leídas hasta leido.
func sensorConRegistro(t *testing.T, kb int) (*sensor, string, *[]string) {
	t.Helper()
	datos := t.TempDir()
	dir := filepath.Join(datos, "registros", "t1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	activo := filepath.Join(dir, "cowrie.json")
	if err := os.WriteFile(activo, []byte(strings.Repeat(strings.Repeat("x", 1023)+"\n", kb)), 0o644); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(activo)
	var tp plan.TrampaPlan
	tp.ID = "t1"
	tp.Manifiesto.Eventos.Fuente.Ruta = "cowrie.json"
	var paradas []string
	s := &sensor{
		plan: &plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{tp}},
		estado: &estado.Estado{
			Leido: map[string]int64{"t1": fi.Size()}, Huellas: map[string]string{"t1": "h"}, Modifs: map[string]int64{},
			Inodos: map[string]uint64{"t1": seguidor.InodoDe(fi)},
		},
		pararTrampa: func(id string) error { paradas = append(paradas, id); return nil },
	}
	s.opc.Datos = datos
	return s, activo, &paradas
}

func conCuota(t *testing.T, cuota int64, f func(string, int64) error) {
	t.Helper()
	antes, antesP := cuotaRegistros, perforar
	cuotaRegistros, perforar = cuota, f
	t.Cleanup(func() { cuotaRegistros, perforar = antes, antesP })
}

func TestSinPoderPerforarLaTrampaSeParaYVuelveAlLeerlaEntera(t *testing.T) {
	conCuota(t, 1<<20, func(ruta string, _ int64) error {
		return &os.PathError{Op: "fallocate", Path: ruta, Err: syscall.EOPNOTSUPP}
	})
	s, activo, paradas := sensorConRegistro(t, 2048)
	// Le quedan 100 KB por leer.
	fi, _ := os.Stat(activo)
	s.estado.Leido["t1"] = fi.Size() - 100<<10

	s.vigilarCuota(time.Now())
	aviso := s.estado.Paradas["t1"]
	if len(*paradas) != 1 || !strings.Contains(aviso, "cuota superada (registros.sin-perforar)") {
		t.Fatalf("sin poder perforar, la trampa se para con el aviso: paradas=%v aviso=%q", *paradas, aviso)
	}
	if s.opc.Paradas["t1"] != aviso {
		t.Fatal("el despliegue tiene que saber que está parada, para no volver a arrancarla")
	}
	if e, _ := estado.Cargar(s.opc.Datos); e.Paradas["t1"] != aviso {
		t.Fatal("la parada se guarda: sigue tras un reinicio del sensor")
	}

	// Mientras le quede algo por leer, sigue parada y su registro no se toca.
	s.vigilarCuota(time.Now())
	if _, sigue := s.estado.Paradas["t1"]; !sigue {
		t.Fatal("con líneas por leer no vuelve")
	}
	if _, err := os.Stat(activo); err != nil {
		t.Fatal("con líneas por leer su registro no se toca")
	}

	// El sensor lo acaba; el honeypot dejó media línea al pararse, que no
	// se acabará nunca.
	fi, _ = os.Stat(activo)
	s.estado.Leido["t1"] = fi.Size()
	f, _ := os.OpenFile(activo, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(`{"eventid":"cowrie.sess`)
	f.Close()
	s.vigilarCuota(time.Now())
	if _, sigue := s.estado.Paradas["t1"]; sigue || s.opc.Paradas["t1"] != "" {
		t.Fatalf("leída entera, vuelve: %v", s.estado.Paradas)
	}
	if _, err := os.Stat(activo); !os.IsNotExist(err) {
		t.Fatal("parada y leída entera, su registro se quita")
	}
	if _, ok := s.estado.Leido["t1"]; ok || s.estado.Inodos["t1"] != 0 || s.estado.Huellas["t1"] != "" {
		t.Fatal("y su posición se vacía: el registro nuevo se lee desde el principio")
	}
	if e, _ := estado.Cargar(s.opc.Datos); len(e.Paradas) != 0 {
		t.Fatal("y deja de estar parada también en el estado guardado")
	}
}

func TestSinPermisoParaPerforarTambienSePara(t *testing.T) {
	conCuota(t, 1<<20, func(ruta string, _ int64) error {
		return &os.PathError{Op: "open", Path: ruta, Err: syscall.EACCES}
	})
	s, _, paradas := sensorConRegistro(t, 2048)
	s.vigilarCuota(time.Now())
	if len(*paradas) != 1 || !strings.Contains(s.estado.Paradas["t1"], "(registros.sin-permiso)") {
		t.Fatalf("sin permiso, se para con su motivo: %v %v", *paradas, s.estado.Paradas)
	}
}

func TestSiPerforaLaTrampaNoSePara(t *testing.T) {
	conCuota(t, 1<<20, func(string, int64) error { return nil })
	s, _, paradas := sensorConRegistro(t, 2048)
	s.vigilarCuota(time.Now())
	if len(*paradas) != 0 || len(s.estado.Paradas) != 0 {
		t.Fatalf("si se puede liberar lo leído, la trampa sigue: %v", s.estado.Paradas)
	}
}

func TestSiNoSePuedeConfirmarQueEstaParadaNoSeTocaSuRegistro(t *testing.T) {
	conCuota(t, 1<<20, func(ruta string, _ int64) error { return syscall.EOPNOTSUPP })
	s, activo, _ := sensorConRegistro(t, 2048)
	s.vigilarCuota(time.Now())
	s.pararTrampa = func(string) error { return os.ErrDeadlineExceeded }
	s.vigilarCuota(time.Now())
	if _, err := os.Stat(activo); err != nil || s.estado.Paradas["t1"] == "" {
		t.Fatal("si el honeypot puede seguir escribiendo, su registro no se quita")
	}
}

func TestAvisoDeCuota(t *testing.T) {
	casos := map[error]string{
		errSinPerforar:                     causaSinPerforar,
		syscall.EOPNOTSUPP:                 causaSinPerforar,
		syscall.ENOSYS:                     causaSinPerforar,
		&os.PathError{Err: syscall.EACCES}: causaSinPermiso,
		syscall.EPERM:                      causaSinPermiso,
		syscall.EROFS:                      causaSinPermiso,
		syscall.EIO:                        causaNoLiberado,
	}
	for err, causa := range casos {
		if got := causaCuota(err); got != causa {
			t.Errorf("%v: %s, quería %s", err, got, causa)
		}
		// La consola guarda 200 caracteres del estado, que empieza por «parada: ».
		aviso := avisoCuota(causa)
		if n := utf8.RuneCountInString("parada: " + aviso); n > 200 {
			t.Errorf("el aviso no cabe en el estado (%d caracteres): %q", n, aviso)
		}
		if !strings.HasPrefix(aviso, "cuota superada ("+causa+")") {
			t.Errorf("el aviso empieza por «cuota superada» y su código: %q", aviso)
		}
	}
}

func TestLasParadasDeTrampasRetiradasSeOlvidan(t *testing.T) {
	s := &sensor{estado: &estado.Estado{Paradas: map[string]string{"t1": "x", "vieja": "y"}}}
	s.opc.Datos = t.TempDir()
	s.olvidarParadasRetiradas(plan.Plan{Trampas: []plan.TrampaPlan{{ID: "t1"}}})
	if len(s.estado.Paradas) != 1 || s.estado.Paradas["t1"] != "x" {
		t.Fatalf("solo quedan las del plan: %v", s.estado.Paradas)
	}
}
