# Sugardaddy (SeguridadSI) — SEN-8: identidad del sistema simulado por Cowrie,
# derivada de una semilla propia de cada instancia, para que la trampa no se
# reconozca por huella. De aquí salen el usuario del sistema, su hash de
# /etc/shadow, el UUID del disco, el modelo de CPU y la MAC. Así dos Cowrie de
# Sugardaddy no comparten esos datos (un escáner no los correlaciona) y son
# estables entre reinicios (misma imagen para todos; lo que cambia es la
# semilla, guardada junto al estado).
#
# preparar.sh lo copia a src/cowrie/core/sugardaddy_fs.py y parche.py lo engancha
# en:
#   * honeyfs (árbol del fs.pickle en memoria): sustituye los marcadores de los
#     ficheros embebidos (/etc/passwd, /etc/shadow, /proc/cpuinfo, ...) y
#     renombra el directorio del usuario (/home/__SD_USER__).
#   * protocol.txtcmd: sustituye los marcadores en la salida de órdenes de texto
#     (df, lscpu).
#   * commands/ifconfig: MAC e IPv6 de enlace estables por semilla, no al azar.
#   * core/events: el valor de la nota para agentes de IA (token_nota), con el
#     que sugardaddy.marcar_agente marca los eventos de comando.
#
# La nota para agentes de IA: el home del usuario lleva un AGENTS.md (lo crea el
# Dockerfile, ver parche.py) que pide ejecutar una orden con un valor propio de
# la instancia (__SD_AGENT_TOKEN__, de la semilla). Interruptor:
# COWRIE_HONEYPOT_SD_NOTA_AGENTES ([honeypot] sd_nota_agentes). De serie va
# puesta; con «no» el fichero se quita del árbol y no se marca ningún evento.
#
# Los ficheros del fs y los txtcmds se construyen con marcadores __SD_*__ (ver
# imagen/fs/ y los txtcmds del parche); aquí se sustituyen al arrancar. Sin
# dependencias fuera de la biblioteca estándar y de cowrie.core.config.

from __future__ import annotations

import functools
import hashlib
import os
from typing import Any

# Índices de la tupla de un nodo del fs.pickle (cowrie.shell.fs / createfs).
A_NAME, A_TYPE, A_SIZE, A_CONTENTS = 0, 1, 4, 7
T_FILE = 2

# Marcadores que dejan el fs.pickle y los txtcmds, sustituidos al arrancar.
PH_USER = b"__SD_USER__"
PH_HOST = b"__SD_HOSTNAME__"
PH_HASH = b"__SD_HASH__"
PH_UUID = b"__SD_FS_UUID__"
PH_CPU = b"__SD_CPU_MODEL__"
PH_AGENT = b"__SD_AGENT_TOKEN__"

# El fichero de la nota para agentes de IA (el mismo nombre que busca
# sugardaddy.FICHERO_AGENTES en los comandos) y su interruptor.
NOMBRE_NOTA = "AGENTS.md"
ENV_NOTA = "COWRIE_HONEYPOT_SD_NOTA_AGENTES"

# Alfabeto de un hash de crypt (sal y resumen de sha512crypt: $6$sal$resumen).
_CRYPT = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_HEX = "0123456789abcdef"

# Nombres de cuenta verosímiles de un servidor (sintéticos; nunca «phil»).
USUARIOS = [
    "admin",
    "ubuntu",
    "deploy",
    "sysop",
    "operator",
    "webadmin",
    "dbadmin",
    "ansible",
    "devops",
    "mgmt",
]

# Fabricante y familia de CPU que anuncian, fijos, /proc/cpuinfo y lscpu
# (imagen/fs/*/proc/cpuinfo y imagen/txtcmds/usr/bin/lscpu): GenuineIntel,
# cpu family 6, model 85 (Skylake-SP / Cascade Lake). Todo modelo de CPUS tiene
# que cuadrar con eso: un AMD junto a «GenuineIntel», o un Xeon sin AVX-512 /
# de otra familia junto a «model 85», es imposible en un equipo real y delata la
# trampa. Lo comprueba una prueba de coherencia (test_sugardaddy_fs.py).
CPU_VENDOR_ID = "GenuineIntel"

# Modelos de CPU verosímiles (sintéticos; nunca el E5-2680 de serie). SOLO Xeon
# Intel Scalable Skylake-SP / Cascade Lake (model 85), a juego con el cpuinfo y
# el lscpu fijos (ver CPU_VENDOR_ID). Nada de AMD EPYC ni de Xeon E (sin AVX-512)
# ni de Ice Lake (model 106): chocarían con esos ficheros.
CPUS = [
    "Intel(R) Xeon(R) Silver 4210R CPU @ 2.40GHz",
    "Intel(R) Xeon(R) Silver 4214 CPU @ 2.20GHz",
    "Intel(R) Xeon(R) Silver 4216 CPU @ 2.10GHz",
    "Intel(R) Xeon(R) Gold 5218 CPU @ 2.30GHz",
    "Intel(R) Xeon(R) Gold 5220 CPU @ 2.20GHz",
    "Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz",
    "Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz",
    "Intel(R) Xeon(R) Gold 6252 CPU @ 2.10GHz",
]

# Hipervisor que anuncia lscpu («Hypervisor vendor: KVM») y del que cpuinfo lleva
# el flag «hypervisor». La MAC tiene que llevar su OUI, o no cuadra con lo
# anunciado.
HIPERVISOR = "KVM"

# OUI de la MAC: el de KVM/QEMU (52:54:00), a juego con el hipervisor anunciado
# (ver HIPERVISOR). Nada de VMware (00:50:56, 00:0c:29) ni Xen (00:16:3e)
# mientras lscpu diga KVM: la MAC delataría la trampa. Lo comprueba una prueba de
# coherencia MAC↔hipervisor (test_sugardaddy_fs.py).
OUIS = [
    (0x52, 0x54, 0x00),  # QEMU/KVM
]


class _Flujo:
    """Un flujo de bytes determinista de la semilla (SHA-256 en contador),
    separado por etiqueta: cada propiedad sale de su propio flujo."""

    def __init__(self, semilla_: bytes, etiqueta: bytes) -> None:
        self.base = semilla_ + b"\x00" + etiqueta
        self.cont = 0
        self.buf = b""

    def leer(self, n: int) -> bytes:
        while len(self.buf) < n:
            self.buf += hashlib.sha256(self.base + self.cont.to_bytes(8, "big")).digest()
            self.cont += 1
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


def _cadena(semilla_: bytes, etiqueta: bytes, n: int, alfabeto: str) -> str:
    return "".join(alfabeto[b % len(alfabeto)] for b in _Flujo(semilla_, etiqueta).leer(n))


def _elegir(semilla_: bytes, etiqueta: bytes, opciones: list[Any]) -> Any:
    h = hashlib.sha256(semilla_ + b"\x00" + etiqueta).digest()
    return opciones[int.from_bytes(h[:4], "big") % len(opciones)]


def _ruta_estado() -> str:
    try:
        from cowrie.core.config import CowrieConfig

        base = CowrieConfig.get("honeypot", "state_path", fallback="var/lib/cowrie")
    except Exception:
        base = "var/lib/cowrie"
    try:
        if base and os.path.isdir(base):
            return os.path.join(base, ".semilla")
    except OSError:
        pass
    return ""


@functools.cache
def semilla() -> bytes:
    """La semilla de esta instancia: SD_COWRIE_SEMILLA, o el fichero .semilla
    junto al estado (escribible), o una nueva al azar que se guarda (0600) para
    mantenerla entre reinicios. Si no se puede guardar, una del proceso."""
    env = os.environ.get("SD_COWRIE_SEMILLA", "").strip()
    if env:
        return env.encode("utf-8", "surrogatepass")
    ruta = _ruta_estado()
    if ruta:
        try:
            b = open(ruta, "rb").read().strip()
            if b:
                return b
        except OSError:
            pass
        nueva = os.urandom(16).hex().encode("ascii")
        try:
            fd = os.open(ruta, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, nueva)
            finally:
                os.close(fd)
            return nueva
        except OSError:
            try:  # carrera: otro proceso la creó
                b = open(ruta, "rb").read().strip()
                if b:
                    return b
            except OSError:
                pass
            return nueva
    return os.urandom(16).hex().encode("ascii")


@functools.cache
def usuario() -> str:
    return _elegir(semilla(), b"usuario", USUARIOS)


@functools.cache
def hash_shadow() -> str:
    """Un hash con la pinta de sha512crypt: $6$<sal 16>$<resumen 86>. No es el
    hash de ninguna contraseña (no hace falta: nadie lo verifica), solo tiene
    que parecer real."""
    return "$6$" + _cadena(semilla(), b"sal", 16, _CRYPT) + "$" + _cadena(semilla(), b"hash", 86, _CRYPT)


@functools.cache
def uuid_fs() -> str:
    b = bytearray(_Flujo(semilla(), b"uuid").leer(16))
    b[6] = (b[6] & 0x0F) | 0x40  # versión 4
    b[8] = (b[8] & 0x3F) | 0x80  # variante RFC 4122
    x = b.hex()
    return f"{x[0:8]}-{x[8:12]}-{x[12:16]}-{x[16:20]}-{x[20:32]}"


@functools.cache
def modelo_cpu() -> str:
    return _elegir(semilla(), b"cpu", CPUS)


@functools.cache
def mac() -> str:
    oui = _elegir(semilla(), b"oui", OUIS)
    resto = _Flujo(semilla(), b"mac").leer(3)
    return ":".join("%02x" % x for x in list(oui) + list(resto))


@functools.cache
def inet6_enlace() -> str:
    """Una IPv6 de enlace (fe80::/64) derivada de la MAC por EUI-64."""
    partes = [int(x, 16) for x in mac().split(":")]
    eui = [partes[0] ^ 0x02, partes[1], partes[2], 0xFF, 0xFE, partes[3], partes[4], partes[5]]
    return "fe80::%02x%02x:%02xff:fe%02x:%02x%02x/64" % (
        eui[0],
        eui[1],
        eui[2],
        eui[5],
        eui[6],
        eui[7],
    )


@functools.cache
def token_agente() -> str:
    """El valor que lleva la orden del AGENTS.md: 16 hex de la semilla, por su
    propio flujo. Distinto en cada instancia y estable entre reinicios; no está
    en ningún otro sitio del sistema simulado, así que un comando que lo lleva
    solo puede venir de haber leído el fichero."""
    return _cadena(semilla(), b"agente", 16, _HEX)


@functools.cache
def nota_agentes() -> bool:
    """Si esta instancia lleva la nota para agentes de IA. Solo «no» la quita:
    vacío, o un ${notaAgentes} que llegue sin sustituir, la deja puesta."""
    try:
        from cowrie.core.config import CowrieConfig

        v = CowrieConfig.get("honeypot", "sd_nota_agentes", fallback="si")
    except Exception:
        v = os.environ.get(ENV_NOTA, "si")
    return str(v).strip().lower() != "no"


def token_nota() -> str:
    """El valor con el que marcar los eventos de comando
    (sugardaddy.marcar_agente): el de la instancia, o vacío con la nota
    quitada (no se marca nada)."""
    return token_agente() if nota_agentes() else ""


def _es_nota(nodo: Any) -> bool:
    """Si un nodo del árbol es el fichero de la nota: por nombre y por llevar
    su marcador, para no quitar nunca un AGENTS.md que no sea el nuestro."""
    return (
        nodo[A_TYPE] == T_FILE
        and nodo[A_NAME] == NOMBRE_NOTA
        and isinstance(nodo[A_CONTENTS], bytes)
        and PH_AGENT in nodo[A_CONTENTS]
    )


def _nombre_equipo() -> str:
    try:
        from cowrie.core.config import CowrieConfig

        n = CowrieConfig.get("honeypot", "hostname", fallback="server").strip()
    except Exception:
        n = "server"
    if not n or len(n) > 63 or not all(c.isalnum() or c in "-." for c in n):
        return "server"
    return n


def _mapa() -> dict[bytes, bytes]:
    return {
        PH_USER: usuario().encode("ascii"),
        PH_HOST: _nombre_equipo().encode("ascii"),
        PH_HASH: hash_shadow().encode("ascii"),
        PH_UUID: uuid_fs().encode("ascii"),
        PH_CPU: modelo_cpu().encode("ascii"),
        PH_AGENT: token_agente().encode("ascii"),
    }


def sustituir_bytes(datos: bytes) -> bytes:
    """Sustituye los marcadores __SD_*__ por los valores de esta instancia."""
    if not isinstance(datos, bytes) or b"__SD_" not in datos:
        return datos
    for marcador, valor in _mapa().items():
        if marcador in datos:
            datos = datos.replace(marcador, valor)
    return datos


def personalizar_arbol(tree: list[Any]) -> int:
    """Recorre el árbol del fs.pickle (en memoria) y, sin alargar la lista de
    nodos, sustituye los marcadores de los ficheros embebidos y renombra las
    entradas cuyo nombre lleva el del usuario (p. ej. /home/__SD_USER__). Con
    la nota para agentes de IA quitada, saca su fichero del directorio que lo
    tiene. Devuelve cuántos nodos tocó. No sigue enlaces (A_TARGET): los
    renombra el nodo al que apuntan."""
    usr = usuario()
    con_nota = nota_agentes()
    tocados = 0
    pila = [tree]
    while pila:
        nodo = pila.pop()
        if isinstance(nodo[A_NAME], str) and "__SD_USER__" in nodo[A_NAME]:
            nodo[A_NAME] = nodo[A_NAME].replace("__SD_USER__", usr)
            tocados += 1
        contenido = nodo[A_CONTENTS]
        if nodo[A_TYPE] == T_FILE and isinstance(contenido, bytes):
            nuevo = sustituir_bytes(contenido)
            if nuevo != contenido:
                nodo[A_CONTENTS] = nuevo
                nodo[A_SIZE] = len(nuevo)
                tocados += 1
        elif isinstance(contenido, list):
            if not con_nota and any(_es_nota(h) for h in contenido):
                # En el sitio: el directorio sigue siendo la misma lista.
                antes = len(contenido)
                contenido[:] = [h for h in contenido if not _es_nota(h)]
                tocados += antes - len(contenido)
            pila.extend(contenido)
    return tocados


def reiniciar() -> None:
    """Olvida la semilla y lo derivado (para las pruebas)."""
    for f in (
        semilla,
        usuario,
        hash_shadow,
        uuid_fs,
        modelo_cpu,
        mac,
        inet6_enlace,
        token_agente,
        nota_agentes,
    ):
        f.cache_clear()
