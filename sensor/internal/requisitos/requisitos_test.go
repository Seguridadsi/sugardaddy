package requisitos

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// Los mismos vectores los pasa el contrato en TypeScript
// (paquetes/contrato/src/requisitos.spec.ts): si Go y TS dejan de comparar
// igual, falla uno de los dos lados.
const vectores = "../../../paquetes/contrato/vectores/requisitos.jsonl"

type vector struct {
	Nombre           string    `json:"nombre"`
	Hechos           Hechos    `json:"hechos"`
	Requisito        Requisito `json:"requisito"`
	Resultado        Resultado `json:"resultado"`
	Efecto           Efecto    `json:"efecto"`
	FueraDelLenguaje bool      `json:"fueraDelLenguaje"`
}

func leerVectores(t *testing.T) []vector {
	t.Helper()
	datos, err := os.ReadFile(vectores)
	if err != nil {
		t.Fatal(err)
	}
	var vs []vector
	for i, l := range bytes.Split(bytes.TrimSuffix(datos, []byte("\n")), []byte("\n")) {
		var v vector
		if err := json.Unmarshal(l, &v); err != nil {
			t.Fatalf("línea %d: %v", i+1, err)
		}
		vs = append(vs, v)
	}
	return vs
}

func TestVectoresCompartidos(t *testing.T) {
	vs := leerVectores(t)
	if len(vs) < 30 {
		t.Fatalf("hay %d vectores; el diseño pide al menos 30", len(vs))
	}
	nombres := map[string]bool{}
	for _, v := range vs {
		if nombres[v.Nombre] {
			t.Errorf("el vector %q está repetido", v.Nombre)
		}
		nombres[v.Nombre] = true
		t.Run(v.Nombre, func(t *testing.T) {
			if r := Evaluar(v.Requisito, v.Hechos); r != v.Resultado {
				t.Errorf("Evaluar da %s; el vector dice %s", r, v.Resultado)
			}
			if e := EfectoDe(v.Requisito, v.Resultado); e != v.Efecto {
				t.Errorf("EfectoDe da %s; el vector dice %s", e, v.Efecto)
			}
		})
	}
}

// Un requisito se escribe con la misma forma con que se lee.
func TestRequisitoIdaYVuelta(t *testing.T) {
	for _, v := range leerVectores(t) {
		b, err := json.Marshal(v.Requisito)
		if err != nil {
			t.Fatal(err)
		}
		var otra Requisito
		if err := json.Unmarshal(b, &otra); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(otra, v.Requisito) {
			t.Errorf("%s: %+v vuelve como %+v", v.Nombre, v.Requisito, otra)
		}
	}
}

func TestOperadoresEnJSON(t *testing.T) {
	casos := map[string]Requisito{
		`{"hecho":"motor.modo","en":["rootful"],"siFalta":"ignora","motivo":"m"}`: {
			Hecho: "motor.modo", Operador: En, Valor: []any{"rootful"}, SiFalta: "ignora", Motivo: "m",
		},
		`{"hecho":"motor.codigo","presente":false,"nivel":"avisa","motivo":"m"}`: {
			Hecho: "motor.codigo", Operador: Presente, Valor: false, Nivel: "avisa", Motivo: "m",
		},
		// Fuera del lenguaje: ninguno o dos operadores.
		`{"hecho":"motor.modo","motivo":"m"}`:                        {Hecho: "motor.modo", Motivo: "m"},
		`{"hecho":"motor.modo","igual":"a","en":["a"],"motivo":"m"}`: {Hecho: "motor.modo", Motivo: "m"},
		`{"hecho":"motor.modo","igual":null,"motivo":"m"}`:           {Hecho: "motor.modo", Operador: Igual, Motivo: "m"},
		`{"HECHO":"motor.modo","IGUAL":"rootful","motivo":7}`:        {},
		`{"hecho":["motor.modo"],"igual":"rootful","nivel":{"a":1}}`: {Operador: Igual, Valor: "rootful"},
		`["no","es","un","objeto"]`:                                  {},
	}
	for j, quiere := range casos {
		var r Requisito
		if err := json.Unmarshal([]byte(j), &r); err != nil {
			t.Fatalf("%s: %v", j, err)
		}
		if !reflect.DeepEqual(r, quiere) {
			t.Errorf("%s da %+v; quiero %+v", j, r, quiere)
		}
	}
}

func TestHechoEnJSON(t *testing.T) {
	var h Hechos
	err := json.Unmarshal([]byte(`{
		"a.b": {"valor": ["tcp/22"], "motivo": "puertos.sonda", "fuente": "sensor"},
		"a.c": {"VALOR": true},
		"a.d": "rootful",
		"a.e": {"valor": null},
		"a.f": null
	}`), &h)
	if err != nil {
		t.Fatal(err)
	}
	quiere := Hechos{
		"a.b": {Valor: []any{"tcp/22"}, Motivo: "puertos.sonda"},
		"a.c": {}, "a.d": {}, "a.e": {}, "a.f": {},
	}
	if !reflect.DeepEqual(h, quiere) {
		t.Errorf("da %#v", h)
	}
	for _, k := range []string{"a.c", "a.d", "a.e", "a.f", "a.z"} {
		if r := Evaluar(Requisito{Hecho: k, Operador: Igual, Valor: true}, h); r != SinDato {
			t.Errorf("%s: %s, quiero sin-dato", k, r)
		}
	}
}

// Desde Go también se pueden escribir hechos y requisitos con tipos de Go.
func TestTiposDeGo(t *testing.T) {
	h := Hechos{
		"agente.ejecutores": {Valor: []string{"contenedor@1"}},
		"motor.cpus":        {Valor: 4},
		"motor.memoria":     {Valor: int64(8 << 30)},
	}
	casos := []struct {
		r    Requisito
		res  Resultado
		efec Efecto
	}{
		{Requisito{Hecho: "agente.ejecutores", Operador: Contiene, Valor: "contenedor@1"}, Cumple, Nada},
		{Requisito{Hecho: "agente.ejecutores", Operador: Contiene, Valor: "servicio@1"}, NoCumple, Descarta},
		{Requisito{Hecho: "motor.cpus", Operador: Igual, Valor: 4.0}, Cumple, Nada},
		{Requisito{Hecho: "motor.cpus", Operador: En, Valor: []any{2, 4}}, Cumple, Nada},
		{Requisito{Hecho: "motor.cpus", Operador: Minimo, Valor: uint8(8), Nivel: "avisa"}, NoCumple, Avisa},
		{Requisito{Hecho: "motor.memoria", Operador: Minimo, Valor: 4 << 30}, Cumple, Nada},
		{Requisito{Hecho: "motor.modo", Operador: Igual, Valor: "rootful", SiFalta: "ignora"}, SinDato, Nada},
		{Requisito{Hecho: "motor.modo", Operador: "parecido", Valor: "rootful"}, NoCumple, Descarta},
	}
	for _, c := range casos {
		if r := Evaluar(c.r, h); r != c.res {
			t.Errorf("%+v da %s; quiero %s", c.r, r, c.res)
		}
		if e := EfectoDe(c.r, c.res); e != c.efec {
			t.Errorf("%+v: efecto %s; quiero %s", c.r, e, c.efec)
		}
	}
}

func TestVersiones(t *testing.T) {
	for _, c := range []struct {
		valor, minimo string
		cumple        bool
	}{
		{"0.13.10", "0.13.9", true},
		{"10.0.17763", "10.0.14393", true},
		{"0.13.9", "0.13.10", false},
		{"7.4.6-preview", "7.4.6", true},
		{"0.13", "0.13.0", true},
		{"010.1", "10.1", true},
		{"10.01", "10.2", false},
		{"1." + strings.Repeat("9", 30), "1." + strings.Repeat("9", 29) + "8", true},
		{"1." + strings.Repeat("9", 29) + "8", "1." + strings.Repeat("9", 30), false},
		{"dev", "0.0.1", false},
		{"", "0", false},
	} {
		h := Hechos{"agente.version": {Valor: c.valor}}
		r := Evaluar(Requisito{Hecho: "agente.version", Operador: Minimo, Valor: c.minimo}, h)
		if (r == Cumple) != c.cumple {
			t.Errorf("%s ≥ %s da %s", c.valor, c.minimo, r)
		}
	}
}

// Ningún valor, en el hecho ni en el operador, hace entrar en pánico; con
// dato, el resultado es cumple o no-cumple.
func TestNoEntraEnPanico(t *testing.T) {
	raros := []any{
		nil, true, false, 0.0, -1, 0.5, math.NaN(), math.Inf(1), "", "5.1", "x", "1.2.3-rc",
		".1", "1..2", strings.Repeat("9", 400), []any{}, []any{nil}, []any{[]any{}},
		[]any{"a", 1.0, true, nil, map[string]any{}}, []string{}, []string{"a"},
		map[string]any{}, map[string]any{"valor": 1.0}, struct{}{}, func() {}, make(chan int),
		[]int{1}, &struct{}{},
	}
	for _, op := range append(slices.Clone(operadores), "", "otro") {
		for _, valor := range raros {
			for _, x := range raros {
				res := Evaluar(Requisito{Hecho: "x.y", Operador: op, Valor: x}, Hechos{"x.y": {Valor: valor}})
				switch {
				case op == "" || op == "otro":
					if res != NoCumple {
						t.Fatalf("operador %q da %s", op, res)
					}
				case op == Presente || valor != nil:
					if res != Cumple && res != NoCumple {
						t.Fatalf("%s con %#v y %#v da %s", op, valor, x, res)
					}
				default:
					if res != SinDato {
						t.Fatalf("%s sin dato da %s", op, res)
					}
				}
			}
		}
	}
}
