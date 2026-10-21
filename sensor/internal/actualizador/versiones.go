package actualizador

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// EscribirVersiones deja en el versiones.env del compose las imágenes que
// están corriendo, para que compose y el nodo no se lleven la contraria.
// Con configuracion, apunta también que la configuración firmada de esa
// versión está aplicada. Escribe en un temporal y lo renombra: o queda el
// fichero viejo o el nuevo.
func EscribirVersiones(ruta string, r Release, configuracion bool) error {
	var b strings.Builder
	fmt.Fprintf(&b, "# Lo escribe el actualizador tras instalar una versión. No editar a mano.\nSUGARDADDY_VERSION=%s\n", r.Version)
	nombres := make([]string, 0, len(r.Servicios))
	for s := range r.Servicios {
		nombres = append(nombres, s)
	}
	sort.Strings(nombres)
	for _, s := range nombres {
		fmt.Fprintf(&b, "%s_IMAGEN=%s\n", strings.ToUpper(strings.ReplaceAll(s, "-", "_")), r.Servicios[s])
	}
	if r.Actualizador != "" {
		fmt.Fprintf(&b, "ACTUALIZADOR_IMAGEN=%s\n", r.Actualizador)
	}
	if configuracion {
		fmt.Fprintf(&b, "SUGARDADDY_CONFIGURACION=%s\n", r.Version)
	}
	tmp := filepath.Join(filepath.Dir(ruta), ".versiones.env.tmp")
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, ruta)
}

// VersionInstalada lee SUGARDADDY_VERSION de un versiones.env; "" si no hay.
func VersionInstalada(ruta string) string { return valorDe(ruta, "SUGARDADDY_VERSION") }

// ConfiguracionAplicada lee de qué versión es la configuración aplicada; "" si ninguna (0.11 o anterior).
func ConfiguracionAplicada(ruta string) string { return valorDe(ruta, "SUGARDADDY_CONFIGURACION") }

func valorDe(ruta, clave string) string {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return ""
	}
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), clave+"="); ok {
			return v
		}
	}
	return ""
}
