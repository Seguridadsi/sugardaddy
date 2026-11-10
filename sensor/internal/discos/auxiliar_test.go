package discos

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// maquinaFalsa hace de mount, umount, losetup, mkfs y e2fsck: apunta lo que se le
// pide y «monta» marcando la carpeta. cp es el de verdad.
type maquinaFalsa struct {
	ordenes  []string
	montados map[string]bool
	enLoop   map[string]bool // ficheros que siguen en un dispositivo loop
	fallos   map[string]error
	salidas  map[string]string
	e2fsck   []int // códigos de salida de cada e2fsck, por orden
	libre    int64
	cpFalla  bool
}

func salida(codigo int) error {
	err := exec.Command("sh", "-c", "exit "+string(rune('0'+codigo))).Run()
	return err
}

func (m *maquinaFalsa) ejecutar(ctx context.Context, orden string, args ...string) (string, error) {
	linea := orden + " " + strings.Join(args, " ")
	m.ordenes = append(m.ordenes, linea)
	if err := m.fallos[orden]; err != nil {
		return m.salidas[orden], err
	}
	switch orden {
	case "mount":
		m.montados[args[len(args)-1]] = true
	case "umount":
		delete(m.montados, args[len(args)-1])
	case "losetup":
		if m.enLoop[args[len(args)-1]] {
			return "/dev/loop7\n", nil
		}
	case "e2fsck":
		if len(m.e2fsck) > 0 {
			c := m.e2fsck[0]
			m.e2fsck = m.e2fsck[1:]
			if c != 0 {
				return "", salida(c)
			}
		}
	case "cp":
		if m.cpFalla {
			return "cp: no space left on device", errors.New("exit status 1")
		}
		return Exec(ctx, orden, args...)
	}
	return "", nil
}

func (m *maquinaFalsa) hizo(prefijo string) bool {
	return slices.ContainsFunc(m.ordenes, func(o string) bool { return strings.HasPrefix(o, prefijo) })
}

func nuevaMaquina(t *testing.T) (*maquinaFalsa, *Auxiliar, string) {
	t.Helper()
	datos := t.TempDir()
	ctrl := filepath.Join(t.TempDir(), "loop-control")
	if err := os.WriteFile(ctrl, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	m := &maquinaFalsa{montados: map[string]bool{}, enLoop: map[string]bool{}, fallos: map[string]error{}, salidas: map[string]string{}, libre: 100 << 30}
	a := &Auxiliar{
		Ejecutar:    m.ejecutar,
		Montado:     func(dir string) bool { return m.montados[dir] },
		Libre:       func(string) (int64, error) { return m.libre, nil },
		LoopControl: ctrl,
		Reserva:     1 << 30,
	}
	raiz := raizViejos
	raizViejos = filepath.Join(t.TempDir(), "viejos")
	t.Cleanup(func() { raizViejos = raiz })
	return m, a, datos
}

func TestDiscoNuevoConLoQueHabiaAntes(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	// Lo que la trampa tenía sin disco: su registro y su semilla, y las claves de su volumen.
	antes := filepath.Join(datos, "registros", "t1")
	_ = os.MkdirAll(antes, 0o777)
	_ = os.WriteFile(filepath.Join(antes, "cowrie.json"), []byte("{\"a\":1}\n"), 0o644)
	_ = os.WriteFile(filepath.Join(antes, "semilla"), []byte("s"), 0o600)
	viejo := ViejoEn("t1", 0)
	_ = os.MkdirAll(viejo, 0o750)
	_ = os.WriteFile(filepath.Join(viejo, "ssh_host_ed25519_key"), []byte("clave"), 0o600)

	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1", Escribibles: 1, Viejos: []int{0}}}})
	if r.Codigo != "" || r.Discos["t1"].Codigo != "" || !r.Discos["t1"].Nuevo {
		t.Fatalf("resultado: %+v", r)
	}
	img := Fichero(datos, "t1")
	fi, err := os.Stat(img)
	if err != nil || fi.Size() != 1024<<20 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("el fichero del disco: %v %v", fi, err)
	}
	if !m.hizo("mkfs.ext4 -q -F -m 0 -J size=4 -i 65536 -O ^orphan_file,^metadata_csum_seed") ||
		!m.hizo("mount -t ext4 -o loop,nosuid,nodev,noexec "+img+" "+Dir(datos, "t1")) {
		t.Fatalf("órdenes: %v", m.ordenes)
	}
	reg, _ := os.Stat(Registros(datos, "t1"))
	if reg == nil || reg.Mode()&os.ModeSticky == 0 || reg.Mode().Perm() != 0o777 {
		t.Fatalf("la carpeta de registros del disco: %v", reg)
	}
	if b, _ := os.ReadFile(filepath.Join(Registros(datos, "t1"), "cowrie.json")); string(b) != "{\"a\":1}\n" {
		t.Fatalf("el registro sin leer pasa al disco: %q", b)
	}
	if _, err := os.Stat(antes); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("la carpeta de la máquina se vacía: si no, ocuparía sitio y confundiría")
	}
	if b, _ := os.ReadFile(filepath.Join(Escribible(datos, "t1", 0), "ssh_host_ed25519_key")); string(b) != "clave" {
		t.Fatal("las claves de Cowrie pasan del volumen al disco")
	}
	if fi, _ := os.Stat(Escribible(datos, "t1", 0)); fi.Mode().Perm() != 0o750 {
		t.Fatalf("la escribible queda con los permisos de la de antes: %v", fi.Mode())
	}
}

func TestDiscoQueYaExisteSeCompruebaAntes(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	_ = os.MkdirAll(filepath.Join(datos, Carpeta), 0o700)
	_ = os.WriteFile(Fichero(datos, "t1"), nil, 0o600)
	m.e2fsck = []int{4, 1}
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}}})
	if r.Discos["t1"].Codigo != "" || r.Discos["t1"].Nuevo || m.hizo("mkfs") {
		t.Fatalf("resultado: %+v, órdenes %v", r, m.ordenes)
	}
	if !m.hizo("e2fsck -p") || !m.hizo("e2fsck -y") || !m.montados[Dir(datos, "t1")] {
		t.Fatalf("se comprueba (y se repara) antes de montar: %v", m.ordenes)
	}

	m.montados = map[string]bool{}
	m.e2fsck = []int{4, 4}
	r = a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}}})
	if r.Discos["t1"].Codigo != CodigoError || r.Codigo != "" || m.montados[Dir(datos, "t1")] {
		t.Fatalf("un disco que no se puede reparar no se monta, y es cosa de ese disco: %+v", r)
	}
	if _, err := os.Stat(Fichero(datos, "t1")); err != nil {
		t.Fatal("ni se borra: lo que tenga puede servir")
	}
}

func TestDiscoQueSigueEnUnLoopNiSeComprueba(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	_ = os.MkdirAll(filepath.Join(datos, Carpeta), 0o700)
	_ = os.WriteFile(Fichero(datos, "t1"), nil, 0o600)
	m.enLoop[Fichero(datos, "t1")] = true
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}}})
	if r.Discos["t1"].Codigo != "" || m.hizo("e2fsck") || !m.hizo("mount") {
		t.Fatalf("en uso no se comprueba (lo estropearía) y se monta el mismo dispositivo: %+v %v", r, m.ordenes)
	}
}

func TestYaMontadoSoloSusCarpetas(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	m.montados[Dir(datos, "t1")] = true
	etc := CarpetaImagen("/cowrie/cowrie-git/etc")
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1", Escribibles: 2, Carpetas: []string{etc}}}})
	if r.Discos["t1"].Codigo != "" || m.hizo("mount") || m.hizo("mkfs") {
		t.Fatalf("%+v %v", r, m.ordenes)
	}
	for _, p := range []string{Escribible(datos, "t1", 1), filepath.Join(Dir(datos, "t1"), etc)} {
		if e, err := os.ReadDir(p); err != nil || len(e) != 0 {
			t.Fatalf("%s, vacía para que Docker la llene: %v %v", p, e, err)
		}
	}
}

func TestSinLoopNingunoYSeDicePorQue(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	a.LoopControl = filepath.Join(datos, "no-existe")
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}, {ID: "t2"}}})
	if r.Codigo != CodigoSinLoop || r.Discos["t2"].Codigo != CodigoSinLoop || len(m.ordenes) != 0 {
		t.Fatalf("%+v %v", r, m.ordenes)
	}
}

func TestMontarFallaPorLaMaquina(t *testing.T) {
	for _, c := range []struct {
		dice   string
		codigo string
	}{
		{"mount: /x: failed to setup loop device for /x.img.", CodigoSinLoop},
		{"mount: /x: permission denied.", CodigoSinPermiso},
		{"mount: /x: wrong fs type, bad option, bad superblock", CodigoError},
	} {
		m, a, datos := nuevaMaquina(t)
		m.fallos["mount"], m.salidas["mount"] = errors.New("exit status 32"), c.dice
		r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}, {ID: "t2"}}})
		if r.Discos["t1"].Codigo != c.codigo {
			t.Fatalf("%q: %+v", c.dice, r)
		}
		if _, err := os.Stat(Fichero(datos, "t1")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%q: el disco nuevo que no se monta se borra", c.dice)
		}
		if DeLaMaquina(c.codigo) != (r.Codigo == c.codigo) || DeLaMaquina(c.codigo) != (r.Discos["t2"].Codigo == c.codigo && strings.Count(strings.Join(m.ordenes, "\n"), "mount ") == 1) {
			t.Fatalf("%q: lo de la máquina vale para todos y no se sigue intentando: %+v %v", c.dice, r, m.ordenes)
		}
	}
}

func TestSinSitioParaSuDisco(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	m.libre = 1500 << 20
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}}})
	if r.Discos["t1"].Codigo != CodigoSinEspacio || r.Codigo != "" || m.hizo("mkfs") {
		t.Fatalf("1 GiB más 1 GiB de reserva no caben en 1,5 GiB: %+v", r)
	}
}

func TestSiNoPuedeTraerLoDeAntesSeQuedaComoEstaba(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	antes := filepath.Join(datos, "registros", "t1")
	_ = os.MkdirAll(antes, 0o777)
	_ = os.WriteFile(filepath.Join(antes, "cowrie.json"), []byte("x\n"), 0o644)
	m.cpFalla = true
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}}})
	if r.Discos["t1"].Codigo != CodigoError || m.montados[Dir(datos, "t1")] {
		t.Fatalf("%+v", r)
	}
	if _, err := os.Stat(Fichero(datos, "t1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("el disco nuevo a medias se borra")
	}
	if _, err := os.Stat(filepath.Join(antes, "cowrie.json")); err != nil {
		t.Fatal("y lo de antes sigue en la máquina, sin perder nada")
	}
}

func TestRetirarDesmontaYBorra(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	_ = os.MkdirAll(Registros(datos, "t1"), 0o755)
	_ = os.WriteFile(Fichero(datos, "t1"), nil, 0o600)
	m.montados[Dir(datos, "t1")] = true
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, Retirar: []string{"t1"}})
	if r.Discos["t1"].Codigo != "" || !m.hizo("umount -l "+Dir(datos, "t1")) {
		t.Fatalf("%+v %v", r, m.ordenes)
	}
	for _, p := range []string{Fichero(datos, "t1"), Dir(datos, "t1")} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s sigue ahí", p)
		}
	}
	// Sin dispositivos loop también se retira: no los necesita.
	a.LoopControl = filepath.Join(datos, "no-existe")
	_ = os.WriteFile(Fichero(datos, "t2"), nil, 0o600)
	if r := a.Aplicar(context.Background(), Pedido{Datos: datos, Retirar: []string{"t2"}}); r.Discos["t2"].Codigo != "" || r.Codigo != "" {
		t.Fatalf("%+v", r)
	}
}

func TestProbar(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Probar: true})
	if r.Codigo != "" || !m.hizo("mkfs.ext4") || !m.hizo("mount") || !m.hizo("umount -l") {
		t.Fatalf("%+v %v", r, m.ordenes)
	}
	if e, _ := os.ReadDir(filepath.Join(datos, Carpeta)); len(e) != 0 {
		t.Fatalf("la prueba no deja nada: %v", e)
	}
	m.fallos["mount"], m.salidas["mount"] = errors.New("exit status 32"), "mount: permission denied"
	m.libre = 0 // sin sitio para un disco de verdad se prueba igual
	if r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Probar: true}); r.Codigo != CodigoSinPermiso {
		t.Fatalf("%+v", r)
	}
}

func TestUnaImagenSinLasHerramientasNoSirve(t *testing.T) {
	m, a, datos := nuevaMaquina(t)
	a.Herramientas = []string{"sd-no-existe-esta-orden"}
	r := a.Aplicar(context.Background(), Pedido{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}}})
	if r.Codigo != CodigoSinAuxiliar || r.Discos["t1"].Codigo != CodigoSinAuxiliar || len(m.ordenes) != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestPedidosQueNoSeAceptan(t *testing.T) {
	_, a, datos := nuevaMaquina(t)
	for _, p := range []Pedido{
		{Datos: "relativa", TamMb: 1024},
		{Datos: "/", TamMb: 1024},
		{Datos: datos + "/../x", TamMb: 1024},
		{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "../t1"}}},
		{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "a..b"}}},
		{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1"}, {ID: "t1"}}},
		{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1", Escribibles: 1, Viejos: []int{1}}}},
		{Datos: datos, TamMb: 1 << 20, Montar: []Montaje{{ID: "t1"}}},
		{Datos: datos, Retirar: []string{"x/y"}},
		{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1", Carpetas: []string{"../registros"}}}},
		{Datos: datos, TamMb: 1024, Montar: []Montaje{{ID: "t1", Carpetas: []string{"escribible-0"}}}},
	} {
		if r := a.Aplicar(context.Background(), p); r.Codigo != CodigoError {
			t.Fatalf("%+v: %+v", p, r)
		}
	}
}
