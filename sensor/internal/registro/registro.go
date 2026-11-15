// Package registro libera lo ya leído de un registro de trampa. Lo hace el sensor
// (sin sd-motor, como root con DAC_OVERRIDE) o sd-motor por él: el sensor ya no es
// root y el registro lo escribe el usuario del honeypot (docs/diseno/aislamiento-trampas.md).
package registro

import "errors"

// ErrSinPerforar: en esta plataforma no se saben perforar ficheros.
var ErrSinPerforar = errors.New("punching holes in files is only supported on Linux")
