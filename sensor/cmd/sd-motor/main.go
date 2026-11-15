// sd-motor es el intermediario entre el sensor y Docker (docs/diseno/aislamiento-trampas.md).
// En el nodo corre desde la imagen del sensor (`/app motor …`); este binario aparte es
// para el banco de pruebas, que lo lanza en el propio Mac delante de Docker Desktop.
package main

import (
	"os"

	"github.com/kinomakino/sugardaddy/sensor/internal/intermediario"
)

func main() { os.Exit(intermediario.Main(os.Args[1:])) }
