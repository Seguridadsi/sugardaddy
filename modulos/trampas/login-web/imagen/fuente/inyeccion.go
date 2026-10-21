package main

import "strings"

// Detección de inyección y Path Traversal en lo que el atacante escribe: el
// usuario, la contraseña y la ruta pedida. Son los patrones típicos que lanzan
// las herramientas automáticas contra un formulario de login; una credencial
// normal (admin / Admin-2026) no los lleva. Nada se ejecuta ni se evalúa: solo
// se miran, y el intento se apunta como web.comando (alta).

var patronesInyeccion = []struct {
	trozo   string // en minúsculas
	tipo    string // tipo de inyección, va en el campo grave
	detalle string
}{
	{"or 1=1", "inyección SQL", "OR siempre verdadero"},
	{"' or", "inyección SQL", "comilla y OR"},
	{"\" or", "inyección SQL", "comilla y OR"},
	{"' and", "inyección SQL", "comilla y AND"},
	{"'='", "inyección SQL", "comilla e igualdad"},
	{"union select", "inyección SQL", "UNION SELECT"},
	{"union all", "inyección SQL", "UNION"},
	{"; drop", "inyección SQL", "sentencia apilada DROP"},
	{"; delete", "inyección SQL", "sentencia apilada DELETE"},
	{"; insert", "inyección SQL", "sentencia apilada INSERT"},
	{"; update", "inyección SQL", "sentencia apilada UPDATE"},
	{"'--", "inyección SQL", "comilla y comentario"},
	{"' --", "inyección SQL", "comilla y comentario"},
	{"'#", "inyección SQL", "comilla y comentario"},
	{"sleep(", "inyección SQL", "espera temporal (sleep)"},
	{"benchmark(", "inyección SQL", "espera temporal (benchmark)"},
	{"waitfor delay", "inyección SQL", "espera temporal (waitfor)"},
	{"xp_cmdshell", "inyección SQL", "xp_cmdshell"},
	{"<script", "inyección XSS", "etiqueta script"},
	{"javascript:", "inyección XSS", "pseudoprotocolo javascript"},
	{"onerror=", "inyección XSS", "atributo de evento onerror"},
	{"{{", "inyección de plantilla", "doble llave"},
	{"${", "inyección de plantilla", "signo de dolar y llave"},
}

// motivoInyeccion: si el valor lleva un patrón típico de inyección o de Path
// Traversal, el texto del campo grave (vacío = valor limpio).
func motivoInyeccion(campo, valor string) string {
	if strings.Contains(valor, "../") || strings.Contains(valor, `..\`) {
		return "Path Traversal (../) en " + campo
	}
	t := strings.ToLower(valor)
	for _, p := range patronesInyeccion {
		if strings.Contains(t, p.trozo) {
			return p.tipo + " (" + p.detalle + ") en " + campo
		}
	}
	return ""
}
