package actualizador

import (
	"crypto"
	"fmt"
	"slices"
	"strings"
)

// Umbral de dos firmas (docs/diseno/politica-cambios.md, plan de fortificación §6.7).
//
// Una versión que cambia la confianza del nodo (las claves en las que confía) o su
// configuración (compose.yml, el Caddyfile o variables nuevas del .env) no se instala con
// una sola firma: tiene que venir firmada por dos claves de confianza distintas. Así, quien
// robe una sola clave puede cambiar imágenes (lo que la versión siguiente deshace), pero no
// quedarse con el nodo cambiando en qué confía o qué monta.
//
// Las versiones que solo cambian imágenes siguen valiendo con una. Un nodo que confía en una
// sola clave (los de antes de PUBLICACION_CLAVES) no puede exigir dos: se le pide una, y la
// primera versión que le deje la lista ya entra con las dos de siempre.

// FirmasExigidas: las firmas distintas que se piden a una versión con cambios sensibles.
const FirmasExigidas = 2

// candidatasUmbral: las claves que cuentan para el umbral. Todas las de confianza del nodo,
// de cualquier uso, y la de legado: Verificar ya exige que una sea de su edición, y así la
// segunda puede ser la de reserva de otro uso. Si se pierde el Key Vault sin la de legado,
// la de reserva de la edición y la de reserva de «delegaciones» siguen sumando dos, y un
// traspaso de claves sigue siendo posible.
func (c Confianza) candidatasUmbral() []crypto.PublicKey {
	var r []crypto.PublicKey
	if c.Legado != nil {
		r = append(r, c.Legado)
	}
	for _, k := range c.Claves {
		r = append(r, k.Publica)
	}
	return r
}

// FirmantesDistintos: las huellas, sin repetir, de las claves de confianza del nodo que
// firmaron el texto (en `firma` o en `firmas`).
func (c Confianza) FirmantesDistintos(texto, firma string, firmas []Firma) []string {
	var r []string
	sumar := func(h string) {
		if h != "" && !slices.Contains(r, h) {
			r = append(r, h)
		}
	}
	cand := c.candidatasUmbral()
	if firma != "" {
		for _, p := range cand {
			if firmaBuena(p, texto, firma) {
				sumar(Huella(p))
			}
		}
	}
	for i, f := range firmas {
		if i >= 8 {
			break
		}
		for _, p := range cand {
			if Huella(p) == f.Clave && firmaBuena(p, texto, f.Firma) {
				sumar(Huella(p))
			}
		}
	}
	return r
}

// clavesDistintas: cuántas claves distintas cuentan para el umbral.
func (c Confianza) clavesDistintas() int {
	var hs []string
	for _, p := range c.candidatasUmbral() {
		if h := Huella(p); !slices.Contains(hs, h) {
			hs = append(hs, h)
		}
	}
	return len(hs)
}

// CambiosSensibles: qué cambia la versión de lo que pide dos firmas, comparado con lo que hay
// en esta máquina. env es el .env de la carpeta; leer, un fichero de esa carpeta (falso si no
// está). Vacío: nada sensible.
func CambiosSensibles(r Release, modo string, env map[string]string, leer func(string) (string, bool)) []string {
	var cambios []string
	conf := r.Nodo
	if modo == ModoSensorRemoto {
		conf = r.SensorRemoto
	}
	if conf != nil {
		nombres := make([]string, 0, len(conf.Ficheros))
		for n := range conf.Ficheros {
			nombres = append(nombres, n)
		}
		slices.Sort(nombres)
		for _, n := range nombres {
			if actual, ok := leer(n); !ok || actual != conf.Ficheros[n] {
				cambios = append(cambios, n)
			}
		}
		if conf.Entorno != nil {
			for k := range conf.Entorno.Nuevas {
				if _, ok := env[k]; !ok {
					cambios = append(cambios, "new .env variables")
					break
				}
			}
		}
	}
	if c := r.Confianza; c != nil {
		if !mismaLista(c.Claves, env["PUBLICACION_CLAVES"]) {
			cambios = append(cambios, "trusted keys")
		}
		if c.RetirarLegado && strings.TrimSpace(env["PUBLICACION_CLAVE_PUBLICA"]) != "" {
			cambios = append(cambios, "legacy key retirement")
		}
		if strings.TrimSpace(c.Marcas) != "" && !mismaLista(c.Marcas, env["PUBLICACION_MARCAS"]) {
			cambios = append(cambios, "timestamp keys")
		}
	}
	return cambios
}

// mismaLista: las mismas entradas separadas por comas, sin mirar orden ni espacios.
func mismaLista(a, b string) bool {
	trozos := func(s string) []string {
		var r []string
		for _, p := range strings.Split(s, ",") {
			if p = strings.TrimSpace(p); p != "" {
				r = append(r, p)
			}
		}
		slices.Sort(r)
		return slices.Compact(r)
	}
	return slices.Equal(trozos(a), trozos(b))
}

// ComprobarUmbral: nil si la versión puede instalarse con las firmas que trae.
func ComprobarUmbral(c Confianza, r Release, f ReleaseFirmada, cambios []string) error {
	if len(cambios) == 0 {
		return nil
	}
	exigidas := min(FirmasExigidas, c.clavesDistintas())
	if n := len(c.FirmantesDistintos(f.Release, f.Firma, f.Firmas)); n < exigidas {
		return fmt.Errorf("version %s changes %s and needs signatures from %d different trusted keys; it has %d: not applied",
			r.Version, strings.Join(cambios, ", "), exigidas, n)
	}
	return nil
}
