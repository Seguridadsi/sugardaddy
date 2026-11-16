// probarescape es la prueba de escape del banco (docs/diseno/aislamiento-trampas.md §6):
// despliega a través de sd-motor la trampa «maliciosa» de pruebas/escape, espera a que
// acabe sus intentos de salir (montar, ptrace, /proc/1/root, crear dispositivos,
// hablar con el socket, salir a internet, ARP…) y falla si alguno ha salido bien.
// Después le pide a sd-motor, con el manifiesto de esa trampa, las creaciones que
// darían el nodo (privileged, red del anfitrión, el socket de Docker…) y falla si
// alguna llega a Docker. Lo lanza herramientas/probar-escape.sh.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

type intento struct {
	Intento   string `json:"intento"`
	Bloqueado bool   `json:"bloqueado"`
	Detalle   string `json:"detalle"`
	Fin       bool   `json:"fin"`
}

type informe struct {
	Fecha       string    `json:"fecha"`
	Aislamiento string    `json:"aislamiento"`
	Dentro      []intento `json:"dentro"`
	Politica    []intento `json:"politica"`
	Bien        bool      `json:"bien"`
}

func main() {
	motor := flag.String("motor", "", "socket de sd-motor")
	datos := flag.String("datos", "", "carpeta del sensor (la misma que -datos de sd-motor)")
	rutaM := flag.String("manifiesto", "", "manifiesto de la trampa de escape (JSON)")
	rutaInf := flag.String("informe", "", "dónde dejar el informe en JSON (vacío: no se deja)")
	esperado := flag.String("esperado", "", "aislamiento que tiene que aplicar sd-motor (runsc, runc-perfiles, runc-seccomp); vacío: el que sea")
	oyente := flag.String("oyente", "", "dirección en la que escuchar mientras dura la prueba (p. ej. 0.0.0.0:18080, con la red del anfitrión): así la prueba SEN-5 tiene algo a lo que llegar")
	soloAislamiento := flag.Bool("solo-aislamiento", false, "solo preguntar a sd-motor con qué aísla las trampas y salir")
	flag.Parse()
	if *soloAislamiento {
		ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelar()
		a, err := docker.Nuevo(*motor).Aislamiento(ctx)
		if err != nil {
			fmt.Fprintln(os.Stderr, "FALLA: sd-motor no contesta:", err)
			os.Exit(1)
		}
		b, _ := json.Marshal(a)
		fmt.Println(string(b))
		return
	}
	if *oyente != "" {
		ln, err := net.Listen("tcp", *oyente)
		if err != nil {
			fmt.Fprintln(os.Stderr, "FALLA: oyente:", err)
			os.Exit(1)
		}
		defer ln.Close()
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
	}
	inf, err := probar(*motor, *datos, *rutaM)
	if err == nil && *esperado != "" && inf.Aislamiento != *esperado {
		inf.Bien = false
		err = fmt.Errorf("sd-motor aísla con %q y se esperaba %q", inf.Aislamiento, *esperado)
	}
	if *rutaInf != "" && inf != nil {
		b, _ := json.MarshalIndent(inf, "", "  ")
		_ = os.WriteFile(*rutaInf, append(b, '\n'), 0o644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "FALLA:", err)
		os.Exit(1)
	}
	fmt.Println("BIEN: ningún intento de escape ha salido bien y sd-motor ha rechazado todas las creaciones peligrosas")
}

func probar(motor, datos, rutaM string) (*informe, error) {
	if motor == "" || datos == "" || rutaM == "" {
		return nil, errors.New("hacen falta -motor, -datos y -manifiesto")
	}
	var m plan.Manifiesto
	b, err := os.ReadFile(rutaM)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	ctx, cancelar := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancelar()
	d := docker.Nuevo(motor)
	inf := &informe{Fecha: time.Now().UTC().Format(time.RFC3339)}
	if a, err := d.Aislamiento(ctx); err == nil {
		inf.Aislamiento, _ = a["valor"].(string)
		fmt.Println("sd-motor: aislamiento", inf.Aislamiento)
	} else {
		return inf, fmt.Errorf("sd-motor no contesta: %w", err)
	}
	o := despliegue.Opciones{Datos: datos, Escucha: "127.0.0.1"}
	const sensor = "banco-escape"
	t := plan.TrampaPlan{ID: "prueba-escape", Nombre: "Escape", Manifiesto: m}
	defer func() { _, _ = despliegue.Aplicar(context.WithoutCancel(ctx), d, o, plan.Plan{Sensor: sensor}) }()
	estados, err := despliegue.Aplicar(ctx, d, o, plan.Plan{Sensor: sensor, Trampas: []plan.TrampaPlan{t}})
	if err != nil {
		return inf, fmt.Errorf("desplegar: %w", err)
	}
	if strings.HasPrefix(estados[0].Donde, "error") {
		return inf, fmt.Errorf("desplegar: %s", estados[0].Donde)
	}
	fmt.Println("trampa de escape desplegada:", estados[0].Donde)

	// Lo que ha intentado desde dentro.
	ruta := filepath.Join(despliegue.Registros(o, t.ID), "escape.jsonl")
	limite := time.Now().Add(2 * time.Minute)
	for {
		inf.Dentro = leer(ruta)
		if n := len(inf.Dentro); n > 0 && inf.Dentro[n-1].Fin {
			inf.Dentro = inf.Dentro[:n-1]
			break
		}
		if time.Now().After(limite) {
			return inf, fmt.Errorf("la trampa de escape no ha terminado sus intentos (%d apuntados en %s)", len(inf.Dentro), ruta)
		}
		time.Sleep(time.Second)
	}
	var fallos []string
	for k, i := range inf.Dentro {
		marca := "bloqueado"
		if !i.Bloqueado && inf.Aislamiento == "runsc" && dentroDeGVisor[i.Intento] {
			// Con gVisor estas llamadas las atiende su núcleo en espacio de usuario, sin
			// llegar al de la máquina, y solo ven los procesos de la propia trampa.
			marca = "en gVisor"
			i.Bloqueado = true
			i.Detalle += " (inside gVisor's user-space kernel: it does not reach the host kernel)"
			inf.Dentro[k] = i
		}
		if !i.Bloqueado {
			marca = "¡SALE BIEN!"
			fallos = append(fallos, i.Intento+" ("+i.Detalle+")")
		}
		fmt.Printf("  dentro  %-45s %-12s %s\n", i.Intento, marca, i.Detalle)
	}

	// Lo que pediría un sensor tomado a sd-motor.
	for _, p := range peticiones(datos, m) {
		man, _ := json.Marshal(m)
		_, err := d.CrearTrampa(ctx, "sd-"+sensor+"-escape-mala", p.cfg, man)
		var ea *docker.ErrAPI
		i := intento{Intento: p.nombre, Bloqueado: errors.As(err, &ea) && ea.Codigo == 403}
		if err != nil {
			i.Detalle = err.Error()
		} else {
			i.Detalle = "sd-motor let it through"
			_ = d.Borrar(ctx, "sd-"+sensor+"-escape-mala")
		}
		if !i.Bloqueado {
			fallos = append(fallos, "sd-motor: "+p.nombre)
		}
		inf.Politica = append(inf.Politica, i)
		fmt.Printf("  sd-motor %-44s %v\n", p.nombre, i.Bloqueado)
	}
	if len(inf.Dentro) < 20 {
		fallos = append(fallos, fmt.Sprintf("solo %d intentos desde dentro", len(inf.Dentro)))
	}
	inf.Bien = len(fallos) == 0
	if !inf.Bien {
		return inf, fmt.Errorf("%d fugas: %s", len(fallos), strings.Join(fallos, "; "))
	}
	return inf, nil
}

// dentroDeGVisor: lo que el seccomp de Sugardaddy quita en runc porque abre superficie del
// núcleo de la máquina, y que gVisor resuelve en el suyo. Con runsc, sd-motor no pone ese
// seccomp (gVisor no lo aplica sin --oci-seccomp): que salgan bien no es una fuga.
var dentroDeGVisor = map[string]bool{
	"ptrace attach to its own child": true,
	"process_vm_readv":               true,
	"keyctl":                         true,
}

func leer(ruta string) []intento {
	f, err := os.Open(ruta)
	if err != nil {
		return nil
	}
	defer f.Close()
	var r []intento
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var i intento
		if json.Unmarshal(sc.Bytes(), &i) == nil {
			r = append(r, i)
		}
	}
	return r
}

type peticion struct {
	nombre string
	cfg    map[string]any
}

// peticiones: la creación de la trampa de escape, cada vez con una fuga.
func peticiones(datos string, m plan.Manifiesto) []peticion {
	base := func() map[string]any {
		return map[string]any{
			"Image":  m.Contenedor.Imagen,
			"Labels": map[string]string{"sugardaddy.trampa": "prueba-escape", "sugardaddy.sensor": "banco-escape"},
			"HostConfig": map[string]any{
				"NetworkMode": "sugardaddy-trampas-aisladas", "ReadonlyRootfs": true,
				"CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges"},
				"Memory": 64 << 20, "MemorySwap": 64 << 20, "NanoCpus": 500_000_000, "PidsLimit": 256,
				"Mounts": []map[string]any{{"Type": "bind", "Source": filepath.Join(datos, "registros", "prueba-escape"), "Target": "/log"}},
			},
		}
	}
	con := func(nombre string, f func(c, h map[string]any)) peticion {
		c := base()
		f(c, c["HostConfig"].(map[string]any))
		return peticion{nombre, c}
	}
	montar := func(origen, destino string) func(c, h map[string]any) {
		return func(_, h map[string]any) {
			h["Mounts"] = append(h["Mounts"].([]map[string]any), map[string]any{"Type": "bind", "Source": origen, "Target": destino})
		}
	}
	return []peticion{
		con("privileged", func(_, h map[string]any) { h["Privileged"] = true }),
		con("host network", func(_, h map[string]any) { h["NetworkMode"] = "host" }),
		con("host PID", func(_, h map[string]any) { h["PidMode"] = "host" }),
		con("host IPC", func(_, h map[string]any) { h["IpcMode"] = "host" }),
		con("host user namespace", func(_, h map[string]any) { h["UsernsMode"] = "host" }),
		con("device /dev/sda", func(_, h map[string]any) {
			h["Devices"] = []map[string]string{{"PathOnHost": "/dev/sda", "PathInContainer": "/dev/sda", "CgroupPermissions": "rwm"}}
		}),
		con("CapAdd SYS_ADMIN", func(_, h map[string]any) { h["CapAdd"] = []string{"SYS_ADMIN"} }),
		con("CapAdd NET_RAW", func(_, h map[string]any) { h["CapAdd"] = []string{"NET_RAW"} }),
		con("seccomp unconfined", func(_, h map[string]any) { h["SecurityOpt"] = []string{"no-new-privileges", "seccomp=unconfined"} }),
		con("apparmor unconfined", func(_, h map[string]any) { h["SecurityOpt"] = []string{"no-new-privileges", "apparmor=unconfined"} }),
		con("bind of the Docker socket", montar("/var/run/docker.sock", "/log/docker.sock")),
		con("bind of the host root", montar("/", "/log/host")),
		con("bind of /etc", montar("/etc", "/log/etc")),
		con("bind of the sensor folder", montar(datos, "/log/sensor")),
		con("Binds field", func(_, h map[string]any) { h["Binds"] = []string{"/:/host"} }),
		con("run as root", func(c, _ map[string]any) { c["User"] = "0:0" }),
		con("another image (a shell)", func(c, _ map[string]any) { c["Image"] = "alpine:3.20" }),
		con("own command", func(c, _ map[string]any) { c["Cmd"] = []string{"/bin/sh", "-c", "id"} }),
		con("network with internet access", func(_, h map[string]any) { h["NetworkMode"] = "sugardaddy-trampas-salida-aisladas" }),
		con("join another container's network", func(_, h map[string]any) { h["NetworkMode"] = "container:sd-motor" }),
		con("runtime chosen by the sensor", func(_, h map[string]any) { h["Runtime"] = "runc" }),
		con("writable root", func(_, h map[string]any) { h["ReadonlyRootfs"] = false }),
		con("sysctls", func(_, h map[string]any) { h["Sysctls"] = map[string]string{"net.ipv4.ip_forward": "1"} }),
		con("cgroup parent", func(_, h map[string]any) { h["CgroupParent"] = "/" }),
	}
}
