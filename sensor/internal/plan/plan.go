// Package plan es lo que la consola le pide al sensor: qué trampas tener en
// marcha y con qué parámetros. Es un subconjunto del manifiesto del contrato;
// el sensor ignora lo que no necesita.
package plan

import "encoding/json"

// Toque es una conexión de prueba a una trampa. Codigo es lo que se pone en
// sus eventos; IPs, las de esta máquina con las que puede llegar a la trampa.
type Toque struct {
	ID        string   `json:"id"`
	Trampa    string   `json:"trampa"`
	Direccion string   `json:"direccion"`
	Puerto    int      `json:"puerto"`
	Codigo    string   `json:"codigo"`
	IPs       []string `json:"ips,omitempty"`
}

type Plan struct {
	Sensor     string       `json:"sensor"`
	UltimoHash string       `json:"ultimoHash"`
	Trampas    []TrampaPlan `json:"trampas"`
	// Licencia es el sobre firmado de la licencia de pago ({licencia, firma}),
	// tal cual lo guardó la consola. El sensor no la verifica (es abierto): la
	// pasa opaca y la monta de solo lectura en cada trampa de pago, que es quien
	// la comprueba al arrancar (modulos/comun/licencia). Vacía si el nodo no
	// tiene licencia (edición gratis); una consola anterior no la manda.
	Licencia json.RawMessage `json:"licencia,omitempty"`
	// Toques son las conexiones de prueba que pide «Prueba mi detección» y se
	// hacen una vez (ver cmd/sensor/toques.go). Una consola anterior no los manda.
	Toques []Toque `json:"toques,omitempty"`
	// IgnorarPropio pide no registrar lo que venga de la dirección de red de la propia
	// máquina del sensor (ver cmd/sensor/propio.go), salvo lo de las trampas de
	// RegistrarSiempre: las que tienen una prueba abierta o reciben la señal de un cebo.
	// Una consola anterior no lo manda, y se registra todo.
	IgnorarPropio    bool     `json:"ignorarPropio,omitempty"`
	RegistrarSiempre []string `json:"registrarSiempre,omitempty"`
	// IPPublicaEn es la dirección (https) a la que el sensor pregunta por dónde sale a
	// internet: contesta con la IP desde la que le llega la petición (ver
	// cmd/sensor/ip_publica.go). Vacía, o una consola anterior: no pregunta.
	IPPublicaEn string `json:"ipPublicaEn,omitempty"`
	// Senuelos es el nombre de Trampas en las consolas anteriores a la 0.8.0.
	Senuelos    []TrampaPlan `json:"senuelos"`
	Descartados []struct {
		ID     string `json:"id"`
		Motivo string `json:"motivo"`
	} `json:"descartados"`
	// Admite: lo nuevo que la consola acepta en lo que le manda el sensor.
	// Una consola que no lo dice no acepta nada nuevo.
	Admite []string `json:"admite,omitempty"`
}

// OrigenOculta: la consola acepta origen.oculta en los eventos (desde la 0.13.1).
const OrigenOculta = "origen.oculta"

// Artefactos: la consola guarda la COPIA de los ficheros que captura una trampa
// (el binario que el atacante mandó traer o dejó) y pide al sensor que se la
// suba. Solo lo anuncia si el nodo activó la captura (opt-in, por defecto no;
// ver docs/diseno/captura-artefactos.md). Un sensor solo saca binarios del
// contenedor y los sube si la consola lo admite: sin esto, no toca nada.
const Artefactos = "artefactos"

// Acepta dice si la consola admite algo nuevo en lo que le manda el sensor.
func (p *Plan) Acepta(que string) bool {
	if p == nil {
		return false
	}
	for _, a := range p.Admite {
		if a == que {
			return true
		}
	}
	return false
}

type TrampaPlan struct {
	ID         string         `json:"id"`
	Nombre     string         `json:"nombre"`
	Manifiesto Manifiesto     `json:"manifiesto"`
	Parametros map[string]any `json:"parametros"`
	// Licencia dice si la trampa es de pago y lee la licencia (SEN-9): a las
	// demás no se les monta. nil (una consola anterior no lo manda): a todas.
	Licencia *bool `json:"licencia,omitempty"`
	// Escucha es la dirección de la máquina, de las varias que tenga, en la que
	// se publican los puertos de esta trampa y solo en ella. Vacía (o una
	// consola anterior, que no lo manda): en todas, como siempre. Va fuera del
	// manifiesto, que es lo firmado: el sensor la comprueba contra las
	// direcciones que él mismo ha medido (despliegue.config).
	Escucha string `json:"escucha,omitempty"`
}

type Manifiesto struct {
	ID   string `json:"id"`
	Tipo string `json:"tipo"`
	// SensorMinimo: la consola no manda la trampa a sensores más viejos.
	SensorMinimo string      `json:"sensorMinimo,omitempty"`
	Contenedor   *Contenedor `json:"contenedor"`
	// Red es el modo de red «IP propia» (docs/diseno/red.md): la trampa no
	// va en el puente aislado, sino con su propia IP en el segmento del
	// cliente. nil: el modo de siempre de las 41.
	Red         *RedTrampa   `json:"red,omitempty"`
	Aislamiento *Aislamiento `json:"aislamiento"`
	Eventos     Eventos      `json:"eventos"`
}

// RedTrampa es el bloque red del manifiesto v1 que el sensor recibe.
type RedTrampa struct {
	Modo string `json:"modo"`
	// Capturar son los rangos (CIDR IPv4 por comas, ya sustituidos) que la
	// trampa puede leer del enlace: el sensor compila el BPF que solo deja
	// pasar ese tráfico y solo entonces concede NET_RAW. Vacío: sin NET_RAW.
	Capturar string `json:"capturar,omitempty"`
}

type Contenedor struct {
	Imagen  string `json:"imagen"`
	Puertos []struct {
		Interno int `json:"interno"`
		// Expuesto es un número fijo o "${parametro}".
		Expuesto  any    `json:"expuesto"`
		Protocolo string `json:"protocolo"`
		// Si es el parámetro que enciende el puerto (yes o true).
		Si string `json:"si"`
	} `json:"puertos"`
	// Cada valor es un texto con ${parametro} o {segun, valores}.
	Entorno  map[string]any `json:"entorno"`
	Ficheros []struct {
		Destino   string `json:"destino"`
		Contenido string `json:"contenido"`
	} `json:"ficheros"`
	Escribibles []string `json:"escribibles"`
	Registros   string   `json:"registros"`
}

type Aislamiento struct {
	Salida      bool    `json:"salida"`
	SoloLectura bool    `json:"soloLectura"`
	CPU         float64 `json:"cpu"`
	MemoriaMb   int     `json:"memoriaMb"`
}

type Eventos struct {
	Fuente struct {
		Tipo string `json:"tipo"`
		Ruta string `json:"ruta"`
	} `json:"fuente"`
	Formato string `json:"formato"`
	Campos  struct {
		Cuando  string `json:"cuando"`
		IP      string `json:"ip"`
		Puerto  string `json:"puerto"`
		Usuario string `json:"usuario"`
		Equipo  string `json:"equipo"`
	} `json:"campos"`
	Accion struct {
		Campo      string            `json:"campo"`
		Valores    map[string]string `json:"valores"`
		PorDefecto string            `json:"porDefecto"`
		Ignorar    []string          `json:"ignorar"`
	} `json:"accion"`
	Severidad struct {
		PorDefecto string            `json:"porDefecto"`
		PorAccion  map[string]string `json:"porAccion"`
		PorValor   map[string]string `json:"porValor"`
		// PorCampo: severidad según el valor de otro campo (p. ej. el CVE que se
		// intenta explotar). Gana a las anteriores. Desde la 0.13.
		PorCampo *SegunCampo `json:"porCampo,omitempty"`
	} `json:"severidad"`
	ConexionEstablecida bool `json:"conexionEstablecida"`
	// ConexionPorCampo: si hay sesión completa según el valor de un campo (p.
	// ej. tcp sí, udp no: por UDP el origen se puede falsificar). Si el valor
	// no está en la lista, vale ConexionEstablecida; si la línea no trae el
	// campo, no hay sesión completa (desde la 0.24.3). Desde la 0.13; un sensor
	// anterior lo ignora y usa ConexionEstablecida.
	ConexionPorCampo *SegunCampoBool `json:"conexionPorCampo,omitempty"`
	Detalle          []string        `json:"detalle"`
}

type SegunCampo struct {
	Campo   string            `json:"campo"`
	Valores map[string]string `json:"valores"`
}

type SegunCampoBool struct {
	Campo   string          `json:"campo"`
	Valores map[string]bool `json:"valores"`
}
