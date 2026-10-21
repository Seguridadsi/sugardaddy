package main

import (
	"fmt"
	"strconv"
	"time"
)

// config: lo que el sensor pasa por entorno (RETEN_*). Lo que elige el cliente
// (modo, banner, retardo, duración) llega validado por la consola y se vuelve
// a comprobar aquí; los topes son fijos en el manifiesto.
type config struct {
	puerto      int
	modo        string // "ssh" o "banner"
	banner      string // solo en modo banner
	retardo     time.Duration
	duracionMax time.Duration
	maxConex    int
	maxPorIP    int
	topeDia     int64 // bytes por día del registro
	resumen     time.Duration
	registro    string
	// semilla: la de esta trampa (semilla.go); RETEN_SEMILLA la fija a mano.
	semilla string

	// Fijos (no van por entorno); las pruebas los acortan.
	maxLeido      int64         // bytes que se leen de un cliente antes de cortarle
	esperaPrimera time.Duration // lo que se espera a que acabe su primera línea
	plazoEscribir time.Duration // lo que puede tardar en aceptar lo que se le manda
}

// bannerPorDefecto: el saludo tal cual lo da vsftpd 3.0.5, el de miles de
// servidores de verdad. El de antes («220 srv-ftp01 FTP server (vsFTPd 3.0.5)
// ready.») no lo da ningún vsftpd y era el mismo en toda la flota.
const bannerPorDefecto = "220 (vsFTPd 3.0.5)"

func leerConfig(entorno func(string) string) (config, error) {
	c := config{
		maxLeido:      1 << 20,
		esperaPrimera: 10 * time.Second,
		plazoEscribir: 30 * time.Second,
		modo:          "ssh",
		banner:        bannerPorDefecto,
		registro:      "/registros/reten.json",
	}
	var errs []error
	num := func(clave string, porDefecto, min, max int) int {
		v := entorno(clave)
		if v == "" {
			return porDefecto
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < min || n > max {
			errs = append(errs, fmt.Errorf("%s=%q: tiene que ser un entero de %d a %d", clave, v, min, max))
			return porDefecto
		}
		return n
	}
	c.puerto = num("RETEN_PUERTO", 2222, 1, 65535)
	c.retardo = time.Duration(num("RETEN_RETARDO_S", 10, 1, 60)) * time.Second
	c.duracionMax = time.Duration(num("RETEN_DURACION_MAX_H", 24, 1, 168)) * time.Hour
	c.maxConex = num("RETEN_MAX_CONEXIONES", 1024, 1, 8192)
	c.maxPorIP = num("RETEN_MAX_POR_IP", 32, 1, 8192)
	c.resumen = time.Duration(num("RETEN_RESUMEN_S", 60, 1, 3600)) * time.Second
	c.topeDia = int64(num("RETEN_TOPE_DIA_MB", 60, 1, 1024)) << 20

	if v := entorno("RETEN_MODO"); v != "" {
		if v != "ssh" && v != "banner" {
			errs = append(errs, fmt.Errorf("RETEN_MODO=%q: tiene que ser ssh o banner", v))
		} else {
			c.modo = v
		}
	}
	if v := entorno("RETEN_BANNER"); v != "" {
		if err := bannerValido(v); err != nil {
			errs = append(errs, fmt.Errorf("RETEN_BANNER: %w", err))
		} else {
			c.banner = v
		}
	}
	if v := entorno("RETEN_REGISTRO"); v != "" {
		c.registro = v
	}
	c.semilla = entorno("RETEN_SEMILLA")
	if len(errs) > 0 {
		return c, fmt.Errorf("configuración: %v", errs)
	}
	return c, nil
}

// bannerValido: texto imprimible (ASCII), de 1 a 200 caracteres. Nada de
// saltos de línea: el saludo es una línea, y la acaba reten con \r\n.
func bannerValido(s string) error {
	if len(s) < 1 || len(s) > 200 {
		return fmt.Errorf("tiene que tener de 1 a 200 caracteres (tiene %d)", len(s))
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return fmt.Errorf("solo admite caracteres imprimibles (ASCII); el %d no lo es", i+1)
		}
	}
	return nil
}
