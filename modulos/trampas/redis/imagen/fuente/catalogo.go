package main

// comandos conocidos por la trampa: los que atiende responder y unos cuantos
// más que un Redis real reconoce (para que, dentro de MULTI, se encolen con
// +QUEUED en vez de dar "unknown command" y delatar la trampa).
var catalogo = func() map[string]bool {
	m := map[string]bool{}
	for _, c := range []string{
		"QUIT", "PING", "AUTH", "HELLO", "RESET", "INFO", "COMMAND", "CONFIG",
		"CLIENT", "SELECT", "SWAPDB", "SET", "SETEX", "PSETEX", "SETNX", "GET",
		"GETDEL", "GETSET", "GETEX", "APPEND", "STRLEN", "SETRANGE", "GETRANGE",
		"MSET", "MSETNX", "MGET", "DEL", "UNLINK", "EXISTS", "KEYS", "SCAN",
		"RANDOMKEY", "TYPE", "TTL", "PTTL", "EXPIRE", "PEXPIRE", "EXPIREAT",
		"PEXPIREAT", "PERSIST", "EXPIRETIME", "PEXPIRETIME", "DBSIZE", "INCR",
		"DECR", "INCRBY", "DECRBY", "INCRBYFLOAT", "MULTI", "EXEC", "DISCARD",
		"WATCH", "UNWATCH", "SLAVEOF", "REPLICAOF", "MODULE", "EVAL", "EVAL_RO",
		"EVALSHA", "EVALSHA_RO", "FCALL", "FCALL_RO", "FUNCTION", "SCRIPT",
		"FLUSHALL", "FLUSHDB", "SAVE", "BGSAVE", "BGREWRITEAOF", "LASTSAVE",
		"ECHO", "TIME", "DEBUG", "OBJECT", "WAIT", "WAITAOF", "SUBSCRIBE",
		"UNSUBSCRIBE", "PSUBSCRIBE", "PUNSUBSCRIBE", "SSUBSCRIBE", "SUNSUBSCRIBE",
		"PUBLISH", "SPUBLISH", "PUBSUB", "MEMORY", "ACL", "SHUTDOWN", "LOLWUT",
		"LATENCY", "SLOWLOG", "DUMP", "RESTORE", "MOVE", "COPY", "RENAME",
		"RENAMENX", "TOUCH", "SORT", "SORT_RO", "SETBIT", "GETBIT", "BITCOUNT",
		"BITPOS", "BITOP", "LPUSH", "RPUSH", "LPOP", "RPOP", "LLEN", "LRANGE",
		"LINDEX", "LSET", "LREM", "LTRIM", "LPOS", "HSET", "HGET", "HDEL",
		"HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HMGET", "HMSET",
		"HINCRBY", "HSCAN", "SADD", "SREM", "SMEMBERS", "SCARD", "SISMEMBER",
		"SSCAN", "SPOP", "SRANDMEMBER", "SINTER", "SUNION", "SDIFF", "ZADD",
		"ZREM", "ZRANGE", "ZCARD", "ZSCORE", "ZRANK", "ZSCAN", "ZINCRBY",
		"XADD", "XLEN", "XRANGE", "XREAD", "XINFO", "GEOADD", "PFADD", "PFCOUNT",
		"CLUSTER", "XGROUP", "PERSIST", "FAILOVER", "REPLICAOF",
		// Redis los tiene en su tabla para cortar a quien le habla HTTP.
		"POST", "HOST:",
	} {
		m[c] = true
	}
	return m
}()

// desde: comandos que no existen en todas las versiones que finge la trampa,
// con la primera en que aparecen (nver). En una anterior son "unknown command".
var desde = map[string]int{
	"FUNCTION": 700, "FCALL": 700, "FCALL_RO": 700, "EVAL_RO": 700, "EVALSHA_RO": 700,
	"SPUBLISH": 700, "SSUBSCRIBE": 700, "SUNSUBSCRIBE": 700,
	"EXPIRETIME": 700, "PEXPIRETIME": 700,
	"WAITAOF": 702,
}

// esComando dice si cmd es un comando que un Redis de esta versión reconoce.
// Sirve para encolar dentro de MULTI como lo hace Redis: lo conocido con
// +QUEUED, lo desconocido con error (que aborta el EXEC).
func esComando(id *identidad, cmd string) bool {
	return catalogo[cmd] && id.nver >= desde[cmd]
}

// subcomandos que atiende la trampa en cada comando contenedor, con la
// primera versión que los tiene (nver; 0: todas). Cualquier otro da el error
// de subcomando desconocido de la versión fingida.
var subcomandos = map[string]map[string]int{
	"CONFIG": {"GET": 0, "SET": 0, "REWRITE": 0, "RESETSTAT": 0},
	"CLIENT": {"SETNAME": 0, "GETNAME": 0, "ID": 0, "INFO": 602, "LIST": 0, "KILL": 0,
		"PAUSE": 0, "UNPAUSE": 602, "REPLY": 0, "TRACKING": 0, "CACHING": 0, "GETREDIR": 0,
		"TRACKINGINFO": 602, "UNBLOCK": 0, "NO-EVICT": 700, "NO-TOUCH": 702, "SETINFO": 702},
	"MODULE":   {"LIST": 0, "LOAD": 0, "UNLOAD": 0, "LOADEX": 700},
	"FUNCTION": {"LIST": 700, "DUMP": 700, "STATS": 700, "LOAD": 700, "RESTORE": 700, "FLUSH": 700, "DELETE": 700, "KILL": 700},
	"SCRIPT":   {"LOAD": 0, "EXISTS": 0, "FLUSH": 0, "KILL": 0},
	"OBJECT":   {"ENCODING": 0, "REFCOUNT": 0, "IDLETIME": 0, "FREQ": 0},
	"MEMORY":   {"USAGE": 0, "DOCTOR": 0, "PURGE": 0},
	"ACL":      {"WHOAMI": 0, "LIST": 0, "USERS": 0, "CAT": 0, "GETUSER": 0},
	"LATENCY":  {"HISTORY": 0, "LATEST": 0, "RESET": 0},
	"SLOWLOG":  {"GET": 0, "LEN": 0, "RESET": 0},
	"COMMAND":  {"COUNT": 0, "INFO": 0, "GETKEYS": 0, "DOCS": 700, "LIST": 700, "GETKEYSANDFLAGS": 700},
	"CLUSTER": {"INFO": 0, "NODES": 0, "SLOTS": 0, "MYID": 0, "KEYSLOT": 0, "COUNTKEYSINSLOT": 0,
		"GETKEYSINSLOT": 0, "ADDSLOTS": 0, "DELSLOTS": 0, "FLUSHSLOTS": 0, "FAILOVER": 0, "FORGET": 0,
		"MEET": 0, "REPLICATE": 0, "REPLICAS": 0, "SLAVES": 0, "RESET": 0, "SAVECONFIG": 0,
		"SET-CONFIG-EPOCH": 0, "SETSLOT": 0, "BUMPEPOCH": 0, "COUNT-FAILURE-REPORTS": 0,
		"SHARDS": 700, "LINKS": 700, "ADDSLOTSRANGE": 700, "DELSLOTSRANGE": 700, "MYSHARDID": 702},
}
