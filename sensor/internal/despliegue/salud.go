package despliegue

import (
	"context"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
	"github.com/kinomakino/sugardaddy/sensor/internal/salud"
)

// SaludTrampas dice cómo están los contenedores de las trampas de este sensor
// (docs/diseno/salud.md): en marcha o no, su estado y cuántas veces los ha
// reiniciado el motor. Una llamada para la lista y una por contenedor para sus
// reinicios, que la lista no da.
func SaludTrampas(ctx context.Context, d *docker.Cliente, sensor string) ([]salud.Trampa, error) {
	lista, err := d.ListarConEtiqueta(ctx, etiquetaSensor+"="+sensor)
	if err != nil {
		return nil, err
	}
	cs := make([]salud.Contenedor, 0, len(lista))
	for _, c := range lista {
		de := c.Labels[etiquetaTrampa]
		if de == "" {
			de = c.Labels[etiquetaAntigua]
		}
		if de == "" {
			continue
		}
		cs = append(cs, contenedorSalud(ctx, d, de, c))
	}
	return salud.Agrupar(cs), nil
}

func contenedorSalud(ctx context.Context, d *docker.Cliente, trampa string, c docker.Contenedor) salud.Contenedor {
	r := salud.Contenedor{Trampa: trampa, Principal: true, Estado: c.State}
	ins, err := d.Inspeccionar(ctx, c.ID)
	if err != nil {
		return r
	}
	if n, ok := ins["RestartCount"].(float64); ok && n >= 0 {
		r.Reinicios = int(n)
	}
	estado, _ := ins["State"].(map[string]any)
	if s, ok := estado["Status"].(string); ok && s != "" {
		r.Estado = s
	}
	if s, ok := estado["StartedAt"].(string); ok {
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil && t.Year() > 2000 {
			r.Desde = t
		}
	}
	if h, ok := estado["Health"].(map[string]any); ok {
		r.Saludable, _ = h["Status"].(string)
	}
	return r
}
