package despliegue

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker/motorfalso"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// motorDiscos: un Docker falso con los contenedores y volúmenes que diga la prueba,
// que apunta en el mismo registro que el auxiliar falso (para ver el orden).
type motorDiscos struct {
	mu           sync.Mutex
	registro     *[]string
	contenedores []map[string]any
	volumenes    []map[string]any
	creados      []map[string]any
	// Los VOLUME que declara cada imagen, y si inspeccionarlas falla.
	volumenesImagen map[string][]string
	inspeccionFalla bool
	inspecciones    int
}

func (m *motorDiscos) servir(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := r.URL.Path
	*m.registro = append(*m.registro, r.Method+" "+p)
	responder := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch {
	case r.Method == http.MethodGet && p == "/containers/json":
		responder(m.contenedores)
	case r.Method == http.MethodGet && p == "/volumes":
		var filtros map[string][]string
		_ = json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filtros)
		var vs []map[string]any
		for _, v := range m.volumenes {
			etiquetas, _ := v["Labels"].(map[string]string)
			todas := true
			for _, f := range filtros["label"] {
				k, val, _ := strings.Cut(f, "=")
				if etiquetas[k] != val {
					todas = false
				}
			}
			if todas && len(filtros["label"]) > 0 {
				vs = append(vs, v)
			}
		}
		responder(map[string]any{"Volumes": vs})
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/networks/"):
		responder(map[string]any{"Options": map[string]string{"com.docker.network.bridge.enable_icc": "false", "com.docker.network.bridge.enable_ip_masquerade": "false"}, "Containers": map[string]any{}})
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/images/") && strings.HasSuffix(p, "/json"):
		m.inspecciones++
		if m.inspeccionFalla {
			w.WriteHeader(http.StatusInternalServerError)
			responder(map[string]string{"message": "el motor no contesta"})
			return
		}
		vols := map[string]any{}
		for _, v := range m.volumenesImagen[strings.TrimSuffix(strings.TrimPrefix(p, "/images/"), "/json")] {
			vols[v] = map[string]any{}
		}
		responder(map[string]any{"Config": map[string]any{"Volumes": vols}})
	case r.Method == http.MethodPost && p == "/containers/create":
		var c map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &c)
		m.creados = append(m.creados, c)
		responder(map[string]string{"Id": "nuevo-" + r.URL.Query().Get("name")})
	default:
		responder(map[string]any{})
	}
}

type pruebaDiscos struct {
	o        Opciones
	d        *docker.Cliente
	m        *motorDiscos
	registro []string
	montados map[string]bool
	pedidos  []discos.Pedido
	responde func(discos.Pedido) (discos.Resultado, error)
	maquina  string // lo que contesta la prueba de la máquina ("": puede)
}

func nuevaPruebaDiscos(t *testing.T) *pruebaDiscos {
	t.Helper()
	x := &pruebaDiscos{montados: map[string]bool{}}
	x.m = &motorDiscos{registro: &x.registro}
	base, err := os.MkdirTemp("", "dd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	sock := filepath.Join(base, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: motorfalso.Envolver(motorfalso.Docker27, http.HandlerFunc(x.m.servir))}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	x.d = docker.Nuevo(sock)
	datos := t.TempDir()
	g := &discos.Gestor{
		Datos:       datos,
		Imagen:      "r/actualizador@sha256:1",
		Propagacion: func() bool { return true },
		Ve:          func(dir string) bool { return x.montados[dir] },
	}
	g.Lanzar = func(_ context.Context, _ string, p discos.Pedido) (discos.Resultado, error) {
		x.registro = append(x.registro, "AUXILIAR")
		x.pedidos = append(x.pedidos, p)
		if p.Probar {
			return discos.Resultado{Codigo: x.maquina}, nil
		}
		if x.responde != nil {
			return x.responde(p)
		}
		r := discos.Resultado{Discos: map[string]discos.Estado{}}
		for _, m := range p.Montar {
			x.montarCon(m)
			r.Discos[m.ID] = discos.Estado{Nuevo: true}
		}
		for _, id := range p.Retirar {
			delete(x.montados, discos.Dir(datos, id))
			r.Discos[id] = discos.Estado{}
		}
		return r, nil
	}
	x.o = Opciones{Datos: datos, Escucha: "0.0.0.0", Discos: g}
	return x
}

func (x *pruebaDiscos) montar(id string) { x.montarCon(discos.Montaje{ID: id}) }

// montarCon «monta» el disco con sus carpetas, como el auxiliar.
func (x *pruebaDiscos) montarCon(m discos.Montaje) {
	_ = os.MkdirAll(discos.Registros(x.o.Datos, m.ID), 0o755)
	for i := 0; i < m.Escribibles; i++ {
		_ = os.MkdirAll(discos.Escribible(x.o.Datos, m.ID, i), 0o755)
	}
	for _, c := range m.Carpetas {
		_ = os.MkdirAll(filepath.Join(discos.Dir(x.o.Datos, m.ID), c), 0o755)
	}
	x.montados[discos.Dir(x.o.Datos, m.ID)] = true
}

func conEscribible(id string) plan.TrampaPlan {
	s := trampa(id, "r/cowrie@sha256:1")
	s.Manifiesto.Contenedor.Escribibles = []string{"/cowrie/var/lib/cowrie"}
	return s
}

func montajesDe(c map[string]any) []map[string]any {
	var r []map[string]any
	for _, m := range c["HostConfig"].(map[string]any)["Mounts"].([]any) {
		r = append(r, m.(map[string]any))
	}
	return r
}

func TestUnaTrampaNuevaVaConSuDisco(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{conEscribible("t1")}}
	estados, err := Aplicar(context.Background(), x.d, x.o, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(x.pedidos) != 2 || !x.pedidos[0].Probar || len(x.pedidos[1].Montar) != 1 || x.pedidos[1].Montar[0].Escribibles != 1 {
		t.Fatalf("primero se prueba la máquina y después se monta, una vez: %+v", x.pedidos)
	}
	if len(x.m.creados) != 1 || strings.HasPrefix(estados[0].Donde, "error") {
		t.Fatalf("%+v %d", estados, len(x.m.creados))
	}
	c := x.m.creados[0]
	ms := montajesDe(c)
	if ms[0]["Source"] != discos.Registros(x.o.Datos, "t1") {
		t.Fatalf("los registros, en su disco: %v", ms[0])
	}
	v := ms[1]
	opciones := v["VolumeOptions"].(map[string]any)["DriverConfig"].(map[string]any)["Options"].(map[string]any)
	if v["Source"] != "sd_disco_s1_t1_0" || opciones["device"] != discos.Escribible(x.o.Datos, "t1", 0) || opciones["o"] != "bind" {
		t.Fatalf("la escribible, una carpeta de su disco: %v", v)
	}
	if c["Labels"].(map[string]any)[etiquetaDisco] != "1" {
		t.Fatal("con la etiqueta del disco")
	}
	if Registros(x.o, "t1") != discos.Registros(x.o.Datos, "t1") {
		t.Fatal("el sensor lee sus registros en su disco")
	}
	if len(estados[0].Avisos) != 0 || strings.Contains(estados[0].Donde, "fixed-size") {
		t.Fatalf("con disco no hay aviso: %+v", estados[0])
	}
}

func TestLaQueYaEstabaPasaAlDiscoConSusClaves(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "running", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaHuella: "vieja"}}}
	x.m.volumenes = []map[string]any{
		{"Name": "sd-s1-t1-0", "Labels": map[string]string{etiquetaSensor: "s1", etiquetaTrampa: "t1"}},
	}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{conEscribible("t1")}}
	if _, err := Aplicar(context.Background(), x.d, x.o, p); err != nil {
		t.Fatal(err)
	}
	borra := slices.Index(x.registro, "DELETE /containers/c-t1")
	auxiliar := -1 // el último: el primero es la prueba de la máquina
	for i, l := range x.registro {
		if l == "AUXILIAR" {
			auxiliar = i
		}
	}
	if borra < 0 || auxiliar <= borra {
		t.Fatalf("el contenedor de antes se quita antes de pasar lo suyo al disco: %v", x.registro)
	}
	m := x.pedidos[1].Montar[0]
	if !slices.Equal(m.Viejos, []int{0}) || m.Volumenes[0] != "sd-s1-t1-0" {
		t.Fatalf("su volumen de antes va al auxiliar, para las claves de Cowrie: %+v", m)
	}
	if slices.Contains(x.registro, "DELETE /volumes/sd-s1-t1-0") {
		t.Fatal("el volumen de antes no se borra en la misma vuelta: aún no ha pasado al disco")
	}
	// En la vuelta siguiente su contenedor ya va con disco: el volumen de antes sobra.
	cfg, _, _ := config(x.o, "s1", "", conEscribible("t1"), true, nil)
	x.m.contenedores = []map[string]any{{"Id": "nuevo", "State": "running", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1", etiquetaHuella: huella(cfg)}}}
	x.m.volumenes = append(x.m.volumenes, map[string]any{"Name": "sd_disco_s1_t1_0", "Labels": map[string]string{etiquetaSensor: "s1", etiquetaTrampa: "t1"}})
	x.registro = nil
	if _, err := Aplicar(context.Background(), x.d, x.o, p); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(x.registro, "DELETE /volumes/sd-s1-t1-0") || slices.Contains(x.registro, "DELETE /volumes/sd_disco_s1_t1_0") {
		t.Fatalf("%v", x.registro)
	}
	if slices.Contains(x.registro, "AUXILIAR") || len(x.m.creados) != 1 {
		t.Fatal("en marcha, con su disco montado y sin cambios: no se toca")
	}
}

func TestSinDiscosEnLaMaquinaVaComoAntesYSeDice(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.maquina = discos.CodigoSinLoop
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{conEscribible("t1")}}
	estados, err := Aplicar(context.Background(), x.d, x.o, p)
	if err != nil {
		t.Fatal(err)
	}
	c := x.m.creados[0]
	if montajesDe(c)[0]["Source"] != filepath.Join(x.o.Datos, "registros", "t1") || montajesDe(c)[1]["Source"] != "sd-s1-t1-0" {
		t.Fatalf("como antes: %v", montajesDe(c))
	}
	if !strings.Contains(estados[0].Donde, "warning: no fixed-size disk (disco.sin-loop)") || !slices.Equal(estados[0].Avisos, []string{discos.CodigoSinLoop}) {
		t.Fatalf("y se dice, con su código: %+v", estados[0])
	}
	x.pedidos = nil
	Aplicar(context.Background(), x.d, x.o, p)
	if len(x.pedidos) != 0 {
		t.Fatal("no se vuelve a probar en cada vuelta")
	}
}

func TestUnDiscoQueNoCabeEsCosaDeEsaTrampa(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.responde = func(p discos.Pedido) (discos.Resultado, error) {
		r := discos.Resultado{Discos: map[string]discos.Estado{}}
		for _, m := range p.Montar {
			if m.ID == "t2" {
				r.Discos[m.ID] = discos.Estado{Codigo: discos.CodigoSinEspacio}
				continue
			}
			x.montarCon(m)
			r.Discos[m.ID] = discos.Estado{}
		}
		return r, nil
	}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:1"), trampa("t2", "r/x@sha256:1")}}
	estados, err := Aplicar(context.Background(), x.d, x.o, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(x.m.creados) != 2 {
		t.Fatalf("las dos en marcha: %d", len(x.m.creados))
	}
	if montajesDe(x.m.creados[0])[0]["Source"] != discos.Registros(x.o.Datos, "t1") ||
		montajesDe(x.m.creados[1])[0]["Source"] != filepath.Join(x.o.Datos, "registros", "t2") {
		t.Fatal("t1 con disco, t2 sin él")
	}
	if len(estados[0].Avisos) != 0 || !slices.Equal(estados[1].Avisos, []string{discos.CodigoSinEspacio}) {
		t.Fatalf("%+v", estados)
	}
	if Registros(x.o, "t2") != filepath.Join(x.o.Datos, "registros", "t2") {
		t.Fatal("y el sensor lee t2 donde la escribe")
	}
}

func TestSinDiscoNuncaCreaNadaDentroDelDeLaTrampa(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.maquina = discos.CodigoSinLoop
	// Iba con disco (la máquina ha cambiado): ahora va sin él.
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "exited", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1"}}}
	estados, err := Aplicar(context.Background(), x.d, x.o, plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:1")}})
	if err != nil || strings.HasPrefix(estados[0].Donde, "error") {
		t.Fatalf("%v %+v", err, estados)
	}
	if _, err := os.Stat(discos.Registros(x.o.Datos, "t1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("con la carpeta del disco creada, Docker arrancaría una trampa con disco sobre la máquina")
	}
	if fi, err := os.Stat(filepath.Join(x.o.Datos, "registros", "t1")); err != nil || fi.Mode()&os.ModeSticky == 0 {
		t.Fatalf("la de la máquina, como siempre: %v %v", fi, err)
	}
}

func TestUnFalloPasajeroNoLaRehaceSinDisco(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.responde = func(discos.Pedido) (discos.Resultado, error) {
		return discos.Resultado{}, errors.New("docker no contesta")
	}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:1")}}
	estados, _ := Aplicar(context.Background(), x.d, x.o, p)
	if len(x.m.creados) != 0 || estados[0].Codigo != discos.CodigoError || !strings.HasPrefix(estados[0].Donde, "error: waiting to mount its disk") {
		t.Fatalf("%+v %d", estados, len(x.m.creados))
	}
}

func TestTrasReiniciarLaMaquinaSeMontaAntesDeArrancar(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	s := trampa("t1", "r/x@sha256:1")
	cfg, _, _ := config(x.o, "s1", "", s, true, nil)
	// Parada (Docker no la ha podido arrancar: sus montajes no tienen origen) y sin disco montado.
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "exited", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1", etiquetaHuella: huella(cfg)}}}
	// El disco existe, desmontado.
	_ = os.MkdirAll(filepath.Join(x.o.Datos, discos.Carpeta), 0o700)
	_ = os.WriteFile(discos.Fichero(x.o.Datos, "t1"), nil, 0o600)
	estados, err := Aplicar(context.Background(), x.d, x.o, plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{s}})
	if err != nil {
		t.Fatal(err)
	}
	auxiliar, crea := slices.Index(x.registro, "AUXILIAR"), slices.Index(x.registro, "POST /containers/create")
	if auxiliar < 0 || crea < auxiliar || strings.HasPrefix(estados[0].Donde, "error") {
		t.Fatalf("primero su disco, después el contenedor: %v %+v", x.registro, estados)
	}
	if len(x.pedidos) != 2 || !x.pedidos[0].Probar || x.pedidos[1].Montar[0].ID != "t1" {
		t.Fatalf("sin ningún disco montado, se prueba la máquina y se monta: %+v", x.pedidos)
	}
}

func TestConElDiscoDesmontadoEnMarchaSeVuelveAMontar(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.montar("otra") // la máquina ya se sabe que puede
	s := trampa("t1", "r/x@sha256:1")
	cfg, _, _ := config(x.o, "s1", "", s, true, nil)
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "running", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1", etiquetaHuella: huella(cfg)}}}
	estados, err := Aplicar(context.Background(), x.d, x.o, plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{s, trampa("otra", "r/x@sha256:1")}})
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(x.registro, "DELETE /containers/c-t1") || len(x.pedidos) != 1 || x.pedidos[0].Montar[0].ID != "t1" {
		t.Fatalf("se monta sin rehacerla: %v %+v", x.registro, x.pedidos)
	}
	if strings.HasPrefix(estados[0].Donde, "error") {
		t.Fatalf("%+v", estados[0])
	}
}

func TestLaRetiradaSeLlevaSuDisco(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.montar("vieja")
	_ = os.WriteFile(discos.Fichero(x.o.Datos, "vieja"), nil, 0o600)
	_ = os.WriteFile(discos.Fichero(x.o.Datos, "desmontada"), nil, 0o600)
	x.m.contenedores = []map[string]any{{"Id": "c-vieja", "State": "running", "Labels": map[string]string{etiquetaTrampa: "vieja", etiquetaSensor: "s1", etiquetaDisco: "1"}}}
	if _, err := Aplicar(context.Background(), x.d, x.o, plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:1")}}); err != nil {
		t.Fatal(err)
	}
	borra, auxiliar := slices.Index(x.registro, "DELETE /containers/c-vieja"), slices.Index(x.registro, "AUXILIAR")
	if borra < 0 || auxiliar < borra {
		t.Fatalf("primero el contenedor, después su disco: %v", x.registro)
	}
	ultimo := x.pedidos[len(x.pedidos)-1]
	if !slices.Equal(ultimo.Retirar, []string{"vieja"}) || len(ultimo.Montar) != 1 {
		t.Fatalf("la montada la retira el auxiliar, junto con lo que hay que montar: %+v", ultimo)
	}
	if _, err := os.Stat(discos.Fichero(x.o.Datos, "desmontada")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("la desmontada la borra el sensor")
	}
}

func TestUnaParadaConDiscoSeMontaParaPoderLeerla(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.montar("otra")
	x.o.Paradas = map[string]string{"t1": "quota exceeded (registros.ajenos)"}
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "exited", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1"}}}
	estados, _ := Aplicar(context.Background(), x.d, x.o, plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{trampa("t1", "r/x@sha256:1")}})
	if len(x.pedidos) != 1 || x.pedidos[0].Montar[0].ID != "t1" || len(x.m.creados) != 0 {
		t.Fatalf("%+v %d", x.pedidos, len(x.m.creados))
	}
	if !strings.HasPrefix(estados[0].Donde, prefijoParada) || !x.o.Discos.Usa("t1") {
		t.Fatalf("sigue parada, y el sensor la lee en su disco: %+v", estados[0])
	}
}

// cowrieReal: lo que declara la imagen de Cowrie, con su escribible y sus registros más adentro.
func cowrieReal(id, imagen string) plan.TrampaPlan {
	s := trampa(id, imagen)
	s.Manifiesto.Contenedor.Registros = "/cowrie/cowrie-git/var/log/cowrie"
	s.Manifiesto.Contenedor.Escribibles = []string{"/cowrie/cowrie-git/var/lib/cowrie"}
	return s
}

var volumenesCowrie = []string{"/cowrie/cowrie-git/var", "/cowrie/cowrie-git/etc"}

func TestLosVolumeDeLaImagenVanAlDisco(t *testing.T) {
	o := Opciones{Datos: "/d"}
	s := cowrieReal("t1", "r/cowrie@sha256:1")
	tapados := append(slices.Clone(volumenesCowrie), "/tmp", "/cowrie/cowrie-git/var/log/cowrie", "/cowrie/cowrie-git/var/lib/cowrie/")
	cfg, _, err := config(o, "s1", "", s, true, tapados)
	if err != nil {
		t.Fatal(err)
	}
	var deImagen []map[string]any
	for _, m := range cfg["HostConfig"].(map[string]any)["Mounts"].([]map[string]any) {
		if src, _ := m["Source"].(string); strings.Contains(src, "_imagen-") {
			deImagen = append(deImagen, m)
		}
	}
	if len(deImagen) != 2 || deImagen[0]["Target"] != "/cowrie/cowrie-git/etc" || deImagen[1]["Target"] != "/cowrie/cowrie-git/var" {
		t.Fatalf("solo los que la trampa no monta ya, en orden: %v", deImagen)
	}
	etc := deImagen[0]
	opciones := etc["VolumeOptions"].(map[string]any)["DriverConfig"].(map[string]any)["Options"].(map[string]string)
	if etc["Source"] != "sd_disco_s1_t1_"+discos.CarpetaImagen("/cowrie/cowrie-git/etc") ||
		opciones["device"] != filepath.Join(discos.Dir("/d", "t1"), discos.CarpetaImagen("/cowrie/cowrie-git/etc")) || opciones["o"] != "bind" {
		t.Fatalf("un volumen que es una carpeta del disco, que Docker llena con lo de la imagen: %v", etc)
	}
	// La misma huella con los VOLUME en otro orden; sin disco, como antes (Docker pone los suyos).
	otro, _, _ := config(o, "s1", "", s, true, []string{"/cowrie/cowrie-git/etc", "/tmp", "/cowrie/cowrie-git/var"})
	if huella(otro) != huella(cfg) {
		t.Fatal("la huella no depende del orden en que vienen")
	}
	sin, _, _ := config(o, "s1", "", s, false, volumenesCowrie)
	nada, _, _ := config(o, "s1", "", s, false, nil)
	if huella(sin) != huella(nada) {
		t.Fatal("sin disco no cambia nada")
	}
	if c := necesidad(s, "", volumenesCowrie).Carpetas; len(c) != 2 || c[0] != discos.CarpetaImagen("/cowrie/cowrie-git/etc") {
		t.Fatalf("y el auxiliar crea sus carpetas: %v", c)
	}
}

func TestCowrieConSusVolumeEnElDisco(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	img := "r/cowrie@sha256:vol1"
	x.m.volumenesImagen = map[string][]string{img: volumenesCowrie}
	p := plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{cowrieReal("t1", img)}}
	if _, err := Aplicar(context.Background(), x.d, x.o, p); err != nil {
		t.Fatal(err)
	}
	m := x.pedidos[len(x.pedidos)-1].Montar[0]
	if len(m.Carpetas) != 2 || m.Escribibles != 1 {
		t.Fatalf("el auxiliar prepara una carpeta por VOLUME: %+v", m)
	}
	n := 0
	for _, mt := range montajesDe(x.m.creados[0]) {
		if src, _ := mt["Source"].(string); strings.HasPrefix(src, "sd_disco_s1_t1_imagen-") {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("la trampa los monta: %v", montajesDe(x.m.creados[0]))
	}
	// Otra vuelta, en marcha y sin cambios: ni se rehace ni se vuelve a preguntar por la imagen.
	cfg, _, _ := config(x.o, "s1", "", cowrieReal("t1", img), true, volumenesCowrie)
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "running", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1", etiquetaHuella: huella(cfg)}}}
	inspecciones, creados := x.m.inspecciones, len(x.m.creados)
	if _, err := Aplicar(context.Background(), x.d, x.o, p); err != nil {
		t.Fatal(err)
	}
	if len(x.m.creados) != creados || slices.Contains(x.registro, "DELETE /containers/c-t1") || x.m.inspecciones != inspecciones {
		t.Fatalf("misma huella y sin preguntar otra vez: %d inspecciones, %v", x.m.inspecciones-inspecciones, x.registro)
	}
}

func TestUnDiscoDeAntesSinLaCarpetaDelVolumeLaPideAlAuxiliar(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	img := "r/cowrie@sha256:vol2"
	x.m.volumenesImagen = map[string][]string{img: volumenesCowrie}
	// Montado de antes de esto: con su escribible, sin las carpetas de los VOLUME.
	x.montarCon(discos.Montaje{ID: "t1", Escribibles: 1})
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "running", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1", etiquetaHuella: "de-antes"}}}
	if _, err := Aplicar(context.Background(), x.d, x.o, plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{cowrieReal("t1", img)}}); err != nil {
		t.Fatal(err)
	}
	borra, auxiliar, crea := slices.Index(x.registro, "DELETE /containers/c-t1"), slices.Index(x.registro, "AUXILIAR"), slices.Index(x.registro, "POST /containers/create")
	if borra < 0 || auxiliar < borra || crea < auxiliar || len(x.pedidos[len(x.pedidos)-1].Montar[0].Carpetas) != 2 {
		t.Fatalf("se rehace (sus volúmenes anónimos se van con el contenedor) y el auxiliar crea las carpetas antes: %v", x.registro)
	}
}

func TestSinPoderVerLaImagenNoSeRehace(t *testing.T) {
	x := nuevaPruebaDiscos(t)
	x.montar("otra")
	x.m.inspeccionFalla = true
	x.m.contenedores = []map[string]any{{"Id": "c-t1", "State": "running", "Labels": map[string]string{etiquetaTrampa: "t1", etiquetaSensor: "s1", etiquetaDisco: "1", etiquetaHuella: "x"}}}
	estados, _ := Aplicar(context.Background(), x.d, x.o, plan.Plan{Sensor: "s1", Trampas: []plan.TrampaPlan{cowrieReal("t1", "r/cowrie@sha256:vol3"), trampa("otra", "r/x@sha256:1")}})
	if slices.Contains(x.registro, "DELETE /containers/c-t1") || !strings.Contains(estados[0].Donde, "it keeps running as before") {
		t.Fatalf("%v %+v", x.registro, estados[0])
	}
}
