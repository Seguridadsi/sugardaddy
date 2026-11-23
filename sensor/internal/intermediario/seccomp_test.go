package intermediario

import (
	"encoding/json"
	"slices"
	"testing"
)

type perfilLeido struct {
	DefaultAction string `json:"defaultAction"`
	Syscalls      []struct {
		Names  []string `json:"names"`
		Action string   `json:"action"`
		Args   []any    `json:"args"`
	} `json:"syscalls"`
}

func leerPerfil(t *testing.T, s string) (p perfilLeido, por map[string]string) {
	t.Helper()
	if err := json.Unmarshal([]byte(s), &p); err != nil {
		t.Fatal(err)
	}
	por = map[string]string{}
	for _, r := range p.Syscalls {
		for _, n := range r.Names {
			por[n] = r.Action
		}
	}
	return p, por
}

func TestPerfilPropioSoloEstrecha(t *testing.T) {
	// ptrace y mount no están en el común: aunque la lista los pida, no pasan.
	perfil, propio := PerfilSeccompPara([]string{"read", "write", "epoll_pwait", "ptrace", "mount", "clone"})
	if !propio {
		t.Fatal("tendría que ser propio")
	}
	p, por := leerPerfil(t, perfil)
	if p.DefaultAction != "SCMP_ACT_ERRNO" {
		t.Fatal(p.DefaultAction)
	}
	for _, n := range []string{"read", "write", "epoll_pwait", "exit_group", "futex", "clone"} {
		if por[n] != "SCMP_ACT_ALLOW" {
			t.Errorf("%s tendría que pasar (%q)", n, por[n])
		}
	}
	for _, n := range []string{"ptrace", "mount", "execve", "socket", "setuid"} {
		if por[n] == "SCMP_ACT_ALLOW" {
			t.Errorf("%s no tendría que pasar", n)
		}
	}
	if por["clone3"] != "SCMP_ACT_ERRNO" {
		t.Error("clone3 tiene que seguir dando ENOSYS")
	}
	// clone sigue con su filtro de espacios de nombres.
	for _, r := range p.Syscalls {
		if slices.Contains(r.Names, "clone") && len(r.Args) == 0 {
			t.Error("clone sin filtro de argumentos")
		}
	}
}

func TestPerfilPropioSinListaEsElComun(t *testing.T) {
	for _, l := range [][]string{nil, {}, {"Read"}, {"../x"}} {
		if p, propio := PerfilSeccompPara(l); propio || p != PerfilSeccomp() {
			t.Errorf("%v: tendría que ser el común", l)
		}
	}
}

func TestPerfilObservacion(t *testing.T) {
	_, por := leerPerfil(t, PerfilObservacion([]string{"read"}))
	if por["read"] != "SCMP_ACT_ALLOW" || por["write"] != "SCMP_ACT_LOG" || por["socket"] != "SCMP_ACT_LOG" {
		t.Fatalf("read %q write %q socket %q", por["read"], por["write"], por["socket"])
	}
	// Lo que el común cierra sigue cerrado al observar.
	for _, n := range []string{"ptrace", "mount", "bpf", "unshare"} {
		if _, ok := por[n]; ok {
			t.Errorf("%s aparece en el perfil de observar", n)
		}
	}
}

func TestServidorEligePerfil(t *testing.T) {
	s := &Servidor{Llamadas: func(m string) []string {
		if m == "redis" {
			return []string{"read"}
		}
		return nil
	}}
	if _, c := s.perfil("redis"); c != "propio" {
		t.Fatal(c)
	}
	if _, c := s.perfil("cowrie"); c != "comun" {
		t.Fatal(c)
	}
	s.Observar = true
	if _, c := s.perfil("redis"); c != "observar" {
		t.Fatal(c)
	}
}

func TestUsernsDeSonda(t *testing.T) {
	con := func(red string) map[string]any {
		return map[string]any{"HostConfig": map[string]any{"NetworkMode": red}}
	}
	c := con("host")
	usernsDeSonda(TipoSonda, c)
	if hc(c)["UsernsMode"] != "host" {
		t.Fatal("una sonda con la red de la máquina va en su espacio de usuarios")
	}
	for _, x := range []struct {
		tipo Tipo
		red  string
	}{{TipoSonda, "none"}, {TipoTrampa, "host"}, {TipoCaptura, "container:x"}} {
		c := con(x.red)
		usernsDeSonda(x.tipo, c)
		if _, ok := hc(c)["UsernsMode"]; ok {
			t.Errorf("%v %s: no", x.tipo, x.red)
		}
	}
}
