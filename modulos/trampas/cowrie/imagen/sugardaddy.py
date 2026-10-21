# Sugardaddy (SeguridadSI): lo que Cowrie apunta de un atacante, con tope.
# preparar.sh lo copia a src/cowrie/core/sugardaddy.py y parche.py lo engancha
# en el despachador de eventos (core/events.py) y en output/jsonlog.py.

"""Que un atacante no pueda llenar el disco del cliente con cowrie.json.

* ``recortar_evento``: antes de registrar un evento, cada valor que viene
  del atacante (usuario, contraseña, comando y cualquier otro campo) se
  recorta a un tope en bytes de cowrie.json, y ``message`` se compone con los
  valores ya recortados. El campo ``recortado`` dice qué se recortó y cuánto
  medía.
* ``RegistroDiario``: cowrie.json con rotación diaria (UTC) y un tope de
  bytes por día repartido por origen (ver ``Cupos``). Lo que se calla se
  resume en una línea ``cowrie.sugardaddy.log_dropped`` por minuto como
  mucho, y cada parte del registro que se llena deja una línea
  ``cowrie.sugardaddy.log_full``.

Sin dependencias de Twisted ni de la configuración de Cowrie: se prueba solo.
"""

from __future__ import annotations

import ipaddress
import json
import os
import stat
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

# ---- Recorte de lo que viene del atacante ---------------------------------

# Topes de cada valor en bytes de cowrie.json: el texto tal como queda escrito
# en JSON (con sus escapes), que es lo que ocupa en el disco.
TOPES = {"username": 256, "password": 256, "input": 4096}
TOPE_CAMPO = 2048  # cualquier otro campo
TOPE_MENSAJE = 4608  # message: un comando entero y lo que lo rodea
TOPE_ELEMENTO = 256  # cada elemento de una lista o un diccionario
TOPE_CLAVE = 64  # cada clave de un diccionario
MAX_ELEMENTOS = 64  # elementos de una lista o un diccionario
TOPE_EVENTO = 16384  # todo lo de un evento junto, sin contar message
PROFUNDIDAD = 3  # listas dentro de listas
# Detrás de cada valor recortado, en message (que es texto para leer).
MARCA = "[…]"
# Lo pone el propio Cowrie, no el atacante: no se toca (y así un evento
# nunca pierde de qué sesión y de qué origen es).
INTOCABLES = frozenset(
    {"eventid", "format", "time", "timestamp", "sensor", "uuid", "session", "protocol",
     "src_ip", "src_port", "recortado"}
)
# Si el presupuesto del evento no da para todo, va primero lo que más importa.
PRIORIDAD = ("username", "password", "input", "url", "filename", "outfile", "shasum")


def coste(valor: Any) -> int:
    """Bytes que ocupa un valor en cowrie.json (jsonlog escribe con
    ``json.dumps`` y ``ensure_ascii``, como aquí)."""
    try:
        return len(json.dumps(valor, separators=(",", ":")))
    except (TypeError, ValueError):
        return len(json.dumps(str(valor)))


def cortar_texto(s: str, tope: int) -> tuple[str, bool]:
    """El prefijo más largo de ``s`` que ocupa como mucho ``tope`` bytes en
    cowrie.json, y si se ha cortado. Nunca parte un carácter."""
    tope = max(0, tope)
    # Un carácter ocupa como mucho 12 bytes escapado (\\ud83d\\ude00).
    if len(s) * 12 <= tope:
        return s, False
    # Y como poco 1: más de tope caracteres seguro que no caben.
    corto = s[:tope]
    if len(corto) == len(s) and coste(s) - 2 <= tope:
        return s, False
    bajo, alto = 0, len(corto)
    while bajo < alto:
        medio = (bajo + alto + 1) // 2
        if coste(corto[:medio]) - 2 <= tope:
            bajo = medio
        else:
            alto = medio - 1
    return corto[:bajo], True


class _Recorte:
    """Un evento a medio recortar: lo que queda de su presupuesto."""

    def __init__(self, presupuesto: int) -> None:
        self.restante = presupuesto

    def valor(self, v: Any, tope: int, prof: int = 0) -> tuple[Any, bool]:
        if v is None or isinstance(v, bool | float):
            self.restante -= coste(v)
            return v, False
        if isinstance(v, int):
            if -(2**63) <= v < 2**63:
                self.restante -= coste(v)
                return v, False
            # Un entero gigante solo puede venir del atacante (y str() de uno
            # de más de 4300 cifras falla).
            return self.valor(f"<entero de {v.bit_length()} bits>", tope, prof)[0], True
        if isinstance(v, bytes | bytearray):
            v = bytes(v).decode("utf-8", "backslashreplace")
        if isinstance(v, str):
            s, cortado = cortar_texto(v, min(tope, max(0, self.restante)))
            self.restante -= coste(s)
            return s, cortado
        if isinstance(v, list | tuple | set | frozenset | dict):
            if prof >= PROFUNDIDAD:
                return None, True
            return self._contenedor(v, prof)
        return self.valor(str(v), tope, prof)

    def _contenedor(self, v: Any, prof: int) -> tuple[Any, bool]:
        es_dict = isinstance(v, dict)
        items = list(v.items()) if es_dict else list(v)
        cortado = len(items) > MAX_ELEMENTOS
        self.restante -= 2
        salida: Any = {} if es_dict else []
        for item in items[:MAX_ELEMENTOS]:
            if self.restante <= 0:
                cortado = True
                break
            if es_dict:
                clave, c1 = cortar_texto(str(item[0]), TOPE_CLAVE)
                self.restante -= coste(clave) + 1
                nuevo, c2 = self.valor(item[1], TOPE_ELEMENTO, prof + 1)
                salida[clave] = nuevo
                cortado = cortado or c1 or c2
            else:
                nuevo, c = self.valor(item, TOPE_ELEMENTO, prof + 1)
                salida.append(nuevo)
                cortado = cortado or c
            self.restante -= 1
        return salida, cortado


def _medida(v: Any) -> str:
    if isinstance(v, str):
        return f"{len(v.encode('utf-8', 'surrogatepass'))} bytes"
    if isinstance(v, bytes | bytearray):
        return f"{len(v)} bytes"
    if isinstance(v, list | tuple | set | frozenset | dict):
        return f"{len(v)} elementos"
    if isinstance(v, int):
        return f"{v.bit_length()} bits"
    return "valor"


def recortar_evento(ev: dict[str, Any]) -> dict[str, Any]:
    """Recorta, en el sitio, todo lo que el atacante haya podido meter en un
    evento ya convertido (``cowrie.core.output.convert``) y compone su
    ``message`` como Cowrie (``format % evento``), pero con los valores ya
    recortados y la MARCA detrás de cada uno. Si algo se recorta, el campo
    ``recortado`` dice qué y cuánto medía: «password (102400 bytes)»."""
    recorte = _Recorte(TOPE_EVENTO)
    recortados: list[str] = []
    orden = sorted(
        (k for k in ev if k not in INTOCABLES and k != "message"),
        key=lambda k: PRIORIDAD.index(k) if k in PRIORIDAD else len(PRIORIDAD),
    )
    marcados: set[str] = set()
    for clave in orden:
        original = ev[clave]
        nuevo, cortado = recorte.valor(original, TOPES.get(clave, TOPE_CAMPO))
        if nuevo is not original:
            ev[clave] = nuevo
        if cortado:
            recortados.append(f"{clave} ({_medida(original)})")
            if isinstance(nuevo, str):
                marcados.add(clave)
    if "format" in ev and "message" not in ev:
        datos = {k: (f"{v}{MARCA}" if k in marcados else v) for k, v in ev.items()}
        try:
            ev["message"] = ev["format"] % datos
            del ev["format"]
        except (KeyError, TypeError, ValueError):
            ev["message"] = ev["format"]
    if "message" in ev:
        original = ev["message"]
        mensaje, cortado = _Recorte(TOPE_MENSAJE).valor(original, TOPE_MENSAJE)
        if cortado:
            recortados.append(f"message ({_medida(original)})")
            mensaje = f"{mensaje}{MARCA}" if isinstance(mensaje, str) else mensaje
        ev["message"] = mensaje
    if recortados:
        ev["recortado"] = cortar_texto(", ".join(recortados), TOPE_CAMPO)[0]
    return ev


# ---- Registro con tope diario ----------------------------------------------

ACCESO, ACTIVIDAD = 0, 1
# Lo que hace quien ya ha entrado (y el login que lo deja entrar): tiene su
# propia parte del registro, para que una lluvia de intentos de acceso no lo
# tape. El resto (conexiones, cliente, cifrado, contraseñas rechazadas...) es
# acceso.
_PREFIJOS_ACTIVIDAD = (
    "cowrie.login.success",
    "cowrie.command.",
    "cowrie.session.file_",
    "cowrie.session.input",
    "cowrie.direct-tcpip.",
    "cowrie.tunnelproxy-tcpip.",
    "cowrie.telnet.exploit",
)

LOG_FULL = "cowrie.sugardaddy.log_full"
LOG_DROPPED = "cowrie.sugardaddy.log_dropped"


def clase_de(eventid: Any) -> int:
    if isinstance(eventid, str) and eventid.startswith(_PREFIJOS_ACTIVIDAD):
        return ACTIVIDAD
    return ACCESO


def clave_ip(ip: Any) -> str | None:
    """La clave de cupo de un origen: la IPv4, o la /64 de una IPv6 (quien
    tiene una IPv6 suele tener la /64 entera). None si no es una IP."""
    try:
        dir_ip = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return None
    if isinstance(dir_ip, ipaddress.IPv6Address):
        if dir_ip.ipv4_mapped:
            return str(dir_ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{dir_ip}/64", strict=False))
    return str(dir_ip)


class Cupos:
    """Quién puede escribir todavía en el cowrie.json de hoy.

    Un atacante no puede dejar sin registro a los demás, así que el tope del
    día (``tope`` bytes) se reparte:

    * Cada origen (una IPv4 o una /64) puede gastar al día ``cuota_ip`` del
      tope en accesos y otro tanto en actividad (ver ``clase_de``).
    * Los accesos de todos juntos, como mucho ``parte_accesos`` de la parte
      común: el resto queda para lo que pasa tras entrar.
    * Con la parte común llena, un origen que hoy aún no ha escrito nada tiene
      ``nuevo_ip`` bytes de una reserva (``reserva_nuevos`` del tope): una
      sesión con su login y unas decenas de comandos.
    * Los resúmenes y avisos van en la parte común mientras quepan, y si no,
      en su propia reserva (``reserva_sistema``), que nada más usa.

    Cada parte tiene su tope y entre todas suman ``tope``: el fichero del día
    no pasa de ahí. Se cuentan como mucho ``max_ips`` orígenes: los demás
    comparten una sola cuota, así que una lluvia de orígenes no gasta memoria.
    """

    def __init__(
        self,
        tope: int,
        *,
        cuota_ip: float = 0.04,
        parte_accesos: float = 0.6,
        reserva_nuevos: float = 0.04,
        nuevo_ip: int = 16384,
        reserva_sistema: float = 0.02,
        max_ips: int = 16384,
    ) -> None:
        self.tope = max(0, int(tope))
        self.cuota_ip = int(self.tope * cuota_ip)
        self.tope_nuevos = int(self.tope * reserva_nuevos)
        self.tope_sistema = int(self.tope * reserva_sistema)
        self.tope_comun = self.tope - self.tope_nuevos - self.tope_sistema
        self.tope_accesos = int(self.tope_comun * parte_accesos)
        self.nuevo_ip = nuevo_ip
        self.max_ips = max_ips
        self.nuevo_dia(0)

    def nuevo_dia(self, usado: int) -> None:
        """Empieza un día con ``usado`` bytes ya en el fichero (un reinicio
        sobre lo que este registro escribió hoy). No se sabe de quién eran:
        cuentan primero en la parte común (y en la de accesos, para no
        quitarle sitio a la actividad), después en la reserva de orígenes
        nuevos y solo lo que pase de ahí en la de avisos, que así no pierde
        más de lo que ya hubiera gastado."""
        self.usado = max(0, int(usado))
        self.comun = min(self.usado, self.tope_comun)
        self.accesos = min(self.usado, self.tope_accesos)
        self.nuevos = min(self.usado - self.comun, self.tope_nuevos)
        self.sist = min(self.usado - self.comun - self.nuevos, self.tope_sistema)
        # clave -> [accesos, actividad, de la reserva de nuevos]
        self.por_ip: dict[str, list[int]] = {}

    def _de(self, clave: str | None) -> tuple[str | None, list[int]]:
        if clave is None:
            return None, [0, 0, 0]
        if clave not in self.por_ip and len(self.por_ip) >= self.max_ips:
            clave = "*"
        return clave, self.por_ip.get(clave) or [0, 0, 0]

    def decidir(self, clave: str | None, clase: int, n: int) -> str | None:
        """None si se puede escribir (y queda contado), o por qué no:
        cupo_ip, cupo_accesos o registro_lleno."""
        if not self.tope:
            return None
        clave, cuenta = self._de(clave)
        if clave is not None and cuenta[clase] + n > self.cuota_ip:
            return "cupo_ip"
        comun_ok = self.comun + n <= self.tope_comun
        if comun_ok and (clase != ACCESO or self.accesos + n <= self.tope_accesos):
            self.comun += n
            if clase == ACCESO:
                self.accesos += n
            cuenta[clase] += n
        elif (
            clave not in (None, "*")
            and cuenta[0] == cuenta[1] == 0
            and cuenta[2] + n <= self.nuevo_ip
            and self.nuevos + n <= self.tope_nuevos
        ):
            self.nuevos += n
            cuenta[2] += n
        else:
            return "registro_lleno" if not comun_ok else "cupo_accesos"
        if clave is not None:
            self.por_ip[clave] = cuenta
        self.usado += n
        return None

    def sistema(self, n: int) -> bool:
        """Sitio para una línea de resumen o aviso (y queda contada): en la
        parte común si cabe, para guardar la reserva de avisos para cuando se
        llene."""
        if not self.tope:
            pass
        elif self.comun + n <= self.tope_comun:
            self.comun += n
        elif self.sist + n <= self.tope_sistema:
            self.sist += n
        else:
            return False
        self.usado += n
        return True


class Omitidos:
    """Lo que se calla, contado para una línea de resumen por periodo. La
    primera tras un rato sin nada sale enseguida; después, una por periodo
    como mucho. Se cuentan una a una como mucho ``max_ips`` IP."""

    def __init__(self, periodo: float = 60.0, max_ips: int = 1024, max_eventos: int = 32) -> None:
        self.periodo = periodo
        self.max_ips = max_ips
        self.max_eventos = max_eventos
        self.ultimo = float("-inf")
        self._vaciar()

    def _vaciar(self) -> None:
        self.total = 0
        self.motivos: dict[str, int] = {}
        self.eventos: dict[str, int] = {}
        self.ips: dict[str, int] = {}
        self.sin_contar = 0

    def contar(self, ip: str | None, motivo: str, eventid: str | None) -> None:
        self.total += 1
        self.motivos[motivo] = self.motivos.get(motivo, 0) + 1
        if eventid and (eventid in self.eventos or len(self.eventos) < self.max_eventos):
            self.eventos[eventid] = self.eventos.get(eventid, 0) + 1
        ip = ip or ""
        if ip in self.ips or len(self.ips) < self.max_ips:
            self.ips[ip] = self.ips.get(ip, 0) + 1
        else:
            self.sin_contar += 1

    def toca(self, ahora: float) -> bool:
        return self.total > 0 and ahora - self.ultimo >= self.periodo

    def sacar(self, ahora: float) -> dict[str, Any]:
        mas, n = "", 0
        for ip, c in self.ips.items():
            if c > n or (c == n and ip < mas):
                mas, n = ip, c
        out: dict[str, Any] = {
            "message": f"{self.total} eventos sin apuntar en cowrie.json por el tope del registro",
            "omitidos": self.total,
        }
        for motivo, c in sorted(self.motivos.items()):
            out[f"por_{motivo}"] = c
        if mas:
            out["src_ip"] = mas
        out["de_su_ip"] = n
        out["ips_distintas"] = len(self.ips)
        if self.sin_contar:
            out["ips_sin_contar"] = self.sin_contar
        if self.eventos:
            eventos = sorted(self.eventos.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
            out["eventos"] = ", ".join(f"{k} {c}" for k, c in eventos)
        out["periodo_s"] = int(self.periodo)
        self.ultimo = ahora
        self._vaciar()
        return out


AVISOS = {
    "cupo_accesos": (
        "accesos",
        "los intentos de acceso de hoy ya han gastado su parte del registro: hasta "
        "mañana (UTC) solo se apunta lo que pasa tras entrar, lo primero de cada "
        "origen nuevo y un resumen de lo demás",
    ),
    "registro_lleno": (
        "registro",
        "registro de hoy lleno: hasta mañana (UTC) solo se apunta lo primero de "
        "cada origen nuevo y un resumen de lo demás",
    ),
}


def _hora(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _dia(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def _ocupado(st: os.stat_result) -> int:
    """Lo que ocupa de verdad un fichero: el de una versión anterior pudo
    quedar disperso (el sensor lo vació mientras Cowrie escribía sin
    O_APPEND)."""
    return min(st.st_size, st.st_blocks * 512)


class RegistroDiario:
    """cowrie.json para el sensor de Sugardaddy.

    * Nombre fijo y abierto con O_APPEND: si el sensor lo vacía, lo siguiente
      se escribe al principio (sin dejar un fichero disperso). Al cambiar el
      día (UTC) se renombra a ``<ruta>.AAAA-MM-DD`` (el día que guarda, con
      ``.N`` si ese nombre ya existe) y se empieza otro. Aquí no se borra
      nada: el sensor poda los rotados cuando los ha leído.
    * Como mucho ``tope`` bytes por día, repartidos por origen (``Cupos``).
      Lo que se calla se resume (``Omitidos``) y cada parte que se llena deja
      una línea de aviso. ``tope`` 0: sin tope.
    * Tras un reinicio, lo que ya hay hoy en cowrie.json cuenta para el tope
      solo si lo empezó este registro: lo dice ``marca`` (``.<nombre>.sugardaddy``
      junto a él, que no empieza como el registro para que el sensor no lo
      tome por un rotado). Si no, lo ha dejado otra imagen sin tope (la
      pública, antes del relevo) y se aparta como un rotado de hoy: si no, la
      trampa se quedaría callada, sin ningún aviso, hasta medianoche.
    * Cada línea se escribe de una vez; si una escritura se queda a medias
      (disco lleno), la siguiente empieza en una línea nueva.
    """

    def __init__(
        self,
        ruta: str,
        tope: int,
        *,
        base: dict[str, Any] | None = None,
        reloj: Callable[[], float] = time.time,
        periodo: float = 60.0,
        **cupos: Any,
    ) -> None:
        self.ruta = ruta
        carpeta, nombre = os.path.split(ruta)
        self.marca = os.path.join(carpeta, f".{nombre}.sugardaddy")
        self.tope = max(0, int(tope))
        self.base = dict(base or {})
        self.reloj = reloj
        self.cupos = Cupos(self.tope, **cupos)
        self.omitidos = Omitidos(periodo)
        self.cerrojo = threading.Lock()
        self.fd: int | None = None
        self.cerrado = False
        self.a_medias = False
        self.dia = ""
        self.avisado: set[str] = set()
        self._abrir(reloj())

    def _abrir_fd(self) -> int:
        return os.open(self.ruta, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC, 0o664)

    def _abrir(self, ahora: float) -> None:
        hoy = _dia(ahora)
        self.fd = self._abrir_fd()
        st = os.fstat(self.fd)
        self.avisado = set()
        # Tras un reinicio, un fichero con algo es del día en que se escribió:
        # si fue ayer, el primer evento de hoy lo rota.
        self.dia = _dia(st.st_mtime) if st.st_size else hoy
        if self.dia != hoy or not self.tope:
            self.cupos.nuevo_dia(0)
            return
        usado = _ocupado(st)
        if not st.st_size:
            self._marcar(st.st_ino, hoy)
        elif not self._es_mio(st, usado, hoy):
            # Lo de hoy lo ha escrito otro: la imagen sin tope de antes del
            # relevo, sobre la misma carpeta. No cuenta para este tope: se
            # aparta como un rotado de hoy (el sensor lo lee y lo poda como
            # cualquiera) y el día empieza de cero.
            self._cerrar_fd()
            apartado = self._apartar(hoy)
            try:
                self.fd = self._abrir_fd()
            except OSError:
                apartado = False  # _escribir lo vuelve a intentar
            if not apartado:
                # Se sigue detrás, contando solo lo de este registro (y sin
                # marca: el próximo arranque lo vuelve a intentar).
                self.cupos.nuevo_dia(0)
                return
            st = os.fstat(self.fd)
            usado = _ocupado(st)
            self._marcar(st.st_ino, hoy)
        self.cupos.nuevo_dia(usado)

    def _es_mio(self, st: os.stat_result, usado: int, hoy: str) -> bool:
        """Si el cowrie.json abierto (``st``) lo empezó hoy este registro, y
        nada lo ha hecho pasar del tope."""
        if usado > self.tope:
            return False
        try:
            # Sin seguir enlaces ni bloquearse en algo que no sea un fichero.
            fd = os.open(self.marca, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    return False
                inodo, dia = os.read(fd, 64).decode("ascii").split()
            finally:
                os.close(fd)
            return int(inodo) == st.st_ino and dia == hoy
        except (OSError, ValueError):
            return False

    def _marcar(self, inodo: int, dia: str) -> None:
        """Deja dicho que el cowrie.json de ``inodo`` lo empezó hoy este
        registro, para que tras un reinicio lo que tenga cuente para el tope.
        Se escribe aparte y se renombra: nunca a medias ni a través de un
        enlace."""
        tmp = f"{self.marca}.tmp"
        try:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
            try:
                os.write(fd, f"{inodo} {dia}\n".encode("ascii"))
            finally:
                os.close(fd)
            os.replace(tmp, self.marca)
        except OSError:
            pass  # sin marca, un reinicio de hoy lo apartaría: se pierde tope, no eventos

    def _apartar(self, dia: str) -> bool:
        """Renombra cowrie.json, si tiene algo, a ``<ruta>.<dia>`` (con ``.N``
        si ese nombre ya existe), que el sensor lee y poda como rotado. True
        si lo ha renombrado."""
        try:
            if os.path.getsize(self.ruta) == 0:
                return False
            destino, n = f"{self.ruta}.{dia}", 1
            while os.path.lexists(destino):
                destino, n = f"{self.ruta}.{dia}.{n}", n + 1
            os.rename(self.ruta, destino)
            return True
        except OSError:
            return False

    def _rotar(self, ahora: float) -> None:
        self._cerrar_fd()
        # Si no se puede, se sigue escribiendo en el mismo: no se pierde nada.
        self._apartar(self.dia)
        try:
            self._abrir(ahora)
        except OSError:
            self.fd = None
        self.dia = _dia(ahora)
        self.cupos.nuevo_dia(0)
        self.avisado = set()

    def _cerrar_fd(self) -> None:
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None

    def _escribir(self, datos: bytes) -> bool:
        if self.fd is None and not self.cerrado:
            try:  # no se pudo abrir al rotar: se vuelve a intentar
                self.fd = self._abrir_fd()
            except OSError:
                return False
        if self.fd is None:
            return False
        if self.a_medias:
            datos = b"\n" + datos
        vista = memoryview(datos)
        try:
            while vista:
                vista = vista[os.write(self.fd, vista) :]
        except OSError:
            self.a_medias = len(vista) < len(datos)
            return False
        self.a_medias = False
        return True

    def _linea(self, ahora: float, eventid: str, campos: dict[str, Any]) -> bytes:
        ev = {"eventid": eventid, **campos, **self.base, "timestamp": _hora(ahora)}
        return (json.dumps(ev, separators=(",", ":")) + "\n").encode("ascii", "backslashreplace")

    def _sistema(self, ahora: float, eventid: str, campos: dict[str, Any]) -> None:
        datos = self._linea(ahora, eventid, campos)
        if self.cupos.sistema(len(datos)):
            self._escribir(datos)

    def _al_dia(self, ahora: float) -> None:
        if _dia(ahora) != self.dia:
            self._rotar(ahora)

    def _resumen(self, ahora: float, siempre: bool = False) -> None:
        if self.omitidos.toca(ahora) or (siempre and self.omitidos.total):
            self._sistema(ahora, LOG_DROPPED, self.omitidos.sacar(ahora))

    def apuntar(self, linea: str, evento: dict[str, Any]) -> bool:
        """Escribe la línea de un evento si cabe; si no, la cuenta para el
        resumen. True si se ha escrito."""
        with self.cerrojo:
            ahora = self.reloj()
            self._al_dia(ahora)
            datos = (linea + "\n").encode("utf-8", "backslashreplace")
            eventid = evento.get("eventid")
            ip = evento.get("src_ip")
            motivo = self.cupos.decidir(clave_ip(ip), clase_de(eventid), len(datos))
            if motivo is None:
                return self._escribir(datos)
            self.omitidos.contar(
                cortar_texto(str(ip), 64)[0] if ip else None,
                motivo,
                cortar_texto(str(eventid), 64)[0] if eventid else None,
            )
            if motivo in AVISOS and motivo not in self.avisado:
                self.avisado.add(motivo)
                lleno, aviso = AVISOS[motivo]
                self._sistema(
                    ahora,
                    LOG_FULL,
                    {"message": aviso, "lleno": lleno, "tope_bytes": self.tope, "aviso": aviso},
                )
            self._resumen(ahora)
            return False

    def tick(self, ahora: float | None = None) -> None:
        """Cada pocos segundos: escribe el resumen pendiente si ya toca."""
        with self.cerrojo:
            ahora = self.reloj() if ahora is None else ahora
            self._al_dia(ahora)
            self._resumen(ahora)

    def close(self) -> None:
        """Escribe lo que quede por resumir y cierra."""
        with self.cerrojo:
            if self.fd is not None:
                ahora = self.reloj()
                self._al_dia(ahora)
                self._resumen(ahora, siempre=True)
            self.cerrado = True
            self._cerrar_fd()
