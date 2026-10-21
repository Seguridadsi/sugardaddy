package main

import (
	"fmt"
	"html"
)

// Plantillas del portal: los tres interiores que la trampa sabe fingir. Cada
// una con su título, su aspecto y su contenido falso tras el login cebo,
// coherentes entre sí (quien entra al «Panel de Administración» no ve una
// página de nóminas). Nada de lo que el atacante escribe llega a estas
// páginas: no se hace eco de su entrada, así que no hay ni XSS ni que
// escapar salvo el usuario cebo configurado, que se escapa igual.

// servidorHTTP: lo que responde el encabezado Server, para que un escáner de
// versiones (nmap -sV) vea un Apache corriente y no un servidor de trampa.
const servidorHTTP = "Apache/2.4.62 (Debian)"

type plantilla struct {
	clave     string
	titulo    string
	subtitulo string
	boton     string
	pie       string
	estilo    string
	// cuerpoContenido: el contenido falso que se enseña tras el login cebo.
	cuerpoContenido func(usuario, token string) string
}

func plantillaDe(clave string) plantilla {
	for _, p := range plantillas {
		if p.clave == clave {
			return p
		}
	}
	return plantillas[0]
}

var plantillas = []plantilla{
	{
		clave:     "intranet",
		titulo:    "Intranet Corporativa",
		subtitulo: "Acceso con sus credenciales de red corporativa.",
		boton:     "Entrar",
		pie:       "Problemas de acceso: contacte con el CAU (ext. 4040).",
		estilo: `body{font-family:Arial,Helvetica,sans-serif;background:#eceff1;margin:0;color:#263238}
.caja{max-width:360px;margin:8% auto;background:#fff;border:1px solid #b0bec5;border-top:4px solid #37474f;padding:28px}
h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}
input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box;border:1px solid #b0bec5}
button{width:100%;padding:10px;background:#37474f;color:#fff;border:0;margin-top:10px;cursor:pointer}
.error{color:#b71c1c;background:#fdecea;border:1px solid #f5c6cb;padding:8px;margin:10px 0;font-size:14px}
.pie{font-size:12px;color:#78909c;margin-top:18px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{border-bottom:1px solid #e0e0e0;padding:6px 4px}
code{background:#eceff1;padding:1px 4px}`,
		cuerpoContenido: func(usuario, token string) string {
			return `<h2>Avisos internos</h2>
<table>
<tr><td>12/10</td><td>Mantenimiento del ERP el sábado de 22:00 a 02:00.</td></tr>
<tr><td>08/10</td><td>Nueva política de teletrabajo disponible en Documentos.</td></tr>
<tr><td>02/10</td><td>Actualización del cliente VPN obligatoria antes del día 20.</td></tr>
</table>
<h2>Enlaces</h2>
<table>
<tr><td>· Gestión documental</td></tr>
<tr><td>· Reserva de salas</td></tr>
<tr><td>· Ticketing del CAU</td></tr>
</table>`
		},
	},
	{
		clave:     "admin",
		titulo:    "Panel de Administración",
		subtitulo: "Zona restringida al personal de sistemas.",
		boton:     "Iniciar sesión",
		pie:       "Uso exclusivo del equipo de infraestructura. Todos los accesos quedan registrados.",
		estilo: `body{font-family:Verdana,Arial,sans-serif;background:#1c1c24;margin:0;color:#e8e8f0}
.caja{max-width:360px;margin:9% auto;background:#262632;border:1px solid #3a3a4a;border-top:4px solid #5c6bc0;padding:28px}
h1{font-size:17px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px;color:#b0b0c8}
input{width:100%;padding:9px;margin:6px 0;box-sizing:border-box;background:#1c1c24;border:1px solid #3a3a4a;color:#e8e8f0}
button{width:100%;padding:10px;background:#5c6bc0;color:#fff;border:0;margin-top:10px;cursor:pointer}
.error{color:#ff8a80;background:#3a1a1a;border:1px solid #5c2a2a;padding:8px;margin:10px 0;font-size:13px}
.pie{font-size:11px;color:#8888a8;margin-top:18px}
table{width:100%;border-collapse:collapse;font-size:12px}
td{border-bottom:1px solid #3a3a4a;padding:6px 4px}
code{background:#1c1c24;padding:1px 4px}
.ok{color:#69f0ae}`,
		cuerpoContenido: func(usuario, token string) string {
			return `<h2>Estado de los servicios</h2>
<table>
<tr><td>Correo interno</td><td class="ok">En marcha</td></tr>
<tr><td>ERP</td><td class="ok">En marcha</td></tr>
<tr><td>Copias de seguridad</td><td class="ok">Última: hoy 03:12</td></tr>
<tr><td>VPN</td><td class="ok">En marcha</td></tr>
</table>
<h2>Cuentas</h2>
<table>
<tr><td>admin</td><td>activo</td></tr>
<tr><td>operador</td><td>activo</td></tr>
<tr><td>soporte</td><td>bloqueado (3 intentos fallidos)</td></tr>
</table>
<h2>Acciones rápidas</h2>
<table>
<tr><td>· Reiniciar servicio de correo</td></tr>
<tr><td>· Lanzar copia manual</td></tr>
<tr><td>· Ver registro de accesos</td></tr>
</table>`
		},
	},
	{
		clave:     "portal",
		titulo:    "Portal del Empleado",
		subtitulo: "Nóminas, calendario y gastos internos.",
		boton:     "Acceder",
		pie:       "¿Olvidó su contraseña? Solicite una nueva desde la app móvil.",
		estilo: `body{font-family:"Segoe UI",Arial,sans-serif;background:#f1f8e9;margin:0;color:#33691e}
.caja{max-width:360px;margin:8% auto;background:#fff;border:1px solid #c5e1a5;border-top:4px solid #7cb342;padding:28px}
h1{font-size:19px;margin:0 0 4px;color:#558b2f}h2{font-size:15px;margin:18px 0 6px;color:#558b2f}
input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box;border:1px solid #c5e1a5}
button{width:100%;padding:10px;background:#7cb342;color:#fff;border:0;margin-top:10px;cursor:pointer}
.error{color:#b71c1c;background:#fdecea;border:1px solid #f5c6cb;padding:8px;margin:10px 0;font-size:14px}
.pie{font-size:12px;color:#9e9d24;margin-top:18px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{border-bottom:1px solid #e6ee9c;padding:6px 4px}
code{background:#f1f8e9;padding:1px 4px}`,
		cuerpoContenido: func(usuario, token string) string {
			return `<h2>Novedades</h2>
<table>
<tr><td>· La nómina de este mes ya está disponible para su descarga (PDF).</td></tr>
<tr><td>· Quedan 12 días de vacaciones por planificar antes del 31/12.</td></tr>
<tr><td>· Tiene 2 notas de gasto pendientes de revisión.</td></tr>
</table>
<h2>Accesos directos</h2>
<table>
<tr><td>· Descargar nóminas</td></tr>
<tr><td>· Solicitar vacaciones</td></tr>
<tr><td>· Revisar mis gastos</td></tr>
</table>`
		},
	},
}

// docEnvuelve una página completa con el estilo de la plantilla.
func (p plantilla) doc(titulo, cuerpo string) string {
	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + titulo + `</title>
<style>` + p.estilo + `</style>
</head>
<body>
<div class="caja">
` + cuerpo + `
<p class="pie">` + p.pie + `</p>
</div>
</body>
</html>
`
}

// paginaFormulario: el formulario de acceso. Con aviso != "" lleva el cuadro
// de error verosímil (credencial equivocada, formulario ilegible...): igual
// que un portal de verdad, que no dice si falló el usuario o la contraseña.
func (p plantilla) paginaFormulario(aviso string) string {
	error := ""
	if aviso != "" {
		error = `<div class="error">` + aviso + `</div>`
	}
	return p.doc(p.titulo+" — Acceso", `<h1>`+p.titulo+`</h1>
<p>`+p.subtitulo+`</p>
`+error+`
<form method="post" action="/login">
<label>Usuario<br><input type="text" name="usuario" autocomplete="username" required></label>
<label>Contraseña<br><input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">`+p.boton+`</button>
</form>`)
}

// paginaContenido: lo que se enseña tras entrar con la credencial cebo.
// Contenido falso plausible del portal que se finge ser, con la bienvenida y
// el token de sesión (de la semilla de la trampa) como lo haría un portal
// real recién autenticado.
func (p plantilla) paginaContenido(usuario, token string) string {
	u := html.EscapeString(usuario)
	return p.doc(p.titulo+" — Inicio", `<h1>`+p.titulo+`</h1>
<p>Bienvenido, `+u+`. Sesión iniciada correctamente.</p>
`+p.cuerpoContenido(u, token)+`
<p class="pie">Sesión <code>`+token+`</code> · <a href="/login" style="color:inherit">Cerrar sesión</a></p>`)
}

// pagina404: la página de «no existe» del servidor, con el pie que pone un
// Apache real (el portal finge estar servido por él). El pie lleva el puerto
// que ve el atacante, como el de verdad.
func pagina404(host string, puerto int) string {
	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>404 No encontrado</title>
</head>
<body>
<h1>No encontrado</h1>
<p>El recurso pedido no existe en este servidor.</p>
<hr>
<address>` + servidorHTTP + ` Server at ` + html.EscapeString(host) + fmt.Sprintf(` Port %d</address>`, puerto) + `
</body>
</html>
`
}

// pagina405: método no permitido. El formulario solo acepta GET y POST, como
// el de verdad; el resto es de una herramienta que no es un navegador.
func pagina405(host string, puerto int) string {
	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>405 Método no permitido</title>
</head>
<body>
<h1>Método no permitido</h1>
<p>El método usado no está permitido para este recurso.</p>
<hr>
<address>` + servidorHTTP + ` Server at ` + html.EscapeString(host) + fmt.Sprintf(` Port %d</address>`, puerto) + `
</body>
</html>
`
}

// pagina413: cuerpo más grande que el tope. No se leyó entero (nunca se
// reserva por la longitud que anuncia el atacante) y quedó apuntado.
func pagina413(host string, puerto int) string {
	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>413 Entidad demasiado grande</title>
</head>
<body>
<h1>Entidad demasiado grande</h1>
<p>El servidor no acepta un cuerpo de petición tan grande.</p>
<hr>
<address>` + servidorHTTP + ` Server at ` + html.EscapeString(host) + fmt.Sprintf(` Port %d</address>`, puerto) + `
</body>
</html>
`
}

// pagina400: petición que no llega a entenderse como formulario.
func pagina400(host string, puerto int) string {
	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>400 Solicitud incorrecta</title>
</head>
<body>
<h1>Solicitud incorrecta</h1>
<p>El servidor no pudo entender la petición.</p>
<hr>
<address>` + servidorHTTP + ` Server at ` + html.EscapeString(host) + fmt.Sprintf(` Port %d</address>`, puerto) + `
</body>
</html>
`
}
