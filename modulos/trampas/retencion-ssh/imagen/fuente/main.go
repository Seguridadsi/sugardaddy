// reten: trampa de retención de Sugardaddy. Código propio de SeguridadSI, sin
// dependencias: solo la biblioteca estándar de Go.
//
// Modo ssh (H68): la técnica de Endlessh (dominio público; aquí no hay código
// suyo). Antes de su línea de versión, un servidor SSH puede mandar otras
// líneas de texto (RFC 4253, 4.2) y el cliente las espera. reten manda, línea
// a línea y cada pocos segundos, un aviso legal propio de cada trampa
// (aviso.go) y nunca llega a la versión: el cliente se queda esperando horas
// sin llegar siquiera a autenticarse.
//
// Modo banner (H18): manda un saludo fijo (el de un FTP, un SMTP...) y se
// queda escuchando sin contestar nada más.
//
// Registra en JSON por líneas cada conexión, lo que dice el cliente (su versión
// de SSH o su primera orden) y cuánto tiempo se ha quedado. Con topes de
// conexiones (global y por IP), de tiempo por conexión, de lo que lee de cada
// cliente y de lo que escribe al día en el registro (repartido por IP). Las
// conexiones rechazadas por los topes y las líneas que no se apuntan salen en
// un resumen periódico, no una línea por cada una.
package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg, err := leerConfig(os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "reten:", err)
		os.Exit(2)
	}
	if cfg.semilla == "" {
		cfg.semilla = semillaDeLaTrampa(cfg.registro)
	}
	reg, err := nuevoRegistrador(cfg.registro, cfg.topeDia, time.Now)
	if err != nil {
		fmt.Fprintln(os.Stderr, "reten: no se puede abrir el registro:", err)
		os.Exit(1)
	}
	l, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.puerto))
	if err != nil {
		fmt.Fprintln(os.Stderr, "reten:", err)
		os.Exit(1)
	}
	// Al parar el contenedor (SIGTERM), suelta a todos con su línea de fin.
	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer parar()
	s := nuevoServidor(cfg, reg)
	resumen := make(chan struct{})
	go func() {
		s.resumirCada(ctx)
		close(resumen)
	}()
	fmt.Fprintf(os.Stderr, "reten: modo %s en el puerto %d\n", cfg.modo, cfg.puerto)
	_ = s.servir(ctx, l)
	<-resumen
	reg.cerrar()
}
