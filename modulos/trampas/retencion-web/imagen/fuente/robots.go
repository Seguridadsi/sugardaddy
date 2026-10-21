// Código propio de SeguridadSI (no viene de go-pot) para la trampa
// retencion-web de Sugardaddy. preparar.sh lo copia a protocol/http/.
//
// go-pot servía el mismo robots.txt en todas partes («User-agent: *\n
// Disallow: /», sin salto final): toda la flota con la misma respuesta,
// byte a byte. Aquí cada trampa tiene el suyo, sacado de su semilla
// (logging.SemillaDeLaTrampa): siempre el mismo en esa trampa y distinto de
// una a otra. Sigue prohibiendo todo («Disallow: /» justo debajo de
// «User-agent: *»): un rastreador que respeta robots.txt (el de un buscador o
// el inventario de una intranet) se va sin entrar al tarpit ni dar eventos.
// Detrás, las rutas que esconde un servidor interno corriente: el atacante
// lee todas las líneas Disallow y cada una es un sitio más donde se queda
// atascado.
package http

import (
	"crypto/sha256"
	"encoding/binary"
	"math/rand/v2"
	"slices"
	"strings"
)

var rutasRobots = []string{
	"/admin/", "/administrator/", "/api/internal/", "/archive/", "/backup/", "/backups/",
	"/bak/", "/cgi-bin/", "/conf/", "/config/", "/db/", "/debug/", "/dev/", "/dump/",
	"/export/", "/files/", "/includes/", "/install/", "/internal/", "/jenkins/", "/logs/",
	"/manage/", "/old/", "/phpmyadmin/", "/private/", "/reports/", "/scripts/",
	"/server-status", "/setup/", "/staging/", "/stats/", "/temp/", "/test/", "/tmp/",
	"/uploads/", "/vendor/", "/.git/", "/.svn/",
}

func robotsDeLaTrampa(semilla string) string {
	h := sha256.Sum256([]byte("robots\x00" + semilla))
	r := rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[:8]), binary.LittleEndian.Uint64(h[8:16])))
	var b strings.Builder
	b.WriteString("User-agent: *\nDisallow: /\n")
	rutas := slices.Clone(rutasRobots)
	r.Shuffle(len(rutas), func(i, j int) { rutas[i], rutas[j] = rutas[j], rutas[i] })
	rutas = rutas[:3+r.IntN(6)]
	if r.IntN(2) == 0 {
		slices.Sort(rutas)
	}
	for _, ruta := range rutas {
		b.WriteString("Disallow: " + ruta + "\n")
	}
	return b.String()
}
