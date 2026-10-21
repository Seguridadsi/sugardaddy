package main

import (
	"sort"
	"strconv"
	"strings"
	"time"
)

// maxNombreCliente: lo que se guarda de CLIENT SETNAME, HELLO SETNAME y
// CLIENT SETINFO. Ningún cliente real usa nombres más largos, y así un
// atacante no retiene 64 KB por conexión (con prefijo: un s[:256] retenía
// el argumento entero).
const maxNombreCliente = 256

// nombreClienteValido: como validateClientAttr de Redis, solo caracteres
// visibles de ASCII ('!' a '~'), sin espacios ni saltos de línea.
func nombreClienteValido(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '!' || s[i] > '~' {
			return false
		}
	}
	return true
}

func recortarNombre(s string) string { return prefijo(s, maxNombreCliente) }

// cmdClient atiende CLIENT. GETNAME/SETNAME guardan y devuelven el nombre;
// ID el de la conexión; INFO y LIST muestran la IP y el puerto reales del
// cliente, y LIST solo las conexiones de su misma IP (las que cuenta INFO
// connected_clients): ni enseña a otros atacantes ni se contradice.
func (s *servidor) cmdClient(o *resp, cli *cliente, args []string) {
	sub := s.contenedor(o, "CLIENT", args)
	switch sub {
	case "":
	case "SETNAME":
		if len(args) != 3 {
			o.err(s.errArgsSub("CLIENT", sub))
			return
		}
		if !nombreClienteValido(args[2]) {
			o.err("ERR Client names cannot contain spaces, newlines or special characters.")
			return
		}
		cli.nombre = recortarNombre(args[2])
		o.simple("OK")
	case "GETNAME":
		if cli.nombre == "" {
			o.nulo()
			return
		}
		o.bulk(cli.nombre)
	case "ID":
		o.entero(cli.id)
	case "SETINFO":
		if len(args) != 4 {
			o.err(s.errArgsSub("CLIENT", sub))
			return
		}
		var destino *string
		switch strings.ToUpper(args[2]) {
		case "LIB-NAME":
			destino = &cli.biblioteca
		case "LIB-VER":
			destino = &cli.libVer
		default:
			o.err("ERR Unrecognized option '" + cortarC(args[2], -1) + "'")
			return
		}
		if !nombreClienteValido(args[3]) {
			o.err("ERR " + cortarC(args[2], -1) + " cannot contain spaces, newlines or special characters.")
			return
		}
		*destino = recortarNombre(args[3])
		o.simple("OK")
	case "INFO":
		o.verbatim(s.lineaCliente(s.fotoPropia(cli), true) + "\n")
	case "LIST":
		o.verbatim(s.listaClientes(cli))
	case "KILL":
		if len(args) == 3 {
			o.err("ERR No such client")
		} else {
			o.entero(0)
		}
	case "UNBLOCK":
		o.entero(0)
	case "GETREDIR":
		o.entero(-1)
	default:
		// PAUSE, UNPAUSE, REPLY, TRACKING, CACHING, NO-EVICT, NO-TOUCH...
		o.simple("OK")
	}
}

// fotoPropia: la foto de la conexión que pregunta, con la orden en curso.
func (s *servidor) fotoPropia(cli *cliente) *fotoCliente {
	cli.publicar()
	return cli.foto.Load()
}

// listaClientes: CLIENT LIST de la vista del que pregunta, por id como Redis.
func (s *servidor) listaClientes(cli *cliente) string {
	var fotos []*fotoCliente
	s.banco.conVista(func() {
		for otro := range cli.vista.clientes {
			if otro == cli {
				continue
			}
			if f := otro.foto.Load(); f != nil {
				fotos = append(fotos, f)
			}
		}
	})
	propia := s.fotoPropia(cli)
	fotos = append(fotos, propia)
	sort.Slice(fotos, func(i, j int) bool { return fotos[i].id < fotos[j].id })
	var b strings.Builder
	for _, f := range fotos {
		b.WriteString(s.lineaCliente(f, f == propia))
		b.WriteByte('\n')
	}
	return b.String()
}

// lineaCliente: la línea de CLIENT INFO/LIST con los campos de cada versión
// (catClientInfoString de 6.2.14, 7.0.15 y 7.2.4). La conexión que pregunta
// tiene su orden en el búfer (qbuf=26: *2 $6 client $4 list); las demás, no.
func (s *servidor) lineaCliente(f *fotoCliente, propia bool) string {
	ahora := time.Now()
	idle := int64(ahora.Sub(f.ultimaActividad) / time.Second)
	qbuf, qbufLibre, argvMem := "0", "0", "0"
	if propia {
		idle = 0
		qbuf, qbufLibre, argvMem = "26", "20448", "10"
		if s.id.nver < 700 {
			qbufLibre = "32742"
		}
	}
	// tot-mem cuenta el búfer de entrada: sin orden en curso, lo de la
	// conexión que pregunta menos su qbuf, qbuf-free y argv-mem.
	totMem := "22426"
	if s.id.nver < 700 {
		totMem = "61466"
	}
	if !propia {
		totMem = "1942"
		if s.id.nver < 700 {
			totMem = "28688"
		}
	}
	fd := f.fd
	if fd < 8 {
		fd = 8
	}
	cmd := f.cmd
	if cmd == "" {
		cmd = "NULL"
	}
	campos := []string{
		"id=" + strconv.FormatInt(f.id, 10),
		"addr=" + f.addr,
		"laddr=" + f.laddr,
		"fd=" + strconv.Itoa(fd),
		"name=" + f.nombre,
		"age=" + strconv.FormatInt(int64(ahora.Sub(f.creado)/time.Second), 10),
		"idle=" + strconv.FormatInt(idle, 10),
		"flags=N",
		"db=" + strconv.Itoa(f.db),
		"sub=0", "psub=0",
	}
	if s.id.nver >= 700 {
		campos = append(campos, "ssub=0")
	}
	campos = append(campos, "multi="+strconv.Itoa(f.multi), "qbuf="+qbuf, "qbuf-free="+qbufLibre, "argv-mem="+argvMem)
	if s.id.nver >= 700 {
		campos = append(campos, "multi-mem=0", "rbs=1024", "rbp=0")
	}
	campos = append(campos, "obl=0", "oll=0", "omem=0", "tot-mem="+totMem, "events=r",
		"cmd="+cmd, "user="+f.usuario, "redir=-1")
	if s.id.nver >= 700 {
		campos = append(campos, "resp="+strconv.Itoa(f.proto))
	}
	if s.id.nver >= 702 {
		campos = append(campos, "lib-name="+f.biblioteca, "lib-ver="+f.libVer)
	}
	return strings.Join(campos, " ")
}

// laddr: la dirección local de una instalación en máquina (no docker): la IP
// privada de su interfaz y el puerto que anuncia.
func laddr(id *identidad) string {
	return id.ipLocal + ":" + strconv.Itoa(id.puerto)
}

func usuarioCliente(cli *cliente) string {
	if cli.usuario != "" {
		return cli.usuario
	}
	return "default"
}
