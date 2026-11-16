package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
)

// La orden «aislar-anfitrion» corre en la raíz de la máquina: la de su PID 1.

const caminoMaquina = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

func entrarEnLaMaquina() error {
	if os.Getpid() == 1 {
		return errors.New("the container does not share the machine PID namespace")
	}
	if err := syscall.Chroot("/proc/1/root"); err != nil {
		return err
	}
	if err := os.Chdir("/"); err != nil {
		return err
	}
	return os.Setenv("PATH", caminoMaquina)
}

func hayEnLaMaquina(nombre string) bool {
	_, err := exec.LookPath(nombre)
	return err == nil
}

func ejecutarEnLaMaquina(nombre string, args ...string) ([]byte, error) {
	c := exec.Command(nombre, args...)
	c.Env = []string{"PATH=" + caminoMaquina, "LANG=C"}
	return c.CombinedOutput()
}

// anfitrionAuxiliar entra en la raíz de la máquina y mira (y prepara) lo de
// maquina.go: SSH, auditd y, en el appliance, Docker. Escribe lo que ve en una línea
// JSON y sale con 0 siempre que la escribe.
func anfitrionAuxiliar() int {
	nodo := os.Getenv("ANFITRION_NODO")
	var motor *actualizador.MotorFijado
	if t := os.Getenv("ANFITRION_MOTOR"); t != "" {
		var m actualizador.MotorFijado
		if json.Unmarshal([]byte(t), &m) == nil && actualizador.ValidarMotor(&m) == nil {
			motor = &m
		}
	}
	var h actualizador.HechosMaquina
	if err := entrarEnLaMaquina(); err != nil {
		h.Auditd.Estado, h.Auditd.Detalle = actualizador.PiezaFallo, "cannot enter the machine root: "+err.Error()
		h.Docker.Actualizacion = actualizador.PiezaFallo
	} else {
		if !actualizador.RutaDatosValida(nodo) {
			nodo = ""
		}
		m := actualizador.Maquina{Anfitrion: actualizador.Anfitrion{Raiz: "/", Ejecutar: ejecutarEnLaMaquina, Hay: hayEnLaMaquina}}
		h = m.Mirar(nodo, motor)
	}
	b, _ := json.Marshal(map[string]any{"maquina": h})
	fmt.Println(string(b))
	return 0
}
