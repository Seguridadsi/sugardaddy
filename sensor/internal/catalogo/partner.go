package catalogo

// Trampas de partner: PIEZA DE CLOUD (docs/diseno/trampas-de-partner.md, en el
// núcleo privado). La edición Community no tiene partner: aquí queda solo lo que el
// sensor, el intermediario y el actualizador esperan, con la respuesta de un nodo sin
// partner. No se lee ni se trae ningún catálogo de partner, y lo que no está en el
// catálogo firmado de SeguridadSI no arranca.

import (
	"context"
	"net/http"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

// Partner: en esta edición nunca hay uno.
type Partner struct{}

// LectorPartner no lee nada: Leer siempre da nil.
type LectorPartner struct {
	Ruta      string
	Confianza actualizador.Confianza
	Partner   string
	RutaSerie string
	Ahora     func() time.Time
}

func (l *LectorPartner) Leer() (*Partner, error) { return nil, nil }

// Regla: solo el catálogo de SeguridadSI. Con `c` nil (sin versión firmada con
// catálogo) no hay regla, como siempre.
func Regla(c *Catalogo, _ *Partner, _ error, _ func() time.Time) func(plan.TrampaPlan) string {
	if c == nil {
		return nil
	}
	return c.Motivo
}

// ReglaCaducadas: sin partner, nada caduca.
func ReglaCaducadas(_ *Catalogo, _ *Partner, _ func() time.Time) func(plan.TrampaPlan) string {
	return nil
}

// Traedor no trae nada: sin partner no hay catálogo que traer.
type Traedor struct {
	URL       string
	Token     string
	HTTP      *http.Client
	Dir       string
	Partner   string
	Confianza actualizador.Confianza
	Log       func(string, ...any)
	Ahora     func() time.Time
}

func (t *Traedor) Vuelta(context.Context) error { return nil }
