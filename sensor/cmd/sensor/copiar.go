package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// copiarBinario deja una copia de este binario en la ruta dada: el instalador la
// usa para poner en el anfitrión el servicio de discos (sd-discos), que es este
// mismo binario firmado con la orden discos-anfitrion. La imagen no tiene shell.
func copiarBinario(args []string) int {
	if len(args) != 1 || !filepath.IsAbs(args[0]) {
		fmt.Fprintln(os.Stderr, "usage: copiar-binario <absolute path>")
		return 2
	}
	yo, err := os.Executable()
	if err == nil {
		err = copiar(yo, args[0])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func copiar(origen, destino string) error {
	o, err := os.Open(origen)
	if err != nil {
		return err
	}
	defer o.Close()
	tmp := destino + ".tmp"
	d, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(d, o); err != nil {
		d.Close()
		return err
	}
	if err := d.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, destino)
}
