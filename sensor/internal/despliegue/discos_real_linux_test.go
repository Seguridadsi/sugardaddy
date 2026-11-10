//go:build linux

package despliegue

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// TestDiscosReal es la prueba de verdad que lanza herramientas/probar-discos-trampa.sh:
// corre dentro de un contenedor como el del sensor (la carpeta de datos con
// rslave y el socket de Docker), con el auxiliar de verdad (la imagen del
// actualizador construida en local) y una trampa de verdad. Sin SD_DISCOS_REAL no
// hace nada. Para no tocar nada de la máquina, la trampa va sin red y todo lleva
// el nombre del sensor de la prueba.
func TestDiscosReal(t *testing.T) {
	datos := os.Getenv("SD_DISCOS_REAL")
	if datos == "" {
		t.Skip("solo dentro de herramientas/probar-discos-trampa.sh")
	}
	ctx := context.Background()
	sensor, imagen, trampaImg := os.Getenv("SD_DISCOS_SENSOR"), os.Getenv("SD_DISCOS_AUXILIAR"), os.Getenv("SD_DISCOS_TRAMPA")
	d := docker.Nuevo("/var/run/docker.sock")
	g := &discos.Gestor{Datos: datos, Imagen: imagen, TamMb: 64, Docker: d}
	o := Opciones{Datos: datos, Escucha: "127.0.0.1", Discos: g}
	s := plan.TrampaPlan{ID: "t1", Manifiesto: plan.Manifiesto{
		Contenedor:  &plan.Contenedor{Imagen: trampaImg, Registros: "/registros", Escribibles: []string{"/estado"}},
		Aislamiento: &plan.Aislamiento{CPU: 0.5, MemoriaMb: 64, SoloLectura: true},
	}}
	nombre := "sd-" + sensor + "-t1"
	arrancar := func(conDisco bool) string {
		t.Helper()
		cfg, _, err := config(o, sensor, "", s, conDisco, nil)
		if err != nil {
			t.Fatal(err)
		}
		cfg["HostConfig"].(map[string]any)["NetworkMode"] = "none"
		_ = d.Borrar(ctx, nombre)
		id, err := d.Crear(ctx, nombre, cfg)
		if err == nil {
			err = d.Arrancar(ctx, id)
		}
		if err != nil {
			t.Fatalf("la trampa no arranca (disco=%v): %v", conDisco, err)
		}
		g.Usar("t1", conDisco)
		return id
	}
	leer := func(f string) string {
		b, _ := os.ReadFile(filepath.Join(Registros(o, "t1"), f))
		return string(b)
	}
	esperar := func(que string, cond func() bool) {
		t.Helper()
		for i := 0; i < 60; i++ {
			if cond() {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
		t.Fatalf("no llega: %s", que)
	}

	if privada := os.Getenv("SD_DISCOS_PRIVADA"); privada != "" {
		t.Log("0. una carpeta sin propagación en la máquina: el auxiliar no arranca y se dice")
		gp := &discos.Gestor{Datos: privada, Imagen: imagen, TamMb: 64, Docker: d, Propagacion: func() bool { return true }}
		if c := gp.Maquina(ctx, sensor+"privada", true); c != discos.CodigoSinPropagacion {
			t.Fatalf("la máquina con la carpeta privada: %q", c)
		}
	}
	t.Log("1. sin disco, como antes: escribe en la carpeta del sensor y en su volumen")
	if err := prepararRegistros(o, "t1"); err != nil {
		t.Fatal(err)
	}
	id := arrancar(false)
	// La trampa guarda su clave en su escribible (como Cowrie) y la copia en su registro.
	esperar("su registro y su clave sin disco", func() bool {
		return strings.Count(leer("t.json"), "\n") >= 5 && strings.Contains(leer("clave"), "-")
	})
	clave := leer("clave")
	if err := d.Borrar(ctx, id); err != nil {
		t.Fatal(err)
	}

	t.Log("2. la máquina puede y el disco se crea con lo de antes dentro")
	if c := g.Maquina(ctx, sensor, true); c != discos.CodigoFijo {
		t.Fatalf("la máquina: %s", c)
	}
	r := g.Asegurar(ctx, sensor, []discos.Montaje{conViejos(ctx, d, sensor, necesidad(s, "", nil))}, nil)
	if r["t1"].Codigo != "" || !g.Montado("t1") {
		t.Fatalf("montar: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(datos, "registros", "t1")); !os.IsNotExist(err) {
		t.Fatal("la carpeta de la máquina se ha vaciado")
	}
	g.Usar("t1", true)
	lineas := strings.Count(leer("t.json"), "\n")
	if lineas < 5 || leer("clave") != clave {
		t.Fatalf("su registro y su clave están en el disco: %d %q", lineas, leer("clave"))
	}
	// Con su disco, además, intenta llenarlo.
	s.Manifiesto.Contenedor.Entorno = map[string]any{"LLENAR": "si"}
	arrancar(true)
	esperar("su registro en el disco", func() bool { return strings.Count(leer("t.json"), "\n") >= lineas+5 })
	if leer("clave") != clave {
		t.Fatal("la clave de su escribible no cambia al pasar al disco")
	}

	t.Log("3. llena su disco y no pasa de él")
	esperar("el disco lleno", func() bool {
		var st syscall.Statfs_t
		return syscall.Statfs(discos.Registros(datos, "t1"), &st) == nil && st.Bavail*uint64(st.Bsize) < 1<<20
	})
	fi, err := os.Stat(discos.Fichero(datos, "t1"))
	if err != nil {
		t.Fatal(err)
	}
	ocupa := fi.Sys().(*syscall.Stat_t).Blocks * 512
	if ocupa > 64<<20 {
		t.Fatalf("en la máquina ocupa %d bytes, más que su disco", ocupa)
	}
	t.Logf("   lleno: en la máquina ocupa %d MiB de 64", ocupa>>20)

	t.Log("4. como tras un reinicio: sin el disco montado, Docker no puede arrancarla")
	if err := d.Parar(ctx, nombre); err != nil {
		t.Fatal(err)
	}
	desmontar(t, ctx, d, imagen, sensor, datos)
	if g.Montado("t1") {
		t.Fatal("sigue montado")
	}
	if err := d.Arrancar(ctx, nombre); err == nil {
		t.Fatal("arranca sin su disco: escribiría en el disco de la máquina")
	} else {
		t.Logf("   Docker no la arranca: %v", err)
	}
	if _, err := os.Stat(discos.Registros(datos, "t1")); !os.IsNotExist(err) {
		t.Fatal("y nada ha creado su carpeta en la máquina")
	}
	r = g.Asegurar(ctx, sensor, []discos.Montaje{conViejos(ctx, d, sensor, necesidad(s, "", nil))}, nil)
	if r["t1"].Codigo != "" || r["t1"].Nuevo || !g.Montado("t1") {
		t.Fatalf("montar otra vez (comprobado, el mismo): %+v", r)
	}
	if err := d.Arrancar(ctx, nombre); err != nil {
		t.Fatalf("con su disco arranca: %v", err)
	}

	t.Log("5. retirarla se lleva su disco")
	_ = d.Borrar(ctx, nombre)
	r = g.Asegurar(ctx, sensor, nil, []string{"t1"})
	time.Sleep(time.Second)
	for _, p := range []string{discos.Fichero(datos, "t1"), discos.Dir(datos, "t1")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s sigue ahí: %+v", p, r)
		}
	}
}

// desmontar el disco como lo haría un reinicio, con un contenedor privilegiado de la imagen del auxiliar.
func desmontar(t *testing.T, ctx context.Context, d *docker.Cliente, imagen, sensor, datos string) {
	t.Helper()
	nombre := "sd_disco_" + sensor + "_reinicio"
	_ = d.Borrar(ctx, nombre)
	id, err := d.Crear(ctx, nombre, map[string]any{
		"Image": imagen, "Entrypoint": []string{"umount"}, "Cmd": []string{"-l", discos.Dir(datos, "t1")},
		"HostConfig": map[string]any{"Privileged": true, "Mounts": []map[string]any{
			{"Type": "bind", "Source": datos, "Target": datos, "BindOptions": map[string]any{"Propagation": "rshared"}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Borrar(context.WithoutCancel(ctx), id) }()
	if err := d.Arrancar(ctx, id); err != nil {
		t.Fatal(err)
	}
	if c, err := d.Esperar(ctx, id); err != nil || c != 0 {
		salida, _ := d.Salida(ctx, id, 10)
		t.Fatalf("umount: %d %v %s", c, err, salida)
	}
}

// TestDiscosCowrieReal: con la imagen de Cowrie de verdad, sus dos VOLUME
// (/cowrie/cowrie-git/var y /cowrie/cowrie-git/etc) van también a su disco: Docker
// no le pone ningún volumen anónimo, etc trae lo de la imagen y, escriba donde
// escriba (con fsync, como un atacante con cuidado), no pasa de su disco. Sin
// SD_DISCOS_COWRIE no hace nada.
func TestDiscosCowrieReal(t *testing.T) {
	datos, img := os.Getenv("SD_DISCOS_REAL"), os.Getenv("SD_DISCOS_COWRIE")
	if datos == "" || img == "" {
		t.Skip("solo dentro de herramientas/probar-discos-trampa.sh, con la imagen de Cowrie")
	}
	ctx := context.Background()
	sensor, imagen := os.Getenv("SD_DISCOS_SENSOR"), os.Getenv("SD_DISCOS_AUXILIAR")
	d := docker.Nuevo("/var/run/docker.sock")
	g := &discos.Gestor{Datos: datos, Imagen: imagen, TamMb: 64, Docker: d}
	o := Opciones{Datos: datos, Escucha: "127.0.0.1", Discos: g}
	s := plan.TrampaPlan{ID: "cw", Manifiesto: plan.Manifiesto{
		Contenedor: &plan.Contenedor{Imagen: img, Registros: "/cowrie/cowrie-git/var/log/cowrie",
			Escribibles: []string{"/cowrie/cowrie-git/var/lib/cowrie"}},
		Aislamiento: &plan.Aislamiento{CPU: 1, MemoriaMb: 256, SoloLectura: true},
	}}
	vols, err := volumenesDeImagen(ctx, d, img)
	if err != nil || !slices.Contains(vols, "/cowrie/cowrie-git/etc") || !slices.Contains(vols, "/cowrie/cowrie-git/var") {
		t.Fatalf("los VOLUME de la imagen: %v %v", vols, err)
	}
	if c := g.Maquina(ctx, sensor, true); c != discos.CodigoFijo {
		t.Fatalf("la máquina: %s", c)
	}
	nec := necesidad(s, "", vols)
	if r := g.Asegurar(ctx, sensor, []discos.Montaje{conViejos(ctx, d, sensor, nec)}, nil); r["cw"].Codigo != "" || !g.Listo(nec) {
		t.Fatalf("montar: %+v", r)
	}
	cfg, _, err := config(o, sensor, "", s, true, vols)
	if err != nil {
		t.Fatal(err)
	}
	cfg["HostConfig"].(map[string]any)["NetworkMode"] = "none"
	crear := func(nombre string, cfg map[string]any) string {
		t.Helper()
		_ = d.Borrar(ctx, nombre)
		id, err := d.Crear(ctx, nombre, cfg)
		if err == nil {
			err = d.Arrancar(ctx, id)
		}
		if err != nil {
			t.Fatalf("%s no arranca: %v", nombre, err)
		}
		return id
	}

	t.Log("1. Cowrie arranca con sus VOLUME en su disco y sin volúmenes anónimos")
	id := crear("sd-"+sensor+"-cw", cfg)
	// Lo que trae la imagen en esas carpetas (en la 3.1.2-sd5: etc/.gitignore y var/run),
	// copiado por Docker al disco la primera vez, como en un volumen.
	for _, f := range []string{
		filepath.Join(discos.Dir(datos, "cw"), discos.CarpetaImagen("/cowrie/cowrie-git/etc"), ".gitignore"),
		filepath.Join(discos.Dir(datos, "cw"), discos.CarpetaImagen("/cowrie/cowrie-git/var"), "run"),
	} {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("en su disco, con lo que trae la imagen: %v", err)
		}
	}
	time.Sleep(15 * time.Second)
	i, err := d.Inspeccionar(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := i["State"].(map[string]any); st["Running"] != true {
		salida, _ := d.Salida(ctx, id, 30)
		t.Fatalf("Cowrie no sigue en marcha: %v\n%s", st, salida)
	}
	for _, m := range i["Mounts"].([]any) {
		m := m.(map[string]any)
		if m["Type"] == "volume" && !strings.HasPrefix(fmt.Sprint(m["Name"]), "sd_disco_") {
			t.Fatalf("un volumen que no es de su disco (anónimo, en la máquina): %v", m)
		}
	}
	_ = d.Borrar(ctx, id)

	t.Log("2. con su Python y fsync, escribe en var, en etc y en su escribible: para en su disco")
	llenar := `
import os
for d in ['/cowrie/cowrie-git/var', '/cowrie/cowrie-git/etc', '/cowrie/cowrie-git/var/lib/cowrie']:
    n, fd = 0, -1
    try:
        fd = os.open(d + '/relleno', os.O_WRONLY | os.O_CREAT, 0o600)
        b = bytes(1 << 20)
        for _ in range(200):
            os.write(fd, b)
            n += 1
            if n % 8 == 0:
                os.fsync(fd)
        os.fsync(fd)
        print(d, n, 'sin-tope', flush=True)
    except OSError as e:
        print(d, n, 'para:', e.strerror, flush=True)
    if fd >= 0:
        os.close(fd)
    try:
        os.remove(d + '/relleno')
    except OSError:
        pass
`
	cfg["Cmd"] = []string{"-c", llenar}
	delete(cfg["HostConfig"].(map[string]any), "RestartPolicy")
	id = crear("sd-"+sensor+"-cw-llenar", cfg)
	defer func() { _ = d.Borrar(context.WithoutCancel(ctx), id) }()
	espera, cancelar := context.WithTimeout(ctx, 5*time.Minute)
	defer cancelar()
	if _, err := d.Esperar(espera, id); err != nil {
		t.Fatal(err)
	}
	salida, _ := d.Salida(ctx, id, 20)
	t.Logf("   %s", strings.ReplaceAll(strings.TrimSpace(salida), "\n", "\n   "))
	if strings.Contains(salida, "sin-tope") || strings.Count(salida, "para: No space left on device") != 3 {
		t.Fatalf("en ninguna carpeta pasa de su disco de 64 MiB:\n%s", salida)
	}
	fi, err := os.Stat(discos.Fichero(datos, "cw"))
	if err != nil {
		t.Fatal(err)
	}
	if ocupa := fi.Sys().(*syscall.Stat_t).Blocks * 512; ocupa > 64<<20 {
		t.Fatalf("en la máquina ocupa %d bytes, más que su disco", ocupa)
	}
	_ = d.Borrar(ctx, id)
	if r := g.Asegurar(ctx, sensor, nil, []string{"cw"}); r != nil && r["cw"].Codigo != "" {
		t.Fatalf("retirar: %+v", r)
	}
}
