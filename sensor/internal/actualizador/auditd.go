package actualizador

// Los eventos de auditd de la máquina, a la consola (docs/diseno/cortafuegos-anfitrion.md,
// plan de fortificación §1.5). El actualizador lee el audit.log de la máquina (montado
// solo de lectura en /anfitrion/audit), se queda con lo que marcan las reglas de
// Sugardaddy (claves sd-*, ReglasAuditd) y los cambios de usuarios y de la propia
// auditoría, y lo manda a la consola. La consola lo apunta en su auditoría y de ahí sale
// al SIEM del cliente como integridad.anfitrion.
//
// Acotado: lee como mucho TopeLecturaAuditd por vuelta y manda como mucho
// TopeEventosAuditd; lo que sobra se cuenta (omitidos), no se pierde en silencio. La
// primera vez empieza por el final: lo de antes de encenderlo no se manda.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// RutaAuditLog es el audit.log de la máquina dentro del actualizador.
const RutaAuditLog = "/anfitrion/audit/audit.log"

// FicheroCursorAuditd guarda por dónde se va leyendo (en la carpeta del nodo).
const FicheroCursorAuditd = ".auditd-cursor.json"

const (
	TopeLecturaAuditd = 1 << 20
	TopeEventosAuditd = 200
)

// EventoAuditd es un evento de auditd, ya resumido.
type EventoAuditd struct {
	Cuando    string `json:"cuando"`
	Serie     string `json:"serie"`
	Categoria string `json:"categoria"` // docker, nodo, sudoers, ssh, usuarios, auditoria
	Tipo      string `json:"tipo"`      // SYSCALL, ADD_USER, CONFIG_CHANGE…
	Usuario   string `json:"usuario,omitempty"`
	Programa  string `json:"programa,omitempty"`
	Ruta      string `json:"ruta,omitempty"`
	Exito     string `json:"exito,omitempty"`
}

// Tipos de registro que cuentan aunque no lleven clave: cambios de cuentas y de la
// propia auditoría.
var tiposAuditd = map[string]string{
	"ADD_USER": "usuarios", "DEL_USER": "usuarios", "USER_MGMT": "usuarios", "ADD_GROUP": "usuarios",
	"DEL_GROUP": "usuarios", "GRP_MGMT": "usuarios", "USER_CHAUTHTOK": "usuarios", "ACCT_LOCK": "usuarios",
	"ACCT_UNLOCK": "usuarios", "CONFIG_CHANGE": "auditoria", "DAEMON_END": "auditoria", "DAEMON_ABORT": "auditoria",
}

type registroAuditd struct {
	tipo   string
	serie  string
	cuando time.Time
	campos map[string]string
}

// LeerRegistroAuditd entiende una línea de audit.log: «type=X msg=audit(t:serie): k=v …»,
// con la parte «enriquecida» (tras \x1d) en mayúsculas.
func LeerRegistroAuditd(l string) (registroAuditd, bool) {
	var r registroAuditd
	if !strings.HasPrefix(l, "type=") {
		return r, false
	}
	sp := strings.IndexByte(l, ' ')
	if sp < 0 {
		return r, false
	}
	r.tipo = l[5:sp]
	resto := l[sp+1:]
	if !strings.HasPrefix(resto, "msg=audit(") {
		return r, false
	}
	fin := strings.Index(resto, "):")
	if fin < 0 {
		return r, false
	}
	marca := resto[len("msg=audit("):fin]
	t, serie, ok := strings.Cut(marca, ":")
	if !ok {
		return r, false
	}
	seg, frac, _ := strings.Cut(t, ".")
	s, err := strconv.ParseInt(seg, 10, 64)
	if err != nil {
		return r, false
	}
	ms, _ := strconv.Atoi((frac + "000")[:3])
	r.cuando = time.Unix(s, int64(ms)*int64(time.Millisecond)).UTC()
	r.serie = serie
	r.campos = camposAuditd(strings.ReplaceAll(resto[fin+2:], "\x1d", " "))
	return r, true
}

// camposAuditd parte «k=v k="v con espacios" msg='…'» en un mapa.
func camposAuditd(s string) map[string]string {
	m := map[string]string{}
	for len(s) > 0 {
		s = strings.TrimLeft(s, " ")
		eq := strings.IndexByte(s, '=')
		if eq <= 0 {
			break
		}
		k := s[:eq]
		s = s[eq+1:]
		var v string
		switch {
		case strings.HasPrefix(s, `"`):
			fin := strings.IndexByte(s[1:], '"')
			if fin < 0 {
				v, s = s[1:], ""
			} else {
				v, s = s[1:fin+1], s[fin+2:]
			}
		case strings.HasPrefix(s, `'`):
			fin := strings.IndexByte(s[1:], '\'')
			if fin < 0 {
				v, s = s[1:], ""
			} else {
				// msg='op=… acct="x" …': sus campos también cuentan.
				for k2, v2 := range camposAuditd(s[1 : fin+1]) {
					if _, ya := m[k2]; !ya {
						m[k2] = v2
					}
				}
				v, s = s[1:fin+1], s[fin+2:]
			}
		default:
			fin := strings.IndexByte(s, ' ')
			if fin < 0 {
				v, s = s, ""
			} else {
				v, s = s[:fin], s[fin:]
			}
			// auditd escribe en hexadecimal lo que trae espacios o caracteres raros.
			if (k == "name" || k == "exe" || k == "comm" || k == "key" || k == "acct") && len(v) >= 2 && len(v)%2 == 0 {
				if b, err := hex.DecodeString(v); err == nil {
					v = string(bytes.ReplaceAll(b, []byte{1}, []byte(",")))
				}
			}
		}
		if _, ya := m[k]; !ya {
			m[k] = v
		}
	}
	return m
}

// eventoDe junta los registros de una misma serie y dice si cuenta.
func eventoDe(rs []registroAuditd) (EventoAuditd, bool) {
	var e EventoAuditd
	cuenta := false
	for _, r := range rs {
		e.Serie = r.serie
		if e.Cuando == "" {
			e.Cuando = r.cuando.Format(time.RFC3339Nano)
		}
		switch r.tipo {
		case "SYSCALL":
			e.Tipo = "SYSCALL"
			for _, k := range strings.Split(r.campos["key"], ",") {
				if c, ok := strings.CutPrefix(k, "sd-"); ok {
					e.Categoria, cuenta = c, true
				}
			}
			e.Programa = primero(r.campos["exe"], r.campos["comm"])
			e.Exito = r.campos["success"]
			e.Usuario = usuarioAuditd(r.campos)
		case "PATH":
			if e.Ruta == "" && r.campos["nametype"] != "PARENT" {
				e.Ruta = r.campos["name"]
			}
		default:
			if c, ok := tiposAuditd[r.tipo]; ok {
				e.Tipo, e.Categoria, cuenta = r.tipo, c, true
				e.Programa = primero(e.Programa, r.campos["exe"], r.campos["comm"])
				e.Usuario = primero(e.Usuario, usuarioAuditd(r.campos))
				e.Exito = primero(e.Exito, r.campos["res"], r.campos["success"])
				if a := r.campos["acct"]; a != "" && e.Ruta == "" {
					e.Ruta = "account " + a
				}
			}
		}
	}
	if len(e.Ruta) > 300 {
		e.Ruta = e.Ruta[:300]
	}
	return e, cuenta
}

func usuarioAuditd(c map[string]string) string {
	if v := c["AUID"]; v != "" && v != "unset" {
		return v
	}
	if v := c["auid"]; v != "" && v != "4294967295" && v != "unset" {
		return "uid " + v
	}
	return ""
}

func primero(vs ...string) string {
	for _, v := range vs {
		if v != "" && v != "(null)" {
			return v
		}
	}
	return ""
}

// EventosAuditd saca los eventos que cuentan de un trozo de audit.log (líneas enteras).
func EventosAuditd(texto string) []EventoAuditd {
	series := map[string][]registroAuditd{}
	var orden []string
	sc := bufio.NewScanner(strings.NewReader(texto))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		r, ok := LeerRegistroAuditd(sc.Text())
		if !ok {
			continue
		}
		if _, ya := series[r.serie]; !ya {
			orden = append(orden, r.serie)
		}
		series[r.serie] = append(series[r.serie], r)
	}
	var r []EventoAuditd
	for _, s := range orden {
		if e, ok := eventoDe(series[s]); ok {
			r = append(r, e)
		}
	}
	sort.SliceStable(r, func(i, j int) bool { return r[i].Cuando < r[j].Cuando })
	return r
}

type cursorAuditd struct {
	Inodo  uint64 `json:"inodo"`
	Tamano int64  `json:"tamano"`
	Pos    int64  `json:"pos"`
}

// AuditdNodo lleva los eventos de auditd de la máquina a la consola.
type AuditdNodo struct {
	Consola string
	Token   string
	HTTP    *http.Client
	Local   string
	Log     string // RutaAuditLog si vacío
	Logf    func(string, ...any)
	// Ruta en la consola (RutaAnfitrionNodo si vacía; RutaAnfitrionSensor en un sensor remoto).
	Ruta string
}

// Vuelta lee lo nuevo del audit.log y lo manda.
func (a *AuditdNodo) Vuelta(ctx context.Context) error {
	ruta := a.Log
	if ruta == "" {
		ruta = RutaAuditLog
	}
	f, err := os.Open(ruta)
	if err != nil {
		return nil // sin auditd, o sin el montaje (un compose de antes): nada que leer
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	inodo := inodoDe(st)
	cfich := filepath.Join(a.Local, FicheroCursorAuditd)
	var c cursorAuditd
	b, err := os.ReadFile(cfich)
	if err != nil || json.Unmarshal(b, &c) != nil {
		// La primera vez, desde el final.
		return a.guardar(cfich, cursorAuditd{inodo, st.Size(), st.Size()})
	}
	if c.Inodo != inodo || st.Size() < c.Pos {
		// Rotado (o truncado): el fichero nuevo, desde el principio.
		c = cursorAuditd{Inodo: inodo}
	}
	if st.Size() == c.Pos {
		return nil
	}
	if _, err := f.Seek(c.Pos, io.SeekStart); err != nil {
		return err
	}
	trozo := make([]byte, TopeLecturaAuditd)
	n, err := io.ReadFull(f, trozo)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return err
	}
	trozo = trozo[:n]
	// Solo líneas enteras: lo que falta de la última, la próxima vez.
	if i := bytes.LastIndexByte(trozo, '\n'); i >= 0 {
		trozo = trozo[:i+1]
	} else if n == TopeLecturaAuditd {
		trozo = trozo[:n] // una línea más larga que el tope: se salta entera
	} else {
		return nil
	}
	eventos := EventosAuditd(string(trozo))
	omitidos := 0
	if len(eventos) > TopeEventosAuditd {
		omitidos = len(eventos) - TopeEventosAuditd
		eventos = eventos[:TopeEventosAuditd]
	}
	// Más de lo que se lee en una vuelta: lo que queda se salta y se cuenta como omitido.
	nueva := c.Pos + int64(len(trozo))
	saltado := false
	if st.Size()-nueva > 4*TopeLecturaAuditd {
		nueva, saltado = st.Size(), true
	}
	if len(eventos) > 0 || omitidos > 0 || saltado {
		if err := a.mandar(ctx, eventos, omitidos, saltado); err != nil {
			return err // se repite en la próxima vuelta desde el mismo sitio
		}
	}
	return a.guardar(cfich, cursorAuditd{inodo, st.Size(), nueva})
}

func (a *AuditdNodo) guardar(ruta string, c cursorAuditd) error {
	b, _ := json.Marshal(c)
	return escribirAtomico(ruta, b, 0o600)
}

func (a *AuditdNodo) mandar(ctx context.Context, eventos []EventoAuditd, omitidos int, saltado bool) error {
	if eventos == nil {
		eventos = []EventoAuditd{}
	}
	b, _ := json.Marshal(map[string]any{"eventos": eventos, "omitidos": omitidos, "saltado": saltado})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, a.Consola+rutaOConsola(a.Ruta)+"/auditoria", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+a.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.HTTP.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil // una consola de antes
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	if a.Logf != nil && (omitidos > 0 || saltado) {
		a.Logf("host audit: too many events in one round", "mandados", len(eventos), "omitidos", omitidos, "saltado", saltado)
	}
	return nil
}

func rutaOConsola(r string) string {
	if r != "" {
		return r
	}
	return RutaAnfitrionNodo
}
