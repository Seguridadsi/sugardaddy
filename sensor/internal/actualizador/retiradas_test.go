package actualizador

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var (
	dRetirado = "sha256:" + strings.Repeat("1", 64)
	dOtro     = "sha256:" + strings.Repeat("2", 64)
)

func firmarRetiradas(t *testing.T, priv ed25519.PrivateKey, r Retiradas) RetiradasFirmadas {
	t.Helper()
	b, _ := json.Marshal(r)
	return RetiradasFirmadas{Retiradas: string(b), Firma: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, b))}
}

func lista(digests ...string) Retiradas {
	return Retiradas{Tipo: "retiradas", Version: 1, Edicion: "cloud", Digests: digests, Emitida: "2026-11-15T10:00:00Z"}
}

// El vector lo genera TypeScript (paquetes/canal/src/vectores/retiradas.json).
func TestVectorRetiradas(t *testing.T) {
	b, err := os.ReadFile("../../../paquetes/canal/src/vectores/retiradas.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Clave   string            `json:"clavePublicacion"`
		Firmada RetiradasFirmadas `json:"firmada"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	c := LeerConfianza("", v.Clave)
	r, err := VerificarRetiradas(c, "cloud", v.Firmada)
	if err != nil || len(r.Digests) != 2 || r.Digests[0] != dRetirado {
		t.Fatalf("el vector debería pasar: %v %+v", err, r)
	}
	if _, err := VerificarRetiradas(c, "community", v.Firmada); err == nil {
		t.Fatal("una lista de cloud no vale en un nodo community")
	}
	tocada := v.Firmada
	tocada.Retiradas = strings.Replace(tocada.Retiradas, dRetirado+`",`, `",`, 1)
	if _, err := VerificarRetiradas(c, "cloud", tocada); err == nil {
		t.Fatal("quitar un digest del texto firmado debería invalidarla")
	}
}

func TestRetiradasClavesYForma(t *testing.T) {
	pub, priv := claveB64(t)
	_, privOtra := claveB64(t)
	c := LeerConfianza("cloud:"+pub, "")
	if _, err := VerificarRetiradas(c, "cloud", firmarRetiradas(t, priv, lista(dRetirado))); err != nil {
		t.Fatalf("firmada con la de cloud debería valer: %v", err)
	}
	if _, err := VerificarRetiradas(c, "cloud", firmarRetiradas(t, privOtra, lista(dRetirado))); err == nil {
		t.Fatal("con otra clave no debería valer")
	}
	soloDelegaciones := LeerConfianza("delegaciones:"+pub+",licencias:"+pub, "")
	if _, err := VerificarRetiradas(soloDelegaciones, "cloud", firmarRetiradas(t, priv, lista(dRetirado))); err == nil {
		t.Fatal("una clave de otro uso no basta")
	}
	for nombre, r := range map[string]Retiradas{
		"digest sin prefijo": lista(strings.Repeat("1", 64)),
		"digest repetido":    lista(dRetirado, dRetirado),
		"otra edición":       {Tipo: "retiradas", Version: 1, Edicion: "msp", Digests: []string{dRetirado}, Emitida: "2026-11-15T10:00:00Z"},
		"fecha mala":         {Tipo: "retiradas", Version: 1, Edicion: "cloud", Digests: []string{dRetirado}, Emitida: "ayer"},
	} {
		if _, err := VerificarRetiradas(c, "cloud", firmarRetiradas(t, priv, r)); err == nil {
			t.Fatalf("%s no debería valer aunque venga firmada", nombre)
		}
	}
	if _, err := VerificarRetiradas(c, "", firmarRetiradas(t, priv, lista(dRetirado))); err == nil {
		t.Fatal("un nodo sin edición no aplica listas")
	}
}

func TestRetiradasSeJuntanYNoSeOlvidan(t *testing.T) {
	pub, priv := claveB64(t)
	c := LeerConfianza("cloud:"+pub, "")
	dir := t.TempDir()
	primera := firmarRetiradas(t, priv, lista(dRetirado))
	if cambio, err := GuardarRetiradas(dir, c, "cloud", primera); err != nil || !cambio {
		t.Fatalf("debería guardarse: %v %v", cambio, err)
	}
	if cambio, _ := GuardarRetiradas(dir, c, "cloud", primera); cambio {
		t.Fatal("la misma lista dos veces no cambia nada")
	}
	// Una lista más nueva sin el primer digest (un error, o una lista vieja servida) no lo devuelve a la vida.
	segunda := lista(dOtro)
	segunda.Emitida = "2026-11-16T10:00:00Z"
	if _, err := GuardarRetiradas(dir, c, "cloud", firmarRetiradas(t, priv, segunda)); err != nil {
		t.Fatal(err)
	}
	conj, err := RetiradasGuardadas(dir, c, "cloud")
	if err != nil || !conj[dRetirado] || !conj[dOtro] {
		t.Fatalf("deberían estar las dos: %v %v", conj, err)
	}
	// Una que alguien deja en la carpeta sin firma buena no se cuenta.
	_, privAjena := claveB64(t)
	l, _ := leerGuardadas(dir)
	l = append(l, firmarRetiradas(t, privAjena, lista("sha256:"+strings.Repeat("3", 64))))
	b, _ := json.Marshal(l)
	_ = os.WriteFile(filepath.Join(dir, FicheroRetiradas), b, 0o644)
	conj, _ = RetiradasGuardadas(dir, c, "cloud")
	if conj["sha256:"+strings.Repeat("3", 64)] || len(conj) != 2 {
		t.Fatalf("la ajena no debería contar: %v", conj)
	}
	// Una mala no se guarda.
	if _, err := GuardarRetiradas(dir, c, "cloud", firmarRetiradas(t, privAjena, lista(dOtro))); err == nil {
		t.Fatal("una lista con otra clave no se guarda")
	}
	// Un fichero ilegible es un error para quien pregunta.
	_ = os.WriteFile(filepath.Join(dir, FicheroRetiradas), []byte("{roto"), 0o644)
	if _, err := RetiradasGuardadas(dir, c, "cloud"); err == nil {
		t.Fatal("un fichero roto debería ser un error")
	}
}

func TestRetiradasEnLaVersionYEnLaImagen(t *testing.T) {
	conj := ConjuntoRetiradas{dRetirado: true}
	if !conj.Retirada("r.azurecr.io/sugardaddy-trampa-adb:0.1.2@" + dRetirado) {
		t.Fatal("la imagen fijada a un digest retirado debería estar retirada")
	}
	if conj.Retirada("r.azurecr.io/sugardaddy-trampa-adb:0.1.2") || conj.Retirada("r.azurecr.io/x@"+dOtro) {
		t.Fatal("sin digest, o con otro, no")
	}
	r := Release{Version: "1.0.0", Servicios: map[string]string{"consola": "r.azurecr.io/c@" + dOtro, "sensor": "r.azurecr.io/s@" + dRetirado}}
	if got := conj.EnRelease(r); got != "r.azurecr.io/s@"+dRetirado {
		t.Fatalf("debería encontrar la del sensor: %q", got)
	}
	r.Servicios["sensor"] = "r.azurecr.io/s@" + dOtro
	if conj.EnRelease(r) != "" {
		t.Fatal("sin retiradas en la versión, nada")
	}
}

func TestTraerRetiradas(t *testing.T) {
	pub, priv := claveB64(t)
	c := LeerConfianza("cloud:"+pub, "")
	f := firmarRetiradas(t, priv, lista(dRetirado))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transparencia/retiradas-cloud.json" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(f)
	}))
	defer srv.Close()
	dir := t.TempDir()
	if cambio, err := TraerRetiradas(context.Background(), srv.Client(), srv.URL+"/transparencia", dir, c, "cloud"); err != nil || !cambio {
		t.Fatalf("debería traerla: %v %v", cambio, err)
	}
	if cambio, err := TraerRetiradas(context.Background(), srv.Client(), srv.URL+"/transparencia", dir, c, "community"); err != nil || cambio {
		t.Fatalf("sin fichero de community no hay nada, y no es un error: %v %v", cambio, err)
	}
	conj, _ := RetiradasGuardadas(dir, c, "cloud")
	if !conj[dRetirado] {
		t.Fatal("debería estar guardada")
	}
}

// El actualizador deja las listas donde el sensor las lee: junto a la versión firmada, la
// carpeta que el sensor monta en /firmado (en el nodo y en un sensor remoto).
func TestCarpetaRetiradasEsLaDeLaFirmada(t *testing.T) {
	for _, local := range []string{"/nodo", "/sensor"} {
		if got, want := CarpetaRetiradas(local), filepath.Dir(filepath.Join(local, FicheroFirmada)); got != want {
			t.Fatalf("%s: %s, expected %s", local, got, want)
		}
	}
}
