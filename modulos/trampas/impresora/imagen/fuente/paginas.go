package main

import (
	"fmt"
	"html"
	"net"
	"strings"
)

// Páginas de la web de administración de la impresora. Textos en español,
// persona genérica, sin logotipos ni marcas reales (regla de tpot.md §5). Son
// creíbles para quien husmea la web de una impresora (estado, bandejas,
// configuración de red y de LDAP/SMTP), pero nada de lo que se envía tiene
// efecto: solo se registra.

// paginaDe resuelve una ruta GET/HEAD. Devuelve el cuerpo, el tipo y el código:
// 200 solo para las rutas que una impresora tiene de verdad (/, login,
// configuración e /ipp*); el resto, 404, para no dar cientos de falsos
// positivos a nikto/dirb (/.git/HEAD, /wp-login.php…), que son la seña típica de
// un honeypot.
func (s *servidor) paginaDe(ruta, host, ip string) (cuerpo, tipo string, codigo int) {
	htmlTipo := "text/html; charset=utf-8"
	r := strings.ToLower(ruta)
	switch {
	case r == "" || r == "/" || r == "/index.html" || r == "/hp/device/this.loadstatus":
		return paginaInicio(s.persona, host), htmlTipo, 200
	case esRutaLogin(r):
		return paginaLogin(s.persona, false), htmlTipo, 200
	case contieneConfig(r):
		return s.paginaConfigIP(ip), htmlTipo, 200
	case strings.HasPrefix(r, "/ipp"):
		// IPP sobre GET: una impresora contesta una página, no 404.
		return paginaInicio(s.persona, host), htmlTipo, 200
	default:
		return paginaError(s.persona, 404), htmlTipo, 404
	}
}

func contieneConfig(r string) bool {
	for _, s := range []string{"config", "network", "setting", "ldap", "smtp"} {
		if strings.Contains(r, s) {
			return true
		}
	}
	return false
}

func paginaBase(p *persona, titulo, contenido string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s - %s</title>
</head>
<body>
<h1>%s</h1>
<p><strong>Modelo:</strong> %s<br>
<strong>Nombre:</strong> %s<br>
<strong>Ubicación:</strong> %s</p>
<nav><a href="/">Estado</a> | <a href="/config">Configuración</a> | <a href="/login">Iniciar sesión</a></nav>
<hr>
%s
<hr>
<p><small>Servidor web integrado - %s</small></p>
</body>
</html>`, html.EscapeString(p.modelo), html.EscapeString(titulo),
		html.EscapeString(titulo), html.EscapeString(p.modelo),
		html.EscapeString(p.nombre), html.EscapeString(p.ubicacion),
		contenido, html.EscapeString(p.fabricante))
}

// paginaError: página breve de error, como la de una impresora real.
func paginaError(p *persona, codigo int) string {
	return paginaBase(p, estadoHTTP(codigo), fmt.Sprintf(
		`<h2>%d %s</h2><p>La página solicitada no está disponible en este dispositivo.</p>`,
		codigo, html.EscapeString(estadoHTTP(codigo))))
}

// ipDeHost devuelve la IP literal de una cabecera Host (host o host:puerto), o
// "" si Host es un nombre o viene vacío. Así la web enseña la dirección por la
// que el atacante llegó —como hace CUPS—, no una IP inventada que no cuadra con
// la red.
func ipDeHost(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if net.ParseIP(host) != nil {
		return host
	}
	return ""
}

func paginaInicio(p *persona, host string) string {
	// Solo se muestra la dirección IP si la petición llegó por una IP literal
	// (la real que ve el atacante). Con un nombre, no se inventa ninguna.
	lineaIP := ""
	if ip := ipDeHost(host); ip != "" {
		lineaIP = fmt.Sprintf("<li>Dirección IP: %s</li>\n", html.EscapeString(ip))
	}
	cont := fmt.Sprintf(`<h2>Estado del dispositivo</h2>
<ul>
<li>Estado: <strong>Preparada</strong></li>
<li>Tóner negro: %d%%</li>
<li>Páginas impresas: %d</li>
<li>Bandeja 1 (multiuso): A4</li>
<li>Bandeja 2: A4</li>
<li>Firmware: %s</li>
<li>Número de serie: %s</li>
%s<li>Dirección MAC: %s</li>
</ul>`, p.nivelToner, p.paginas, html.EscapeString(p.firmware),
		html.EscapeString(p.serie), lineaIP, html.EscapeString(p.mac))
	return paginaBase(p, "Estado", cont)
}

func paginaLogin(p *persona, fallo bool) string {
	aviso := ""
	if fallo {
		aviso = `<p style="color:#b00">Usuario o contraseña incorrectos.</p>`
	}
	cont := fmt.Sprintf(`<h2>Iniciar sesión</h2>%s
<form method="POST" action="/login">
<p>Usuario: <input type="text" name="username"></p>
<p>Contraseña: <input type="password" name="password"></p>
<p><input type="submit" value="Acceder"></p>
</form>
<p><small>Acceso de administración del dispositivo.</small></p>`, aviso)
	return paginaBase(p, "Iniciar sesión", cont)
}

// valoresConfig: los valores por defecto del formulario de configuración. Son
// la referencia con la que cambioServidor decide qué ha cambiado de verdad: por
// eso el formulario de paginaConfig debe mostrar EXACTAMENTE estos valores.
func valoresConfig(p *persona) map[string]string {
	dom := dominioDe(p)
	return map[string]string{
		"ldap_server":   "ldap." + dom,
		"ldap_base":     "dc=" + dom,
		"ldap_user":     "svc-impresora",
		"ldap_password": "********",
		"smtp_server":   "smtp." + dom,
	}
}

// paginaConfigIP arma la página de configuración mostrando, para esa IP de
// origen, los últimos valores que envió (si los hay y no han caducado) sobre
// los valores por defecto: así quien hace el passback y recarga ve «guardado»
// su servidor, como en una impresora real.
func (s *servidor) paginaConfigIP(ip string) string {
	vals := valoresConfig(s.persona)
	for k, v := range s.recuerda.leer(ip) {
		vals[k] = v
	}
	return paginaConfig(s.persona, vals)
}

func paginaConfig(p *persona, vals map[string]string) string {
	if vals == nil {
		vals = valoresConfig(p)
	}
	v := func(k string) string { return html.EscapeString(vals[k]) }
	cont := fmt.Sprintf(`<h2>Configuración de red y directorio</h2>
<form method="POST" action="/config">
<h3>LDAP (libreta de direcciones)</h3>
<p>Servidor LDAP: <input type="text" name="ldap_server" value="%s"></p>
<p>Base de búsqueda: <input type="text" name="ldap_base" value="%s"></p>
<p>Usuario de servicio: <input type="text" name="ldap_user" value="%s"></p>
<p>Contraseña de servicio: <input type="password" name="ldap_password" value="%s"></p>
<h3>SMTP (enviar a correo)</h3>
<p>Servidor SMTP: <input type="text" name="smtp_server" value="%s"></p>
<p><input type="submit" value="Guardar"> <input type="submit" name="test" value="Probar"></p>
</form>`, v("ldap_server"), v("ldap_base"), v("ldap_user"), v("ldap_password"), v("smtp_server"))
	return paginaBase(p, "Configuración", cont)
}

func dominioDe(p *persona) string {
	// Un dominio interno plausible, sin ser el de nadie real: .local no se
	// resuelve en Internet.
	return "corp.local"
}

// nombreOperacion da el nombre legible de una operación IPP para el registro.
func nombreOperacion(op uint16) string {
	switch op {
	case opPrintJob:
		return "Print-Job"
	case opValidateJob:
		return "Validate-Job"
	case opCreateJob:
		return "Create-Job"
	case opSendDocument:
		return "Send-Document"
	case opCancelJob:
		return "Cancel-Job"
	case opGetJobAttrs:
		return "Get-Job-Attributes"
	case opGetJobs:
		return "Get-Jobs"
	case opGetPrinterAttrs:
		return "Get-Printer-Attributes"
	}
	return fmt.Sprintf("op-0x%04x", op)
}
