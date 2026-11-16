package cortafuegos

import (
	"context"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// go test ./internal/cortafuegos -run Dorado -actualizar  (rehace los ficheros de testdata)
var actualizarDorados = flag.Bool("actualizar", false, "rewrite the golden files")

func casosEstricto() map[string]Estricto {
	return map[string]Estricto{
		"minimo": {
			Consola:    ConsolaEstricta{Puerto: 443, Redes: []string{"192.0.2.10"}},
			Publicados: []Publicado{{"tcp", 443}},
		},
		"completo": {
			Consola: ConsolaEstricta{Puerto: 443, Redes: []string{
				"10.0.0.0/8", "10.1.2.3", "2001:db8::/32", "198.51.100.7", " 10.0.0.0/8 ", "::ffff:203.0.113.5",
			}},
			Publicados: []Publicado{{"tcp", 22}, {"udp", 53}, {"tcp", 445}, {"tcp", 22}, {"tcp", 443}, {"udp", 123}},
			SSH:        SSHEstricto{Puerto: 2222, Redes: []string{"192.0.2.0/24", "2001:db8:1::/48"}},
			Salida: SalidaEstricta{Restringida: true, Destinos: []Destino{
				{"20.1.2.3", 443}, {"2603:1000::1", 443}, {"20.1.2.3", 443}, {"52.0.0.9", 8080},
			}},
		},
		"abierta": {
			Consola:    ConsolaEstricta{Puerto: 8443, Abierta: true, Redes: []string{"192.0.2.10"}},
			Publicados: []Publicado{{"tcp", 21}, {"tcp", 3389}},
		},
	}
}

func TestDoradoEstricto(t *testing.T) {
	for nombre, e := range casosEstricto() {
		t.Run(nombre, func(t *testing.T) {
			r, err := ReglasEstricto(e)
			if err != nil {
				t.Fatal(err)
			}
			f := filepath.Join("testdata", "estricto-"+nombre+".nft")
			if *actualizarDorados {
				if err := os.WriteFile(f, []byte(r), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			esperado, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			if string(esperado) != r {
				t.Fatalf("%s differs from the generated rules (go test -run Dorado -actualizar if intended):\n%s", f, r)
			}
		})
	}
}

func TestEstrictoHuellaEstable(t *testing.T) {
	a := Estricto{Consola: ConsolaEstricta{Puerto: 443, Redes: []string{"10.0.0.0/8", "192.0.2.1"}},
		Publicados: []Publicado{{"udp", 53}, {"tcp", 22}}}
	b := Estricto{Consola: ConsolaEstricta{Puerto: 443, Redes: []string{"192.0.2.1", "10.0.0.0/8", "10.9.9.9"}},
		Publicados: []Publicado{{"tcp", 22}, {"udp", 53}, {"tcp", 22}}}
	ha, err := HuellaEstricto(a)
	if err != nil {
		t.Fatal(err)
	}
	hb, _ := HuellaEstricto(b)
	if ha != hb {
		t.Fatal("the same rules in another order (or with a covered network) must have the same fingerprint")
	}
}

func TestEstrictoRechaza(t *testing.T) {
	base := func() Estricto {
		return Estricto{Consola: ConsolaEstricta{Puerto: 443, Redes: []string{"192.0.2.1"}}}
	}
	casos := map[string]func(*Estricto){
		"lista vacía":          func(e *Estricto) { e.Consola.Redes = nil },
		"todo internet":        func(e *Estricto) { e.Consola.Redes = []string{"0.0.0.0/0"} },
		"red mal escrita":      func(e *Estricto) { e.Consola.Redes = []string{"10.0.0.0/33"} },
		"inyección":            func(e *Estricto) { e.Consola.Redes = []string{"1.2.3.4 } accept; #"} },
		"puerto consola":       func(e *Estricto) { e.Consola.Puerto = 0 },
		"protocolo":            func(e *Estricto) { e.Publicados = []Publicado{{"sctp", 80}} },
		"puerto publicado":     func(e *Estricto) { e.Publicados = []Publicado{{"tcp", 70000}} },
		"ssh en el de consola": func(e *Estricto) { e.SSH = SSHEstricto{Puerto: 443, Redes: []string{"10.0.0.0/8"}} },
		"ssh en el de trampa": func(e *Estricto) {
			e.SSH = SSHEstricto{22, []string{"10.0.0.0/8"}}
			e.Publicados = []Publicado{{"tcp", 22}}
		},
		"ssh para todos":          func(e *Estricto) { e.SSH = SSHEstricto{22, []string{"::/0"}} },
		"destino sin ip":          func(e *Estricto) { e.Salida = SalidaEstricta{true, []Destino{{"panel.example", 443}}} },
		"destino sin especificar": func(e *Estricto) { e.Salida = SalidaEstricta{true, []Destino{{"0.0.0.0", 443}}} },
	}
	for nombre, cambiar := range casos {
		e := base()
		cambiar(&e)
		if err := ValidarEstricto(e); err == nil {
			t.Errorf("%s: accepted", nombre)
		}
	}
	if err := ValidarEstricto(base()); err != nil {
		t.Fatal(err)
	}
	// Abierta no necesita lista.
	e := base()
	e.Consola = ConsolaEstricta{Puerto: 443, Abierta: true}
	if err := ValidarEstricto(e); err != nil {
		t.Fatal(err)
	}
}

func TestLeerEstrictoCampoDeMas(t *testing.T) {
	if _, err := LeerEstricto(`{"consola":{"puerto":443,"abierta":true},"extra":1}`); err == nil {
		t.Fatal("an unknown field must be refused")
	}
	if _, err := LeerEstricto(`{"consola":{"puerto":443,"abierta":true},"publicados":[{"proto":"tcp","puerto":22}]}`); err != nil {
		t.Fatal(err)
	}
}

// nftDoble simula nft e iptables: guarda la tabla que se carga y lo que se pide.
type nftDoble struct {
	tabla     string // lo que devolvería «nft list table»; vacío: no está
	cargas    []string
	sinNft    bool
	ufw       bool
	firewalld bool
	falla     bool
}

func (d *nftDoble) ej(_ context.Context, entrada, orden string, args ...string) (string, error) {
	todo := orden + " " + strings.Join(args, " ")
	switch {
	case orden == "nft" && d.sinNft:
		return "", errFalso("nft: not found")
	case todo == "nft --version":
		return "nftables v1.0.9", nil
	case todo == "nft list tables":
		if d.firewalld {
			return "table inet firewalld\ntable ip filter\n", nil
		}
		return "table ip filter\n", nil
	case todo == "nft list table inet "+TablaEstricta:
		if d.tabla == "" {
			return "", errFalso("No such file or directory")
		}
		return d.tabla, nil
	case todo == "nft -f -":
		if d.falla {
			return "", errFalso("syntax error")
		}
		d.cargas = append(d.cargas, entrada)
		// Lo cargado queda como tabla (borrar y volver a crear).
		if i := strings.LastIndex(entrada, "table inet "+TablaEstricta+" {"); i >= 0 {
			d.tabla = entrada[i:]
		} else {
			d.tabla = ""
		}
		return "", nil
	case strings.HasPrefix(orden, "iptables-") && strings.Contains(todo, "-S INPUT"):
		if d.ufw && orden == "iptables-nft" {
			return "-P INPUT DROP\n-A INPUT -j ufw-before-logging-input\n", nil
		}
		return "-P INPUT ACCEPT\n", nil
	}
	return "", errFalso("unexpected: " + todo)
}

type errFalso string

func (e errFalso) Error() string { return string(e) }

func estrictoDePrueba() Estricto {
	return Estricto{Consola: ConsolaEstricta{Puerto: 443, Redes: []string{"192.0.2.1"}},
		Publicados: []Publicado{{"tcp", 22}}}
}

func TestAplicarEstrictoConfirmado(t *testing.T) {
	d := &nftDoble{}
	r := AplicarEstricto(context.Background(), estrictoDePrueba(), d.ej, func(string) bool { return true }, time.Minute)
	if r.Estado != EstrictoAplicado || len(d.cargas) != 1 {
		t.Fatalf("%+v %d", r, len(d.cargas))
	}
	if !strings.Contains(d.cargas[0], `comment "sd:`+r.Huella+`"`) {
		t.Fatal("the loaded rules must carry their fingerprint")
	}
	// Otra vez lo mismo: no se vuelve a cargar.
	r = AplicarEstricto(context.Background(), estrictoDePrueba(), d.ej, func(string) bool { t.Fatal("must not wait"); return false }, time.Minute)
	if r.Estado != EstrictoAplicado || len(d.cargas) != 1 {
		t.Fatalf("reapplying the same rules: %+v, %d loads", r, len(d.cargas))
	}
}

func TestAplicarEstrictoSinConfirmarVuelveAtras(t *testing.T) {
	antes := "table inet sugardaddy {\n\tchain entrada {\n\t\ttype filter hook input priority filter; policy accept;\n\t}\n}\n"
	d := &nftDoble{tabla: antes}
	r := AplicarEstricto(context.Background(), estrictoDePrueba(), d.ej, func(string) bool { return false }, 1500*time.Millisecond)
	if r.Estado != EstrictoRevertido {
		t.Fatalf("%+v", r)
	}
	if len(d.cargas) != 2 || !strings.HasSuffix(d.cargas[1], antes) {
		t.Fatalf("the previous table must be loaded back: %q", d.cargas)
	}
	// Sin tabla antes: queda sin tabla.
	d = &nftDoble{}
	r = AplicarEstricto(context.Background(), estrictoDePrueba(), d.ej, func(string) bool { return false }, time.Second)
	if r.Estado != EstrictoRevertido || d.tabla != "" {
		t.Fatalf("%+v, table left: %q", r, d.tabla)
	}
}

func TestAplicarEstrictoConflictos(t *testing.T) {
	for _, d := range []*nftDoble{{ufw: true}, {firewalld: true}} {
		r := AplicarEstricto(context.Background(), estrictoDePrueba(), d.ej, nil, time.Second)
		if r.Estado != EstrictoConflicto || len(d.cargas) != 0 {
			t.Fatalf("%+v", r)
		}
	}
	d := &nftDoble{sinNft: true}
	if r := AplicarEstricto(context.Background(), estrictoDePrueba(), d.ej, nil, time.Second); r.Estado != EstrictoSinNft {
		t.Fatalf("%+v", r)
	}
	d = &nftDoble{falla: true}
	if r := AplicarEstricto(context.Background(), estrictoDePrueba(), d.ej, nil, time.Second); r.Estado != ConError {
		t.Fatalf("%+v", r)
	}
}

func TestQuitarEstricto(t *testing.T) {
	d := &nftDoble{tabla: "table inet sugardaddy {\n}\n"}
	if r := QuitarEstricto(context.Background(), d.ej); r.Estado != EstrictoQuitado || d.tabla != "" {
		t.Fatalf("%+v %q", r, d.tabla)
	}
	if r := QuitarEstricto(context.Background(), d.ej); r.Estado != EstrictoQuitado || len(d.cargas) != 1 {
		t.Fatalf("removing twice must not load anything: %+v", r)
	}
}

// La regla de SEN-5 y la de la consola tienen que estar en lo que se genera.
func TestEstrictoConservaSEN5ySEN1(t *testing.T) {
	r, _ := ReglasEstricto(estrictoDePrueba())
	for _, debe := range []string{
		`iifname "sd-trampas*" drop`,
		`tcp dport 443 ip saddr @consola4 accept`,
		`ct status dnat meta l4proto tcp ct original proto-dst 443 reject with tcp reset`,
		"policy drop;",
	} {
		if !strings.Contains(r, debe) {
			t.Errorf("missing %q", debe)
		}
	}
	// La regla de SEN-5 antes que cualquier accept que no sea de respuestas.
	if strings.Index(r, `iifname "sd-trampas*" drop`) > strings.Index(r, `iifname "docker0"`) {
		t.Fatal("SEN-5 must come before the bridge rules")
	}
}
