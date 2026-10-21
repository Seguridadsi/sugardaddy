package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// errArgs: el error exacto de Redis cuando sobran o faltan argumentos.
func errArgs(cmd string) string {
	return "ERR wrong number of arguments for '" + strings.ToLower(cmd) + "' command"
}

// cortarC imita el %.*s de C: la cadena acaba en el primer byte nulo y se
// recorta a n bytes (n < 0: sin recorte). Lo recortado va en memoria propia
// (prefijo): el host de SLAVEOF se guarda en la vista.
func cortarC(s string, n int) string {
	fin := len(s)
	if i := strings.IndexByte(s, 0); i >= 0 {
		fin = i
	}
	if n >= 0 && fin > n {
		fin = n
	}
	return prefijo(s, fin)
}

// errDesconocido: el "unknown command" con el formato exacto de cada versión
// (commandCheckExistence en 7.x, processCommand en 6.2): el nombre tal como
// llega (en 7.x recortado a 128 bytes) y los argumentos hasta unos 128 bytes,
// entre comillas simples y separados por espacio en 7.x, y entre acentos
// graves con coma en 6.2. Los saltos de línea los cambia por espacios resp.err.
func errDesconocido(id *identidad, args []string) string {
	if id.nver < 700 {
		return "ERR unknown command `" + cortarC(args[0], -1) + "`, with args beginning with: " + argsResumen(args, "`", "`, ")
	}
	return "ERR unknown command '" + cortarC(args[0], 128) + "', with args beginning with: " + argsResumen(args, "'", "' ")
}

// argsResumen: como el bucle de Redis, mientras lo acumulado no llegue a 128
// bytes añade el argumento recortado a lo que falta hasta 128.
func argsResumen(args []string, abre, cierra string) string {
	var sb strings.Builder
	for _, a := range args[1:] {
		if sb.Len() >= 128 {
			break
		}
		falta := 128 - sb.Len()
		sb.WriteString(abre)
		sb.WriteString(cortarC(a, falta))
		sb.WriteString(cierra)
	}
	return sb.String()
}

// errSub: subcomando que no existe en un comando contenedor, con el texto de
// la versión fingida. cmd va en mayúsculas, como lo pone Redis.
func (s *servidor) errSub(cmd, sub string) string {
	if s.id.nver >= 700 {
		return "ERR unknown subcommand '" + cortarC(sub, 128) + "'. Try " + cmd + " HELP."
	}
	return "ERR Unknown subcommand or wrong number of arguments for '" + cortarC(sub, -1) + "'. Try " + cmd + " HELP."
}

// errArgsSub: aridad de un subcomando. 7.x lo nombra como config|get; 6.2 da
// el mismo error que a un subcomando desconocido.
func (s *servidor) errArgsSub(cmd, sub string) string {
	if s.id.nver >= 700 {
		return "ERR wrong number of arguments for '" + strings.ToLower(cmd) + "|" + strings.ToLower(sub) + "' command"
	}
	return s.errSub(cmd, sub)
}

// subcomando: el subcomando en mayúsculas si existe en esta versión; "" si no.
func (s *servidor) subcomando(cmd string, args []string) string {
	if len(args) < 2 {
		return ""
	}
	sub := strings.ToUpper(cortarC(args[1], 64))
	if v, ok := subcomandos[cmd][sub]; ok && s.id.nver >= v {
		return sub
	}
	return ""
}

// contenedor atiende lo común de un comando con subcomandos: sin subcomando,
// el error de aridad; con uno que no existe en la versión, el suyo. Devuelve
// el subcomando o "" si ya contestó.
func (s *servidor) contenedor(o *resp, cmd string, args []string) string {
	if len(args) < 2 {
		o.err(errArgs(cmd))
		return ""
	}
	sub := s.subcomando(cmd, args)
	if sub == "" {
		o.err(s.errSub(cmd, args[1]))
	}
	return sub
}

// nombreCompleto: cómo nombra Redis la orden en CLIENT LIST (cmd=): en 7.x
// los subcomandos van con su contenedor (client|list); en 6.2, solo el
// comando. Una orden o subcomando desconocido deja NULL, como en Redis.
func (s *servidor) nombreCompleto(cmd string, args []string) string {
	if !esComando(s.id, cmd) {
		return "NULL"
	}
	n := strings.ToLower(cmd)
	if _, es := subcomandos[cmd]; !es || len(args) < 2 || s.id.nver < 700 {
		return n
	}
	if sub := s.subcomando(cmd, args); sub != "" {
		return n + "|" + strings.ToLower(sub)
	}
	return "NULL"
}

// errProtegido: DEBUG y MODULE en 7.x con enable-debug-command y
// enable-module-command en "no" (lo de fábrica): Redis rechaza la orden
// entera antes de mirar el subcomando.
func errProtegido(cmd, opcion string) string {
	return "ERR " + cmd + " command not allowed. If the " + opcion + " option is set to \"local\", you can run it from a local connection, otherwise you need to set this option in the configuration file, and then restart the server."
}

// responder da una respuesta creíble. Devuelve true si hay que cerrar la
// conexión (QUIT, HTTP contra Redis o un tope de memoria, que deja el motivo
// en cli.corte). No ejecuta nada de lo que pide el atacante ni escribe ningún
// fichero.
func (s *servidor) responder(o *resp, cli *cliente, cmd string, args []string) bool {
	// Como en Redis, lo desconocido se rechaza antes que la falta de AUTH, y
	// dentro de MULTI aborta el EXEC.
	if !esComando(s.id, cmd) {
		if cli.enCola {
			cli.multiError = true
		}
		o.err(errDesconocido(s.id, args))
		return false
	}

	// En MULTI, casi todo se encola en vez de ejecutarse, con tope por
	// conexión (órdenes y bytes) y dentro del presupuesto de su IP y total.
	if cli.enCola && !mandaEnMulti(cmd) {
		coste := costeOrden(args)
		if len(cli.cola) >= maxColaOrdenes || cli.colaBytes+coste > int64(s.cfg.maxComando+holguraCola) ||
			!cli.cuota.tomarCola(coste) {
			cli.corte = "cola de MULTI por encima del tope (" + strconv.Itoa(len(cli.cola)) + " órdenes encoladas)"
			return true
		}
		cli.colaBytes += coste
		cli.cola = append(cli.cola, append([]string(nil), args...))
		o.simple("QUEUED")
		return false
	}

	// Antes de autenticar (si hay contraseña), solo pasan unas pocas.
	if !cli.autenticado && !sinAuth(cmd) {
		o.err("NOAUTH Authentication required.")
		return false
	}

	switch cmd {
	case "QUIT":
		o.simple("OK")
		return true
	case "POST", "HOST:":
		// HTTP contra Redis: Redis cierra sin contestar (securityWarningCommand).
		// La orden ya quedó en el registro.
		return true
	case "PING":
		s.cmdPing(o, cli, args)
	case "AUTH":
		s.cmdAuth(o, cli, args)
	case "HELLO":
		s.cmdHello(o, cli, args)
	case "RESET":
		s.cmdReset(o, cli)
	case "INFO":
		o.verbatim(s.infoTexto(cli, args))
	case "COMMAND":
		s.cmdCommand(o, args)
	case "CONFIG":
		s.cmdConfig(o, cli, args)
	case "CLIENT":
		s.cmdClient(o, cli, args)
	case "CLUSTER":
		// Sin modo clúster. En 6.2 se comprueba antes que el subcomando.
		if (s.id.nver < 700 && len(args) >= 2) || s.contenedor(o, cmd, args) != "" {
			o.err("ERR This instance has cluster support disabled")
		}
	case "SELECT":
		s.cmdSelect(o, cli, args)
	case "SWAPDB":
		o.simple("OK")
	case "SET":
		s.cmdSet(o, cli, args)
	case "SETEX", "PSETEX":
		s.cmdSetex(o, cli, cmd, args)
	case "SETNX":
		s.cmdSetnx(o, cli, args)
	case "GET", "GETDEL":
		s.cmdGet(o, cli, cmd, args)
	case "GETSET":
		s.cmdGetset(o, cli, args)
	case "APPEND":
		s.cmdAppend(o, cli, args)
	case "STRLEN":
		s.cmdStrlen(o, cli, args)
	case "MSET":
		s.cmdMset(o, cli, args)
	case "MGET":
		s.cmdMget(o, cli, args)
	case "DEL", "UNLINK":
		s.cmdDel(o, cli, args)
	case "EXISTS":
		s.cmdExists(o, cli, args)
	case "KEYS":
		s.cmdKeys(o, cli, args)
	case "SCAN":
		s.cmdScan(o, cli, args)
	case "RANDOMKEY":
		s.cmdRandomKey(o, cli)
	case "TYPE":
		s.cmdType(o, cli, args)
	case "TTL", "PTTL":
		s.cmdTTL(o, cli, cmd, args)
	case "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT":
		s.cmdExpire(o, cli, cmd, args)
	case "PERSIST":
		s.cmdPersist(o, cli, args)
	case "EXPIRETIME", "PEXPIRETIME":
		s.cmdExpireTime(o, cli, cmd, args)
	case "DBSIZE":
		o.entero(int64(s.banco.tam(cli.vista, cli.db)))
	case "INCR", "DECR":
		s.cmdIncr(o, cli, cmd, args)
	case "INCRBY", "DECRBY":
		s.cmdIncrBy(o, cli, cmd, args)
	case "MULTI":
		s.cmdMulti(o, cli)
	case "EXEC":
		return s.cmdExec(o, cli)
	case "DISCARD":
		s.cmdDiscard(o, cli)
	case "WATCH":
		if len(args) < 2 {
			o.err(errArgs(cmd))
		} else {
			o.simple("OK")
		}
	case "UNWATCH":
		o.simple("OK")
	case "SLAVEOF", "REPLICAOF":
		s.cmdSlaveof(o, cli, cmd, args)
	case "MODULE":
		s.cmdModule(o, args)
	case "EVAL", "EVAL_RO", "EVALSHA", "EVALSHA_RO":
		o.err("ERR Error running script: @user_script:1: Script attempted to access nonexistent global variable")
	case "FCALL", "FCALL_RO":
		o.err("ERR Function not found")
	case "FUNCTION":
		s.cmdFunction(o, args)
	case "SCRIPT":
		s.cmdScript(o, args)
	case "FLUSHALL":
		s.banco.vaciar(cli.vista, -1)
		o.simple("OK")
	case "FLUSHDB":
		s.banco.vaciar(cli.vista, cli.db)
		o.simple("OK")
	case "SAVE":
		s.marcarSave(cli)
		o.simple("OK")
	case "BGSAVE":
		s.marcarSave(cli)
		o.simple("Background saving started")
	case "BGREWRITEAOF":
		o.simple("Background append only file rewriting started")
	case "LASTSAVE":
		o.entero(s.ultimoSave(cli))
	case "ECHO":
		if len(args) >= 2 {
			o.bulk(args[1])
		} else {
			o.err(errArgs(cmd))
		}
	case "TIME":
		s.cmdTime(o)
	case "DEBUG":
		s.cmdDebug(o, args)
	case "OBJECT":
		s.cmdObject(o, cli, args)
	case "WAIT":
		o.entero(0)
	case "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE":
		s.cmdSubscribe(o, cmd, args)
	case "UNSUBSCRIBE", "PUNSUBSCRIBE", "SUNSUBSCRIBE":
		o.simple("OK")
	case "MEMORY":
		s.cmdMemory(o, cli, args)
	case "ACL":
		s.cmdACL(o, cli, args)
	case "SHUTDOWN":
		// Redis no contesta a SHUTDOWN (se apaga); la trampa ni se apaga ni
		// contesta nada, como el real cuando le niega el apagado por NOSAVE
		// imposible: deja la conexión como está.
		o.err("ERR Errors trying to SHUTDOWN. Check logs.")
	case "LOLWUT":
		o.verbatim("Redis ver. " + s.id.version + "\n")
	case "LATENCY":
		s.cmdLatency(o, args)
	case "SLOWLOG":
		s.cmdSlowlog(o, args)
	case "XINFO", "XLEN", "LPOS":
		o.err("ERR no such key")
	case "WAITAOF":
		o.cabecera(2)
		o.entero(0)
		o.entero(0)
	default:
		o.err(errDesconocido(s.id, args))
	}
	// Una respuesta que no cabe en la cuota (KEYS, SCAN, CONFIG GET) deja el
	// motivo en cli.corte y no contesta: se cierra.
	return cli.corte != ""
}

// sinAuth: órdenes que pasan sin estar autenticado.
func sinAuth(cmd string) bool {
	switch cmd {
	case "AUTH", "HELLO", "QUIT", "RESET":
		return true
	}
	return false
}

// mandaEnMulti: órdenes que, dentro de MULTI, no se encolan.
func mandaEnMulti(cmd string) bool {
	switch cmd {
	case "MULTI", "EXEC", "DISCARD", "WATCH", "RESET", "QUIT":
		return true
	}
	return false
}

func (s *servidor) cmdPing(o *resp, cli *cliente, args []string) {
	switch {
	case len(args) >= 3:
		o.err(errArgs("ping"))
	case len(args) == 2:
		o.bulk(args[1])
	default:
		o.simple("PONG")
	}
}

const errWrongpass = "WRONGPASS invalid username-password pair or user is disabled."

// credencialesValen: si usuario y contraseña autentican. Sin contraseña (modo
// abierto), el usuario default de Redis 6 y 7 tiene la marca nopass y vale
// cualquier contraseña; los nombres de usuario distinguen mayúsculas.
func (s *servidor) credencialesValen(usuario, pass string) bool {
	if usuario != "default" {
		return false
	}
	return s.cfg.contrasena == "" || pass == s.cfg.contrasena
}

func (s *servidor) cmdAuth(o *resp, cli *cliente, args []string) {
	if len(args) < 2 || len(args) > 3 {
		o.err(errArgs("auth"))
		return
	}
	if len(args) == 2 && s.cfg.contrasena == "" {
		// El texto de 6.0 en adelante (el de 5.x delataba la versión).
		o.err("ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?")
		return
	}
	usuario := "default"
	if len(args) == 3 {
		usuario = args[1]
	}
	if !s.credencialesValen(usuario, args[len(args)-1]) {
		o.err(errWrongpass)
		return
	}
	cli.autenticado = true
	cli.usuario = usuario
	o.simple("OK")
}

// cmdHello sigue helloCommand de Redis: el primer argumento, si lo hay, es
// siempre la versión del protocolo; luego AUTH y SETNAME (el nombre se valida
// al leerlo), y si no hay AUTH, exige estar autenticado cuando hay contraseña.
func (s *servidor) cmdHello(o *resp, cli *cliente, args []string) {
	proto := cli.proto
	if len(args) >= 2 {
		n, err := strconv.ParseInt(args[1], 10, 64)
		if err != nil {
			o.err("ERR Protocol version is not an integer or out of range")
			return
		}
		if n < 2 || n > 3 {
			o.err("NOPROTO unsupported protocol version")
			return
		}
		proto = int(n)
	}
	usuario, pass, hayAuth, nombre, hayNombre := "default", "", false, "", false
	for i := 2; i < len(args); i++ {
		switch {
		case strings.EqualFold(args[i], "AUTH") && i+2 < len(args):
			usuario, pass, hayAuth = args[i+1], args[i+2], true
			i += 2
		case strings.EqualFold(args[i], "SETNAME") && i+1 < len(args):
			nombre, hayNombre = args[i+1], true
			if !nombreClienteValido(nombre) {
				o.err("ERR Client names cannot contain spaces, newlines or special characters.")
				return
			}
			i++
		default:
			o.err("ERR Syntax error in HELLO option '" + cortarC(args[i], -1) + "'")
			return
		}
	}

	if hayAuth {
		if !s.credencialesValen(usuario, pass) {
			o.err(errWrongpass)
			return
		}
		cli.autenticado = true
		cli.usuario = usuario
	}
	if !cli.autenticado {
		o.err("NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time")
		return
	}
	if hayNombre {
		cli.nombre = recortarNombre(nombre)
	}
	cli.proto = proto
	o.proto = proto
	s.escribirHello(o, cli)
}

func (s *servidor) escribirHello(o *resp, cli *cliente) {
	rol := "master"
	s.banco.conVista(func() {
		if cli.vista.replica[0] != "" {
			rol = "replica"
		}
	})
	o.mapa(7)
	o.bulk("server")
	o.bulk("redis")
	o.bulk("version")
	o.bulk(s.id.version)
	o.bulk("proto")
	o.entero(int64(cli.proto))
	o.bulk("id")
	o.entero(cli.id)
	o.bulk("mode")
	o.bulk("standalone")
	o.bulk("role")
	o.bulk(rol)
	o.bulk("modules")
	o.cabecera(0)
}

func (s *servidor) cmdReset(o *resp, cli *cliente) {
	cli.db = 0
	cli.proto = 2
	o.proto = 2
	cli.vaciarCola()
	cli.nombre = ""
	cli.autenticado = s.cfg.contrasena == ""
	cli.usuario = ""
	o.simple("RESET")
}

func (s *servidor) cmdCommand(o *resp, args []string) {
	if len(args) < 2 {
		o.cabecera(0)
		return
	}
	switch s.subcomando("COMMAND", args) {
	case "COUNT":
		o.entero(240)
	case "":
		o.err(s.errSub("COMMAND", args[1]))
	default:
		o.cabecera(0)
	}
}

func (s *servidor) cmdSelect(o *resp, cli *cliente, args []string) {
	if len(args) != 2 {
		o.err(errArgs("select"))
		return
	}
	n, err := strconv.Atoi(args[1])
	if err != nil {
		o.err("ERR value is not an integer or out of range")
		return
	}
	if n < 0 || n > 15 {
		o.err("ERR DB index is out of range")
		return
	}
	cli.db = n
	o.simple("OK")
}

// marcarSave y ultimoSave fingen la hora del último guardado por vista.
func (s *servidor) marcarSave(cli *cliente) {
	s.banco.conVista(func() {
		cli.vista.ultimoSave = time.Now()
		cli.vista.cambios = 0
	})
}

func (s *servidor) ultimoSave(cli *cliente) int64 {
	var t time.Time
	s.banco.conVista(func() { t = cli.vista.ultimoSave })
	if t.IsZero() {
		t = s.id.arranque
	}
	return t.Unix()
}

func (s *servidor) cmdTime(o *resp) {
	ahora := time.Now()
	o.cabecera(2)
	o.bulk(strconv.FormatInt(ahora.Unix(), 10))
	o.bulk(strconv.Itoa(ahora.Nanosecond() / 1000))
}

// maxHostReplica: lo que se guarda del host de SLAVEOF (en la vista, que vive
// mientras la IP tenga conexiones y media hora más). Más que cualquier nombre
// de host real (253).
const maxHostReplica = 256

func (s *servidor) cmdSlaveof(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) != 3 {
		o.err(errArgs(cmd))
		return
	}
	no := strings.EqualFold(args[1], "no") && strings.EqualFold(args[2], "one")
	if !no {
		// Como Redis: el puerto tiene que ser un entero.
		if _, err := strconv.ParseInt(args[2], 10, 64); err != nil {
			o.err(errNoEntero)
			return
		}
	}
	s.banco.conVista(func() {
		if no {
			cli.vista.replica = [2]string{}
		} else {
			cli.vista.replica = [2]string{cortarC(args[1], maxHostReplica), cortarC(args[2], 20)}
		}
	})
	o.simple("OK")
}

func (s *servidor) cmdModule(o *resp, args []string) {
	sub := s.contenedor(o, "MODULE", args)
	if sub == "" {
		return
	}
	// En 7.x, enable-module-command está en "no" de fábrica.
	if s.id.nver >= 700 {
		o.err(errProtegido("MODULE", "enable-module-command"))
		return
	}
	switch sub {
	case "LIST":
		o.cabecera(0)
	case "LOAD":
		o.err("ERR Error loading the extension. Please check the server logs.")
	case "UNLOAD":
		o.err("ERR Error unloading module: no such module with that name")
	}
}

func (s *servidor) cmdFunction(o *resp, args []string) {
	sub := s.contenedor(o, "FUNCTION", args)
	switch sub {
	case "":
	case "LIST":
		o.cabecera(0)
	case "DUMP":
		o.nulo()
	case "STATS":
		o.mapa(2)
		o.bulk("running_script")
		o.nulo()
		o.bulk("engines")
		o.mapa(0)
	case "LOAD", "RESTORE":
		if len(args) < 3 {
			o.err(s.errArgsSub("FUNCTION", sub))
			return
		}
		o.err("ERR Missing library metadata")
	case "FLUSH":
		o.simple("OK")
	case "DELETE":
		o.err("ERR Library not found")
	case "KILL":
		o.err("NOTBUSY No scripts in execution right now.")
	}
}

func (s *servidor) cmdScript(o *resp, args []string) {
	sub := s.contenedor(o, "SCRIPT", args)
	switch sub {
	case "":
	case "LOAD":
		if len(args) != 3 {
			o.err(s.errArgsSub("SCRIPT", sub))
			return
		}
		o.bulk(shaDe(args[2]))
	case "EXISTS":
		if len(args) < 3 {
			o.err(s.errArgsSub("SCRIPT", sub))
			return
		}
		o.cabecera(len(args) - 2)
		for range args[2:] {
			o.entero(0)
		}
	case "FLUSH":
		o.simple("OK")
	case "KILL":
		o.err("NOTBUSY No scripts in execution right now.")
	}
}

func (s *servidor) cmdDebug(o *resp, args []string) {
	if len(args) < 2 {
		o.err(errArgs("debug"))
		return
	}
	// DEBUG está desactivado de fábrica en 7.x (enable-debug-command no):
	// Redis rechaza la orden entera, sea cual sea el subcomando.
	if s.id.nver >= 700 {
		o.err(errProtegido("DEBUG", "enable-debug-command"))
		return
	}
	switch strings.ToUpper(args[1]) {
	case "JMAP", "SLEEP", "SET-ACTIVE-EXPIRE", "QUICKLIST-PACKED-THRESHOLD", "STRINGMATCH-LEN", "CHANGE-REPL-ID":
		o.simple("OK")
	default:
		o.err("ERR unknown DEBUG subcommand or wrong number of arguments")
	}
}

func (s *servidor) cmdObject(o *resp, cli *cliente, args []string) {
	sub := s.contenedor(o, "OBJECT", args)
	if sub == "" {
		return
	}
	if len(args) != 3 {
		o.err(s.errArgsSub("OBJECT", sub))
		return
	}
	// Una clave que no existe da nulo, no error.
	if !s.banco.existe(cli.vista, cli.db, args[2]) {
		o.nulo()
		return
	}
	switch sub {
	case "ENCODING":
		o.bulk("embstr")
	case "REFCOUNT":
		o.entero(1)
	case "IDLETIME", "FREQ":
		o.entero(0)
	}
}

func (s *servidor) cmdSubscribe(o *resp, cmd string, args []string) {
	if len(args) < 2 {
		o.err(errArgs(cmd))
		return
	}
	tipo := "subscribe"
	switch cmd {
	case "PSUBSCRIBE":
		tipo = "psubscribe"
	case "SSUBSCRIBE":
		tipo = "ssubscribe"
	}
	for i, canal := range args[1:] {
		o.cabecera(3)
		o.bulk(tipo)
		o.bulk(canal)
		o.entero(int64(i + 1))
	}
}

// doctorVacio: lo que contesta MEMORY DOCTOR con menos de 5 MB asignados, que
// es siempre el caso de la trampa (getMemoryDoctorReport de Redis).
const doctorVacio = "Hi Sam, this instance is empty or is using very little memory, my issues detector can't be used in these conditions. Please, leave for your mission on Earth and fill it with some data. The new Sam and I will be back to our programming as soon as I finished rebooting.\n"

func (s *servidor) cmdMemory(o *resp, cli *cliente, args []string) {
	switch sub := s.contenedor(o, "MEMORY", args); sub {
	case "":
	case "USAGE":
		if len(args) < 3 {
			o.err(s.errArgsSub("MEMORY", sub))
			return
		}
		if v, ok := s.banco.get(cli.vista, cli.db, args[2]); ok {
			o.entero(int64(len(v) + 64))
		} else {
			o.nulo()
		}
	case "DOCTOR":
		o.verbatim(doctorVacio)
	case "PURGE":
		o.simple("OK")
	}
}

// lineaACL: la línea del usuario default en ACL LIST, como ACLDescribeUser:
// marcas, contraseñas (sha256 en hex) y permisos.
func (s *servidor) lineaACL() string {
	if s.cfg.contrasena == "" {
		return "user default on nopass sanitize-payload ~* &* +@all"
	}
	h := sha256.Sum256([]byte(s.cfg.contrasena))
	return "user default on sanitize-payload #" + hex.EncodeToString(h[:]) + " ~* &* +@all"
}

func (s *servidor) cmdACL(o *resp, cli *cliente, args []string) {
	switch sub := s.contenedor(o, "ACL", args); sub {
	case "":
	case "WHOAMI":
		o.bulk(usuarioCliente(cli))
	case "LIST":
		o.cabecera(1)
		o.bulk(s.lineaACL())
	case "USERS":
		o.cabecera(1)
		o.bulk("default")
	case "CAT":
		o.cabecera(0)
	case "GETUSER":
		o.nuloArreglo()
	}
}

func (s *servidor) cmdLatency(o *resp, args []string) {
	switch sub := s.contenedor(o, "LATENCY", args); sub {
	case "":
	case "HISTORY", "LATEST":
		o.cabecera(0)
	case "RESET":
		o.entero(0)
	}
}

func (s *servidor) cmdSlowlog(o *resp, args []string) {
	switch sub := s.contenedor(o, "SLOWLOG", args); sub {
	case "":
	case "GET":
		o.cabecera(0)
	case "LEN":
		o.entero(0)
	case "RESET":
		o.simple("OK")
	}
}

func shaDe(s string) string {
	return sha1Hex(s)
}
