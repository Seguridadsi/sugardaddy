package discos

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// gestorFalso: el auxiliar es un doble que «monta» creando la carpeta de registros
// y marcándola como montada.
type gestorFalso struct {
	g        *Gestor
	pedidos  []Pedido
	montados map[string]bool
	responde func(p Pedido) (Resultado, error)
	ahora    time.Time
}

func nuevoGestor(t *testing.T) *gestorFalso {
	t.Helper()
	f := &gestorFalso{montados: map[string]bool{}, ahora: time.Unix(1_800_000_000, 0)}
	f.g = &Gestor{
		Datos:       t.TempDir(),
		Imagen:      "r/actualizador@sha256:1",
		Propagacion: func() bool { return true },
		Ve:          func(dir string) bool { return f.montados[dir] },
		Ahora:       func() time.Time { return f.ahora },
	}
	f.g.Lanzar = func(_ context.Context, nombre string, p Pedido) (Resultado, error) {
		if nombre != "sd_disco_s1" {
			t.Fatalf("nombre del auxiliar: %s", nombre)
		}
		f.pedidos = append(f.pedidos, p)
		if f.responde != nil {
			return f.responde(p)
		}
		r := Resultado{Discos: map[string]Estado{}}
		for _, m := range p.Montar {
			_ = subcarpetas(p.Datos, m)
			f.montados[Dir(p.Datos, m.ID)] = true
			r.Discos[m.ID] = Estado{}
		}
		for _, id := range p.Retirar {
			delete(f.montados, Dir(p.Datos, id))
			r.Discos[id] = Estado{}
		}
		return r, nil
	}
	return f
}

func TestLaMaquinaSeAveriguaUnaVez(t *testing.T) {
	ctx := context.Background()
	f := nuevoGestor(t)
	if c := f.g.Maquina(ctx, "s1", false); c != "" || len(f.pedidos) != 0 {
		t.Fatal("sin trampas no se prueba nada")
	}
	if c := f.g.Maquina(ctx, "s1", true); c != CodigoFijo || len(f.pedidos) != 1 || !f.pedidos[0].Probar || f.pedidos[0].TamMb != TamPorDefecto {
		t.Fatalf("se prueba con el auxiliar: %s %+v", c, f.pedidos)
	}
	f.g.Maquina(ctx, "s1", true)
	if len(f.pedidos) != 1 {
		t.Fatal("una vez basta")
	}
	if v, motivo, sabido := f.g.Estado(); !v || motivo != CodigoFijo || !sabido {
		t.Fatalf("hecho: %v %s %v", v, motivo, sabido)
	}
}

func TestLaMaquinaSinAuxiliarOSinPropagacion(t *testing.T) {
	ctx := context.Background()
	f := nuevoGestor(t)
	f.g.Propagacion = func() bool { return false }
	if c := f.g.Maquina(ctx, "s1", true); c != CodigoSinPropagacion || len(f.pedidos) != 0 {
		t.Fatalf("%s %v", c, f.pedidos)
	}
	g := &Gestor{Datos: t.TempDir(), Propagacion: func() bool { return true }}
	if c := g.Maquina(ctx, "s1", true); c != CodigoSinAuxiliar {
		t.Fatal(c)
	}
	if v, motivo, sabido := g.Estado(); v || motivo != CodigoSinAuxiliar || !sabido {
		t.Fatalf("hecho: %v %s %v", v, motivo, sabido)
	}
}

func TestConUnDiscoMontadoNiSePrueba(t *testing.T) {
	f := nuevoGestor(t)
	_ = os.MkdirAll(Registros(f.g.Datos, "t1"), 0o755)
	f.montados[Dir(f.g.Datos, "t1")] = true
	if c := f.g.Maquina(context.Background(), "s1", true); c != CodigoFijo || len(f.pedidos) != 0 {
		t.Fatalf("%s %v", c, f.pedidos)
	}
}

func TestLaPruebaFallaPorLaMaquinaOPorUnRato(t *testing.T) {
	ctx := context.Background()
	f := nuevoGestor(t)
	f.responde = func(Pedido) (Resultado, error) { return Resultado{}, errors.New("la imagen no baja") }
	if c := f.g.Maquina(ctx, "s1", true); c != "" {
		t.Fatal(c)
	}
	f.ahora = f.ahora.Add(30 * time.Second)
	f.g.Maquina(ctx, "s1", true)
	if len(f.pedidos) != 1 {
		t.Fatal("tras un fallo pasajero no se lanza otro auxiliar enseguida")
	}
	f.ahora = f.ahora.Add(time.Minute)
	f.responde = func(Pedido) (Resultado, error) { return Resultado{Codigo: CodigoSinLoop}, nil }
	if c := f.g.Maquina(ctx, "s1", true); c != CodigoSinLoop || len(f.pedidos) != 2 {
		t.Fatalf("%s %d", c, len(f.pedidos))
	}
}

func TestAsegurar(t *testing.T) {
	ctx := context.Background()
	f := nuevoGestor(t)
	f.g.Maquina(ctx, "s1", true)
	_ = os.WriteFile(Fichero(f.g.Datos, "vieja"), nil, 0o600)
	r := f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t1", Escribibles: 1}}, []string{"vieja"})
	if r["t1"].Codigo != "" || !f.g.Montado("t1") || f.g.Fallo("t1") != "" {
		t.Fatalf("%+v", r)
	}
	ultimo := f.pedidos[len(f.pedidos)-1]
	if len(ultimo.Montar) != 1 || len(ultimo.Retirar) != 1 {
		t.Fatalf("montar y retirar van en el mismo auxiliar: %+v", ultimo)
	}

	// Un disco que no cabe: esa trampa va sin disco, las demás no cambian.
	f.responde = func(p Pedido) (Resultado, error) {
		return Resultado{Discos: map[string]Estado{"t2": {Codigo: CodigoSinEspacio}}}, nil
	}
	r = f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t2"}}, nil)
	if r["t2"].Codigo != CodigoSinEspacio || f.g.Fallo("t2") != CodigoSinEspacio {
		t.Fatalf("%+v", r)
	}
	if c := f.g.Maquina(ctx, "s1", true); c != CodigoFijo {
		t.Fatal("un disco sin sitio no dice nada de la máquina")
	}

	// Montado en la máquina pero el sensor no lo ve: su carpeta no recibe montajes.
	f.responde = func(p Pedido) (Resultado, error) { return Resultado{Discos: map[string]Estado{"t3": {}}}, nil }
	r = f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t3"}}, nil)
	if r["t3"].Codigo != CodigoSinPropagacion || f.g.Maquina(ctx, "s1", true) != CodigoSinPropagacion {
		t.Fatalf("%+v", r)
	}
	n := len(f.pedidos)
	if r := f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t4"}}, nil); r["t4"].Codigo != CodigoSinPropagacion || len(f.pedidos) != n {
		t.Fatal("con la máquina sin discos no se lanza el auxiliar para montar")
	}
}

func TestListoConTodasSusCarpetas(t *testing.T) {
	f := nuevoGestor(t)
	m := Montaje{ID: "t1", Escribibles: 1, Carpetas: []string{CarpetaImagen("/cowrie/cowrie-git/etc")}}
	_ = os.MkdirAll(Registros(f.g.Datos, "t1"), 0o755)
	f.montados[Dir(f.g.Datos, "t1")] = true
	if f.g.Listo(m) {
		t.Fatal("le faltan la escribible y la del VOLUME de la imagen")
	}
	_ = subcarpetas(f.g.Datos, m)
	if !f.g.Listo(m) {
		t.Fatal("ya las tiene")
	}
	if CarpetaImagen("/cowrie/cowrie-git/etc") != CarpetaImagen("/cowrie/cowrie-git/etc/") || CarpetaImagen("/a") == CarpetaImagen("/b") {
		t.Fatal("una carpeta por ruta, siempre la misma")
	}
}

func TestAsegurarConFalloPasajeroNoInsiste(t *testing.T) {
	ctx := context.Background()
	f := nuevoGestor(t)
	f.g.Maquina(ctx, "s1", true)
	f.responde = func(Pedido) (Resultado, error) { return Resultado{}, errors.New("docker no contesta") }
	r := f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t1"}}, nil)
	if r["t1"].Codigo != CodigoError || f.g.Fallo("t1") != "" {
		t.Fatalf("pasajero: no se queda como fallo de la trampa: %+v", r)
	}
	n := len(f.pedidos)
	f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t1"}}, nil)
	if len(f.pedidos) != n {
		t.Fatal("ni se vuelve a lanzar enseguida")
	}
	f.ahora = f.ahora.Add(2 * time.Minute)
	f.responde = nil
	if r := f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t1"}}, nil); r["t1"].Codigo != "" {
		t.Fatalf("%+v", r)
	}
}

func TestRetiradaQueFallaEsperaUnaHora(t *testing.T) {
	ctx := context.Background()
	f := nuevoGestor(t)
	f.g.Maquina(ctx, "s1", true)
	f.responde = func(Pedido) (Resultado, error) {
		return Resultado{Discos: map[string]Estado{"vieja": {Codigo: CodigoError}}}, nil
	}
	f.g.Asegurar(ctx, "s1", nil, []string{"vieja"})
	n := len(f.pedidos)
	f.ahora = f.ahora.Add(10 * time.Minute)
	f.g.Asegurar(ctx, "s1", nil, []string{"vieja"})
	if len(f.pedidos) != n {
		t.Fatal("una retirada que falla no se reintenta cada 10 s")
	}
	f.ahora = f.ahora.Add(time.Hour)
	f.g.Asegurar(ctx, "s1", nil, []string{"vieja"})
	if len(f.pedidos) != n+1 {
		t.Fatal("pasada la hora, sí")
	}
}

func TestSinAuxiliarNiSeIntentaRetirar(t *testing.T) {
	ctx := context.Background()
	f := nuevoGestor(t)
	f.g.Propagacion = func() bool { return false }
	f.g.Maquina(ctx, "s1", true)
	if r := f.g.Asegurar(ctx, "s1", []Montaje{{ID: "t1"}}, []string{"vieja"}); r["t1"].Codigo != CodigoSinPropagacion || len(f.pedidos) != 0 {
		t.Fatalf("%+v %v", r, f.pedidos)
	}
}

func TestPresentesYRetirarSinAuxiliar(t *testing.T) {
	f := nuevoGestor(t)
	base := filepath.Join(f.g.Datos, Carpeta)
	_ = os.MkdirAll(filepath.Join(base, "t1"), 0o755)
	_ = os.WriteFile(filepath.Join(base, "t1.img"), nil, 0o600)
	_ = os.WriteFile(filepath.Join(base, "t2.img"), nil, 0o600)
	_ = os.MkdirAll(filepath.Join(base, ".prueba"), 0o755)
	if p := f.g.Presentes(); len(p) != 2 {
		t.Fatalf("%v", p)
	}
	f.montados[Dir(f.g.Datos, "t1")] = true
	if f.g.RetirarSinAuxiliar("t1") {
		t.Fatal("montado, lo retira el auxiliar")
	}
	if !f.g.RetirarSinAuxiliar("t2") {
		t.Fatal("sin montar, lo borra el sensor")
	}
	if _, err := os.Stat(filepath.Join(base, "t2.img")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("t2.img sigue")
	}
}

func TestUsaYOlvidar(t *testing.T) {
	f := nuevoGestor(t)
	f.g.Usar("t1", true)
	f.g.Usar("t2", false)
	if !f.g.Usa("t1") || f.g.Usa("t2") || f.g.Usa("t3") {
		t.Fatal("usa")
	}
	f.g.Olvidar(map[string]bool{"t2": true})
	if f.g.Usa("t1") {
		t.Fatal("olvidar")
	}
}

func TestRecibeMontajes(t *testing.T) {
	info := `22 1 0:20 / / rw shared:1 - overlay overlay rw
4292 4280 0:20 /opt/docker-rootfs/opt/sd/datos/sensor /opt/sd/datos/sensor rw,noatime master:29 - ext4 /dev/sda1 rw
4300 4280 0:20 /x /opt/otro rw - ext4 /dev/sda1 rw
4301 4280 0:20 /x /opt/con\040espacio rw master:3 - ext4 /dev/sda1 rw
`
	for datos, quiere := range map[string]bool{
		"/opt/sd/datos/sensor":       true,
		"/opt/sd/datos/sensor/sub":   true,
		"/opt/otro":                  false,
		"/opt/con espacio/sensor":    true,
		"/var/lib/fuera":             true, // cae en la raíz, que es shared
		"/opt/sd/datos/sensorialmen": true, // no es la del sensor: la raíz
	} {
		if recibeEn(info, datos) != quiere {
			t.Errorf("%s: quiere %v", datos, quiere)
		}
	}
	privada := "22 1 0:20 / / rw - overlay overlay rw\n"
	if recibeEn(privada, "/opt/sd") {
		t.Fatal("una raíz privada no recibe")
	}
}

func TestLeerResultado(t *testing.T) {
	salida := "algo de registro\n{\"v\":1,\"codigo\":\"disco.sin-loop\",\"detalle\":\"no\"}\n"
	if r := LeerResultado(salida, 0); r.Codigo != CodigoSinLoop {
		t.Fatalf("%+v", r)
	}
	if r := LeerResultado("missing ACTUALIZADOR_TOKEN", 2); r.Codigo != CodigoSinAuxiliar {
		t.Fatalf("un actualizador de antes no sabe de discos: %+v", r)
	}
	if r := LeerResultado("panic", 1); r.Codigo != CodigoError {
		t.Fatalf("%+v", r)
	}
	if _, err := deLaMaquina(errors.New("path /opt is mounted on / but it is not a shared mount")); err != nil {
		t.Fatal(err)
	}
	if r, _ := deLaMaquina(errors.New("privileged mode is incompatible with user namespaces")); r.Codigo != CodigoSinPermiso {
		t.Fatal(r)
	}
	if _, err := deLaMaquina(errors.New("No such image")); err == nil {
		t.Fatal("lo demás es pasajero")
	}
}
