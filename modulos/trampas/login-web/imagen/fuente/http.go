package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
)

// Atención de las peticiones HTTP del portal. Todo el servidor web es
// net/http de la biblioteca estándar (el mismo que usa el sensor para sus
// herramientas): cabeceras topadas por el propio servidor, cuerpos topados con
// http.MaxBytesReader (nunca se reserva por la longitud que anuncia el
// atacante: pasado el tope se responde 413 sin leerlo entero y queda apuntado)
// y plazos de lectura y escritura por conexión. Nada de lo que el atacante
// pide se ejecuta: el portal solo contesta páginas y apunta credenciales.

// alias de los campos del formulario: un atacante real fuerza los nombres que
// usan los portales de verdad, no solo los de nuestro formulario.
var (
	aliasUsuario  = []string{"usuario", "username", "user", "email"}
	aliasPassword = []string{"password", "passwd", "pass", "contrasena", "contraseña"}
)

// claveConnCtx / contextoConn / connDelContexto: la conexión (con su sesión y
// su contador de peticiones) viaja al manejador dentro del contexto; es lo que
// une cada evento con la sesión de su conexión TCP.
type claveConnCtx struct{}

func contextoConn(ctx context.Context, c net.Conn) context.Context {
	return context.WithValue(ctx, claveConnCtx{}, c)
}

func connDelContexto(ctx context.Context) *connTrampa {
	if c, ok := ctx.Value(claveConnCtx{}).(*connTrampa); ok {
		return c
	}
	return nil
}

// atenderHTTP: una petición. Primero lo que delata a quien no es un navegador
// ni un usuario (ruta que no existe, método raro, inyección en la ruta), luego
// el formulario.
func (s *servidor) atenderHTTP(w http.ResponseWriter, r *http.Request) {
	ct := connDelContexto(r.Context())
	if ct != nil {
		ct.peticiones.Add(1)
	}
	ip, puerto := origenCadena(r.RemoteAddr)
	ses := nuevaSesion()
	if ct != nil {
		ses = ct.ses
	}
	base := func() evento {
		return evento{Cuando: ahoraRFC3339(), Session: ses, SrcIP: ip, SrcPort: puerto}
	}
	w.Header().Set("Server", servidorHTTP)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	ruta := r.URL.Path
	agente := recortarCodificado(r.UserAgent(), maxCodAgente)
	host := hostDe(r)

	// Path Traversal u otra inyección EN LA RUTA: lo más típico contra un
	// portal mal configurado. Se apunta como web.comando (alta) y se contesta
	// un 404 verosímil, sin abrir nada.
	if motivo := motivoInyeccion("la ruta", ruta); motivo != "" {
		ev := base()
		ev.EventID = "web.comando"
		ev.Ruta = recortarCodificado(ruta, maxCodRuta)
		ev.Metodo = r.Method
		ev.Agente = agente
		ev.Grave = motivo
		s.reg.escribir(ev)
		s.escribirPagina(w, http.StatusNotFound, pagina404(host, s.cfg.puerto))
		return
	}

	// Rutas que no existen: 404 verosímil. Quien las pide está sondeando
	// (escáneres, wordlists, nmap -sV y su http-title): sondeo, baja.
	if ruta != "/login" {
		ev := base()
		ev.EventID = "web.sondeo"
		ev.Ruta = recortarCodificado(ruta, maxCodRuta)
		ev.Metodo = r.Method
		ev.Agente = agente
		ev.Motivo = "ruta que no existe en el portal"
		s.reg.escribir(ev)
		s.escribirPagina(w, http.StatusNotFound, pagina404(host, s.cfg.puerto))
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		// El formulario. Nadie navega por accidente a la web interna de otra
		// empresa: quien lo descarga ya está mirando, y eso apunta la conexión.
		s.escribirPagina(w, http.StatusOK, s.plantilla.paginaFormulario(""))
	case http.MethodPost:
		s.atenderPOST(w, r, base, ses, agente)
	default:
		// PUT, DELETE, TRACE... contra el formulario: no es un navegador.
		ev := base()
		ev.EventID = "web.sondeo"
		ev.Ruta = ruta
		ev.Metodo = r.Method
		ev.Agente = agente
		ev.Motivo = "método que el formulario no acepta"
		s.reg.escribir(ev)
		w.Header().Set("Allow", "GET, POST")
		s.escribirPagina(w, http.StatusMethodNotAllowed, pagina405(host, s.cfg.puerto))
	}
}

// atenderPOST: el corazón de la trampa. Captura el usuario y la contraseña
// probados ENTEROS (con el User-Agent, la ruta y el método), responde como el
// portal de verdad a la credencial equivocada, detecta la inyección en los
// campos y acepta la credencial cebo enseñando el contenido falso.
func (s *servidor) atenderPOST(w http.ResponseWriter, r *http.Request, base func() evento, ses, agente string) {
	// Tope de cuerpo: nunca se reserva por la longitud que anuncia el
	// atacante; pasado el tope la lectura corta y queda apuntado (tope, alta).
	r.Body = http.MaxBytesReader(w, r.Body, int64(s.cfg.maxCuerpo))
	if err := r.ParseForm(); err != nil {
		var deMas *http.MaxBytesError
		if errors.As(err, &deMas) {
			ev := base()
			ev.EventID = "web.session.tope"
			ev.Ruta = r.URL.Path
			ev.Metodo = r.Method
			ev.Agente = agente
			ev.Motivo = "cuerpo de la petición más grande que el tope; no se leyó entero"
			s.reg.escribir(ev)
			s.escribirPagina(w, http.StatusRequestEntityTooLarge, pagina413(hostDe(r), s.cfg.puerto))
			return
		}
		ev := base()
		ev.EventID = "web.sondeo"
		ev.Ruta = r.URL.Path
		ev.Metodo = r.Method
		ev.Agente = agente
		ev.Motivo = "formulario ilegible"
		s.reg.escribir(ev)
		s.escribirPagina(w, http.StatusBadRequest, pagina400(hostDe(r), s.cfg.puerto))
		return
	}

	usuario := valorForm(r.PostForm, aliasUsuario)
	password := valorForm(r.PostForm, aliasPassword)

	// POST sin ningún campo de credenciales: no es un formulario de login, es
	// una sonda o un exploit genérico.
	if usuario == "" && password == "" {
		ev := base()
		ev.EventID = "web.sondeo"
		ev.Ruta = r.URL.Path
		ev.Metodo = r.Method
		ev.Agente = agente
		ev.Motivo = "POST sin campos de credenciales"
		s.reg.escribir(ev)
		s.escribirPagina(w, http.StatusOK, s.plantilla.paginaFormulario("Falta el usuario o la contraseña."))
		return
	}

	ev := base()
	ev.Usuario = recortarCodificado(usuario, maxCodCredencial)
	ev.Password = recortarCodificado(password, maxCodCredencial)
	ev.Ruta = r.URL.Path
	ev.Metodo = http.MethodPost
	ev.Agente = agente

	// Inyección en el usuario o en la contraseña: se apunta como web.comando
	// (alta) con el motivo, y se contesta como a una credencial equivocada,
	// que es lo que un portal con escapado correcto haría.
	if motivo := motivoInyeccion("el campo usuario", usuario); motivo != "" {
		ev.EventID = "web.comando"
		ev.Grave = motivo
		ev.Resultado = "detectada"
		s.reg.escribir(ev)
		s.escribirPagina(w, http.StatusOK, s.plantilla.paginaFormulario("Usuario o contraseña incorrectos."))
		return
	}
	if motivo := motivoInyeccion("el campo password", password); motivo != "" {
		ev.EventID = "web.comando"
		ev.Grave = motivo
		ev.Resultado = "detectada"
		s.reg.escribir(ev)
		s.escribirPagina(w, http.StatusOK, s.plantilla.paginaFormulario("Usuario o contraseña incorrectos."))
		return
	}

	// La credencial cebo: se ACEPTA y se enseña el contenido falso del portal.
	// Contraseña cebo vacía = no se acepta ningún login (solo se apuntan
	// intentos). El acceso es ALTA: esa credencial solo puede haber salido de
	// un robo de datos.
	if s.cfg.password != "" && usuario == s.cfg.usuario && password == s.cfg.password {
		ev.EventID = "web.login.cebo"
		ev.Resultado = "aceptada"
		s.reg.escribir(ev)
		token := s.id.tokenSesion(ses)
		w.Header().Set("Set-Cookie", "sesion="+token+"; Path=/; HttpOnly; SameSite=Lax")
		s.escribirPagina(w, http.StatusOK, s.plantilla.paginaContenido(s.cfg.usuario, token))
		return
	}

	// Credencial equivocada: se apunta ENTERA (media: credencial probada) y se
	// responde con la página de error verosímil, igual que el portal de verdad
	// (que no dice si falló el usuario o la contraseña).
	ev.EventID = "web.login"
	ev.Resultado = "rechazada"
	s.reg.escribir(ev)
	s.escribirPagina(w, http.StatusOK, s.plantilla.paginaFormulario("Usuario o contraseña incorrectos."))
}

// escribirPagina: escribe el código y el cuerpo. Un fallo de escritura (el
// cliente cerró sin leer: su kernel contesta RST) NO deshace nada: el evento
// ya está en el registro, que es la prueba; la página es cortesía.
func (s *servidor) escribirPagina(w http.ResponseWriter, codigo int, cuerpo string) {
	w.WriteHeader(codigo)
	_, _ = w.Write([]byte(cuerpo))
}

// valorForm: el primer campo con valor de los alias pedidos (los portales de
// verdad se llaman igual; un atacante fuerza username, user, email...).
func valorForm(form map[string][]string, alias []string) string {
	for _, nombre := range alias {
		if v := form[nombre]; len(v) > 0 && v[0] != "" {
			return v[0]
		}
	}
	return ""
}

// hostDe: el nombre con el que el atacante llamó a la trampa, sin el puerto
// (para el pie de las páginas de error, como lo escribe un servidor real).
func hostDe(r *http.Request) string {
	host := r.Host
	if i := strings.LastIndexByte(host, ':'); i >= 0 && !strings.Contains(host, "]") {
		host = host[:i]
	}
	return host
}
