package actualizador

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Líneas como las de un Ubuntu 24.04 con log_format = ENRICHED.
const logAuditd = `type=SYSCALL msg=audit(1731600000.123:501): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c items=2 ppid=1 pid=2 auid=1000 uid=0 gid=0 comm="vim" exe="/usr/bin/vim.basic" subj=unconfined key="sd-sudoers"` + "\x1d" + `ARCH=x86_64 SYSCALL=openat AUID="kino" UID="root"
type=CWD msg=audit(1731600000.123:501): cwd="/root"
type=PATH msg=audit(1731600000.123:501): item=0 name="/etc/" inode=1 nametype=PARENT
type=PATH msg=audit(1731600000.123:501): item=1 name="/etc/sudoers" inode=2 nametype=NORMAL
type=PROCTITLE msg=audit(1731600000.123:501): proctitle=76696D002F6574632F7375646F657273
type=EOE msg=audit(1731600000.123:501):
type=SYSCALL msg=audit(1731600001.000:502): arch=c000003e syscall=2 success=yes exit=3 auid=4294967295 uid=0 comm="cat" exe="/usr/bin/cat" key=(null)
type=PATH msg=audit(1731600001.000:502): item=0 name="/etc/hosts" nametype=NORMAL
type=ADD_USER msg=audit(1731600002.500:503): pid=9 uid=0 auid=1000 ses=3 msg='op=adding user id=1002 exe="/usr/sbin/useradd" hostname=? addr=? terminal=pts/0 res=success'` + "\x1d" + `UID="root" AUID="kino" ID="intruso"
type=SYSCALL msg=audit(1731600003.000:504): arch=c000003e syscall=82 success=no exit=-13 auid=1001 uid=1001 comm=6D6920636F736173 exe="/usr/bin/mv" key="sd-nodo"
type=PATH msg=audit(1731600003.000:504): item=0 name=2F6F70742F7375676172646164647920782F2E656E76 nametype=NORMAL
`

func TestEventosAuditd(t *testing.T) {
	es := EventosAuditd(logAuditd)
	if len(es) != 3 {
		t.Fatalf("%d: %+v", len(es), es)
	}
	a := es[0]
	if a.Categoria != "sudoers" || a.Usuario != "kino" || a.Programa != "/usr/bin/vim.basic" || a.Ruta != "/etc/sudoers" || a.Exito != "yes" || a.Cuando != "2024-11-14T16:00:00.123Z" {
		t.Fatalf("%+v", a)
	}
	if es[1].Tipo != "ADD_USER" || es[1].Categoria != "usuarios" || es[1].Usuario != "kino" || es[1].Programa != "/usr/sbin/useradd" {
		t.Fatalf("%+v", es[1])
	}
	// Valores en hexadecimal (con espacios) y un usuario sin nombre enriquecido.
	if es[2].Categoria != "nodo" || es[2].Ruta != "/opt/sugardaddy x/.env" || es[2].Usuario != "uid 1001" || es[2].Exito != "no" {
		t.Fatalf("%+v", es[2])
	}
}

func TestAuditdNodoCursor(t *testing.T) {
	d := t.TempDir()
	log := filepath.Join(d, "audit.log")
	if err := os.WriteFile(log, []byte(logAuditd), 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var recibidos []EventoAuditd
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var c struct {
			Eventos []EventoAuditd `json:"eventos"`
		}
		_ = json.NewDecoder(r.Body).Decode(&c)
		mu.Lock()
		recibidos = append(recibidos, c.Eventos...)
		mu.Unlock()
	}))
	defer srv.Close()
	a := &AuditdNodo{Consola: srv.URL, Token: "t", HTTP: srv.Client(), Local: d, Log: log}
	// La primera vez, desde el final: no manda lo de antes.
	if err := a.Vuelta(t.Context()); err != nil || len(recibidos) != 0 {
		t.Fatalf("%v %d", err, len(recibidos))
	}
	f, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(logAuditd)
	// Una línea a medias: se queda para la próxima vuelta.
	_, _ = f.WriteString(`type=SYSCALL msg=audit(1731600009.000:600): success=yes auid=0 exe="/usr/bin/tee" key="sd-ssh"`)
	f.Close()
	if err := a.Vuelta(t.Context()); err != nil || len(recibidos) != 3 {
		t.Fatalf("%v %d", err, len(recibidos))
	}
	f, _ = os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString("\ntype=PATH msg=audit(1731600009.000:600): item=0 name=\"/root/.ssh/authorized_keys\" nametype=NORMAL\n")
	f.Close()
	if err := a.Vuelta(t.Context()); err != nil || len(recibidos) != 4 || recibidos[3].Categoria != "ssh" || recibidos[3].Ruta != "/root/.ssh/authorized_keys" {
		t.Fatalf("%v %+v", err, recibidos)
	}
	// Rotado: el fichero nuevo, desde el principio.
	_ = os.Rename(log, log+".1")
	if err := os.WriteFile(log, []byte(logAuditd), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.Vuelta(t.Context()); err != nil || len(recibidos) != 7 {
		t.Fatalf("after rotation: %v %d", err, len(recibidos))
	}
	// Sin fichero (sin auditd): nada, sin error.
	a.Log = filepath.Join(d, "no-existe")
	if err := a.Vuelta(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestAuditdNodoTope(t *testing.T) {
	d := t.TempDir()
	log := filepath.Join(d, "audit.log")
	_ = os.WriteFile(log, nil, 0o600)
	var omitidos int
	var n int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var c struct {
			Eventos  []EventoAuditd `json:"eventos"`
			Omitidos int            `json:"omitidos"`
		}
		_ = json.NewDecoder(r.Body).Decode(&c)
		n, omitidos = len(c.Eventos), c.Omitidos
	}))
	defer srv.Close()
	a := &AuditdNodo{Consola: srv.URL, Token: "t", HTTP: srv.Client(), Local: d, Log: log}
	_ = a.Vuelta(t.Context())
	var b strings.Builder
	for i := 0; i < TopeEventosAuditd+50; i++ {
		b.WriteString(`type=SYSCALL msg=audit(1731600000.000:` + itoa(1000+i) + `): success=yes auid=0 exe="/usr/bin/x" key="sd-docker"` + "\n")
	}
	_ = os.WriteFile(log, []byte(b.String()), 0o600)
	if err := a.Vuelta(t.Context()); err != nil || n != TopeEventosAuditd || omitidos != 50 {
		t.Fatalf("%v %d %d", err, n, omitidos)
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}
