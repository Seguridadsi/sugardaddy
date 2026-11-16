package actualizador

// Las copias del nodo, fuera de la máquina (docs/diseno/copias-fuera.md; plan de
// fortificación §8.2). copia.sh las crea cada noche en copias/; el actualizador
// pregunta a la consola por el destino (Ajustes → Backups), sube cada copia nueva,
// deja allí las últimas N, hace la prueba de restauración cuando toca (la consola
// dice cuándo: una vez al mes o cuando se pide) y le cuenta todo a la consola, que
// lo enseña, lo apunta en la auditoría y avisa (salud.copias-*) si algo falla.
//
// Por qué el actualizador y no copia.sh: los secretos del destino viven cifrados
// en la consola (CLAVE_SECRETOS) y el actualizador ya habla con ella con su token;
// ya tiene red, el socket de Docker (para montar la carpeta SMB sin instalar nada)
// y age en su imagen. copia.sh sigue siendo un script del anfitrión sin red ni
// secretos que solo crea la copia: si el destino falla, la copia local sigue ahí.
//
// Corre en su propia goroutine: una subida larga no frena las actualizaciones.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/copias"
	"github.com/kinomakino/sugardaddy/sensor/internal/docker"
)

// FicheroRemotas: lo que ya se subió a cada destino, en copias/ (solo root).
const FicheroRemotas = ".remotas.json"

// EsperaTrasError: tras un fallo del destino no se reintenta en cada vuelta.
const EsperaTrasError = 15 * time.Minute

// ListadoCada: cada cuánto se vuelve a mirar el destino aunque no haya nada que subir.
const ListadoCada = 24 * time.Hour

// configCopias es lo que contesta GET /api/actualizador/copias.
type configCopias struct {
	Activo    bool           `json:"activo"`
	Huella    string         `json:"huella"`
	Destino   *copias.Config `json:"destino"`
	Conservar int            `json:"conservar"`
	// La consola dice si toca la prueba de restauración (cada mes, o pedida).
	PruebaToca bool `json:"pruebaToca"`
	// Pedidos desde la consola, que se devuelven al hacerlos.
	Pedidos struct {
		Comprobar string `json:"comprobar"`
		Prueba    string `json:"prueba"`
	} `json:"pedidos"`
}

// Subida apuntada.
type Subida struct {
	Sha256 string    `json:"sha256"`
	Bytes  int64     `json:"bytes"`
	Cuando time.Time `json:"cuando"`
}

type estadoRemotas struct {
	Destino string            `json:"destino"` // huella del destino
	Subidas map[string]Subida `json:"subidas"`
}

// LocalCopia: la última copia de la máquina.
type LocalCopia struct {
	Nombre string    `json:"nombre"`
	Bytes  int64     `json:"bytes"`
	Cuando time.Time `json:"cuando"`
}

// InformeCopias es lo que se manda a la consola (POST /api/actualizador/copias).
type InformeCopias struct {
	Huella     string               `json:"huella"`
	Local      *LocalCopia          `json:"local"`
	Subidas    []SubidaInformada    `json:"subidas,omitempty"`
	Error      string               `json:"error"`
	Remotas    []copias.Remota      `json:"remotas,omitempty"`
	Listadas   bool                 `json:"listadas"`
	Bloqueadas int                  `json:"bloqueadas,omitempty"`
	Avisos     []string             `json:"avisos,omitempty"`
	Prueba     *copias.Comprobacion `json:"prueba,omitempty"`
	Hechos     map[string]string    `json:"hechos,omitempty"` // pedido → id atendido
}

// SubidaInformada: una copia que acaba de subir.
type SubidaInformada struct {
	Nombre string `json:"nombre"`
	Bytes  int64  `json:"bytes"`
	Sha256 string `json:"sha256"`
}

// CopiasFuera lleva la cuenta entre vueltas.
type CopiasFuera struct {
	Docker    *docker.Cliente
	Consola   string
	Token     string
	HTTP      *http.Client
	Local     string // la carpeta del nodo dentro del contenedor (/nodo)
	Anfitrion string // la misma, en el anfitrión (NODO_DIR)
	Log       func(string, ...any)
	// Age: el programa age (en la imagen del actualizador). Vacío: «age».
	Age string
	// Destino crea el destino; en las pruebas, un doble.
	Destino func(c copias.Config) (copias.Destino, error)
	// Fuera: el cliente HTTP para S3 y Azure (sale por el proxy del nodo, si lo hay).
	Fuera *http.Client

	ultimoError   time.Time
	huellaError   string
	errorVigente  string
	ultimoListado time.Time
	informado     string
	ultimoInforme time.Time
}

func (c *CopiasFuera) dir() string { return filepath.Join(c.Local, "copias") }

// destino construye el de la configuración.
func (c *CopiasFuera) destino(cfg copias.Config) (copias.Destino, error) {
	if c.Destino != nil {
		return c.Destino(cfg)
	}
	if err := cfg.Validar(); err != nil {
		return nil, err
	}
	fuera := c.Fuera
	if fuera == nil {
		fuera = &http.Client{Timeout: 30 * time.Minute}
	}
	switch cfg.Tipo {
	case copias.TipoS3:
		return &copias.S3{C: *cfg.S3, Inmutable: cfg.Inmutable, HTTP: fuera}, nil
	case copias.TipoAzure:
		return &copias.Azure{C: *cfg.Azure, Inmutable: cfg.Inmutable, HTTP: fuera}, nil
	case copias.TipoSMB:
		versiones, err := LeerEnv(filepath.Join(c.Local, "versiones.env"))
		if err != nil || versiones["ACTUALIZADOR_IMAGEN"] == "" {
			return nil, errors.New("versiones.env does not say which updater image to use for the SMB helper")
		}
		if c.Anfitrion == "" {
			return nil, errors.New("NODO_DIR is not set: the SMB helper needs the node folder")
		}
		return &copias.SMB{C: *cfg.SMB, Motor: c.Docker, Imagen: versiones["ACTUALIZADOR_IMAGEN"],
			CopiasAnfitrion: filepath.Join(c.Anfitrion, "copias"), CopiasLocal: c.dir(),
			Registros: docker.RegistrosAcotados()}, nil
	}
	return nil, fmt.Errorf("unknown destination type %q", cfg.Tipo)
}

// Locales: las copias de age de la máquina, de la más nueva a la más vieja.
func Locales(dir string) []LocalCopia {
	entradas, _ := os.ReadDir(dir)
	var out []LocalCopia
	for _, e := range entradas {
		if !e.Type().IsRegular() || !copias.NombreCopia.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, LocalCopia{Nombre: e.Name(), Bytes: info.Size(), Cuando: info.ModTime().UTC()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Nombre > out[j].Nombre })
	return out
}

// Pendientes: qué subir. La primera vez a un destino, solo la última; luego, las
// más nuevas que la última subida (las que se quedaron sin subir mientras el
// destino fallaba), hasta `conservar`. Se suben de la más vieja a la más nueva.
func Pendientes(locales []LocalCopia, subidas map[string]Subida, conservar int) []LocalCopia {
	if len(locales) == 0 {
		return nil
	}
	if len(subidas) == 0 {
		return []LocalCopia{locales[0]}
	}
	ultima := ""
	for n := range subidas {
		if n > ultima {
			ultima = n
		}
	}
	var p []LocalCopia
	for _, l := range locales {
		if l.Nombre <= ultima {
			break
		}
		if _, ya := subidas[l.Nombre]; !ya {
			p = append(p, l)
		}
	}
	if conservar > 0 && len(p) > conservar {
		p = p[:conservar]
	}
	for i, j := 0, len(p)-1; i < j; i, j = i+1, j-1 {
		p[i], p[j] = p[j], p[i]
	}
	return p
}

func (c *CopiasFuera) leerEstado() estadoRemotas {
	var e estadoRemotas
	b, err := os.ReadFile(filepath.Join(c.dir(), FicheroRemotas))
	if err == nil {
		_ = json.Unmarshal(b, &e)
	}
	if e.Subidas == nil {
		e.Subidas = map[string]Subida{}
	}
	return e
}

func (c *CopiasFuera) guardarEstado(e estadoRemotas) {
	b, _ := json.Marshal(e)
	f := filepath.Join(c.dir(), FicheroRemotas)
	if err := os.WriteFile(f+".tmp", b, 0o600); err == nil {
		_ = os.Rename(f+".tmp", f)
	}
}

// Vuelta: una pasada. Devuelve error solo si no pudo hablar con la consola.
func (c *CopiasFuera) Vuelta(ctx context.Context) error {
	cfg, err := c.pedirConfig(ctx)
	if errors.Is(err, errSinRuta) {
		return nil
	}
	if err != nil {
		return err
	}
	locales := Locales(c.dir())
	inf := InformeCopias{Huella: cfg.Huella, Hechos: map[string]string{}}
	if len(locales) > 0 {
		inf.Local = &locales[0]
	}
	if !cfg.Activo || cfg.Destino == nil {
		return c.informarSiCambia(ctx, inf, false)
	}
	pedido := cfg.Pedidos.Comprobar != "" || cfg.Pedidos.Prueba != "" || cfg.PruebaToca
	// Tras un fallo, se espera un rato (salvo que cambie el destino o se pida algo).
	if !pedido && c.huellaError == cfg.Huella && time.Since(c.ultimoError) < EsperaTrasError {
		inf.Error = c.errorVigente
		return c.informarSiCambia(ctx, inf, false)
	}
	secretos := cfg.Destino.Secretos()
	fallar := func(m string, err error) error {
		inf.Error = copias.Tapar(m+": "+err.Error(), secretos)
		c.ultimoError, c.huellaError, c.errorVigente = time.Now(), cfg.Huella, inf.Error
		for k, v := range map[string]string{"comprobar": cfg.Pedidos.Comprobar, "prueba": cfg.Pedidos.Prueba} {
			if v != "" {
				inf.Hechos[k] = v
			}
		}
		if cfg.PruebaToca || cfg.Pedidos.Prueba != "" {
			inf.Prueba = &copias.Comprobacion{Resultado: copias.PruebaFallo, Detalle: inf.Error}
		}
		return c.informarSiCambia(ctx, inf, true)
	}
	d, err := c.destino(*cfg.Destino)
	if err != nil {
		return fallar("destination", err)
	}
	est := c.leerEstado()
	if est.Destino != cfg.Huella {
		est = estadoRemotas{Destino: cfg.Huella, Subidas: map[string]Subida{}}
		c.ultimoListado = time.Time{}
	}
	hizo := false
	for _, l := range Pendientes(locales, est.Subidas, cfg.Conservar) {
		ruta := filepath.Join(c.dir(), l.Nombre)
		suma, n, err := copias.HuellaFichero(ruta)
		if err != nil {
			return fallar("reading "+l.Nombre, err)
		}
		if err := d.Subir(ctx, l.Nombre, ruta, suma, n); err != nil {
			return fallar("uploading "+l.Nombre, err)
		}
		est.Subidas[l.Nombre] = Subida{Sha256: suma, Bytes: n, Cuando: time.Now().UTC()}
		c.guardarEstado(est)
		inf.Subidas = append(inf.Subidas, SubidaInformada{Nombre: l.Nombre, Bytes: n, Sha256: suma})
		if c.Log != nil {
			c.Log("backup uploaded", "copia", l.Nombre, "bytes", n)
		}
		hizo = true
	}
	var remotas []copias.Remota
	if hizo || pedido || time.Since(c.ultimoListado) >= ListadoCada {
		remotas, err = d.Listar(ctx)
		if err != nil {
			return fallar("listing the destination", err)
		}
		c.ultimoListado = time.Now()
		inf.Listadas = true
		if cfg.Pedidos.Comprobar != "" {
			inf.Hechos["comprobar"] = cfg.Pedidos.Comprobar
		}
		// Retención: las más viejas fuera, salvo las que el almacén tiene bloqueadas.
		quedan := remotas[:0:0]
		sobran := map[string]bool{}
		for _, s := range copias.Sobrantes(remotas, cfg.Conservar) {
			sobran[s.Nombre] = true
		}
		for _, r := range remotas {
			if !sobran[r.Nombre] {
				quedan = append(quedan, r)
				continue
			}
			err := d.Borrar(ctx, r.Nombre)
			switch {
			case err == nil:
				delete(est.Subidas, r.Nombre)
			case errors.Is(err, copias.ErrBloqueada):
				inf.Bloqueadas++
				quedan = append(quedan, r)
			default:
				inf.Avisos = append(inf.Avisos, copias.Tapar("could not delete "+r.Nombre+": "+err.Error(), secretos))
				quedan = append(quedan, r)
			}
		}
		c.guardarEstado(est)
		remotas = quedan
		inf.Remotas = remotas
	}
	if cfg.PruebaToca || cfg.Pedidos.Prueba != "" {
		if remotas == nil && !inf.Listadas {
			if remotas, err = d.Listar(ctx); err != nil {
				return fallar("listing the destination", err)
			}
			inf.Remotas, inf.Listadas = remotas, true
		}
		p := c.probar(ctx, d, remotas, est)
		inf.Prueba = &p
		if cfg.Pedidos.Prueba != "" {
			inf.Hechos["prueba"] = cfg.Pedidos.Prueba
		}
	}
	c.huellaError, c.errorVigente = "", ""
	return c.informarSiCambia(ctx, inf, hizo || inf.Listadas || inf.Prueba != nil)
}

// probar baja la última copia del destino a copias/.prueba y la comprueba.
func (c *CopiasFuera) probar(ctx context.Context, d copias.Destino, remotas []copias.Remota, est estadoRemotas) copias.Comprobacion {
	if len(remotas) == 0 {
		return copias.Comprobacion{Resultado: copias.PruebaFallo, Detalle: "there are no backups in your storage to test"}
	}
	ultima := remotas[0]
	carpeta := filepath.Join(c.dir(), copias.Prueba)
	if err := os.MkdirAll(carpeta, 0o700); err != nil {
		return copias.Comprobacion{Resultado: copias.PruebaFallo, Nombre: ultima.Nombre, Detalle: err.Error()}
	}
	ruta := filepath.Join(carpeta, ultima.Nombre+".bajada")
	defer os.Remove(ruta)
	f, err := os.OpenFile(ruta, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return copias.Comprobacion{Resultado: copias.PruebaFallo, Nombre: ultima.Nombre, Detalle: err.Error()}
	}
	err = d.Bajar(ctx, ultima.Nombre, f)
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return copias.Comprobacion{Resultado: copias.PruebaFallo, Nombre: ultima.Nombre, Detalle: "downloading: " + err.Error()}
	}
	identidad := filepath.Join(c.Local, "clave-copias.age")
	if b, err := os.ReadFile(identidad); err != nil || !bytes.Contains(b, []byte("AGE-SECRET-KEY-")) {
		identidad = ""
	}
	p := copias.Comprobar(ctx, ruta, ultima.Nombre, est.Subidas[ultima.Nombre].Sha256, identidad, c.Age)
	if p.Resultado == copias.PruebaOK || p.Resultado == copias.PruebaSinClave {
		if n := destinatariosPub(filepath.Join(c.Local, "clave-copias.pub")); n > 0 && n != p.Destinatarios {
			p.Detalle += fmt.Sprintf(" Note: it is encrypted to %d public key(s) and clave-copias.pub now has %d.", p.Destinatarios, n)
		}
	}
	if c.Log != nil {
		c.Log("restore test", "copia", ultima.Nombre, "resultado", p.Resultado)
	}
	return p
}

func destinatariosPub(ruta string) int {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return 0
	}
	n := 0
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimSpace(strings.SplitN(l, "#", 2)[0])
		if strings.HasPrefix(l, "age1") {
			n++
		}
	}
	return n
}

func (c *CopiasFuera) pedirConfig(ctx context.Context) (configCopias, error) {
	var cfg configCopias
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Consola+"/api/actualizador/copias", nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return cfg, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return cfg, errSinRuta
	}
	if resp.StatusCode != http.StatusOK {
		return cfg, fmt.Errorf("consola: %s", resp.Status)
	}
	return cfg, json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&cfg)
}

// informarSiCambia manda el informe si trae algo nuevo, si cambió la última copia
// local o, aunque no cambie nada, cada hora (la consola sabe así que el actualizador
// sigue mirando).
func (c *CopiasFuera) informarSiCambia(ctx context.Context, inf InformeCopias, hizo bool) error {
	b, _ := json.Marshal(inf)
	clave := inf.Huella + "|" + inf.Error
	if inf.Local != nil {
		clave += "|" + inf.Local.Nombre
	}
	if !hizo && clave == c.informado && time.Since(c.ultimoInforme) < time.Hour {
		return nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.Consola+"/api/actualizador/copias", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("consola: %s", resp.Status)
	}
	c.informado, c.ultimoInforme = clave, time.Now()
	return nil
}
