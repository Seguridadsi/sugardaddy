package main

// Prueba de espacio lleno (-lleno): antes de atacar, se llena el espacio
// escribible acotado de la trampa (sus tmpfs: el /tmp de 16 MB que le pone el
// sensor) con ficheros viejos, como si llevara semanas recibiendo ataques, y
// se le dan unos minutos para recuperarse. Después la prueba sigue igual: los
// mismos ataques tienen que dar los mismos eventos.
//
// Es la regla para todas las trampas (docs/diseno/espacio-trampas.md): lo que
// una trampa escribe está acotado y lo limpia ella; con su espacio lleno de lo
// suyo vuelve a funcionar sola en menos de recuperacionLleno. Nació del /tmp
// de Cowrie, lleno en sensor-1 desde el 2026-11-12: toda descarga fallaba y la
// sesión del atacante se colgaba.
//
// Los volúmenes escribibles no se llenan aquí: en el banco no tienen disco
// propio y llenarlos llenaría el Docker entero. Los acota el disco de cada
// trampa (SEN-4) y los vigila el sensor.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/despliegue"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// Tiempo que tiene la trampa para recuperarse con su espacio lleno.
const recuperacionLleno = 2 * time.Minute

// Tras recuperarse, al menos esta parte de cada tmpfs tiene que estar libre.
const libreMinimo = 0.25

// tmpfsDe devuelve las rutas tmpfs de la trampa, de su inspección.
func tmpfsDe(info map[string]any) []string {
	host, _ := info["HostConfig"].(map[string]any)
	t, _ := host["Tmpfs"].(map[string]any)
	var rutas []string
	for r := range t {
		rutas = append(rutas, r)
	}
	sort.Strings(rutas)
	return rutas
}

// pidDe devuelve el PID del proceso principal de la trampa en la máquina de Docker.
func pidDe(info map[string]any) int {
	st, _ := info["State"].(map[string]any)
	f, _ := st["Pid"].(float64)
	return int(f)
}

type espacio struct{ total, libre int64 }

// ordenMedir dice, por cada ruta, «ruta bloques libres tamaño» (stat -f).
func ordenMedir(pid int, rutas []string) string {
	var b strings.Builder
	for _, r := range rutas {
		fmt.Fprintf(&b, "echo %s $(stat -f -c '%%b %%a %%S' /proc/%d/root%s)\n", r, pid, r)
	}
	return b.String()
}

func leerMedida(out string) map[string]espacio {
	m := map[string]espacio{}
	for _, l := range strings.Split(out, "\n") {
		var r string
		var bl, li, tam int64
		if n, _ := fmt.Sscanf(strings.TrimSpace(l), "%s %d %d %d", &r, &bl, &li, &tam); n == 4 {
			m[r] = espacio{total: bl * tam, libre: li * tam}
		}
	}
	return m
}

// ordenLlenar rellena cada ruta hasta que no cabe más, con ficheros de hace un
// día (lo viejo es lo que una trampa debe poder tirar) y de su usuario.
func ordenLlenar(pid int, rutas []string) string {
	var b strings.Builder
	// Hace un día, en el formato de touch -t (vale en busybox y en coreutils).
	b.WriteString("ayer=$(date -d @$(( $(date +%s) - 86400 )) +%Y%m%d%H%M)\n")
	for _, r := range rutas {
		d := fmt.Sprintf("/proc/%d/root%s", pid, r)
		fmt.Fprintf(&b, "i=0; while dd if=/dev/zero of=%s/sd-relleno-$i bs=1M count=4 2>/dev/null; do i=$((i+1)); [ $i -lt 4096 ] || break; done\n", d)
		// Del usuario de la trampa, como lo que le dejan los atacantes: un /tmp
		// con sticky bit no le deja borrar lo de otro.
		fmt.Fprintf(&b, "chown \"$(awk '/^Uid:/ {print $2}' /proc/%d/status):$(awk '/^Gid:/ {print $2}' /proc/%d/status)\" %s/sd-relleno-*\n", pid, pid, d)
		fmt.Fprintf(&b, "touch -t \"$ayer\" %s/sd-relleno-*\n", d)
	}
	return b.String()
}

// ayudante corre un guion como root en la máquina de Docker (ve /proc de todos).
func ayudante(ctx context.Context, d *docker.Cliente, imagen, guion string) (string, error) {
	if err := d.AsegurarImagen(ctx, imagen); err != nil {
		return "", err
	}
	cid, err := d.Crear(ctx, fmt.Sprintf("sd-banco-lleno-%d", time.Now().UnixNano()), map[string]any{
		"Image":      imagen,
		"Entrypoint": []string{"sh", "-c"},
		"Cmd":        []string{guion},
		"User":       "root",
		"Labels":     map[string]string{"sugardaddy.banco": "lleno"},
		"HostConfig": map[string]any{
			"PidMode": "host", "Privileged": true, "NetworkMode": "none",
			"LogConfig": docker.RegistrosAcotados(),
		},
	})
	if err != nil {
		return "", err
	}
	defer func() { _ = d.Borrar(context.WithoutCancel(ctx), cid) }()
	if err := d.Arrancar(ctx, cid); err != nil {
		return "", err
	}
	codigo, err := d.Esperar(ctx, cid)
	out, _ := d.Salida(ctx, cid, 50)
	if err != nil || codigo != 0 {
		return out, fmt.Errorf("el ayudante acabó con %d: %v\n%s", codigo, err, out)
	}
	return out, nil
}

// llenarYRecuperar: si la trampa ha escrito en su tmpfs en la primera pasada,
// se le llena de ficheros viejos y, pasado recuperacionLleno, tiene que haber
// dejado al menos libreMinimo libre. Si no ha escrito nada, no le afecta.
func llenarYRecuperar(ctx context.Context, d *docker.Cliente, sensor, trampa, imagen string) error {
	id, err := despliegue.ContenedorDeTrampa(ctx, d, sensor, trampa)
	if err != nil || id == "" {
		return fmt.Errorf("lleno: no encuentro el contenedor de la trampa: %v", err)
	}
	info, err := d.Inspeccionar(ctx, id)
	if err != nil {
		return err
	}
	rutas, pid := tmpfsDe(info), pidDe(info)
	if len(rutas) == 0 || pid <= 0 {
		fmt.Println("lleno: la trampa no tiene tmpfs; nada que probar")
		return nil
	}
	out, err := ayudante(ctx, d, imagen, ordenMedir(pid, rutas))
	if err != nil {
		return fmt.Errorf("lleno: no se pudo medir su espacio (¿gVisor?): %w", err)
	}
	antes := leerMedida(out)
	var usadas []string
	for _, r := range rutas {
		e, ok := antes[r]
		if !ok {
			return fmt.Errorf("lleno: no se pudo medir %s:\n%s", r, out)
		}
		usado := e.total - e.libre
		fmt.Printf("lleno: %s usa %d KB de %d KB tras la primera pasada\n", r, usado/1024, e.total/1024)
		if usado > 0 {
			usadas = append(usadas, r)
		}
	}
	if len(usadas) == 0 {
		fmt.Println("lleno: la trampa no escribe en sus tmpfs; nada que probar")
		return nil
	}
	if _, err := ayudante(ctx, d, imagen, ordenLlenar(pid, usadas)); err != nil {
		return fmt.Errorf("lleno: %w", err)
	}
	fmt.Printf("lleno: %s llenos; se le dan %s para limpiarlos\n", strings.Join(usadas, ", "), recuperacionLleno)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(recuperacionLleno):
	}
	out, err = ayudante(ctx, d, imagen, ordenMedir(pid, usadas))
	if err != nil {
		return fmt.Errorf("lleno: %w", err)
	}
	despues := leerMedida(out)
	for _, r := range usadas {
		e := despues[r]
		fmt.Printf("lleno: %s con %d KB libres de %d KB tras %s\n", r, e.libre/1024, e.total/1024, recuperacionLleno)
		if e.total == 0 || float64(e.libre) < libreMinimo*float64(e.total) {
			return fmt.Errorf("la trampa escribe en %s y no lo limpia: lleno, se queda lleno (docs/diseno/espacio-trampas.md)", r)
		}
	}
	return nil
}
