package main

import (
	"strings"
	"testing"
	"time"
)

// Pruebas de los hallazgos de diseño que la revisión fijó: bolsas del registro
// por hora y por IP, rechazo por conexiones, recorte contando el coste del
// JSON escapado, detección de inyección y estabilidad del token por semilla.

func TestBolsasDelRegistro(t *testing.T) {
	if bolsaDe("web.session.connect") != bolsaGeneral ||
		bolsaDe("web.sondeo") != bolsaGeneral ||
		bolsaDe("web.session.closed") != bolsaGeneral ||
		bolsaDe("web.login.cebo") != bolsaCebo ||
		bolsaDe("web.login") != bolsaLogin ||
		bolsaDe("web.comando") != bolsaLogin ||
		bolsaDe("web.log.omitidos") != bolsaAvisos ||
		bolsaDe("web.log.tope") != bolsaAvisos ||
		bolsaDe("web.log.error") != bolsaAvisos ||
		bolsaDe("web.session.rechazos") != bolsaAvisos {
		t.Fatal("bolsaDe no reparte los eventos como debe")
	}
	if reparto[bolsaGeneral] != 600 || reparto[bolsaCebo] != 150 || reparto[bolsaLogin] != 100 {
		t.Fatalf("reparto de bolsas cambiado: %v", reparto)
	}
	// Las credenciales probadas tienen la bolsa apretada por IP: una IP no
	// puede agotarla ella sola.
	if partesIP[bolsaLogin] != 32 {
		t.Fatalf("la bolsa de credenciales debe repartirse en 32 por IP: %d", partesIP[bolsaLogin])
	}
}

func TestCupoDelRegistroPorIPYHora(t *testing.T) {
	r, err := nuevoRegistrador(t.TempDir()+"/login-web.json", 1000, time.Minute, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer r.cerrar()
	// A las 0 UTC del día, la bolsa general solo libera 1/24 del total.
	p := r.permitido(bolsaGeneral, time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC))
	esperado := (1000 - r.margen) * reparto[bolsaGeneral] / 1000 / 24
	if p != esperado {
		t.Fatalf("permitido por hora: %d, esperaba %d", p, esperado)
	}
	// Una IP no gasta más de su parte de lo liberado.
	r.gastado[bolsaGeneral] = p
	if r.admite("1.2.3.4", bolsaGeneral, time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)) != motivoCupoHora {
		t.Fatal("al llenar el cupo de la hora debe devolver el motivo de hora")
	}
	r.gastado[bolsaGeneral] = 0
	r.gastoIP("1.2.3.4")[bolsaGeneral] = p / partesIP[bolsaGeneral]
	if r.admite("1.2.3.4", bolsaGeneral, time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)) != motivoCupoIP {
		t.Fatal("al llenar el cupo de su IP debe devolver el motivo de IP")
	}
}

func TestRechazoPorConexiones(t *testing.T) {
	c := nuevoContador(2, 1)
	if ok, _ := c.admitir("1.2.3.4"); !ok {
		t.Fatal("la primera conexión de la IP entra")
	}
	if ok, motivo := c.admitir("1.2.3.4"); ok || !strings.Contains(motivo, "su IP") {
		t.Fatalf("tope por IP: ok=%v motivo=%q", ok, motivo)
	}
	if ok, _ := c.admitir("5.6.7.8"); !ok {
		t.Fatal("otra IP tiene sus propias plazas")
	}
	if ok, motivo := c.admitir("9.9.9.9"); ok || !strings.Contains(motivo, "total") {
		t.Fatalf("tope total: ok=%v motivo=%q", ok, motivo)
	}
	c.soltar("1.2.3.4")
	if ok, _ := c.admitir("1.2.3.4"); !ok {
		t.Fatal("soltar una conexión devuelve la plaza")
	}
}

func TestRecorteCodificado(t *testing.T) {
	// U+2028 siempre escapa a 6 bytes aunque se desactive EscapeHTML.
	l := strings.Repeat("a", 300) + " " + strings.Repeat("b", 300)
	r := recortarCodificado(l, 300)
	if !strings.HasSuffix(r, "aaa") || strings.Contains(r, " ") {
		t.Fatalf("el recorte no cortó antes del U+2028: %q…", r[:20])
	}
	// Un byte que no es UTF-8 cuenta 6 (carácter de reemplazo).
	if r := recortarCodificado("ab\xffd", 4); r != "ab" {
		t.Fatalf("byte inválido: %q", r)
	}
	// Los caracteres de control escapan a \\u00XX.
	if r := recortarCodificado("ab\x01c", 4); r != "ab" {
		t.Fatalf("carácter de control: %q", r)
	}
	// No parte un carácter multibyte.
	if r := recortarCodificado("ñño", 2); r != "ñ" {
		t.Fatalf("partió un carácter: %q", r)
	}
}

func TestCredencialRecortadaEnElRegistro(t *testing.T) {
	// La credencial probada queda recortada al tope de codificación: una
	// contraseña de megas no infla la línea del registro.
	grande := strings.Repeat("x", 4000)
	if r := recortarCodificado(grande, maxCodCredencial); len(r) != maxCodCredencial {
		t.Fatalf("recorte de la credencial: %d", len(r))
	}
	// La versión compacta de un grave nunca lleva la credencial entera.
	ev := versionCompacta(evento{Cuando: "x", EventID: "web.login.cebo", Usuario: grande, Password: grande, Grave: "prueba"})
	if len(ev.Usuario) > maxCodCredencial || len(ev.Password) > maxCodCredencial || ev.Cuando != "x" {
		t.Fatalf("versión compacta mal: %+v", ev)
	}
}

func TestInyeccion(t *testing.T) {
	casos := []struct {
		valor string
		trozo string // lo que tiene que llevar el motivo; vacío = limpio
	}{
		{"admin'--", "inyección SQL"},
		{"' OR 1=1 --", "inyección SQL"},
		{"admin' or 'a'='a", "inyección SQL"},
		{"x' UNION SELECT usuario, password FROM usuarios--", "inyección SQL"},
		{"a'; DROP TABLE usuarios; --", "inyección SQL"},
		{"1' and sleep(5)--", "inyección SQL"},
		{"<script>alert(1)</script>", "inyección XSS"},
		{"{{7*7}}", "inyección de plantilla"},
		{"../../../etc/passwd", "Path Traversal"},
		{"..\\..\\windows", "Path Traversal"},
		{"admin", ""},
		{"Admin-2026", ""},
		{"mi contraseña de siempre", ""},
		{"letmein123", ""},
	}
	for _, cs := range casos {
		m := motivoInyeccion("el campo usuario", cs.valor)
		if cs.trozo == "" {
			if m != "" {
				t.Fatalf("%q es una credencial limpia, no debería marcar %q", cs.valor, m)
			}
			continue
		}
		if !strings.Contains(m, cs.trozo) {
			t.Fatalf("%q: motivo %q, esperaba que contuviera %q", cs.valor, m, cs.trozo)
		}
	}
	// La ruta también se mira, y con su propio nombre de campo.
	if m := motivoInyeccion("la ruta", "/../../etc/passwd"); !strings.Contains(m, "la ruta") {
		t.Fatalf("motivo de la ruta: %q", m)
	}
}

func TestTokenPorSemilla(t *testing.T) {
	a := nuevaIdentidad(conf{}, "semilla-aaaa")
	b := nuevaIdentidad(conf{}, "semilla-bbbb")
	// Distinto por trampa, estable por sesión y por semilla.
	if a.tokenSesion("sesion-1") == b.tokenSesion("sesion-1") {
		t.Fatal("dos trampas no pueden plantar el mismo token")
	}
	if a.tokenSesion("sesion-1") != a.tokenSesion("sesion-1") {
		t.Fatal("el token de una sesión no puede cambiar entre peticiones")
	}
	if a.tokenSesion("sesion-1") == a.tokenSesion("sesion-2") {
		t.Fatal("el token no puede ser igual para dos sesiones")
	}
}

func TestValorFormConAlias(t *testing.T) {
	// Un atacante fuerza username, user, email... y el portal lo captura igual.
	for _, nombre := range aliasUsuario {
		form := map[string][]string{nombre: {"atacante"}}
		if v := valorForm(form, aliasUsuario); v != "atacante" {
			t.Fatalf("alias %s no capturado: %q", nombre, v)
		}
	}
	for _, nombre := range aliasPassword {
		form := map[string][]string{nombre: {"secreto"}}
		if v := valorForm(form, aliasPassword); v != "secreto" {
			t.Fatalf("alias %s no capturado: %q", nombre, v)
		}
	}
	if v := valorForm(map[string][]string{"otro": {"x"}}, aliasUsuario); v != "" {
		t.Fatalf("campo desconocido no debería dar valor: %q", v)
	}
	// El primer alias con valor gana, y el vacío no cuenta.
	if v := valorForm(map[string][]string{"usuario": {""}, "username": {"segundo"}}, aliasUsuario); v != "segundo" {
		t.Fatalf("alias vacío saltado mal: %q", v)
	}
}
