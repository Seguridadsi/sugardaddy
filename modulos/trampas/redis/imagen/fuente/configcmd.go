package main

import (
	"strings"
)

// cmdConfig atiende CONFIG GET/SET/REWRITE/RESETSTAT con los errores exactos
// de cada versión. Los CONFIG SET se guardan en la vista de la IP y CONFIG GET
// los devuelve: un gusano que hace CONFIG SET dir /x y luego CONFIG GET dir ve
// /x, no el valor de fábrica. No se escribe ningún fichero.
func (s *servidor) cmdConfig(o *resp, cli *cliente, args []string) {
	sub := s.contenedor(o, "CONFIG", args)
	switch sub {
	case "":
	case "GET":
		// 6.2 admite un solo patrón; 7.x, varios.
		if len(args) < 3 || (s.id.nver < 700 && len(args) != 3) {
			o.err(s.errArgsSub("CONFIG", args[1]))
			return
		}
		s.configGet(o, cli, args[2:])
	case "SET":
		s.configSet(o, cli, args)
	case "REWRITE", "RESETSTAT":
		if len(args) != 2 {
			o.err(s.errArgsSub("CONFIG", args[1]))
			return
		}
		// Sin fichero de configuración (imagen oficial), Redis contesta este error.
		if sub == "REWRITE" && s.id.ficheroConf == "" {
			o.err("ERR The server is running without a config file")
			return
		}
		o.simple("OK")
	}
}

func (s *servidor) configGet(o *resp, cli *cliente, patrones []string) {
	base := s.id.configDefecto()
	puestos := map[string]string{}
	s.banco.conVista(func() {
		for k, v := range cli.vista.config {
			puestos[k] = v
		}
	})
	// Orden: como vienen en configDefecto, y los puestos a mano que no estén.
	vistos := map[string]bool{}
	var pares [][2]string
	for _, kv := range base {
		v := kv[1]
		if x, ok := puestos[s.id.canonico(kv[0])]; ok {
			v = x
		}
		pares = append(pares, [2]string{kv[0], v})
		vistos[s.id.canonico(kv[0])] = true
	}
	for k, v := range puestos {
		if !vistos[k] {
			pares = append(pares, [2]string{k, v})
		}
	}
	// Como configGetCommand de Redis 7 (que junta lo que encaja en un dict),
	// cada parámetro sale una vez por muchos patrones que lo nombren: la
	// respuesta nunca pasa de len(pares) pares y el mapa de RESP3 no repite
	// claves. Antes, 'CONFIG GET' con mil '*' armaba mil veces la lista entera
	// y, con el cliente sin leer, ocho conexiones dejaban 35 MB vivos.
	// Un solo presupuesto de trabajo para todos los patrones de la orden: mil
	// patrones patológicos no cuestan más CPU que uno.
	trabajo := s.banco.maxTrabajo
	elegido := make([]bool, len(pares))
	quedan := len(pares)
	for _, p := range patrones {
		if quedan == 0 || trabajo <= 0 {
			break // ya están todos, o ya no se mira nada más
		}
		g := compilarGlob(strings.ToLower(p))
		for i, kv := range pares {
			if !elegido[i] && g.encaja(kv[0], &trabajo) {
				elegido[i] = true
				quedan--
			}
		}
	}
	out := make([]string, 0, 2*(len(pares)-quedan))
	for i, kv := range pares {
		if elegido[i] {
			out = append(out, kv[0], kv[1])
		}
	}
	if !retenerRespuesta(cli, out) {
		return
	}
	defer cli.cuota.soltarRespuesta()
	o.mapaPares(out)
}

// maxValorConfig: lo que se guarda del valor de un CONFIG SET. Más que
// cualquier valor real (rutas, listas de save o de bind).
const maxValorConfig = 4 << 10

// configSet sigue configSetCommand de cada versión: en 6.2, un solo par y
// "Unsupported CONFIG parameter" para lo que no se puede cambiar en marcha; en
// 7.x, varios pares, y el primer error en orden manda (desconocido,
// inmutable, protegido o repetido).
func (s *servidor) configSet(o *resp, cli *cliente, args []string) {
	if s.id.nver < 700 {
		if len(args) != 4 {
			o.err(s.errSub("CONFIG", args[1]))
			return
		}
		k := strings.ToLower(args[2])
		if s.id.parametros[k] != parModificable {
			o.err("ERR Unsupported CONFIG parameter: " + cortarC(args[2], -1))
			return
		}
		s.guardarConfig(cli, [][2]string{{s.id.canonico(k), args[3]}})
		o.simple("OK")
		return
	}
	if len(args) < 4 {
		o.err(s.errArgsSub("CONFIG", args[1]))
		return
	}
	if len(args)%2 != 0 {
		o.err("ERR syntax error")
		return
	}
	var pares [][2]string
	vistos := map[string]bool{}
	for i := 2; i+1 < len(args); i += 2 {
		nombre := cortarC(args[i], -1)
		k := strings.ToLower(args[i])
		var fallo string
		switch s.id.parametros[k] {
		case parNo:
			o.err("ERR Unknown option or number of arguments for CONFIG SET - '" + nombre + "'")
			return
		case parInmutable:
			fallo = "can't set immutable config"
		case parProtegido:
			fallo = "can't set protected config"
		default:
			if c := s.id.canonico(k); vistos[c] {
				fallo = "duplicate parameter"
			} else {
				vistos[c] = true
				pares = append(pares, [2]string{c, args[i+1]})
			}
		}
		if fallo != "" {
			o.err("ERR CONFIG SET failed (possibly related to argument '" + nombre + "') - " + fallo)
			return
		}
	}
	s.guardarConfig(cli, pares)
	o.simple("OK")
}

// guardarConfig deja los pares en la vista, con el valor recortado y lo que
// ocupan contado en los topes del banco. requirepass se guarda y CONFIG GET lo
// devuelve, pero AUTH sigue mandando por SD_REDIS_PASSWORD: la trampa no
// ejecuta nada. Si el banco está lleno de configuraciones de otras IP y no
// queda nada que desalojar, no se guarda: Redis habría contestado OK igual.
func (s *servidor) guardarConfig(cli *cliente, pares [][2]string) {
	for i := range pares {
		pares[i][1] = prefijo(pares[i][1], maxValorConfig)
	}
	s.banco.ponerConfig(cli.vista, pares)
}

// claseParametro: cómo se comporta un parámetro en CONFIG SET.
type claseParametro uint8

const (
	parNo          claseParametro = iota // no existe (en 6.2, tampoco si no se puede cambiar en marcha)
	parModificable                       // se cambia
	parInmutable                         // 7.x: can't set immutable config
	parProtegido                         // 7.x: can't set protected config (enable-protected-configs no)
)

// Parámetros de CONFIG SET, sacados de las tablas de config.c de Redis
// 6.2.14, 7.0.15 y 7.2.4. Solo los que existen de verdad: un nombre inventado
// da el error de la versión, como en Redis.
var (
	// Se cambian en marcha en las tres versiones (dir y dbfilename, en 7.x,
	// son protegidos; los nombres ziplist y lua-time-limit, en 7.x, son alias).
	paramComunes = []string{
		"protected-mode", "rdbcompression", "rdb-del-sync-files", "activerehashing",
		"stop-writes-on-bgsave-error", "dynamic-hz", "lazyfree-lazy-eviction",
		"lazyfree-lazy-expire", "lazyfree-lazy-server-del", "lazyfree-lazy-user-del",
		"lazyfree-lazy-user-flush", "repl-disable-tcp-nodelay", "repl-diskless-sync",
		"aof-rewrite-incremental-fsync", "no-appendfsync-on-rewrite",
		"cluster-require-full-coverage", "rdb-save-incremental-fsync", "aof-load-truncated",
		"aof-use-rdb-preamble", "cluster-replica-no-failover", "cluster-slave-no-failover",
		"replica-lazy-flush", "slave-lazy-flush", "replica-serve-stale-data",
		"slave-serve-stale-data", "replica-read-only", "slave-read-only",
		"replica-ignore-maxmemory", "slave-ignore-maxmemory", "jemalloc-bg-thread",
		"activedefrag", "appendonly", "cluster-allow-reads-when-down", "crash-log-enabled",
		"crash-memcheck-enabled", "cluster-allow-replica-migration", "replica-announced",
		"replica-announce-ip", "slave-announce-ip", "masteruser", "cluster-announce-ip",
		"ignore-warnings", "proc-title-template", "masterauth", "requirepass",
		"repl-diskless-load", "loglevel", "maxmemory-policy", "appendfsync", "oom-score-adj",
		"acl-pubsub-default", "sanitize-dump-payload", "port", "auto-aof-rewrite-percentage",
		"cluster-replica-validity-factor", "cluster-slave-validity-factor", "tcp-keepalive",
		"cluster-migration-barrier", "active-defrag-cycle-min", "active-defrag-cycle-max",
		"active-defrag-threshold-lower", "active-defrag-threshold-upper", "lfu-log-factor",
		"lfu-decay-time", "replica-priority", "slave-priority", "repl-diskless-sync-delay",
		"maxmemory-samples", "maxmemory-eviction-tenacity", "timeout", "replica-announce-port",
		"slave-announce-port", "cluster-announce-bus-port", "cluster-announce-port",
		"repl-timeout", "repl-ping-replica-period", "repl-ping-slave-period",
		"list-compress-depth", "active-expire-effort", "hz", "min-replicas-to-write",
		"min-slaves-to-write", "min-replicas-max-lag", "min-slaves-max-lag", "maxclients",
		"active-defrag-max-scan-fields", "slowlog-max-len", "acllog-max-len",
		"cluster-node-timeout", "slowlog-log-slower-than", "latency-monitor-threshold",
		"proto-max-bulk-len", "stream-node-max-entries", "repl-backlog-size", "maxmemory",
		"set-max-intset-entries", "active-defrag-ignore-bytes", "stream-node-max-bytes",
		"hll-sparse-max-bytes", "tracking-table-max-keys", "client-query-buffer-limit",
		"repl-backlog-ttl", "auto-aof-rewrite-min-size", "save", "client-output-buffer-limit",
		"oom-score-adj-values", "notify-keyspace-events", "list-max-ziplist-size",
		"hash-max-ziplist-entries", "hash-max-ziplist-value", "zset-max-ziplist-entries",
		"zset-max-ziplist-value", "lua-time-limit", "dir", "dbfilename",
	}
	// Solo en 6.2 (quitados en 7.0).
	paramSolo62 = []string{"gopher-enabled", "lua-replicate-commands"}
	// Nuevos en 7.0 (bind se puede cambiar en marcha desde 7.0).
	paramDesde70 = []string{
		"aof-timestamp-enabled", "cluster-allow-pubsubshard-when-down", "latency-tracking",
		"cluster-announce-hostname", "bind-source-addr", "cluster-preferred-endpoint-type",
		"propagation-error-behavior", "shutdown-on-sigint", "shutdown-on-sigterm",
		"shutdown-timeout", "repl-diskless-sync-max-replicas", "busy-reply-threshold",
		"list-max-listpack-size", "hash-max-listpack-entries", "hash-max-listpack-value",
		"zset-max-listpack-entries", "zset-max-listpack-value", "maxmemory-clients",
		"cluster-link-sendbuf-limit", "latency-tracking-info-percentiles", "bind",
		"cluster-announce-tls-port",
	}
	// Nuevos en 7.2.
	paramDesde72 = []string{
		"cluster-announce-human-nodename", "locale-collate", "set-max-listpack-entries",
		"set-max-listpack-value",
	}
	// Existen pero no se cambian en marcha. En 7.x dan "can't set immutable
	// config"; en 6.2, "Unsupported CONFIG parameter" como uno desconocido.
	paramInmutables7 = []string{
		"daemonize", "io-threads-do-reads", "always-show-logo", "set-proc-title",
		"syslog-enabled", "cluster-enabled", "disable-thp", "rdbchecksum", "aclfile",
		"unixsocket", "pidfile", "cluster-config-file", "syslog-ident", "appendfilename",
		"appenddirname", "server_cpulist", "bio_cpulist", "aof_rewrite_cpulist",
		"bgsave_cpulist", "logfile", "supervised", "syslog-facility",
		"enable-protected-configs", "enable-debug-command", "enable-module-command",
		"databases", "io-threads", "tcp-backlog", "cluster-port", "unixsocketperm",
		"replicaof", "slaveof",
	}
	// Solo en las compilaciones con TLS: la imagen oficial y los paquetes sí;
	// un make a mano, no.
	paramTLS = []string{
		"tls-port", "tls-session-cache-size", "tls-session-cache-timeout", "tls-cluster",
		"tls-replication", "tls-auth-clients", "tls-prefer-server-ciphers",
		"tls-session-caching", "tls-cert-file", "tls-key-file", "tls-key-file-pass",
		"tls-client-cert-file", "tls-client-key-file", "tls-client-key-file-pass",
		"tls-dh-params-file", "tls-ca-cert-file", "tls-ca-cert-dir", "tls-protocols",
		"tls-ciphers", "tls-ciphersuites",
	}
	// Alias de las tres versiones (antiguo → nombre propio) y los de 7.x.
	aliasComunes = map[string]string{
		"slave-lazy-flush": "replica-lazy-flush", "slave-serve-stale-data": "replica-serve-stale-data",
		"slave-read-only": "replica-read-only", "slave-ignore-maxmemory": "replica-ignore-maxmemory",
		"cluster-slave-no-failover": "cluster-replica-no-failover", "slave-announce-ip": "replica-announce-ip",
		"cluster-slave-validity-factor": "cluster-replica-validity-factor", "slave-priority": "replica-priority",
		"slave-announce-port": "replica-announce-port", "repl-ping-slave-period": "repl-ping-replica-period",
		"min-slaves-to-write": "min-replicas-to-write", "min-slaves-max-lag": "min-replicas-max-lag",
		"slaveof": "replicaof",
	}
	alias7 = map[string]string{
		"lua-time-limit": "busy-reply-threshold", "list-max-ziplist-size": "list-max-listpack-size",
		"hash-max-ziplist-entries": "hash-max-listpack-entries", "hash-max-ziplist-value": "hash-max-listpack-value",
		"zset-max-ziplist-entries": "zset-max-listpack-entries", "zset-max-ziplist-value": "zset-max-listpack-value",
	}
)

// parametrosDe: los parámetros de CONFIG SET de una versión e instalación.
func parametrosDe(nver int, conTLS bool) map[string]claseParametro {
	m := map[string]claseParametro{}
	pon := func(l []string, c claseParametro) {
		for _, k := range l {
			m[k] = c
		}
	}
	pon(paramComunes, parModificable)
	if conTLS {
		pon(paramTLS, parModificable)
	}
	if nver < 700 {
		pon(paramSolo62, parModificable)
		return m
	}
	pon(paramDesde70, parModificable)
	if nver >= 702 {
		pon(paramDesde72, parModificable)
	}
	pon(paramInmutables7, parInmutable)
	pon([]string{"dir", "dbfilename"}, parProtegido)
	return m
}

// canonico: el nombre propio de un parámetro (el alias se guarda con él, como
// en Redis, donde los dos nombres son el mismo parámetro).
func (id *identidad) canonico(k string) string {
	if c, ok := aliasComunes[k]; ok {
		return c
	}
	if id.nver >= 700 {
		if c, ok := alias7[k]; ok {
			return c
		}
	}
	return k
}
