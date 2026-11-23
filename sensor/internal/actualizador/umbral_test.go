package actualizador

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
)

func TestUmbralDeDosFirmas(t *testing.T) {
	legado, privLegado := claveB64(t)
	nueva, privNueva := claveB64(t)
	reserva, privReserva := claveB64(t)
	lic, _ := claveB64(t)
	del, privDel := claveB64(t)
	claves := "cloud:" + nueva + ",cloud:" + reserva + ",licencias:" + lic + ",delegaciones:" + del
	img := `ejemplo.azurecr.io/sugardaddy-consola@sha256:` + strings.Repeat("a", 64)
	act := `ejemplo.azurecr.io/sugardaddy-actualizador@sha256:` + strings.Repeat("b", 64)
	texto := func(compose, conf string) string {
		return `{"version":"0.33.0","publicada":"2026-11-19T00:00:00Z","notas":"x","servicios":{"consola":"` + img +
			`"},"actualizador":"` + act + `","nodo":{"ficheros":{"compose.yml":"` + compose + `"}}` + conf + `}`
	}
	firmas := func(txt string, privs ...ed25519.PrivateKey) ReleaseFirmada {
		f := firmar(t, privs[0], txt)
		pubs := map[*ed25519.PrivateKey]string{&privNueva: nueva, &privReserva: reserva, &privLegado: legado, &privDel: del}
		for _, p := range privs[1:] {
			for k, pub := range pubs {
				if string(*k) == string(p) {
					pk, _ := ClaveVerificable(pub)
					f.Firmas = append(f.Firmas, Firma{Clave: Huella(pk), Firma: base64.StdEncoding.EncodeToString(ed25519.Sign(p, []byte(txt)))})
				}
			}
		}
		return f
	}
	c := LeerConfianza(claves, legado)
	env := map[string]string{"PUBLICACION_CLAVES": claves, "PUBLICACION_CLAVE_PUBLICA": legado}
	disco := map[string]string{"compose.yml": "services: {}"}
	leer := func(n string) (string, bool) { v, ok := disco[n]; return v, ok }
	comprobar := func(f ReleaseFirmada) ([]string, error) {
		t.Helper()
		r, err := VerificarEnNodo(c, "cloud", f)
		if err != nil {
			t.Fatalf("no verifica: %v", err)
		}
		cambios := CambiosSensibles(r, ModoNodo, env, leer)
		return cambios, ComprobarUmbral(c, r, f, cambios)
	}

	// Solo imágenes (el compose es el mismo): basta una.
	if cambios, err := comprobar(firmas(texto("services: {}", ""), privNueva)); err != nil || len(cambios) != 0 {
		t.Fatalf("solo imágenes: %v %v", cambios, err)
	}
	// Cambia el compose: una sola firma no vale, ni repetida.
	if _, err := comprobar(firmas(texto("services: {x: 1}", ""), privNueva)); err == nil || !strings.Contains(err.Error(), "compose.yml") {
		t.Fatalf("compose con una firma: %v", err)
	}
	if _, err := comprobar(firmas(texto("services: {x: 1}", ""), privNueva, privNueva)); err == nil {
		t.Fatal("la misma clave dos veces no son dos firmas")
	}
	// Con dos claves distintas, sí: legado + nueva (lo de hoy en Cloud) o nueva + reserva.
	if _, err := comprobar(firmas(texto("services: {x: 1}", ""), privLegado, privNueva)); err != nil {
		t.Fatalf("legado y nueva: %v", err)
	}
	if _, err := comprobar(firmas(texto("services: {x: 1}", ""), privNueva, privReserva)); err != nil {
		t.Fatalf("nueva y reserva: %v", err)
	}
	// La segunda puede ser de otro uso (la de reserva de delegaciones, si se pierde el Key Vault).
	if _, err := comprobar(firmas(texto("services: {x: 1}", ""), privReserva, privDel)); err != nil {
		t.Fatalf("reserva de cloud y de delegaciones: %v", err)
	}
	// Pero la principal tiene que ser de su edición: la de delegaciones sola no verifica.
	if _, err := VerificarEnNodo(c, "cloud", firmas(texto("services: {}", ""), privDel)); err == nil {
		t.Fatal("firmada solo con delegaciones no debería verificar")
	}
	// Cambiar las claves de confianza también lo pide; dejarlas como están (en otro orden), no.
	otra, _ := claveB64(t)
	if cambios, _ := comprobar(firmas(texto("services: {}", `,"confianza":{"claves":"delegaciones:`+del+`,cloud:`+reserva+`, cloud:`+nueva+`,licencias:`+lic+`"}`), privNueva)); len(cambios) != 0 {
		t.Fatalf("misma lista en otro orden: %v", cambios)
	}
	if _, err := comprobar(firmas(texto("services: {}", `,"confianza":{"claves":"`+claves+`,cloud:`+otra+`"}`), privNueva)); err == nil || !strings.Contains(err.Error(), "trusted keys") {
		t.Fatalf("claves nuevas con una firma: %v", err)
	}
	if _, err := comprobar(firmas(texto("services: {}", `,"confianza":{"claves":"`+claves+`","retirarLegado":true}`), privNueva)); err == nil {
		t.Fatal("retirar el legado con una firma")
	}
	// Variables nuevas del .env.
	if cambios, _ := comprobar(firmas(texto("services: {}", ""), privNueva)); len(cambios) != 0 {
		t.Fatal(cambios)
	}
	r := Release{Version: "1.0.0", Nodo: &Configuracion{Ficheros: disco, Entorno: &struct {
		Nuevas  map[string]string `json:"nuevas,omitempty"`
		Generar []string          `json:"generar,omitempty"`
	}{Nuevas: map[string]string{"NUEVA": "1"}}}}
	if cambios := CambiosSensibles(r, ModoNodo, env, leer); len(cambios) != 1 {
		t.Fatalf("variable nueva: %v", cambios)
	}
	// Un nodo que solo confía en una clave no puede pedir dos.
	solo := LeerConfianza("", legado)
	f := firmas(texto("services: {x: 1}", ""), privLegado)
	rr, _ := Verificar(solo, f)
	if err := ComprobarUmbral(solo, rr, f, []string{"compose.yml"}); err != nil {
		t.Fatalf("con una sola clave de confianza: %v", err)
	}
	// Sensor remoto: mira su propia sección.
	if cambios := CambiosSensibles(rr, ModoSensorRemoto, env, leer); len(cambios) != 0 {
		t.Fatalf("sensor remoto sin sección: %v", cambios)
	}
}
