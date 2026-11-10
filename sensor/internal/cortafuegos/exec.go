package cortafuegos

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Exec es el Ejecutor de verdad: corre la orden y devuelve su salida; con
// error, lo que escribió por la de errores.
func Exec(ctx context.Context, entrada, orden string, args ...string) (string, error) {
	c := exec.CommandContext(ctx, orden, args...)
	if entrada != "" {
		c.Stdin = strings.NewReader(entrada)
	}
	var salida, errores bytes.Buffer
	c.Stdout, c.Stderr = &salida, &errores
	if err := c.Run(); err != nil {
		return salida.String(), fmt.Errorf("%v: %s", err, strings.TrimSpace(errores.String()))
	}
	return salida.String(), nil
}
