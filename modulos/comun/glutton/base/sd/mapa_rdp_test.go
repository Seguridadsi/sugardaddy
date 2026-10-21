package sd

import (
	"encoding/json"
	"strings"
	"testing"
)

func eventosRDP(t *testing.T, marcos []map[string]any) map[string]Evento {
	t.Helper()
	base := Evento{Proto: "tcp", SrcIP: "198.51.100.7", SrcPort: 51515, DstPort: 3389}
	evs := mapearRDP(Config{}, base, marcos)
	porID := map[string]Evento{}
	for _, e := range evs {
		porID[e.EventID] = e
	}
	return porID
}

func TestMapearRDPFlujoNLA(t *testing.T) {
	marcos := []map[string]any{
		{"direction": "read", "command": "ConnectionRequest", "cookie": "Administrator", "protocols": "TLS, CredSSP"},
		{"direction": "write", "command": "NTLMChallenge", "ntlm_server_challenge": "0123456789abcdef"},
		{"direction": "read", "command": "NTLMAuthenticate", "ntlm_user": "svc-copias", "ntlm_domain": "CORP",
			"ntlm_workstation": "PC-ATACANTE", "ntlm_version": "NTLMv2", "ntlm_server_challenge": "0123456789abcdef",
			"netntlmv2": "svc-copias::CORP:0123456789abcdef:aaaa:bbbb", "ja3": "769,47,0", "ja4": "t13d"},
		// authInfo con la contraseña en claro (login aceptado).
		{"direction": "read", "command": "TSRequest", "ntlm_user": "svc-copias", "ntlm_domain": "CORP", "nla_password": "Otoño-2026"},
	}
	ev := eventosRDP(t, marcos)

	if _, ok := ev["rdp.session.connect"]; !ok {
		t.Fatal("falta rdp.session.connect")
	}
	neg := ev["rdp.session.negotiate"]
	if neg.Usuario != "Administrator" || !strings.Contains(neg.Dialecto, "CredSSP") {
		t.Fatalf("negociación mal mapeada: %+v", neg)
	}
	ac := ev["rdp.auth.aceptado"]
	if ac.Password != "Otoño-2026" {
		t.Fatalf("contraseña en claro del authInfo no capturada: %+v", ac)
	}
	// El Type 3 aceptado lleva el NetNTLMv2 y el reto que emitimos.
	if ac.NTLMHash == "" && ev["rdp.auth"].NTLMHash == "" {
		t.Fatal("no se capturó el NetNTLMv2 del login aceptado")
	}
}

func TestMapearRDPLoginFallido(t *testing.T) {
	marcos := []map[string]any{
		{"direction": "read", "command": "NTLMAuthenticate", "ntlm_user": "root", "ntlm_domain": "",
			"ntlm_version": "NTLMv2", "netntlmv2": "root::.:00:aa:bb"},
	}
	ev := eventosRDP(t, marcos)
	a, ok := ev["rdp.auth"]
	if !ok {
		t.Fatal("falta rdp.auth del login fallido")
	}
	if _, aceptado := ev["rdp.auth.aceptado"]; aceptado {
		t.Fatal("un login fallido no debe dar rdp.auth.aceptado")
	}
	if a.NTLMHash == "" || a.Usuario != "root" {
		t.Fatalf("no se capturó el NetNTLMv2 del intento: %+v", a)
	}
}

func TestMapearRDPClientInfoEnClaro(t *testing.T) {
	marcos := []map[string]any{
		{"direction": "read", "command": "ClientInfo", "client_info": map[string]any{
			"domain": "CORP", "username": "jdoe", "password": "P@ssw0rd!", "encrypted": false}},
		// Un Client Info cifrado no debe filtrar nada.
		{"direction": "read", "command": "ClientInfo", "client_info": map[string]any{"encrypted": true}},
	}
	ev := eventosRDP(t, marcos)
	a := ev["rdp.auth"]
	if a.Usuario != "jdoe" || a.Password != "P@ssw0rd!" || a.Dominio != "CORP" {
		t.Fatalf("Client Info en claro no mapeado: %+v", a)
	}
}

// TestMapearRDPBasura comprueba que entradas malformadas o enormes no rompen ni
// disparan la memoria: textos larguísimos se recortan y lo que no entiende se
// ignora sin pánico.
func TestMapearRDPBasura(t *testing.T) {
	base := Evento{SrcIP: "203.0.113.9"}

	// decoded que no es []marcoRDP: no debe devolver nada ni entrar en pánico.
	if evs := mapearRDP(Config{}, base, map[string]any{"vaya": "basura"}); evs != nil {
		t.Fatalf("un decoded raro no debe dar eventos: %v", evs)
	}
	if evs := mapearRDP(Config{}, base, make(chan int)); evs != nil {
		t.Fatalf("un decoded no serializable no debe dar eventos: %v", evs)
	}

	enorme := strings.Repeat("A", 5_000_000)
	marcos := []map[string]any{
		{"direction": "read", "command": "ConnectionRequest", "cookie": enorme, "protocols": enorme},
		{"direction": "read", "command": "NTLMAuthenticate", "ntlm_user": enorme, "ntlm_domain": enorme,
			"ntlm_workstation": enorme, "netntlmv2": enorme, "ntlm_version": "NTLMv2"},
		{"direction": "read", "command": "TSRequest", "nla_password": enorme},
	}
	b, _ := json.Marshal(marcos)
	var vista []map[string]any
	_ = json.Unmarshal(b, &vista)
	evs := mapearRDP(Config{}, base, vista)
	for _, e := range evs {
		if len(e.Usuario) > maxTexto || len(e.Dominio) > maxTexto || len(e.Equipo) > maxTexto ||
			len(e.Password) > maxTexto || len(e.Dialecto) > maxTexto {
			t.Fatalf("un texto del atacante no se recortó: %q len=%d", e.EventID, len(e.Usuario))
		}
		if len(e.NTLMHash) > maxHash || len(e.Reto) > maxHash {
			t.Fatalf("el hash/reto no se recortó en %q", e.EventID)
		}
	}
}

// contarRDP devuelve los eventos de una sesión y cuántos hay de cada eventid.
func contarRDP(t *testing.T, marcos []map[string]any) ([]Evento, map[string]int) {
	t.Helper()
	base := Evento{Proto: "tcp", SrcIP: "198.51.100.7", SrcPort: 51515, DstPort: 3389}
	evs := mapearRDP(Config{}, base, marcos)
	n := map[string]int{}
	for _, e := range evs {
		n[e.EventID]++
	}
	return evs, n
}

// TestMapearRDPExploitYEquipo cubre el hallazgo de eventos: el MCS
// Connect-Initial trae el nombre de equipo del cliente (que antes se perdía) y,
// si pide el canal MS_T120, es la firma de BlueKeep/MS12-020 y debe dar un
// rdp.exploit crítico.
func TestMapearRDPExploitYEquipo(t *testing.T) {
	marcos := []map[string]any{
		{"direction": "read", "command": "ConnectionRequest", "cookie": "Administr", "protocols": "TLS"},
		{"direction": "read", "command": "MCSConnectInitial", "client_data": map[string]any{
			"client_name": "EMP-LAP-0014", "channels": []any{"rdpdr", "MS_T120", "rdpsnd"}}},
	}
	ev := eventosRDP(t, marcos)
	ex, ok := ev["rdp.exploit"]
	if !ok {
		t.Fatal("falta rdp.exploit cuando el cliente pide el canal MS_T120")
	}
	if ex.Equipo != "EMP-LAP-0014" {
		t.Fatalf("el exploit no trae el equipo del cliente: %+v", ex)
	}
	neg := ev["rdp.session.negotiate"]
	if neg.Equipo != "EMP-LAP-0014" {
		t.Fatalf("la negociación no recogió el nombre de equipo del MCS: %+v", neg)
	}
	// Sin MS_T120 no hay exploit.
	marcos[1]["client_data"].(map[string]any)["channels"] = []any{"rdpdr", "cliprdr"}
	ev = eventosRDP(t, marcos)
	if _, hay := ev["rdp.exploit"]; hay {
		t.Fatal("no debe haber rdp.exploit sin el canal MS_T120")
	}
}

// TestMapearRDPLoginAceptadoUnSoloEvento cubre el hallazgo de eventos: un login
// aceptado (Type 3 + authInfo) tiene que dar UN solo rdp.auth.aceptado con el
// hash y la contraseña juntos, no dos críticos a medias.
func TestMapearRDPLoginAceptadoUnSoloEvento(t *testing.T) {
	marcos := []map[string]any{
		{"direction": "read", "command": "NTLMAuthenticate", "ntlm_user": "administrador", "ntlm_domain": "CORP",
			"ntlm_version": "NTLMv2", "ntlm_server_challenge": "0123456789abcdef",
			"netntlmv2": "administrador::CORP:0123456789abcdef:aaaa:bbbb", "nla_accepted": true},
		{"direction": "read", "command": "TSRequest", "ntlm_user": "administrador", "ntlm_domain": "CORP",
			"nla_password": "Invierno-2026"},
	}
	evs, n := contarRDP(t, marcos)
	if n["rdp.auth.aceptado"] != 1 {
		t.Fatalf("se esperaba 1 rdp.auth.aceptado, hubo %d: %+v", n["rdp.auth.aceptado"], evs)
	}
	var ac Evento
	for _, e := range evs {
		if e.EventID == "rdp.auth.aceptado" {
			ac = e
		}
	}
	if ac.NTLMHash == "" || ac.Password != "Invierno-2026" {
		t.Fatalf("el único evento aceptado debe llevar hash Y contraseña: %+v", ac)
	}
}

// TestMapearRDPNetNTLMv2Intacto ancla un NetNTLMv2 de tamaño real (blob de
// Windows, > 600 caracteres): debe registrarse ENTERO (<= maxHash), no cortado,
// o no sirve para crackear. Protege contra que alguien vuelva a bajar maxHash.
func TestMapearRDPNetNTLMv2Intacto(t *testing.T) {
	blob := strings.Repeat("ab", 400) // 800 caracteres hex: un NetNTLMv2 realista
	hash := "administrador::CORP:0123456789abcdef:" + strings.Repeat("cd", 16) + ":" + blob
	if len(hash) <= 600 {
		t.Fatalf("el hash de prueba debe superar los 600 caracteres, mide %d", len(hash))
	}
	marcos := []map[string]any{
		{"direction": "read", "command": "NTLMAuthenticate", "ntlm_user": "administrador", "ntlm_domain": "CORP",
			"ntlm_version": "NTLMv2", "ntlm_server_challenge": "0123456789abcdef", "netntlmv2": hash},
	}
	ev := eventosRDP(t, marcos)
	a := ev["rdp.auth"]
	if a.NTLMHash != hash {
		t.Fatalf("el NetNTLMv2 no se registró intacto: mide %d, se esperaba %d", len(a.NTLMHash), len(hash))
	}
	if len(a.NTLMHash) > maxHash {
		t.Fatalf("el hash supera maxHash (%d): %d", maxHash, len(a.NTLMHash))
	}
}
