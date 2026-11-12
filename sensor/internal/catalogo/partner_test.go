package catalogo

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

var ahoraPrueba = time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)

type claves struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	b64  string
}

func nuevasClaves() claves {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	return claves{pub, priv, base64.StdEncoding.EncodeToString(der)}
}

func firmar(k claves, texto []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(k.priv, texto))
}

// certificado: el de SeguridadSI (firmante) para la clave del partner.
func certificado(firmante, partner claves, cambios map[string]any) map[string]any {
	d := map[string]any{"tipo": "delegacion-catalogo", "version": 1, "msp": "acme", "clavePublica": partner.b64,
		"prefijo": "acme", "emitida": "2026-11-01T00:00:00Z", "caduca": "2026-12-31T00:00:00Z"}
	for k, v := range cambios {
		d[k] = v
	}
	texto, _ := json.Marshal(d)
	return map[string]any{"delegacion": string(texto), "firma": firmar(firmante, texto)}
}

func catalogoDe(partner claves, cert map[string]any, serie int, modulos map[string][]string, cambios map[string]any) []byte {
	c := map[string]any{"tipo": "catalogo-partner", "version": 1, "msp": "acme", "serie": serie,
		"emitida": "2026-11-10T00:00:00Z", "catalogo": modulos}
	for k, v := range cambios {
		c[k] = v
	}
	texto, _ := json.Marshal(c)
	b, _ := json.Marshal(map[string]any{"catalogo": string(texto), "firma": firmar(partner, texto), "delegacion": cert})
	return b
}

func dePartner(id string) plan.Manifiesto {
	return plan.Manifiesto{ID: id, Tipo: "web", Contenedor: &plan.Contenedor{Imagen: "registro.acme.example/trampa@sha256:" + strings.Repeat("b", 64), Registros: "/log"},
		Aislamiento: &plan.Aislamiento{SoloLectura: true, CPU: 0.5, MemoriaMb: 128}}
}

func TestCadenaDePartner(t *testing.T) {
	kino, partner, atacante := nuevasClaves(), nuevasClaves(), nuevasClaves()
	conf := actualizador.LeerConfianza("delegaciones:"+kino.b64, "")
	buena := dePartner("acme-portal")
	mods := map[string][]string{"acme-portal": {Huella(buena)}}
	cert := certificado(kino, partner, nil)

	p, err := VerificarPartner(conf, "acme", catalogoDe(partner, cert, 3, mods, nil), ahoraPrueba)
	if err != nil || p == nil || p.Serie != 3 || p.Prefijo != "acme" {
		t.Fatalf("la cadena buena vale: %v", err)
	}
	if m := p.Motivo(plan.TrampaPlan{ID: "t", Manifiesto: buena}, ahoraPrueba); m != "" {
		t.Fatalf("la trampa firmada arranca: %s", m)
	}
	otra := dePartner("acme-portal")
	otra.Contenedor.Imagen = "atacante.example/x@sha256:" + strings.Repeat("c", 64)
	if m := p.Motivo(plan.TrampaPlan{ID: "t", Manifiesto: otra}, ahoraPrueba); !strings.Contains(m, "differs from the one signed") {
		t.Fatalf("otra imagen no arranca: %q", m)
	}
	if m := p.Motivo(plan.TrampaPlan{ID: "t", Manifiesto: dePartner("acme-otra")}, ahoraPrueba); !strings.Contains(m, "does not include module") {
		t.Fatalf("una que no está en el catálogo no arranca: %q", m)
	}
	// El certificado caduca con el fichero sin tocar: deja de arrancar.
	if m := p.Motivo(plan.TrampaPlan{ID: "t", Manifiesto: buena}, ahoraPrueba.AddDate(1, 0, 0)); !strings.Contains(m, "has expired") {
		t.Fatalf("caducado después de leerlo: %q", m)
	}

	malas := []struct {
		nombre  string
		partner string
		texto   []byte
		motivo  string
	}{
		{"nodo de otro partner", "otro", catalogoDe(partner, cert, 3, mods, nil), "not to the partner of this node"},
		{"nodo sin partner", "", catalogoDe(partner, cert, 3, mods, nil), "no partner"},
		{"certificado que no firma SeguridadSI", "acme", catalogoDe(atacante, certificado(atacante, atacante, nil), 3, mods, nil), "not signed by SeguridadSI"},
		{"certificado de licencias usado para trampas", "acme", catalogoDe(partner, certificado(kino, partner, map[string]any{"tipo": "delegacion-licencias", "modulos": []string{"acme-portal"}}), 3, mods, nil), "not a partner decoy certificate"},
		{"catálogo firmado con otra clave", "acme", catalogoDe(atacante, cert, 3, mods, nil), "not signed by the partner key"},
		{"certificado caducado", "acme", catalogoDe(partner, certificado(kino, partner, map[string]any{"caduca": "2026-11-10T00:00:00Z"}), 3, mods, nil), "has expired"},
		{"trampa sin el prefijo", "acme", catalogoDe(partner, cert, 3, map[string][]string{"cowrie": {Huella(buena)}}, nil), "does not carry the partner prefix"},
		{"prefijo que solo se parece", "acme", catalogoDe(partner, cert, 3, map[string][]string{"acmex-portal": {Huella(buena)}}, nil), "does not carry the partner prefix"},
		{"catálogo de otro partner con este certificado", "acme", catalogoDe(partner, cert, 3, mods, map[string]any{"msp": "otro"}), "different partners"},
		{"serie cero", "acme", catalogoDe(partner, cert, 0, mods, nil), "serial"},
		{"huella que no lo es", "acme", catalogoDe(partner, cert, 3, map[string][]string{"acme-portal": {"x"}}, nil), "malformed fingerprints"},
		{"otro tipo de documento", "acme", catalogoDe(partner, cert, 3, mods, map[string]any{"tipo": "licencia"}), "not a partner catalog"},
		{"basura", "acme", []byte("{"), "form of a signed partner catalog"},
	}
	for _, c := range malas {
		if p, err := VerificarPartner(conf, c.partner, c.texto, ahoraPrueba); err == nil || p != nil || !strings.Contains(err.Error(), c.motivo) {
			t.Errorf("%s: tenía que fallar con %q y da %v", c.nombre, c.motivo, err)
		}
	}

	// Manipulado después de firmar: una serie cambiada en el texto rompe la firma.
	b := catalogoDe(partner, cert, 3, mods, nil)
	manipulado := []byte(strings.Replace(string(b), `\"serie\":3`, `\"serie\":9`, 1))
	if string(manipulado) == string(b) {
		t.Fatal("la prueba no ha cambiado nada")
	}
	if _, err := VerificarPartner(conf, "acme", manipulado, ahoraPrueba); err == nil {
		t.Fatal("un catálogo tocado tiene que fallar")
	}
	// Una clave de otro uso (cloud) no vale para firmar certificados.
	soloCloud := actualizador.LeerConfianza("cloud:"+kino.b64, "")
	if _, err := VerificarPartner(soloCloud, "acme", b, ahoraPrueba); err == nil {
		t.Fatal("una clave que no es de delegaciones no puede firmar el certificado")
	}
}

func TestTechoDePartner(t *testing.T) {
	if m := MotivoTecho(dePartner("acme-x")); m != "" {
		t.Fatalf("la normal cabe: %s", m)
	}
	casos := map[string]func(*plan.Manifiesto){
		"digest":          func(m *plan.Manifiesto) { m.Contenedor.Imagen = "registro.acme.example/trampa:latest" },
		"own-IP":          func(m *plan.Manifiesto) { m.Red = &plan.RedTrampa{Modo: "ip-propia", Capturar: "10.0.0.0/8"} },
		"isolation block": func(m *plan.Manifiesto) { m.Aislamiento = nil },
		"internet":        func(m *plan.Manifiesto) { m.Aislamiento.Salida = true },
		"read-only":       func(m *plan.Manifiesto) { m.Aislamiento.SoloLectura = false },
		"CPU":             func(m *plan.Manifiesto) { m.Aislamiento.CPU = 0 },
		"CPU limit":       func(m *plan.Manifiesto) { m.Aislamiento.CPU = 4 },
		"memory":          func(m *plan.Manifiesto) { m.Aislamiento.MemoriaMb = 0 },
		"memory limit":    func(m *plan.Manifiesto) { m.Aislamiento.MemoriaMb = 4096 },
		"writable":        func(m *plan.Manifiesto) { m.Contenedor.Escribibles = make([]string, 9) },
		"container":       func(m *plan.Manifiesto) { m.Contenedor = nil },
	}
	for motivo, cambiar := range casos {
		m := dePartner("acme-x")
		cambiar(&m)
		if got := MotivoTecho(m); !strings.Contains(got, motivo) {
			t.Errorf("%s: %q", motivo, got)
		}
	}
	// Firmada y todo, una que pasa del techo no arranca.
	sinTecho := dePartner("acme-x")
	sinTecho.Aislamiento.Salida = true
	p := &Partner{MSP: "acme", Prefijo: "acme", Serie: 1, Caduca: ahoraPrueba.AddDate(0, 1, 0), Modulos: map[string][]string{"acme-x": {Huella(sinTecho)}}}
	if m := p.Motivo(plan.TrampaPlan{ID: "t", Manifiesto: sinTecho}, ahoraPrueba); !strings.Contains(m, "asks for more") {
		t.Fatalf("pasa del techo: %q", m)
	}
}

func TestLectorDePartnerYSerie(t *testing.T) {
	kino, partner := nuevasClaves(), nuevasClaves()
	conf := actualizador.LeerConfianza("delegaciones:"+kino.b64, "")
	dir := t.TempDir()
	ruta, serie := filepath.Join(dir, "catalogo-partner.json"), filepath.Join(dir, "serie")
	nuevo := func() *LectorPartner {
		return &LectorPartner{Ruta: ruta, Confianza: conf, Partner: "acme", RutaSerie: serie, Ahora: func() time.Time { return ahoraPrueba }}
	}
	cert := certificado(kino, partner, nil)
	mods := map[string][]string{"acme-portal": {Huella(dePartner("acme-portal"))}}
	escribir := func(n int, minutos int) {
		t.Helper()
		if err := os.WriteFile(ruta, catalogoDe(partner, cert, n, mods, nil), 0o644); err != nil {
			t.Fatal(err)
		}
		cuando := time.Now().Add(time.Duration(minutos) * time.Minute)
		_ = os.Chtimes(ruta, cuando, cuando)
	}

	l := nuevo()
	if p, err := l.Leer(); p != nil || err != nil {
		t.Fatalf("sin fichero: nada y sin error (%v %v)", p, err)
	}
	if p, err := (&LectorPartner{Ruta: ruta, Confianza: conf, RutaSerie: serie}).Leer(); p != nil || err != nil {
		t.Fatalf("un nodo sin partner no lee nada (%v %v)", p, err)
	}
	var sin *LectorPartner
	if p, err := sin.Leer(); p != nil || err != nil {
		t.Fatalf("sin lector: nada (%v %v)", p, err)
	}
	escribir(5, 1)
	if p, err := l.Leer(); err != nil || p == nil || p.Serie != 5 {
		t.Fatalf("serie 5: %v", err)
	}
	escribir(7, 2)
	if p, err := l.Leer(); err != nil || p == nil || p.Serie != 7 {
		t.Fatalf("serie 7: %v", err)
	}
	// Alguien vuelve a poner el catálogo viejo, bien firmado: no se acepta, ni tras reiniciar.
	escribir(5, 3)
	if p, err := l.Leer(); err == nil || p != nil || !strings.Contains(err.Error(), "older catalog") {
		t.Fatalf("no se vuelve atrás: %v", err)
	}
	if p, err := nuevo().Leer(); err == nil || p != nil {
		t.Fatalf("tampoco un sensor recién arrancado: %v", err)
	}
	escribir(7, 4)
	if p, err := nuevo().Leer(); err != nil || p == nil {
		t.Fatalf("la misma serie de antes sigue valiendo: %v", err)
	}
	// Si no se puede apuntar la serie, no se acepta.
	sinMemoria := nuevo()
	sinMemoria.RutaSerie = filepath.Join(dir, "no-existe", "serie")
	escribir(8, 5)
	if p, err := sinMemoria.Leer(); err == nil || p != nil {
		t.Fatalf("sin poder apuntar la serie no se acepta: %v", err)
	}
}

func TestReglaConLosDosCatalogos(t *testing.T) {
	nuestra := manifiesto("r/smb@sha256:1")
	c := &Catalogo{Version: "0.25.0", Modulos: map[string][]string{"smb": {Huella(nuestra)}, "acme-portal": {"0"}}}
	suya := dePartner("acme-portal")
	otraSuya := dePartner("acme-erp")
	p := &Partner{MSP: "acme", Prefijo: "acme", Serie: 1, Caduca: ahoraPrueba.AddDate(0, 1, 0),
		Modulos: map[string][]string{"acme-portal": {Huella(suya)}, "acme-erp": {Huella(otraSuya)}}}
	ahora := func() time.Time { return ahoraPrueba }

	if Regla(nil, p, nil, ahora) != nil {
		t.Fatal("sin catálogo firmado no hay regla, como siempre")
	}
	r := Regla(c, p, nil, ahora)
	if m := r(plan.TrampaPlan{Manifiesto: nuestra}); m != "" {
		t.Fatalf("la nuestra arranca: %s", m)
	}
	if m := r(plan.TrampaPlan{Manifiesto: otraSuya}); m != "" {
		t.Fatalf("la del partner arranca: %s", m)
	}
	// Un id que está en nuestro catálogo se decide con el nuestro: el partner no lo pisa.
	if m := r(plan.TrampaPlan{Manifiesto: suya}); !strings.Contains(m, "signed in version 0.25.0") {
		t.Fatalf("manda nuestro catálogo: %q", m)
	}
	// Uno que no es nuestro ni lleva el prefijo: fuera, por nuestro catálogo.
	if m := r(plan.TrampaPlan{Manifiesto: dePartner("otro-x")}); !strings.Contains(m, "does not include module") {
		t.Fatalf("sin prefijo: %q", m)
	}
	// Sin catálogo de partner, o con uno que no vale, las suyas no arrancan y las nuestras sí.
	for _, r := range []func(plan.TrampaPlan) string{Regla(c, nil, nil, ahora), Regla(c, nil, os.ErrInvalid, ahora)} {
		if m := r(plan.TrampaPlan{Manifiesto: otraSuya}); m == "" {
			t.Fatal("sin catálogo de partner válido, la suya no arranca")
		}
		if m := r(plan.TrampaPlan{Manifiesto: nuestra}); m != "" {
			t.Fatalf("la nuestra no depende del partner: %s", m)
		}
	}
}

// Punta a punta con las herramientas de verdad (emitir-certificado-partner.ts y
// firmar-catalogo-partner.ts): lo que firma el TypeScript lo acepta este Go. Sin las
// variables no corre; las pone quien prueba las herramientas.
//
//	PARTNER_E2E_CATALOGO=<catálogo firmado> PARTNER_E2E_CLAVE=<pública de delegaciones>
//	PARTNER_E2E_MANIFIESTO=<manifiesto proyectado, JSON> go test ./internal/catalogo -run Herramientas
func TestCatalogoFirmadoPorLasHerramientas(t *testing.T) {
	ruta, clave := os.Getenv("PARTNER_E2E_CATALOGO"), os.Getenv("PARTNER_E2E_CLAVE")
	if ruta == "" || clave == "" {
		t.Skip("sin PARTNER_E2E_CATALOGO y PARTNER_E2E_CLAVE")
	}
	b, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	p, err := VerificarPartner(actualizador.LeerConfianza("delegaciones:"+clave, ""), "acme", b, time.Now())
	if err != nil {
		t.Fatalf("el sensor no acepta lo que firman las herramientas: %v", err)
	}
	if _, err := VerificarPartner(actualizador.LeerConfianza("delegaciones:"+clave, ""), "otro", b, time.Now()); err == nil {
		t.Fatal("el nodo de otro partner no lo acepta")
	}
	m, err := os.ReadFile(os.Getenv("PARTNER_E2E_MANIFIESTO"))
	if err != nil {
		t.Fatal(err)
	}
	var man plan.Manifiesto
	if err := json.Unmarshal(m, &man); err != nil {
		t.Fatal(err)
	}
	if motivo := p.Motivo(plan.TrampaPlan{ID: "t", Manifiesto: man}, time.Now()); motivo != "" {
		t.Fatalf("la trampa firmada no arranca: %s", motivo)
	}
	man.Contenedor.Imagen = "atacante.example/x@sha256:" + strings.Repeat("c", 64)
	if motivo := p.Motivo(plan.TrampaPlan{ID: "t", Manifiesto: man}, time.Now()); motivo == "" {
		t.Fatal("con otra imagen tiene que rechazarla")
	}
}

func TestTraedorDejaElCatalogoDelPartner(t *testing.T) {
	kino, partner, atacante := nuevasClaves(), nuevasClaves(), nuevasClaves()
	conf := actualizador.LeerConfianza("delegaciones:"+kino.b64, "")
	cert := certificado(kino, partner, nil)
	mods := map[string][]string{"acme-portal": {Huella(dePartner("acme-portal"))}}
	var entrega []byte
	estado := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secreto" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if estado != http.StatusOK {
			w.WriteHeader(estado)
			return
		}
		_, _ = w.Write([]byte(`{"catalogo":` + string(entrega) + `}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	ruta := filepath.Join(dir, FicheroPartner)
	tr := &Traedor{URL: srv.URL, Token: "secreto", HTTP: srv.Client(), Dir: dir, Partner: "acme", Confianza: conf,
		Ahora: func() time.Time { return ahoraPrueba }}
	serieEnDisco := func() int64 {
		b, err := os.ReadFile(ruta)
		if err != nil {
			return 0
		}
		p, err := VerificarPartner(conf, "acme", b, ahoraPrueba)
		if err != nil {
			t.Fatalf("lo que hay en disco no verifica: %v", err)
		}
		return p.Serie
	}

	// Sin partner no pregunta ni escribe.
	entrega = catalogoDe(partner, cert, 2, mods, nil)
	if err := (&Traedor{URL: srv.URL, Token: "secreto", HTTP: srv.Client(), Dir: dir, Confianza: conf}).Vuelta(context.Background()); err != nil || serieEnDisco() != 0 {
		t.Fatalf("sin PARTNER no hace nada: %v", err)
	}
	if err := tr.Vuelta(context.Background()); err != nil || serieEnDisco() != 2 {
		t.Fatalf("el bueno se guarda: %v", err)
	}
	// La consola entrega uno firmado por otro: se rechaza y se queda el que había.
	entrega = catalogoDe(atacante, certificado(atacante, atacante, nil), 9, mods, nil)
	if err := tr.Vuelta(context.Background()); err == nil || serieEnDisco() != 2 {
		t.Fatalf("uno falso no entra: %v", err)
	}
	// Uno auténtico pero más viejo: tampoco.
	entrega = catalogoDe(partner, cert, 1, mods, nil)
	if err := tr.Vuelta(context.Background()); err == nil || serieEnDisco() != 2 {
		t.Fatalf("no se vuelve atrás: %v", err)
	}
	entrega = catalogoDe(partner, cert, 3, mods, nil)
	if err := tr.Vuelta(context.Background()); err != nil || serieEnDisco() != 3 {
		t.Fatalf("uno más nuevo sustituye: %v", err)
	}
	// Que la consola deje de entregarlo no borra el que hay.
	estado = http.StatusNotFound
	if err := tr.Vuelta(context.Background()); err != nil || serieEnDisco() != 3 {
		t.Fatalf("un 404 no borra nada: %v", err)
	}
	// Y lo que queda lo lee el sensor.
	l := &LectorPartner{Ruta: ruta, Confianza: conf, Partner: "acme", Ahora: func() time.Time { return ahoraPrueba }}
	if p, err := l.Leer(); err != nil || p == nil || p.Serie != 3 {
		t.Fatalf("el sensor lo lee: %v", err)
	}
}
