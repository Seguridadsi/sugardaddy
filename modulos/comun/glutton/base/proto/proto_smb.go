package main

// Este fichero lo deja preparar-base.sh según el protocolo elegido por la
// trampa: registra el manejador SMB de glutton. Para RDP o MSSQL, la base
// dejaría en su lugar un proto_rdp.go / proto_mssql.go con su HandleRDP /
// HandleMSSQL (y la trampa mantendría también su fichero de manejador y su
// mapeador sd/mapa_<proto>.go).
import "github.com/mushorg/glutton/protocols/tcp"

func init() { registrar("smb", tcp.HandleSMB) }
