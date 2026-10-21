package main

import (
	"math/rand/v2"
	"strconv"
	"strings"
	"time"
)

const errNoEntero = "ERR value is not an integer or out of range"

// plazoDe calcula el momento de caducidad de las opciones EX/PX/EXAT/PXAT de
// SET, o cero si no las lleva. Devuelve si hubo error de sintaxis.
func plazoDe(args []string) (time.Time, bool, bool) {
	var cuando time.Time
	conservarTTL := false
	for i := 3; i < len(args); i++ {
		switch strings.ToUpper(args[i]) {
		case "EX", "PX", "EXAT", "PXAT":
			if i+1 >= len(args) {
				return cuando, false, true
			}
			n, err := strconv.ParseInt(args[i+1], 10, 64)
			if err != nil {
				return cuando, false, true
			}
			switch strings.ToUpper(args[i]) {
			case "EX":
				cuando = time.Now().Add(time.Duration(n) * time.Second)
			case "PX":
				cuando = time.Now().Add(time.Duration(n) * time.Millisecond)
			case "EXAT":
				cuando = time.Unix(n, 0)
			case "PXAT":
				cuando = time.UnixMilli(n)
			}
			i++
		case "KEEPTTL":
			conservarTTL = true
		case "NX", "XX", "GET":
			// se tratan en cmdSet
		default:
			return cuando, false, true
		}
	}
	return cuando, conservarTTL, false
}

func (s *servidor) cmdSet(o *resp, cli *cliente, args []string) {
	if len(args) < 3 {
		o.err(errArgs("set"))
		return
	}
	cuando, conservarTTL, mal := plazoDe(args)
	if mal {
		o.err("ERR syntax error")
		return
	}
	nx, xx, get := false, false, false
	for _, a := range args[3:] {
		switch strings.ToUpper(a) {
		case "NX":
			nx = true
		case "XX":
			xx = true
		case "GET":
			get = true
		}
	}
	anterior, existe := s.banco.get(cli.vista, cli.db, args[1])
	if nx && existe || xx && !existe {
		if get {
			if existe {
				o.bulk(anterior)
			} else {
				o.nulo()
			}
			return
		}
		o.nulo()
		return
	}
	s.banco.set(cli.vista, cli.db, args[1], args[2], cuando, conservarTTL)
	if get {
		if existe {
			o.bulk(anterior)
		} else {
			o.nulo()
		}
		return
	}
	o.simple("OK")
}

func (s *servidor) cmdSetex(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) != 4 {
		o.err(errArgs(cmd))
		return
	}
	n, err := strconv.ParseInt(args[2], 10, 64)
	if err != nil {
		o.err(errNoEntero)
		return
	}
	if n <= 0 {
		o.err("ERR invalid expire time in '" + strings.ToLower(cmd) + "' command")
		return
	}
	d := time.Duration(n) * time.Second
	if cmd == "PSETEX" {
		d = time.Duration(n) * time.Millisecond
	}
	s.banco.set(cli.vista, cli.db, args[1], args[3], time.Now().Add(d), false)
	o.simple("OK")
}

func (s *servidor) cmdSetnx(o *resp, cli *cliente, args []string) {
	if len(args) != 3 {
		o.err(errArgs("setnx"))
		return
	}
	if _, existe := s.banco.get(cli.vista, cli.db, args[1]); existe {
		o.entero(0)
		return
	}
	s.banco.set(cli.vista, cli.db, args[1], args[2], time.Time{}, false)
	o.entero(1)
}

func (s *servidor) cmdGet(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) != 2 {
		o.err(errArgs(cmd))
		return
	}
	v, ok := s.banco.get(cli.vista, cli.db, args[1])
	if !ok {
		o.nulo()
		return
	}
	if cmd == "GETDEL" {
		s.banco.del(cli.vista, cli.db, args[1])
	}
	o.bulk(v)
}

func (s *servidor) cmdGetset(o *resp, cli *cliente, args []string) {
	if len(args) != 3 {
		o.err(errArgs("getset"))
		return
	}
	v, ok := s.banco.get(cli.vista, cli.db, args[1])
	s.banco.set(cli.vista, cli.db, args[1], args[2], time.Time{}, false)
	if ok {
		o.bulk(v)
	} else {
		o.nulo()
	}
}

func (s *servidor) cmdAppend(o *resp, cli *cliente, args []string) {
	if len(args) != 3 {
		o.err(errArgs("append"))
		return
	}
	v, _ := s.banco.get(cli.vista, cli.db, args[1])
	nv := v + args[2]
	s.banco.set(cli.vista, cli.db, args[1], nv, time.Time{}, true)
	nv, _ = s.banco.get(cli.vista, cli.db, args[1])
	o.entero(int64(len(nv)))
}

func (s *servidor) cmdStrlen(o *resp, cli *cliente, args []string) {
	if len(args) != 2 {
		o.err(errArgs("strlen"))
		return
	}
	v, _ := s.banco.get(cli.vista, cli.db, args[1])
	o.entero(int64(len(v)))
}

func (s *servidor) cmdMset(o *resp, cli *cliente, args []string) {
	if len(args) < 3 || len(args)%2 != 1 {
		o.err("ERR wrong number of arguments for 'mset' command")
		return
	}
	for i := 1; i+1 < len(args); i += 2 {
		s.banco.set(cli.vista, cli.db, args[i], args[i+1], time.Time{}, false)
	}
	o.simple("OK")
}

func (s *servidor) cmdMget(o *resp, cli *cliente, args []string) {
	if len(args) < 2 {
		o.err(errArgs("mget"))
		return
	}
	o.cabecera(len(args) - 1)
	for _, k := range args[1:] {
		if v, ok := s.banco.get(cli.vista, cli.db, k); ok {
			o.bulk(v)
		} else {
			o.nulo()
		}
	}
}

func (s *servidor) cmdDel(o *resp, cli *cliente, args []string) {
	if len(args) < 2 {
		o.err(errArgs("del"))
		return
	}
	n := 0
	for _, k := range args[1:] {
		if s.banco.del(cli.vista, cli.db, k) {
			n++
		}
	}
	o.entero(int64(n))
}

func (s *servidor) cmdExists(o *resp, cli *cliente, args []string) {
	if len(args) < 2 {
		o.err(errArgs("exists"))
		return
	}
	n := 0
	for _, k := range args[1:] {
		if s.banco.existe(cli.vista, cli.db, k) {
			n++
		}
	}
	o.entero(int64(n))
}

func (s *servidor) cmdKeys(o *resp, cli *cliente, args []string) {
	if len(args) != 2 {
		o.err(errArgs("keys"))
		return
	}
	claves := s.banco.claves(cli.vista, cli.db, args[1])
	if !retenerRespuesta(cli, claves) {
		return
	}
	defer cli.cuota.soltarRespuesta()
	o.arreglo(claves)
}

// cmdScan hace un SCAN de una pasada: devuelve el cursor 0 y las claves que
// encajan. El atacante que recorre el keyspace ve lo mismo que con KEYS.
func (s *servidor) cmdScan(o *resp, cli *cliente, args []string) {
	if len(args) < 2 {
		o.err(errArgs("scan"))
		return
	}
	patron := "*"
	for i := 2; i+1 < len(args); i += 2 {
		switch strings.ToUpper(args[i]) {
		case "MATCH":
			patron = args[i+1]
		case "COUNT", "TYPE":
			// se ignoran: una sola pasada
		default:
			o.err("ERR syntax error")
			return
		}
	}
	claves := s.banco.claves(cli.vista, cli.db, patron)
	if !retenerRespuesta(cli, claves) {
		return
	}
	defer cli.cuota.soltarRespuesta()
	o.cabecera(2)
	o.bulk("0")
	o.arreglo(claves)
}

func (s *servidor) cmdRandomKey(o *resp, cli *cliente) {
	ks := s.banco.claves(cli.vista, cli.db, "*")
	if len(ks) == 0 {
		o.nulo()
		return
	}
	o.bulk(ks[rand.IntN(len(ks))])
}

func (s *servidor) cmdType(o *resp, cli *cliente, args []string) {
	if len(args) != 2 {
		o.err(errArgs("type"))
		return
	}
	if s.banco.existe(cli.vista, cli.db, args[1]) {
		o.simple("string")
	} else {
		o.simple("none")
	}
}

func (s *servidor) cmdTTL(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) != 2 {
		o.err(errArgs(cmd))
		return
	}
	d := s.banco.ttl(cli.vista, cli.db, args[1])
	switch d {
	case -2:
		o.entero(-2)
	case -1:
		o.entero(-1)
	default:
		if cmd == "PTTL" {
			o.entero(int64(d.Milliseconds()))
		} else {
			o.entero(int64((d + time.Second - 1) / time.Second))
		}
	}
}

func (s *servidor) cmdExpire(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) < 3 {
		o.err(errArgs(cmd))
		return
	}
	n, err := strconv.ParseInt(args[2], 10, 64)
	if err != nil {
		o.err(errNoEntero)
		return
	}
	var cuando time.Time
	switch cmd {
	case "EXPIRE":
		cuando = time.Now().Add(time.Duration(n) * time.Second)
	case "PEXPIRE":
		cuando = time.Now().Add(time.Duration(n) * time.Millisecond)
	case "EXPIREAT":
		cuando = time.Unix(n, 0)
	case "PEXPIREAT":
		cuando = time.UnixMilli(n)
	}
	if s.banco.expirar(cli.vista, cli.db, args[1], cuando) {
		o.entero(1)
	} else {
		o.entero(0)
	}
}

func (s *servidor) cmdPersist(o *resp, cli *cliente, args []string) {
	if len(args) != 2 {
		o.err(errArgs("persist"))
		return
	}
	if s.banco.persistir(cli.vista, cli.db, args[1]) {
		o.entero(1)
	} else {
		o.entero(0)
	}
}

func (s *servidor) cmdExpireTime(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) != 2 {
		o.err(errArgs(cmd))
		return
	}
	d := s.banco.ttl(cli.vista, cli.db, args[1])
	if d == -2 || d == -1 {
		o.entero(int64(d))
		return
	}
	cuando := time.Now().Add(d)
	if cmd == "PEXPIRETIME" {
		o.entero(cuando.UnixMilli())
	} else {
		o.entero(cuando.Unix())
	}
}

func (s *servidor) cmdIncr(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) != 2 {
		o.err(errArgs(cmd))
		return
	}
	delta := int64(1)
	if cmd == "DECR" {
		delta = -1
	}
	s.incrementar(o, cli, args[1], delta)
}

func (s *servidor) cmdIncrBy(o *resp, cli *cliente, cmd string, args []string) {
	if len(args) != 3 {
		o.err(errArgs(cmd))
		return
	}
	delta, err := strconv.ParseInt(args[2], 10, 64)
	if err != nil {
		o.err(errNoEntero)
		return
	}
	if cmd == "DECRBY" {
		delta = -delta
	}
	s.incrementar(o, cli, args[1], delta)
}

func (s *servidor) incrementar(o *resp, cli *cliente, k string, delta int64) {
	v, _ := s.banco.get(cli.vista, cli.db, k)
	base := int64(0)
	if v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			o.err(errNoEntero)
			return
		}
		base = n
	}
	base += delta
	s.banco.set(cli.vista, cli.db, k, strconv.FormatInt(base, 10), time.Time{}, true)
	o.entero(base)
}

// ---- MULTI/EXEC -------------------------------------------------------------

func (s *servidor) cmdMulti(o *resp, cli *cliente) {
	if cli.enCola {
		o.err("ERR MULTI calls can not be nested")
		return
	}
	cli.vaciarCola()
	cli.enCola = true
	o.simple("OK")
}

func (s *servidor) cmdDiscard(o *resp, cli *cliente) {
	if !cli.enCola {
		o.err("ERR DISCARD without MULTI")
		return
	}
	cli.vaciarCola()
	o.simple("OK")
}

// cmdExec ejecuta la cola. Devuelve true si una orden encolada cierra la
// conexión (HTTP contra Redis).
func (s *servidor) cmdExec(o *resp, cli *cliente) bool {
	if !cli.enCola {
		o.err("ERR EXEC without MULTI")
		return false
	}
	if cli.multiError {
		cli.vaciarCola()
		o.err("EXECABORT Transaction discarded because of previous errors.")
		return false
	}
	cola := cli.cola
	cli.vaciarCola()
	o.cabecera(len(cola))
	for _, orden := range cola {
		if s.responder(o, cli, nombreComando(orden[0]), orden) {
			return true
		}
	}
	return false
}
