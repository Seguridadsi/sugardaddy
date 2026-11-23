//go:build !linux

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "observarseccomp: solo en Linux (corre en un contenedor de la máquina de Docker)")
	os.Exit(2)
}
