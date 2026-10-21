package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// TestFlujoBanco reproduce el guion del banco de pruebas con un cliente de
// verdad: descarga del formulario, credenciales equivocadas, login con la
// credencial cebo (contenido falso y cookie de sesión), inyección SQL en el
// usuario, Path Traversal en la contraseña y en la ruta, 404 en rutas que no
// existen, método raro y cierre de conexión con su duración.
func TestFlujoBanco(t *testing.T) {
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba, plantilla: "intranet"})
	ruta := e.ruta

	// El formulario: título coherente con la plantilla y los dos campos.
	codigo, cuerpo, _ := pedir(t, e, "GET", "/login", "")
	if codigo != 200 {
		t.Fatalf("GET /login: código %d, esperaba 200", codigo)
	}
	if !strings.Contains(cuerpo, "Intranet Corporativa") ||
		!strings.Contains(cuerpo, `name="usuario"`) || !strings.Contains(cuerpo, `name="password"`) ||
		!strings.Contains(cuerpo, `method="post"`) || !strings.Contains(cuerpo, `action="/login"`) {
		t.Fatalf("formulario inesperado: %q", cuerpo[:min(300, len(cuerpo))])
	}

	// Credenciales equivocadas: página de error verosímil, 200 como un portal
	// de verdad, sin decir qué falló.
	codigo, cuerpo, _ = pedir(t, e, "POST", "/login", form(map[string]string{"usuario": "empleado01", "password": "equivocada-123"}))
	if codigo != 200 {
		t.Fatalf("login rechazado: código %d, esperaba 200", codigo)
	}
	if !strings.Contains(cuerpo, "Usuario o contraseña incorrectos") {
		t.Fatalf("sin página de error verosímil: %q", cuerpo[:min(200, len(cuerpo))])
	}

	// La credencial cebo: acceso ACEPTADO con el contenido falso del portal.
	codigo, cuerpo, resp := pedir(t, e, "POST", "/login", form(map[string]string{"usuario": usuarioPrueba, "password": clavePrueba}))
	if codigo != 200 {
		t.Fatalf("login cebo: código %d, esperaba 200", codigo)
	}
	if !strings.Contains(cuerpo, "Bienvenido, "+usuarioPrueba) || !strings.Contains(cuerpo, "Avisos internos") {
		t.Fatalf("contenido falso inesperado: %q", cuerpo[:min(200, len(cuerpo))])
	}
	if g := resp.Header.Get("Set-Cookie"); !strings.HasPrefix(g, "sesion=") || !strings.Contains(g, "HttpOnly") {
		t.Fatalf("cookie de sesión tras el login cebo: %q", g)
	}

	// Inyección SQL en el usuario: rechazada como una credencial equivocada
	// (el portal escapa bien), y apuntada como web.comando.
	codigo, _, _ = pedir(t, e, "POST", "/login", form(map[string]string{"usuario": "admin'--", "password": "x"}))
	if codigo != 200 {
		t.Fatalf("inyección: código %d, esperaba 200", codigo)
	}

	// Path Traversal en la contraseña.
	pedir(t, e, "POST", "/login", form(map[string]string{"usuario": "admin", "password": "../../../etc/passwd"}))

	// Path Traversal en la ruta: 404 verosímil, sin abrir nada.
	conexion, err := net.DialTimeout("tcp", strings.TrimPrefix(e.base, "http://"), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conexion.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(conexion, "GET /../../etc/passwd HTTP/1.1\r\nHost: intranet.local\r\nConnection: close\r\n\r\n")
	br := bufio.NewReader(conexion)
	primera, _ := br.ReadString('\n')
	if !strings.Contains(primera, " 404 ") {
		t.Fatalf("traversal en la ruta: esperaba 404, llegó %q", strings.TrimSpace(primera))
	}
	resto, _ := io.ReadAll(br)
	conexion.Close()
	if !strings.Contains(string(resto), "No encontrado") {
		t.Fatalf("404 sin página verosímil: %q", string(resto[:min(120, len(resto))]))
	}

	// Rutas que no existen: 404 plausible (nmap -sV y su http-title piden /).
	codigo, _, _ = pedir(t, e, "GET", "/", "")
	if codigo != 404 {
		t.Fatalf("GET /: código %d, esperaba 404", codigo)
	}

	// Método raro contra el formulario: 405 con su Allow, y sondeo.
	codigo, _, _ = pedir(t, e, "PUT", "/login", "")
	if codigo != 405 {
		t.Fatalf("PUT /login: código %d, esperaba 405", codigo)
	}

	// Los eventos que comprueba el banco.
	esperarEvento(t, ruta, "web.session.connect", nil)
	esperarEvento(t, ruta, "web.login", func(m map[string]any) bool {
		return contiene(m, "usuario", "empleado01") && contiene(m, "password", "equivocada-123") &&
			contiene(m, "resultado", "rechazada") && contiene(m, "agente", "Go-http-client")
	})
	cebo := esperarEvento(t, ruta, "web.login.cebo", func(m map[string]any) bool {
		return contiene(m, "password", clavePrueba) && contiene(m, "resultado", "aceptada")
	})
	if v, _ := cebo["usuario"].(string); v != usuarioPrueba {
		t.Fatalf("login cebo sin el usuario: %v", cebo)
	}
	esperarEvento(t, ruta, "web.comando", func(m map[string]any) bool {
		return contiene(m, "grave", "inyección SQL") && contiene(m, "usuario", "admin'--")
	})
	esperarEvento(t, ruta, "web.comando", func(m map[string]any) bool {
		return contiene(m, "grave", "Path Traversal") && contiene(m, "grave", "password")
	})
	esperarEvento(t, ruta, "web.comando", func(m map[string]any) bool {
		return contiene(m, "grave", "Path Traversal") && contiene(m, "ruta", "../../etc/passwd")
	})
	esperarEvento(t, ruta, "web.sondeo", func(m map[string]any) bool {
		return contiene(m, "ruta", "/") && contiene(m, "motivo", "ruta que no existe")
	})
	esperarEvento(t, ruta, "web.sondeo", func(m map[string]any) bool {
		return contiene(m, "metodo", "PUT")
	})
	esperarEvento(t, ruta, "web.session.closed", func(m map[string]any) bool {
		return contiene(m, "duration", "0.")
	})
}

// TestSondaIlegible: bytes que no son HTTP (sonda binaria de nmap) no tumban
// la trampa; la conexión se apunta como sondeo (baja) aunque no se haya
// entendido ni una petición, y el servidor sigue sirviendo.
func TestSondaIlegible(t *testing.T) {
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba})
	ruta := e.ruta
	conexion, err := net.DialTimeout("tcp", strings.TrimPrefix(e.base, "http://"), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conexion.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(conexion, "\x80\x81\x00\x05sonda\x00\x01binary\r\n\r\n")
	conexion.Close()
	esperarEvento(t, ruta, "web.sondeo", func(m map[string]any) bool {
		return contiene(m, "motivo", "sin una petición legible")
	})

	// La trampa sigue en pie.
	codigo, cuerpo, _ := pedir(t, e, "GET", "/login", "")
	if codigo != 200 || !strings.Contains(cuerpo, "Acceso") {
		t.Fatalf("la trampa debería seguir sirviendo: %d", codigo)
	}
}

// TestSondaEscribeYCierra: una sonda que escribe y cierra SIN LEER (su kernel
// contesta RST a la respuesta) no pierde la señal: el evento ya está escrito
// en el registro antes de responder, y el cierre se apunta igual.
func TestSondaEscribeYCierra(t *testing.T) {
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba})
	ruta := e.ruta
	conexion, err := net.DialTimeout("tcp", strings.TrimPrefix(e.base, "http://"), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	cuerpo := "usuario=empleado02&password=se-va-sin-leer-123"
	fmt.Fprintf(conexion, "POST /login HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\n%s", len(cuerpo), cuerpo)
	// Cierra sin leer la respuesta.
	conexion.(*net.TCPConn).CloseRead()
	conexion.Close()
	esperarEvento(t, ruta, "web.login", func(m map[string]any) bool {
		return contiene(m, "usuario", "empleado02") && contiene(m, "password", "se-va-sin-leer-123")
	})
	esperarEvento(t, ruta, "web.session.closed", nil)
}

// TestCuerpoEnorme: un cuerpo anunciado gigante no se lee entero (nunca se
// reserva por la longitud que anuncia el atacante): se contesta 413, queda
// apuntado como tope y la trampa sigue sirviendo.
func TestCuerpoEnorme(t *testing.T) {
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba})
	ruta := e.ruta
	// Por el enchufe en crudo: Content-Length enorme, solo unos bytes enviados.
	conexion, err := net.DialTimeout("tcp", strings.TrimPrefix(e.base, "http://"), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conexion.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conexion, "POST /login HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: %d\r\n\r\n%s", 1<<20, strings.Repeat("a", 9000))
	primera, err := bufio.NewReader(conexion).ReadString('\n')
	if err != nil {
		t.Fatalf("sin respuesta del 413: %v", err)
	}
	if !strings.Contains(primera, " 413 ") {
		t.Fatalf("cuerpo enorme: esperaba 413, llegó %q", strings.TrimSpace(primera))
	}
	conexion.Close()
	esperarEvento(t, ruta, "web.session.tope", func(m map[string]any) bool {
		return contiene(m, "motivo", "más grande que el tope")
	})

	// La trampa sigue en pie.
	codigo, _, _ := pedir(t, e, "GET", "/login", "")
	if codigo != 200 {
		t.Fatalf("la trampa debería seguir sirviendo tras el cuerpo enorme: %d", codigo)
	}
}

// TestCeboSinContrasena: contraseña cebo vacía = no se acepta NINGÚN login;
// la credencial que sería la cebo se apunta como un intento rechazado más.
func TestCeboSinContrasena(t *testing.T) {
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: "", plantilla: "intranet"})
	ruta := e.ruta
	codigo, cuerpo, _ := pedir(t, e, "POST", "/login", form(map[string]string{"usuario": usuarioPrueba, "password": "admin"}))
	if codigo != 200 || !strings.Contains(cuerpo, "incorrectos") {
		t.Fatalf("sin contraseña cebo se acepta un login: %d", codigo)
	}
	esperarEvento(t, ruta, "web.login", func(m map[string]any) bool {
		return contiene(m, "usuario", usuarioPrueba) && contiene(m, "resultado", "rechazada")
	})
	for _, ev := range eventos(t, ruta) {
		if ev["eventid"] == "web.login.cebo" {
			t.Fatal("no puede haber login cebo con la contraseña cebo vacía")
		}
	}
}

// TestPlantillasCoherentes: cada plantilla sirve su propio título y contenido
// coherente tras el login cebo.
func TestPlantillasCoherentes(t *testing.T) {
	titulos := map[string]string{
		"intranet": "Intranet Corporativa",
		"admin":    "Panel de Administración",
		"portal":   "Portal del Empleado",
	}
	for clave, titulo := range titulos {
		e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba, plantilla: clave})
		_, cuerpo, _ := pedir(t, e, "GET", "/login", "")
		if !strings.Contains(cuerpo, titulo) {
			t.Fatalf("plantilla %s: el formulario no lleva su título %q", clave, titulo)
		}
		_, cuerpo, _ = pedir(t, e, "POST", "/login", form(map[string]string{"usuario": usuarioPrueba, "password": clavePrueba}))
		if !strings.Contains(cuerpo, "Bienvenido, "+usuarioPrueba) || !strings.Contains(cuerpo, titulo) {
			t.Fatalf("plantilla %s: contenido tras el login incoherente: %q", clave, cuerpo[:min(200, len(cuerpo))])
		}
	}
	// Una plantilla desconocida cae en la de intranet, no en pánico.
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba, plantilla: "pepito"})
	_, cuerpo, _ := pedir(t, e, "GET", "/login", "")
	if !strings.Contains(cuerpo, "Intranet Corporativa") {
		t.Fatal("plantilla desconocida: esperaba caer en la de intranet")
	}
}

// TestPOSTSinCampos: un POST sin credenciales es una sonda, no un login.
func TestPOSTSinCampos(t *testing.T) {
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba})
	ruta := e.ruta
	codigo, _, _ := pedir(t, e, "POST", "/login", "campo=valor")
	if codigo != 200 {
		t.Fatalf("POST sin campos: código %d, esperaba 200", codigo)
	}
	esperarEvento(t, ruta, "web.sondeo", func(m map[string]any) bool {
		return contiene(m, "motivo", "sin campos de credenciales")
	})
}

// TestFormularioIlegible: un cuerpo que no es un formulario legible sale como
// sondeo con un 400, como un servidor de verdad.
func TestFormularioIlegible(t *testing.T) {
	e := arrancarServidor(t, conf{usuario: usuarioPrueba, password: clavePrueba})
	ruta := e.ruta
	conexion, err := net.DialTimeout("tcp", strings.TrimPrefix(e.base, "http://"), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conexion.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(conexion, "POST /login HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 2\r\n\r\n%9")
	primera, err := bufio.NewReader(conexion).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(primera, " 400 ") {
		t.Fatalf("formulario ilegible: esperaba 400, llegó %q", strings.TrimSpace(primera))
	}
	conexion.Close()
	esperarEvento(t, ruta, "web.sondeo", func(m map[string]any) bool {
		return contiene(m, "motivo", "formulario ilegible")
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
