//go:build !linux

package discos

import (
	"context"
	"errors"
	"os"
)

// Fuera de Linux (el banco en un Mac) no hay discos de trampa: no se fija nada.
func rutaFija(*os.File) (string, error) {
	return "", errors.New("disks need Linux")
}

func (a *Auxiliar) respaldoDe(context.Context, string, string) error {
	return errors.New("disks need Linux")
}
