package main

// La CA propia del nodo (docs/diseno/ca-nodo.md): crearla al instalar y el
// auxiliar que pasa a ella un nodo que aún usa la CA de Caddy.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/actualizador"
	"github.com/kinomakino/sugardaddy/sensor/internal/canodo"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// caGenerar deja en la carpeta una CA propia que cubra la dirección: la que
// ya hay si la cubre, o una nueva. Escribe «kept <huella>» o «new <huella>»,
// que es lo que lee instalar.sh.
func caGenerar(args []string) int {
	if len(args) < 2 || len(args) > 3 {
		fmt.Fprintln(os.Stderr, "usage: actualizador ca-generar <folder> <console address> [node id]")
		return 2
	}
	nodo := ""
	if len(args) == 3 {
		nodo = args[2]
	}
	if c, err := canodo.Leer(args[0]); err == nil && c.Cubre(args[1]) {
		fmt.Println("kept " + c.Huella())
		return 0
	}
	c, err := canodo.Generar(args[0], args[1], nodo, time.Now())
	if err != nil {
		fmt.Fprintln(os.Stderr, "could not create the node CA: "+err.Error())
		return 1
	}
	fmt.Println("new " + c.Huella())
	return 0
}

// caAuxiliar pasa el nodo a su CA propia (o remata un paso que se cortó) y
// escribe el resultado en una línea JSON, que lee el actualizador.
func caAuxiliar() int {
	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()
	ctx, cancelar := context.WithTimeout(ctx, actualizador.EsperaCambioCA)
	defer cancelar()
	d := docker.Nuevo("/var/run/docker.sock")
	c := &actualizador.CambioCA{
		Dir:      os.Getenv("CA_DIR"),
		Datos:    actualizador.DatosCaddyEnAuxiliar,
		Proyecto: os.Getenv("CA_PROYECTO"),
		Red:      os.Getenv("CA_RED"),
		Huella:   os.Getenv("CA_HUELLA"),
		Docker:   d,
		Binario:  "/docker-compose",
		Log:      func(m string, args ...any) { slog.Info(m, args...) },
	}
	r := c.Aplicar(ctx)
	b, _ := json.Marshal(r)
	fmt.Println(string(b))
	if r.Estado != actualizador.CAAplicada {
		return 1
	}
	return 0
}
