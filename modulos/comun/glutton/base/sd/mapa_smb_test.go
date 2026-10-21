package sd

import (
	"strings"
	"testing"
)

func m(kv map[string]any) map[string]any { return kv }

func contarTipo(evs []Evento, id string) int {
	n := 0
	for _, e := range evs {
		if e.EventID == id {
			n++
		}
	}
	return n
}

func buscar(evs []Evento, id string) *Evento {
	for i := range evs {
		if evs[i].EventID == id {
			return &evs[i]
		}
	}
	return nil
}

func TestMapearSMBCompleto(t *testing.T) {
	base := Evento{SrcIP: "198.51.100.7", SrcPort: 44444, DstPort: 445, Proto: "tcp", Session: "abc"}
	frames := []map[string]any{
		{"direction": "read", "command": "SMB_COM_NEGOTIATE"},
		{"direction": "read", "command": "SMB_COM_NEGOTIATE"}, // repetido: una sola negociación
		{"direction": "write", "command": "SMB_COM_NEGOTIATE"},
		{"direction": "read", "command": "SMB_COM_SESSION_SETUP_ANDX",
			"account": "jdoe", "domain": "ACME", "workstation": "PC07",
			"ntlm_version": "NTLMv2", "ntlm_response": "aabbccdd", "server_challenge": "1122334455667788"},
		{"direction": "read", "command": "SMB_COM_TREE_CONNECT_ANDX", "path": "Finanzas"},
		{"direction": "read", "command": "SMB_COM_NT_CREATE_ANDX", "path": "lectura.txt"},
		{"direction": "read", "command": "SMB_COM_NT_CREATE_ANDX", "path": "factura.xlsx",
			"payload_hash": "deadbeef", "payload_size": 2048},
		{"direction": "read", "command": "SMB_COM_WRITE_ANDX", "interface": "srvsvc", "opnum": 15},
		{"direction": "read", "command": "SMB_COM_TRANSACTION2", "setup": "TRANS2_SESSION_SETUP"},
	}
	evs := mapearSMB(Config{}, base, frames)

	for _, id := range []string{"smb.session.connect", "smb.session.negotiate", "smb.session.auth", "smb.tree.connect", "smb.file.open", "smb.file.write", "smb.rpc.call", "smb.exploit"} {
		if contarTipo(evs, id) == 0 {
			t.Errorf("falta el evento %s", id)
		}
	}
	if contarTipo(evs, "smb.session.negotiate") != 1 {
		t.Errorf("la negociación debería emitirse una sola vez")
	}
	if e := buscar(evs, "smb.session.auth"); e == nil || e.Usuario != "jdoe" || e.Dominio != "ACME" || e.Equipo != "PC07" || e.NTLMVersion != "NTLMv2" {
		t.Errorf("auth mal mapeado: %+v", e)
	}
	if e := buscar(evs, "smb.file.write"); e == nil || e.Fichero != "factura.xlsx" || e.Huella != "deadbeef" || e.Tamano != 2048 {
		t.Errorf("file.write mal mapeado: %+v", e)
	}
	if e := buscar(evs, "smb.exploit"); e == nil || e.Grave != "doublepulsar" {
		t.Errorf("exploit mal mapeado: %+v", e)
	}
	// La identidad de la sesión se copia a los eventos posteriores (quién hizo qué).
	if e := buscar(evs, "smb.tree.connect"); e == nil || e.Usuario != "jdoe" || e.Recurso != "Finanzas" {
		t.Errorf("tree.connect debería llevar el usuario de la sesión: %+v", e)
	}
	if e := buscar(evs, "smb.file.write"); e == nil || e.Usuario != "jdoe" {
		t.Errorf("file.write debería llevar el usuario de la sesión: %+v", e)
	}
	// La sesión y src/dst se propagan a cada evento.
	for _, e := range evs {
		if e.Session != "abc" || e.SrcIP != "198.51.100.7" || e.DstPort != 445 {
			t.Fatalf("base no propagada: %+v", e)
		}
	}
}

func TestMapearSMBAnonimo(t *testing.T) {
	base := Evento{SrcIP: "198.51.100.8"}
	// nmap -sC: sesión de invitado/nula (respuesta NTLMv1 corta, usuario guest).
	frames := []map[string]any{
		{"direction": "read", "command": "SMB_COM_SESSION_SETUP_ANDX",
			"account": "guest", "ntlm_version": "NTLMv1", "ntlm_response": "0011223344556677"},
	}
	evs := mapearSMB(Config{}, base, frames)
	if contarTipo(evs, "smb.session.anonymous") != 1 {
		t.Errorf("una sesión de invitado debería dar smb.session.anonymous: %+v", evs)
	}
	if contarTipo(evs, "smb.session.auth") != 0 {
		t.Errorf("una sesión de invitado NO debería dar smb.session.auth (alta)")
	}

	// Sesión NTLMSSP marcada como anónima.
	evs = mapearSMB(Config{}, base, []map[string]any{
		{"direction": "read", "command": "SMB2_SESSION_SETUP", "ntlm_version": "anonymous"},
	})
	if contarTipo(evs, "smb.session.anonymous") != 1 || contarTipo(evs, "smb.session.auth") != 0 {
		t.Errorf("NTLM anonymous debería dar anonymous, no auth: %+v", evs)
	}
}

func TestMapearSMBExploitMS17yEternalBlue(t *testing.T) {
	base := Evento{SrcIP: "203.0.113.5"}
	// Sonda MS17-010: PeekNamedPipe sobre IPC$.
	evs := mapearSMB(Config{}, base, []map[string]any{
		{"direction": "read", "command": "SMB_COM_TRANSACTION", "setup": "TRANS_PEEK_NMPIPE"},
	})
	if e := buscar(evs, "smb.exploit"); e == nil || e.Grave != "ms17-010-sonda" {
		t.Errorf("PeekNamedPipe debería dar smb.exploit ms17-010-sonda: %+v", evs)
	}
	// EternalBlue: NT_TRANSACT con un TotalDataCount enorme; se apunta el tamaño.
	evs = mapearSMB(Config{}, base, []map[string]any{
		{"direction": "read", "command": "SMB_COM_NT_TRANSACT", "total_data_count": 0x10fe8,
			"payload_hash": "cafe", "payload_size": 69608},
	})
	e := buscar(evs, "smb.exploit")
	if e == nil || e.Grave != "eternalblue" {
		t.Fatalf("NT_TRANSACT enorme debería dar smb.exploit eternalblue: %+v", evs)
	}
	if e.Tamano != 69608 || e.Huella != "cafe" {
		t.Errorf("el exploit debería llevar tamaño y huella: %+v", e)
	}
}

func TestMapearSMBMalformado(t *testing.T) {
	base := Evento{SrcIP: "203.0.113.9"}
	// nil, tipo no serializable y forma incorrecta: nunca debe entrar en pánico.
	if evs := mapearSMB(Config{}, base, nil); len(evs) != 1 { // solo el connect
		t.Errorf("nil decoded debería dar solo connect, dio %d", len(evs))
	}
	ch := make(chan int)
	if evs := mapearSMB(Config{}, base, ch); evs != nil {
		t.Errorf("un valor no serializable debería dar nil")
	}
	if evs := mapearSMB(Config{}, base, map[string]any{"no": "es-array"}); evs != nil {
		t.Errorf("un objeto (no array) debería dar nil")
	}
}

func TestMapearSMBLongitudEnorme(t *testing.T) {
	gigante := strings.Repeat("A", 1<<20)
	base := Evento{SrcIP: "198.51.100.1"}
	frames := []map[string]any{
		{"direction": "read", "command": "SMB_COM_SESSION_SETUP_ANDX",
			"account": gigante, "domain": gigante, "workstation": gigante,
			"ntlm_version":  "NTLMv2",
			"ntlm_response": gigante, "server_challenge": gigante},
		{"direction": "read", "command": "SMB_COM_TREE_CONNECT_ANDX", "path": gigante},
	}
	evs := mapearSMB(Config{}, base, frames)
	auth := buscar(evs, "smb.session.auth")
	if auth == nil {
		t.Fatal("falta auth")
	}
	if len(auth.Usuario) > maxTexto || len(auth.Dominio) > maxTexto || len(auth.Equipo) > maxTexto {
		t.Errorf("campos de texto sin recortar: %d/%d/%d", len(auth.Usuario), len(auth.Dominio), len(auth.Equipo))
	}
	if len(auth.NTLMHash) > maxHash || len(auth.Reto) > maxHash {
		t.Errorf("hash/reto sin recortar: %d/%d", len(auth.NTLMHash), len(auth.Reto))
	}
	tree := buscar(evs, "smb.tree.connect")
	if tree == nil || len(tree.Recurso) > maxTexto {
		t.Errorf("recurso sin recortar")
	}
}

func TestRecortar(t *testing.T) {
	if recortar("hola", 10) != "hola" {
		t.Error("no debería recortar textos cortos")
	}
	if got := recortar(strings.Repeat("x", 100), 10); len(got) != 10 {
		t.Errorf("recorte a 10 dio %d", len(got))
	}
	// No parte un carácter multibyte por la mitad.
	s := strings.Repeat("ñ", 100) // 2 bytes cada una
	got := recortar(s, 5)
	if len(got) > 5 {
		t.Errorf("recorte superó el límite: %d", len(got))
	}
	if len(got)%2 != 0 {
		t.Errorf("recorte partió un carácter: %q", got)
	}
}
