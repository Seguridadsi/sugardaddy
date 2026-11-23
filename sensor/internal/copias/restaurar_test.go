package copias

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// restaurar.sh de verdad, con un docker falso que apunta lo que se le pide (auditoría
// del 2026-11-14, §5): lo descifrado no pasa por /tmp sino por la carpeta del nodo, y
// tras volcar la base se cierran las sesiones y se revocan los tokens de la copia. Si
// eso falla, la consola no se vuelve a arrancar.
func TestRestaurarCierraSesionesYNoUsaTmp(t *testing.T) {
	for _, h := range []string{"bash", "openssl", "tar"} {
		if _, err := exec.LookPath(h); err != nil {
			t.Skip(h + " no está en esta máquina")
		}
	}
	script, err := filepath.Abs("../../../despliegue/nodo/restaurar.sh")
	if err != nil {
		t.Fatal(err)
	}
	preparar := func(t *testing.T, psqlFalla bool) (nodo, tmp, registro string) {
		base := t.TempDir()
		nodo = filepath.Join(base, "nodo")
		tmp = filepath.Join(base, "tmp")
		bin := filepath.Join(base, "bin")
		contenido := filepath.Join(base, "contenido")
		for _, d := range []string{nodo, tmp, bin, contenido} {
			if err := os.MkdirAll(d, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		b, _ := os.ReadFile(script)
		os.WriteFile(filepath.Join(nodo, "restaurar.sh"), b, 0o755)
		os.WriteFile(filepath.Join(nodo, ".env"), []byte("POSTGRES_PASSWORD=x\n"), 0o600)
		os.WriteFile(filepath.Join(nodo, "clave-copias"), []byte("clave-de-prueba"), 0o600)
		for f, v := range map[string]string{"consola.dump": "volcado", ".env": "POSTGRES_PASSWORD=x\n", "versiones.env": "X=1\n"} {
			os.WriteFile(filepath.Join(contenido, f), []byte(v), 0o600)
		}
		tarf := filepath.Join(base, "copia.tar")
		if out, err := exec.Command("tar", "-C", contenido, "-cf", tarf, "consola.dump", ".env", "versiones.env").CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
		copia := filepath.Join(nodo, "copia.tar.enc")
		if out, err := exec.Command("openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt",
			"-pass", "file:"+filepath.Join(nodo, "clave-copias"), "-in", tarf, "-out", copia).CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
		registro = filepath.Join(base, "docker.log")
		falla := "0"
		if psqlFalla {
			falla = "1"
		}
		docker := `#!/usr/bin/env bash
echo "docker $*" >> "` + registro + `"
case "$*" in
*"exec -T postgres pg_restore"*) cat > /dev/null; ls -a "` + nodo + `" | grep '^\.restaurar\.' | sed 's/^/tmpdir /' >> "` + registro + `" ;;
*"exec -T postgres psql"*) sed 's/^/sql /' >> "` + registro + `"; exit ` + falla + ` ;;
esac
exit 0
`
		os.WriteFile(filepath.Join(bin, "docker"), []byte(docker), 0o755)
		return nodo, tmp, registro
	}
	correr := func(nodo, tmp string) (string, error) {
		cmd := exec.Command("bash", filepath.Join(nodo, "restaurar.sh"), "copia.tar.enc")
		cmd.Dir = nodo
		cmd.Env = append(os.Environ(), "TMPDIR="+tmp, "PATH="+filepath.Join(filepath.Dir(nodo), "bin")+":"+os.Getenv("PATH"))
		cmd.Stdin = strings.NewReader("y\n")
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		err := cmd.Run()
		return out.String(), err
	}

	t.Run("bien", func(t *testing.T) {
		nodo, tmp, registro := preparar(t, false)
		out, err := correr(nodo, tmp)
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		r, _ := os.ReadFile(registro)
		log := string(r)
		if !strings.Contains(log, "tmpdir .restaurar.") {
			t.Fatalf("lo descifrado no estaba en la carpeta del nodo:\n%s", log)
		}
		if quedan, _ := os.ReadDir(tmp); len(quedan) != 0 {
			t.Fatalf("restaurar.sh dejó cosas en TMPDIR: %v", quedan)
		}
		if m, _ := filepath.Glob(filepath.Join(nodo, ".restaurar.*")); len(m) != 0 {
			t.Fatalf("no se borró lo descifrado: %v", m)
		}
		for _, q := range []string{"UPDATE sesiones SET cerrada = now() WHERE cerrada IS NULL", "UPDATE tokens_api SET revocado = now()"} {
			if !strings.Contains(log, q) {
				t.Fatalf("falta %q:\n%s", q, log)
			}
		}
		if i, j := strings.Index(log, "pg_restore"), strings.Index(log, "psql"); i < 0 || j < i {
			t.Fatalf("las sesiones se cierran después de volcar la base:\n%s", log)
		}
		if !strings.Contains(log[strings.Index(log, "psql"):], "up -d --wait") {
			t.Fatalf("el nodo tiene que acabar en marcha:\n%s", log)
		}
	})

	t.Run("si no se pueden cerrar, la consola no arranca", func(t *testing.T) {
		nodo, tmp, registro := preparar(t, true)
		out, err := correr(nodo, tmp)
		if err == nil || !strings.Contains(out, "stays stopped") {
			t.Fatalf("tenía que fallar: %v\n%s", err, out)
		}
		r, _ := os.ReadFile(registro)
		despues := string(r)[strings.Index(string(r), "psql"):]
		if strings.Contains(despues, " up -d") {
			t.Fatalf("arrancó la consola sin cerrar las sesiones:\n%s", r)
		}
	})
}
