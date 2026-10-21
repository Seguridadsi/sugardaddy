package main

import (
	"strings"
	"testing"
	"time"
)

func entorno(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestConfigPorDefecto(t *testing.T) {
	c, err := leerConfig(entorno(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.puerto != 2222 || c.modo != "ssh" || c.retardo != 10*time.Second || c.duracionMax != 24*time.Hour ||
		c.maxConex != 1024 || c.maxPorIP != 32 || c.resumen != time.Minute || c.topeDia != 60<<20 ||
		c.registro != "/registros/reten.json" || c.banner != bannerPorDefecto {
		t.Fatalf("%+v", c)
	}
}

func TestConfigDelManifiesto(t *testing.T) {
	c, err := leerConfig(entorno(map[string]string{
		"RETEN_PUERTO": "2222", "RETEN_MODO": "banner", "RETEN_BANNER": "220 mail01 ESMTP Postfix",
		"RETEN_RETARDO_S": "60", "RETEN_DURACION_MAX_H": "1", "RETEN_MAX_CONEXIONES": "1024",
		"RETEN_MAX_POR_IP": "32", "RETEN_RESUMEN_S": "60", "RETEN_TOPE_DIA_MB": "60",
		"RETEN_REGISTRO": "/registros/reten.json",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.modo != "banner" || c.banner != "220 mail01 ESMTP Postfix" || c.retardo != time.Minute || c.duracionMax != time.Hour {
		t.Fatalf("%+v", c)
	}
}

func TestConfigRechazaLoQueNoVale(t *testing.T) {
	malos := []map[string]string{
		{"RETEN_MODO": "http"},
		{"RETEN_RETARDO_S": "0"},
		{"RETEN_RETARDO_S": "61"},
		{"RETEN_RETARDO_S": "diez"},
		{"RETEN_DURACION_MAX_H": "0"},
		{"RETEN_PUERTO": "70000"},
		{"RETEN_BANNER": "220 hola\r\n230 entra"},
		{"RETEN_BANNER": strings.Repeat("a", 201)},
		{"RETEN_BANNER": "220 ñ"},
	}
	for _, m := range malos {
		if _, err := leerConfig(entorno(m)); err == nil {
			t.Errorf("tendría que rechazar %v", m)
		}
	}
}
