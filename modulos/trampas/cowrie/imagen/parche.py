"""El parche de Sugardaddy sobre el Cowrie fijado en preparar.sh.

Se ejecuta en la raíz del código de Cowrie, con src/cowrie/core/sugardaddy.py
y sd-pruebas/ ya copiados. Cada cambio comprueba que el código es el
esperado: si Cowrie cambia, falla aquí en vez de dejar algo a medias.

1. Fuera todo lo de JA4+ con licencia FoxIO 1.1 (no comercial). Se queda JA4
   (huella TLS del cliente), que es BSD-3-Clause; se van JA4H y lo que
   dependía de las constantes de FoxIO, que se escriben aquí desde sus
   fuentes públicas.
2. Lo que apunta del atacante, con tope (ver sugardaddy.py): cada valor
   recortado antes de llegar a cualquier salida, también en message, y
   cowrie.json con tope diario de bytes por origen y total, con sus líneas de
   aviso y resumen. escape_nonprintable, igual pero sin un bucle de Python
   por byte (era lo más caro de un intento con una contraseña enorme).
3. Las pruebas del parche corren al construir la imagen: si una falla, no hay
   imagen.
"""

from pathlib import Path


def cambiar(ruta: str, viejo: str, nuevo: str) -> None:
    p = Path(ruta)
    s = p.read_text()
    assert s.count(viejo) == 1, f"{ruta}: no se encuentra el código esperado:\n{viejo[:200]}"
    p.write_text(s.replace(viejo, nuevo))


def quitar_bloques_http(ruta: str, esperados: int) -> None:
    """Quita las ramas «# Check for HTTP request / elif (...)» que calculan JA4H."""
    p = Path(ruta)
    lineas = p.read_text().split("\n")
    salida, i, n = [], 0, 0
    while i < len(lineas):
        if lineas[i] == "        # Check for HTTP request" and lineas[i + 1] == "        elif (":
            n += 1
            if salida and not salida[-1].strip():
                salida.pop()
            i += 2
            while lineas[i] != "        ):":
                i += 1
            i += 1
            while i < len(lineas) and (not lineas[i].strip() or len(lineas[i]) - len(lineas[i].lstrip()) > 8):
                i += 1
            salida.append("")
            continue
        salida.append(lineas[i])
        i += 1
    assert n == esperados, f"{ruta}: {n} bloques HTTP, se esperaban {esperados}"
    p.write_text("\n".join(salida))


FP = "src/cowrie/core/fingerprint.py"
cambiar(
    FP,
    "# ABOUTME: JA4 and JA4H fingerprinting for TLS and HTTP traffic\n"
    "# ABOUTME: Parses TLS Client Hello and HTTP requests to generate fingerprints\n",
    "# ABOUTME: JA4 fingerprinting for TLS traffic\n"
    "# ABOUTME: Parses TLS Client Hello messages to generate fingerprints\n",
)
cambiar(
    FP,
    """This module provides network fingerprinting capabilities based on the JA4+ suite
developed by FoxIO:

- JA4: TLS client fingerprinting from Client Hello messages
- JA4H: HTTP client fingerprinting from request headers
""",
    """This module provides JA4 TLS client fingerprinting (BSD-3-Clause) from Client
Hello messages.

Sugardaddy build: the rest of the JA4+ suite (JA4H, JA4X, JA4SSH...) is under
the FoxIO License 1.1, which does not allow commercial use, so it is not here.
""",
)
cambiar(
    FP,
    """from twisted.logger import Logger

from cowrie.vendor.ja4.common import GREASE_TABLE, TLS_MAPPER, sha_encode

_log = Logger()

# Convert FoxIO's string-based GREASE table to integer set for our use
GREASE_VALUES = {int(k, 16) for k in GREASE_TABLE}

# Convert FoxIO's string-based TLS mapper to integer keys
TLS_VERSION_MAP = {int(k, 16): v for k, v in TLS_MAPPER.items()}
""",
    """from hashlib import sha256

from twisted.logger import Logger

_log = Logger()

# GREASE values reserved by RFC 8701: 0x0a0a, 0x1a1a, ... 0xfafa
GREASE_VALUES = {0x0A0A + 0x1010 * i for i in range(16)}

# TLS protocol versions as written in a JA4 fingerprint
TLS_VERSION_MAP = {
    0x0002: "s2",
    0x0300: "s3",
    0x0301: "10",
    0x0302: "11",
    0x0303: "12",
    0x0304: "13",
}


def sha_encode(values: list[str] | str) -> str:
    \"\"\"First 12 hex characters of the SHA-256 of the comma-joined values.\"\"\"
    text = ",".join(values) if isinstance(values, list) else values
    return sha256(text.encode("utf8")).hexdigest()[:12]
""",
)
s = Path(FP).read_text()
a, b = s.index("\ndef parse_http_request("), s.index("\ndef generate_ja4(")
s = s[:a] + "\n" + s[b:]
s = s[: s.index("\ndef generate_ja4h(")].rstrip("\n") + "\n"
Path(FP).write_text(s)

for ruta, bloques in [
    ("src/cowrie/ssh/forwarding.py", 2),
    ("src/cowrie/ssh_proxy/protocols/port_forward.py", 1),
]:
    cambiar(
        ruta,
        """from cowrie.core.fingerprint import (
    generate_ja4,
    generate_ja4h,
    parse_http_request,
    parse_tls_client_hello,
)""",
        "from cowrie.core.fingerprint import generate_ja4, parse_tls_client_hello",
    )
    quitar_bloques_http(ruta, bloques)
cambiar(
    "src/cowrie/ssh_proxy/protocols/port_forward.py",
    "Parse forwarded traffic and generate JA4/JA4H fingerprints.",
    "Parse forwarded traffic and generate JA4 fingerprints.",
)
cambiar("src/cowrie/core/eventids.py", '        "cowrie.direct-tcpip.ja4h",\n', "")

doc = Path("docs/OUTPUT.rst")
s = doc.read_text()
a, b = s.index("cowrie.direct-tcpip.ja4h\n========================\n"), s.index("cowrie.direct-tcpip.redirect\n")
doc.write_text(s[:a] + s[b:])
print("JA4H y las constantes de FoxIO, fuera")

# ---- 2. Lo que apunta del atacante, con tope ---------------------------------

assert Path("src/cowrie/core/sugardaddy.py").is_file(), "falta src/cowrie/core/sugardaddy.py (lo copia preparar.sh)"

EV = "src/cowrie/core/events.py"
cambiar(
    EV,
    "from cowrie.core.output import convert\n",
    "from cowrie.core.output import convert\nfrom cowrie.core.sugardaddy import recortar_evento\n",
)
# El único sitio por el que pasa cada evento antes de cualquier salida
# (cowrie.json, el registro de diagnóstico): se recorta ahí, y message se
# compone con los valores ya recortados (recortar_evento lo hace como Cowrie).
cambiar(
    EV,
    """        if "format" in ev and "message" not in ev:
            try:
                ev["message"] = ev["format"] % ev
                del ev["format"]
            except (KeyError, TypeError, ValueError):
                ev["message"] = ev["format"]
""",
    """        # Sugardaddy: lo que viene del atacante, recortado antes de llegar a
        # cualquier salida, y message compuesto con los valores ya recortados.
        recortar_evento(ev)
""",
)

JL = "src/cowrie/output/jsonlog.py"
cambiar(
    JL,
    """import json
import os
from pathlib import Path

from twisted.logger import Logger

import cowrie.core.output
import cowrie.python.logfile
from cowrie.core.config import CowrieConfig
""",
    """import json

from twisted.internet import task
from twisted.logger import Logger

import cowrie.core.output
from cowrie.core.config import CowrieConfig
from cowrie.core.sugardaddy import RegistroDiario
""",
)
cambiar(
    JL,
    """        fn = CowrieConfig.get("output_jsonlog", "logfile", fallback="cowrie.json")
        dirs = os.path.dirname(fn)
        base = os.path.basename(fn)

        logtype = CowrieConfig.get("honeypot", "logtype", fallback="plain")
        if logtype == "rotating":
            self.outfile = cowrie.python.logfile.CowrieDailyLogFile(
                base, dirs, defaultMode=0o664
            )
        elif logtype == "plain":
            self.outfile = open(Path(dirs, base), "a", encoding="utf-8")
        else:
            raise ValueError

    def stop(self):
        if self.outfile:
            self.outfile.flush()
""",
    """        fn = CowrieConfig.get("output_jsonlog", "logfile", fallback="cowrie.json")
        # Sugardaddy: tope diario de bytes repartido por origen, y rotación
        # diaria propia con O_APPEND (cowrie.core.sugardaddy). logtype no
        # cuenta aquí: con el tope, cowrie.json siempre rota a diario.
        self.outfile = RegistroDiario(
            fn,
            CowrieConfig.getint("output_jsonlog", "max_bytes_day", fallback=0),
            base={"sensor": self.sensor, "uuid": self.uuid},
        )
        # El resumen de lo que se calla sale aunque no lleguen más eventos.
        self.resumen = task.LoopingCall(self.outfile.tick)
        self.resumen.start(5, now=False)

    def stop(self):
        if self.resumen.running:
            self.resumen.stop()
        self.outfile.close()
""",
)
cambiar(
    JL,
    """        try:
            # Serialize to a string first and write the line in one call: a
            # rotating logfile checks for rotation on every write, so chunked
            # writes could rotate mid-event and split the line across files.
            self.outfile.write(json.dumps(event, separators=(",", ":")) + "\\n")
            self.outfile.flush()
        except TypeError:
            self._log.error("jsonlog: Can't serialize: '{event!r}'", event=event)
""",
    """        try:
            linea = json.dumps(event, separators=(",", ":"))
        except TypeError:
            self._log.error("jsonlog: Can't serialize: '{event!r}'", event=event)
            return
        # Una línea de una vez, si cabe en el tope; si no, cuenta para el resumen.
        self.outfile.apuntar(linea, event)
""",
)
# Su prueba mira las tripas del fichero rotativo de Twisted, que jsonlog ya no
# usa; lo que comprobaba (una línea nunca se parte al rotar) lo comprueba
# sd-pruebas/test_sugardaddy.py.
prueba_jsonlog = Path("src/cowrie/test/test_jsonlog.py")
assert "logfile.lastDate" in prueba_jsonlog.read_text(), f"{prueba_jsonlog}: no es la prueba esperada"
prueba_jsonlog.unlink()

cambiar(
    "src/cowrie/data/etc/cowrie.cfg.dist",
    """[output_jsonlog]
enabled = true
logfile = ${honeypot:log_path}/cowrie.json
epoch_timestamp = false
""",
    """[output_jsonlog]
enabled = true
logfile = ${honeypot:log_path}/cowrie.json
epoch_timestamp = false
# Sugardaddy: bytes que puede escribir cowrie.json al día (UTC), repartidos
# por origen; lo que no cabe se resume en una línea por minuto. 0: sin tope.
# Rota a diario (cowrie.json.AAAA-MM-DD) sea cual sea logtype.
max_bytes_day = 52428800
""",
)

cambiar(
    "src/cowrie/core/utils.py",
    '''    out: list[str] = []
    for b in data:
        if b == 0x5C:  # backslash
            out.append("\\\\\\\\")
        elif 0x20 <= b <= 0x7E:
            out.append(chr(b))
        else:
            out.append(f"\\\\x{b:02x}")
    return "".join(out)
''',
    '''    # Sugardaddy: lo mismo con str.translate, sin un bucle de Python por
    # byte (con contraseñas de cientos de KB era lo más caro del intento).
    return bytes(data).decode("latin-1").translate(_ESCAPE_NONPRINTABLE)


_ESCAPE_NONPRINTABLE = {
    b: "\\\\\\\\" if b == 0x5C else chr(b) if 0x20 <= b <= 0x7E else f"\\\\x{b:02x}"
    for b in range(256)
}
''',
)
print("Recorte de lo que viene del atacante y tope diario de cowrie.json, dentro")

# ---- 3. Las pruebas, al construir --------------------------------------------

assert Path("sd-pruebas/test_sugardaddy.py").is_file(), "faltan sd-pruebas/ (las copia preparar.sh)"
cambiar(
    "docker/Dockerfile",
    "COPY --chown=${COWRIE_USER}:${COWRIE_GROUP} . ${COWRIE_HOME}/cowrie-git\n",
    """COPY --chown=${COWRIE_USER}:${COWRIE_GROUP} . ${COWRIE_HOME}/cowrie-git

# Sugardaddy: las pruebas del parche, y las de Cowrie de lo que toca, corren
# aquí con las mismas dependencias: si una falla, no hay imagen. No pasan a la
# imagen final.
RUN cd ${COWRIE_HOME}/cowrie-git && \\
    PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 ${COWRIE_HOME}/cowrie-env/bin/python3 -m unittest \\
      discover -q -s sd-pruebas -t sd-pruebas && \\
    PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 ${COWRIE_HOME}/cowrie-env/bin/python3 -m unittest -q \\
      cowrie.test.test_events cowrie.test.test_checkers cowrie.test.test_utils \\
      cowrie.test.test_attacker_bytes cowrie.test.test_eventids cowrie.test.test_output_lifecycle \\
      cowrie.test.test_command_input_events cowrie.test.test_shell_events cowrie.test.test_forwarding_events && \\
    rm -rf sd-pruebas
""",
)
print("Pruebas del parche al construir la imagen")
