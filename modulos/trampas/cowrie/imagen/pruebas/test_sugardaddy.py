# Pruebas del parche de Sugardaddy sobre Cowrie. preparar.sh las copia a
# sd-pruebas/ y corren al construir la imagen (docker/Dockerfile, etapa
# builder), con PYTHONPATH=src:
#
#   python3 -m unittest discover -s sd-pruebas -t sd-pruebas

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from typing import Any
from unittest import mock

os.environ.setdefault("COWRIE_HONEYPOT_DATA_PATH", "data")
os.environ.setdefault("COWRIE_SHELL_FILESYSTEM", "src/cowrie/data/fs.pickle")

from cowrie.core import sugardaddy as sd  # noqa: E402

DIA = 1_792_000_000.0  # 2026-10-14 17:46:40 UTC
MEDIODIA = 1_791_979_200.0  # 2026-10-14 12:00:00 UTC


def en_json(v: Any) -> int:
    """Bytes que ocupa un valor en cowrie.json, sin comillas."""
    return len(json.dumps(v)) - 2


def login(password: str, username: str = "admin", ip: str = "203.0.113.9") -> dict[str, Any]:
    return {
        "eventid": "cowrie.login.failed",
        "format": "login attempt [%(username)s/%(password)s] failed",
        "username": username,
        "password": password,
        "session": "a1b2c3d4e5f6",
        "src_ip": ip,
        "protocol": "ssh",
    }


class Reloj:
    def __init__(self, t: float = DIA) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


# ---- Recorte ------------------------------------------------------------------


class RecorteTests(unittest.TestCase):
    def test_contrasena_de_100_kb_se_recorta_a_256_bytes_con_marca(self) -> None:
        ev = sd.recortar_evento(login("A" * 102400))
        self.assertEqual(ev["password"], "A" * 256)
        self.assertEqual(ev["recortado"], "password (102400 bytes)")
        # message, con lo ya recortado y la marca detrás.
        self.assertEqual(ev["message"], f"login attempt [admin/{'A' * 256}{sd.MARCA}] failed")
        self.assertNotIn("format", ev)
        self.assertLess(len(json.dumps(ev)), 1024)

    def test_usuario_enorme_se_recorta_a_256_bytes(self) -> None:
        ev = sd.recortar_evento(login("x", username="u" * 300000))
        self.assertEqual(ev["username"], "u" * 256)
        self.assertEqual(ev["recortado"], "username (300000 bytes)")
        self.assertIn("u" * 256 + sd.MARCA, ev["message"])

    def test_comando_se_recorta_a_4_kb(self) -> None:
        ev = sd.recortar_evento(
            {"eventid": "cowrie.command.input", "format": "CMD: %(input)s", "input": "echo " + "x" * 200000}
        )
        self.assertEqual(en_json(ev["input"]), 4096)
        self.assertEqual(ev["message"], "CMD: " + ev["input"] + sd.MARCA)
        self.assertEqual(ev["recortado"], "input (200005 bytes)")

    def test_cualquier_campo_del_atacante_tiene_tope(self) -> None:
        ev = sd.recortar_evento(
            {
                "eventid": "cowrie.direct-tcpip.data",
                "format": "to %(dst_ip)s:%(dst_port)s with data %(data)s",
                "dst_ip": "h" * 100000,
                "dst_port": 80,
                "data": repr(b"\x00" * 500000),
                "attempted_command": "c" * 50000,
                "width": 10**5000,
            }
        )
        self.assertEqual(ev["width"], "<entero de 16610 bits>")
        self.assertIn("width (16610 bits)", ev["recortado"])
        for campo in ("dst_ip", "data", "attempted_command"):
            self.assertLessEqual(en_json(ev[campo]), sd.TOPE_CAMPO, campo)
        self.assertEqual(ev["dst_port"], 80)
        self.assertIn("dst_ip (100000 bytes)", ev["recortado"])
        self.assertIn("attempted_command (50000 bytes)", ev["recortado"])
        self.assertLessEqual(en_json(ev["message"]), sd.TOPE_MENSAJE + en_json(sd.MARCA))

    def test_listas_con_tope_de_elementos_y_de_evento(self) -> None:
        enorme = ["n" * 1000] * 100000
        ev = sd.recortar_evento(
            {
                "eventid": "cowrie.client.kex",
                "format": "SSH client hassh fingerprint: %(hassh)s",
                "hassh": "0" * 32,
                "hasshAlgorithms": "k" * 300000,
                **{c: enorme for c in ("kexAlgs", "keyAlgs", "encCS", "macCS", "compCS", "langCS")},
            }
        )
        for c in ("kexAlgs", "keyAlgs", "encCS", "macCS", "compCS", "langCS"):
            self.assertLessEqual(len(ev[c]), sd.MAX_ELEMENTOS)
            self.assertTrue(all(en_json(e) <= sd.TOPE_ELEMENTO for e in ev[c]))
        self.assertIn("kexAlgs (100000 elementos)", ev["recortado"])
        # Todo el evento, acotado aunque cada campo venga al máximo.
        self.assertLess(len(json.dumps(ev)), sd.TOPE_EVENTO + sd.TOPE_MENSAJE + 1024)

    def test_el_tope_es_en_bytes_escritos_y_no_parte_caracteres(self) -> None:
        for relleno in ("\x01", "ñ", "😀", '"', "\\x00"):
            ev = sd.recortar_evento(login(relleno * 5000))
            self.assertLessEqual(en_json(ev["password"]), 256, relleno)
            self.assertGreater(en_json(ev["password"]), 256 - 12, relleno)
            self.assertTrue(set(ev["password"]) <= set(relleno), relleno)

    def test_lo_que_cabe_queda_como_en_cowrie(self) -> None:
        ev = sd.recortar_evento(login("Prueba-2026", username="root"))
        self.assertEqual(ev["password"], "Prueba-2026")
        self.assertEqual(ev["message"], "login attempt [root/Prueba-2026] failed")
        self.assertNotIn("recortado", ev)
        ev = sd.recortar_evento(
            {"eventid": "cowrie.session.closed", "format": "Connection lost after %(duration_ms)d milliseconds", "duration_ms": 1500}
        )
        self.assertEqual(ev["message"], "Connection lost after 1500 milliseconds")

    def test_sesion_y_origen_no_se_pierden_aunque_el_evento_venga_lleno(self) -> None:
        ev = login("p" * 10**6)
        ev.update({f"campo{i}": "z" * 100000 for i in range(30)})
        sd.recortar_evento(ev)
        self.assertEqual((ev["session"], ev["src_ip"], ev["eventid"]), ("a1b2c3d4e5f6", "203.0.113.9", "cowrie.login.failed"))
        self.assertLess(len(json.dumps(ev)), sd.TOPE_EVENTO + sd.TOPE_MENSAJE + 4096)

    def test_message_ya_hecho_tambien_tiene_tope(self) -> None:
        ev = sd.recortar_evento({"eventid": "cowrie.x", "message": "m" * 10**6})
        self.assertEqual(ev["message"], "m" * sd.TOPE_MENSAJE + sd.MARCA)
        self.assertEqual(ev["recortado"], "message (1000000 bytes)")

    def test_formato_que_falla_queda_como_en_cowrie(self) -> None:
        ev = sd.recortar_evento({"eventid": "cowrie.x", "format": "falta %(nada)s"})
        self.assertEqual((ev["message"], ev["format"]), ("falta %(nada)s", "falta %(nada)s"))


class DespachadorTests(unittest.TestCase):
    """El recorte va en el despachador de Cowrie: antes de cualquier salida."""

    def test_el_despachador_recorta_antes_de_las_salidas(self) -> None:
        from cowrie.core.events import ConsoleRenderer, EventDispatcher, EventLog

        vistos: list[dict[str, Any]] = []
        lineas: list[str] = []

        class Sumidero:
            def write(self, event: dict[str, Any]) -> None:
                vistos.append(event)

        despachador = EventDispatcher([Sumidero(), ConsoleRenderer(lambda m, system="-": lineas.append(m))])
        eventos = EventLog(despachador, session="s1", protocol="ssh", src_ip="198.51.100.7")
        eventos.dispatch(
            "cowrie.login.failed",
            "login attempt [%(username)s/%(password)s] failed",
            username="admin",
            password="B" * 102400,
        )
        ev = vistos[0]
        self.assertEqual(ev["password"], "B" * 256)
        self.assertEqual(ev["recortado"], "password (102400 bytes)")
        self.assertEqual(ev["src_ip"], "198.51.100.7")
        self.assertLess(len(lineas[0]), 400)
        self.assertTrue(lineas[0].endswith(f"{sd.MARCA}] failed"))


class EscapeTests(unittest.TestCase):
    def test_escape_nonprintable_da_lo_mismo_que_el_de_cowrie(self) -> None:
        from cowrie.core.utils import escape_nonprintable

        def original(data: bytes) -> str:  # el de Cowrie 3.1.2, tal cual
            out: list[str] = []
            for b in data:
                if b == 0x5C:
                    out.append("\\\\")
                elif 0x20 <= b <= 0x7E:
                    out.append(chr(b))
                else:
                    out.append(f"\\x{b:02x}")
            return "".join(out)

        muestras = [b"", bytes(range(256)), b"root\\pass\n\x1b[31m", os.urandom(4096), "contraseña".encode()]
        for m in muestras:
            self.assertEqual(escape_nonprintable(m), original(m))
        self.assertEqual(escape_nonprintable(bytearray(b"a\x00")), "a\\x00")


# ---- Registro con tope diario -------------------------------------------------


def linea(eventid: str, ip: str | None, relleno: int = 400) -> tuple[str, dict[str, Any]]:
    ev: dict[str, Any] = {"eventid": eventid, "session": "s", "relleno": "r" * relleno}
    if ip is not None:
        ev["src_ip"] = ip
    return json.dumps(ev, separators=(",", ":")), ev


class CuposTests(unittest.TestCase):
    def test_tope_por_ip_y_las_demas_siguen(self) -> None:
        c = sd.Cupos(100_000)  # 4000 bytes por origen y clase
        escritos = 0
        while c.decidir("203.0.113.9", sd.ACCESO, 100) is None:
            escritos += 100
        self.assertEqual(escritos, c.cuota_ip)
        self.assertEqual(c.decidir("203.0.113.9", sd.ACCESO, 100), "cupo_ip")
        self.assertIsNone(c.decidir("198.51.100.7", sd.ACCESO, 100))
        # La actividad de la misma IP tiene su propia cuota.
        self.assertIsNone(c.decidir("203.0.113.9", sd.ACTIVIDAD, 100))

    def test_muchos_origenes_no_gastan_memoria(self) -> None:
        c = sd.Cupos(10**9, max_ips=10)
        for i in range(5000):
            c.decidir(f"10.0.{i // 256}.{i % 256}", sd.ACCESO, 10)
        self.assertLessEqual(len(c.por_ip), 11)
        o = sd.Omitidos(max_ips=10, max_eventos=4)
        for i in range(5000):
            o.contar(f"10.1.{i // 256}.{i % 256}", "cupo_ip", f"cowrie.e{i}")
        self.assertEqual((len(o.ips), len(o.eventos), o.sin_contar), (10, 4, 4990))

    def test_clave_ip(self) -> None:
        self.assertEqual(sd.clave_ip("2001:db8:1:2::1"), sd.clave_ip("2001:db8:1:2:ffff::9"))
        self.assertNotEqual(sd.clave_ip("2001:db8:1:2::1"), sd.clave_ip("2001:db8:1:3::1"))
        self.assertEqual(sd.clave_ip("::ffff:192.0.2.1"), "192.0.2.1")
        self.assertIsNone(sd.clave_ip("no es una ip"))
        self.assertIsNone(sd.clave_ip(None))

    def test_clases(self) -> None:
        for e in ("cowrie.login.success", "cowrie.command.input", "cowrie.session.file_download", "cowrie.direct-tcpip.request"):
            self.assertEqual(sd.clase_de(e), sd.ACTIVIDAD, e)
        for e in ("cowrie.login.failed", "cowrie.session.connect", "cowrie.client.kex", None):
            self.assertEqual(sd.clase_de(e), sd.ACCESO, e)


class RegistroTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp()
        self.ruta = os.path.join(self.dir, "cowrie.json")
        self.reloj = Reloj()

    def tearDown(self) -> None:
        shutil.rmtree(self.dir)

    def registro(self, tope: int, **kw: Any) -> sd.RegistroDiario:
        r = sd.RegistroDiario(self.ruta, tope, base={"sensor": "srv", "uuid": "u"}, reloj=self.reloj, **kw)
        self.addCleanup(r.close)
        return r

    def reiniciado(self, tope: int, **kw: Any) -> sd.RegistroDiario:
        """Otro registro sobre la misma carpeta el mismo día (un reinicio de
        Cowrie): el fichero, con la hora del reloj de la prueba."""
        os.utime(self.ruta, (self.reloj.t, self.reloj.t))
        return self.registro(tope, **kw)

    def lineas(self, ruta: str | None = None) -> list[dict[str, Any]]:
        with open(ruta or self.ruta, encoding="ascii") as f:
            return [json.loads(x) for x in f.read().splitlines()]

    def test_una_ip_no_deja_sin_registro_a_las_demas(self) -> None:
        r = self.registro(1_000_000)
        for _ in range(5000):  # unos 2 MB de intentos de una sola IP
            r.apuntar(*linea("cowrie.login.failed", "203.0.113.9"))
        self.reloj.t += 1
        self.assertTrue(r.apuntar(*linea("cowrie.login.failed", "198.51.100.7")))
        self.assertTrue(r.apuntar(*linea("cowrie.login.success", "198.51.100.7")))
        self.assertTrue(r.apuntar(*linea("cowrie.command.input", "198.51.100.7")))
        # Y la que inunda, tras gastar sus accesos, aún puede apuntar lo que hace dentro.
        self.assertTrue(r.apuntar(*linea("cowrie.login.success", "203.0.113.9")))
        with open(self.ruta, "rb") as f:
            bytes_de_la_primera = sum(
                len(x) for x in f if b'"src_ip":"203.0.113.9"' in x and b'"eventid":"cowrie.login.failed"' in x
            )
        self.assertLessEqual(bytes_de_la_primera, r.cupos.cuota_ip)
        self.assertGreater(bytes_de_la_primera, r.cupos.cuota_ip - 1000)
        self.assertLessEqual(os.path.getsize(self.ruta), 1_000_000)

    def test_tope_total_con_aviso_y_reserva_para_origenes_nuevos(self) -> None:
        tope = 200_000
        r = self.registro(tope)
        for i in range(3000):  # 40 IP a la vez llenan la parte común
            r.apuntar(*linea("cowrie.command.input", f"10.0.0.{i % 40}"))
        self.assertLessEqual(os.path.getsize(self.ruta), tope)
        avisos = [x for x in self.lineas() if x["eventid"] == sd.LOG_FULL]
        self.assertEqual([a["lleno"] for a in avisos], ["registro"])
        self.assertEqual((avisos[0]["tope_bytes"], avisos[0]["sensor"]), (tope, "srv"))
        self.assertTrue(avisos[0]["timestamp"].endswith("Z"))
        # Una IP que ya ha escrito hoy no entra; una nueva, sí (lo primero).
        self.assertFalse(r.apuntar(*linea("cowrie.command.input", "10.0.0.1")))
        self.assertTrue(r.apuntar(*linea("cowrie.session.connect", "192.0.2.50")))
        self.assertTrue(r.apuntar(*linea("cowrie.login.success", "192.0.2.50")))
        # La reserva tiene tope por origen y total.
        while r.apuntar(*linea("cowrie.command.input", "192.0.2.50")):
            pass
        self.assertLessEqual(r.cupos.por_ip["192.0.2.50"][2], r.cupos.nuevo_ip)
        # Por mucho que siga (también desde miles de IP), el fichero no pasa del tope.
        for i in range(3000):
            r.apuntar(*linea("cowrie.command.input", f"172.16.{i // 250}.{i % 250}"))
        self.assertLessEqual(r.cupos.nuevos, r.cupos.tope_nuevos)
        r.close()
        self.assertLessEqual(os.path.getsize(self.ruta), tope)
        self.assertEqual(len([x for x in self.lineas() if x["eventid"] == sd.LOG_FULL]), 1)

    def test_los_accesos_no_tapan_la_actividad(self) -> None:
        r = self.registro(200_000)
        for i in range(3000):
            r.apuntar(*linea("cowrie.login.failed", f"10.0.{i // 250}.{i % 250}"))
        avisos = [x for x in self.lineas() if x["eventid"] == sd.LOG_FULL]
        self.assertEqual([a["lleno"] for a in avisos], ["accesos"])
        self.assertTrue(r.apuntar(*linea("cowrie.login.success", "10.0.0.7")))
        self.assertTrue(r.apuntar(*linea("cowrie.command.input", "10.0.0.7")))
        self.assertFalse(r.apuntar(*linea("cowrie.login.failed", "10.0.0.7")))

    def test_lo_que_se_calla_se_resume_una_vez_por_minuto(self) -> None:
        r = self.registro(100_000)
        for _ in range(200):
            r.apuntar(*linea("cowrie.login.failed", "203.0.113.9"))
        resumenes = [x for x in self.lineas() if x["eventid"] == sd.LOG_DROPPED]
        self.assertEqual(len(resumenes), 1)  # el primero, enseguida
        self.assertEqual((resumenes[0]["omitidos"], resumenes[0]["por_cupo_ip"]), (1, 1))
        self.assertEqual((resumenes[0]["src_ip"], resumenes[0]["periodo_s"]), ("203.0.113.9", 60))
        escritos = len([x for x in self.lineas() if x["eventid"] == "cowrie.login.failed"])
        self.reloj.t += 30
        r.tick()
        self.assertEqual(len([x for x in self.lineas() if x["eventid"] == sd.LOG_DROPPED]), 1)
        self.reloj.t += 30
        r.tick()  # sin más eventos: sale igual
        resumenes = [x for x in self.lineas() if x["eventid"] == sd.LOG_DROPPED]
        self.assertEqual(len(resumenes), 2)
        self.assertEqual(resumenes[1]["omitidos"], 200 - escritos - 1)
        self.assertEqual(resumenes[1]["eventos"], f"cowrie.login.failed {200 - escritos - 1}")
        r.apuntar(*linea("cowrie.login.failed", "203.0.113.9"))
        r.close()  # al cerrar, lo pendiente
        self.assertEqual(self.lineas()[-1]["omitidos"], 1)

    def test_rota_cada_dia_y_el_tope_vuelve_a_empezar(self) -> None:
        r = self.registro(100_000)
        for _ in range(200):
            r.apuntar(*linea("cowrie.login.failed", "203.0.113.9"))
        self.reloj.t += 86400
        self.assertTrue(r.apuntar(*linea("cowrie.login.failed", "203.0.113.9")))
        rotado = self.ruta + ".2026-10-14"
        self.assertTrue(os.path.exists(rotado))
        self.assertEqual(len(self.lineas()), 1)
        ayer = [x for x in self.lineas(rotado) if x["eventid"] == "cowrie.login.failed"]
        self.assertGreater(len(ayer), 0)

    def test_tras_reiniciar_cuenta_lo_que_ya_hay_hoy(self) -> None:
        r = self.registro(100_000)
        for i in range(300):
            r.apuntar(*linea("cowrie.command.input", f"10.0.{i // 250}.{i % 250}"))
        r.close()
        tam = os.path.getsize(self.ruta)
        r2 = self.reiniciado(100_000)
        for i in range(300):
            r2.apuntar(*linea("cowrie.command.input", f"10.1.{i // 250}.{i % 250}"))
        r2.close()
        self.assertGreater(tam, 50_000)
        self.assertEqual(sorted(os.listdir(self.dir)), [".cowrie.json.sugardaddy", "cowrie.json"])
        self.assertLessEqual(os.path.getsize(self.ruta), 100_000)

    def test_vaciado_por_el_sensor_no_deja_fichero_disperso(self) -> None:
        r = self.registro(10**6)
        for _ in range(10):
            r.apuntar(*linea("cowrie.login.failed", "203.0.113.9"))
        os.truncate(self.ruta, 0)  # lo que hace el sensor cuando lo ha leído
        l, ev = linea("cowrie.login.success", "203.0.113.9")
        r.apuntar(l, ev)
        with open(self.ruta, "rb") as f:
            self.assertEqual(f.read(), (l + "\n").encode())

    def test_un_fichero_disperso_de_antes_no_cuenta_como_lleno(self) -> None:
        with open(self.ruta, "wb") as f:
            f.seek(100 * 2**20)
            f.write(b'{"eventid":"cowrie.session.closed"}\n')
        os.utime(self.ruta, (self.reloj.t, self.reloj.t))
        r = self.registro(50 * 2**20)
        # Más de lo que daría la reserva de orígenes nuevos: va a la parte común.
        for _ in range(100):
            self.assertTrue(r.apuntar(*linea("cowrie.login.failed", "203.0.113.9")))

    def test_una_escritura_a_medias_no_rompe_la_linea_siguiente(self) -> None:
        r = self.registro(10**6)
        escribir = os.write
        llamadas = {"n": 0}

        def a_medias(fd: int, datos: Any) -> int:
            llamadas["n"] += 1
            if llamadas["n"] == 1:
                return escribir(fd, bytes(datos[:10]))
            raise OSError(28, "No space left on device")

        with mock.patch.object(sd.os, "write", a_medias):
            self.assertFalse(r.apuntar(*linea("cowrie.login.failed", "203.0.113.9")))
        self.assertTrue(r.apuntar(*linea("cowrie.login.success", "203.0.113.9")))
        with open(self.ruta, encoding="ascii") as f:
            partes = f.read().split("\n")
        self.assertEqual(len(partes[0]), 10)
        self.assertEqual(json.loads(partes[1])["eventid"], "cowrie.login.success")

    def test_sin_tope_escribe_todo(self) -> None:
        r = self.registro(0)
        for _ in range(100):
            self.assertTrue(r.apuntar(*linea("cowrie.login.failed", "203.0.113.9", 10000)))

    # ---- Relevo: el cowrie.json de hoy lo dejó otra imagen (la pública, sin tope)

    def de_otra_imagen(self, tam: int, cuando: float) -> None:
        """Un cowrie.json de ``tam`` bytes de verdad (no disperso) escrito por
        otra imagen: sin la marca de este registro."""
        bloque = (json.dumps({"eventid": "cowrie.login.failed", "password": "x" * 1000}) + "\n").encode()
        bloque = bloque * (2**20 // len(bloque))
        with open(self.ruta, "wb") as f:
            while f.tell() + len(bloque) <= tam:
                f.write(bloque)
            f.write(b"y" * (tam - f.tell() - 1) + b"\n")
        os.utime(self.ruta, (cuando, cuando))

    def vaciar_carpeta(self) -> None:
        for n in os.listdir(self.dir):
            os.remove(os.path.join(self.dir, n))

    def test_relevo_con_un_cowrie_json_de_hoy_de_60_mb_la_trampa_no_queda_muda(self) -> None:
        # Lo que deja la imagen pública al cambiar a la propia en un día de
        # ataque: 60 MB de hoy. Con el tope de verdad, a mediodía UTC.
        self.reloj.t = MEDIODIA
        self.de_otra_imagen(60 * 2**20, MEDIODIA - 3600)
        r = self.registro(52428800)
        self.assertTrue(r.apuntar(*linea("cowrie.login.success", "192.0.2.77")))
        self.assertTrue(r.apuntar(*linea("cowrie.session.file_download", "192.0.2.77")))
        # Lo de la otra imagen queda aparte, entero, como un rotado de hoy: el
        # sensor lo lee y lo poda como cualquier otro.
        self.assertEqual(os.path.getsize(self.ruta + ".2026-10-14"), 60 * 2**20)
        self.assertEqual([x["eventid"] for x in self.lineas()], ["cowrie.login.success", "cowrie.session.file_download"])

    def test_relevo_con_cualquier_tamano_empieza_el_dia_con_todo_el_tope(self) -> None:
        # Escalado (tope de 200 KB): las filas de la revisión, 30, 49,9, 50, 60
        # y 200 MB de un tope de 50. Con lo que pasaba del 94 % se perdían las
        # reservas, y desde el 100 % no salía nada, ni el aviso.
        tope = 200_000
        for tam in (120_000, 199_600, 200_000, 240_000, 800_000):
            with self.subTest(tam=tam):
                self.vaciar_carpeta()
                self.de_otra_imagen(tam, self.reloj.t - 60)
                r = sd.RegistroDiario(self.ruta, tope, reloj=self.reloj)
                try:
                    for i in range(3000):  # 40 IP llenan la parte común
                        r.apuntar(*linea("cowrie.command.input", f"10.0.0.{i % 40}"))
                    self.assertTrue(r.apuntar(*linea("cowrie.login.success", "192.0.2.77")))
                    self.assertTrue(r.apuntar(*linea("cowrie.command.input", "192.0.2.77")))
                finally:
                    r.close()
                eventos = [x["eventid"] for x in self.lineas()]
                self.assertEqual(eventos.count(sd.LOG_FULL), 1)
                self.assertIn(sd.LOG_DROPPED, eventos)
                self.assertGreater(os.path.getsize(self.ruta), r.cupos.tope_comun)
                self.assertLessEqual(os.path.getsize(self.ruta), tope)
                self.assertEqual(os.path.getsize(self.ruta + ".2026-10-14"), tam)

    def test_reiniciar_sobre_su_propio_registro_no_da_otro_tope_ese_dia(self) -> None:
        # Al revés que en el relevo: lo que escribió este mismo registro hoy
        # cuenta, aunque se reinicie con la parte común llena y las reservas
        # empezadas. Si no, cada reinicio daría otros 50 MB.
        tope = 200_000
        r = self.registro(tope)
        for i in range(3000):
            r.apuntar(*linea("cowrie.command.input", f"10.0.{i // 250}.{i % 250}"))
        r.close()
        self.assertGreater(os.path.getsize(self.ruta), r.cupos.tope_comun + r.cupos.tope_nuevos)
        for _ in range(3):
            r = self.reiniciado(tope)
            for i in range(3000):
                r.apuntar(*linea("cowrie.command.input", f"172.16.{i // 250}.{i % 250}"))
            r.close()
        self.assertFalse([n for n in os.listdir(self.dir) if n.startswith("cowrie.json.")])
        self.assertLessEqual(os.path.getsize(self.ruta), tope)

    def test_tras_reiniciar_con_el_registro_casi_lleno_el_aviso_y_el_resumen_salen(self) -> None:
        # El arranque no sabe de quién es lo que ya hay: lo cuenta primero en
        # la parte común y en la de orígenes nuevos, y la de avisos solo pierde
        # lo que de verdad ya hubiera gastado. Antes los orígenes nuevos se
        # comían tras el reinicio la reserva de avisos y no salía ni log_full.
        tope = 200_000
        r = self.registro(tope)
        for i in range(3000):
            r.apuntar(*linea("cowrie.command.input", f"10.0.{i // 250}.{i % 250}"))
        r.close()
        antes = len(self.lineas())
        r = self.reiniciado(tope)
        for i in range(3000):
            r.apuntar(*linea("cowrie.command.input", f"172.16.{i // 250}.{i % 250}"))
        self.reloj.t += 61
        r.tick()
        r.close()
        nuevas = [x["eventid"] for x in self.lineas()[antes:]]
        self.assertEqual(nuevas.count(sd.LOG_FULL), 1)
        self.assertEqual(nuevas.count(sd.LOG_DROPPED), 2)  # enseguida y al minuto
        self.assertLessEqual(os.path.getsize(self.ruta), tope)

    def test_los_avisos_tienen_sitio_aunque_las_otras_partes_esten_llenas(self) -> None:
        c = sd.Cupos(200_000)
        c.nuevo_dia(c.tope_comun + c.tope_nuevos)  # un reinicio con todo lo demás lleno
        self.assertEqual(c.decidir("192.0.2.1", sd.ACTIVIDAD, 100), "registro_lleno")
        self.assertTrue(c.sistema(c.tope_sistema))
        self.assertFalse(c.sistema(1))
        self.assertEqual(c.usado, c.tope)
        # Y no pasan de su reserva aunque quede sitio en la de orígenes nuevos,
        # que no es suya: el total del día no pasa del tope.
        c = sd.Cupos(200_000)
        c.nuevo_dia(c.tope_comun)
        self.assertTrue(c.sistema(c.tope_sistema))
        self.assertFalse(c.sistema(1))
        while c.decidir("192.0.2.1", sd.ACTIVIDAD, 100) is None:
            pass
        self.assertEqual((c.nuevos, c.usado), (c.tope_nuevos, c.tope))
        # Mientras la parte común tiene sitio, los avisos van ahí y su reserva
        # queda para cuando se llene.
        c = sd.Cupos(200_000)
        self.assertTrue(c.sistema(500))
        self.assertEqual((c.comun, c.sist), (500, 0))

    def test_un_registro_de_ayer_de_otra_imagen_rota_con_el_primer_evento(self) -> None:
        self.de_otra_imagen(300_000, self.reloj.t - 86400)
        r = self.registro(200_000)
        self.assertTrue(r.apuntar(*linea("cowrie.login.failed", "203.0.113.9")))
        self.assertEqual(os.path.getsize(self.ruta + ".2026-10-13"), 300_000)
        self.assertEqual(len(self.lineas()), 1)

    def test_la_marca_de_propiedad_no_parece_un_rotado_ni_sigue_enlaces(self) -> None:
        fuera = os.path.join(self.dir, "fuera")
        with open(fuera, "w") as f:
            f.write("intacto")
        marca = os.path.join(self.dir, ".cowrie.json.sugardaddy")
        os.symlink(fuera, marca)
        os.symlink(fuera, marca + ".tmp")
        r = self.registro(10**6)
        self.assertTrue(r.apuntar(*linea("cowrie.login.success", "203.0.113.9")))
        with open(fuera) as f:
            self.assertEqual(f.read(), "intacto")
        self.assertEqual(r.marca, marca)
        self.assertFalse(os.path.islink(marca))
        # El sensor toma por rotado todo lo que empieza por el nombre del registro.
        self.assertFalse(os.path.basename(marca).startswith(os.path.basename(self.ruta)))
        # Y con ella, un reinicio reconoce su fichero.
        r.close()
        r2 = self.reiniciado(10**6)
        self.assertTrue(r2.apuntar(*linea("cowrie.login.success", "203.0.113.9")))
        self.assertEqual(len(self.lineas()), 2)


class JsonlogTests(unittest.TestCase):
    """El jsonlog de Cowrie con el parche: el recorrido entero de un evento."""

    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp()
        self.ruta = os.path.join(self.dir, "cowrie.json")
        self.entorno = mock.patch.dict(
            os.environ,
            {"COWRIE_OUTPUT_JSONLOG_LOGFILE": self.ruta, "COWRIE_OUTPUT_JSONLOG_MAX_BYTES_DAY": "300000"},
        )
        self.entorno.start()

    def tearDown(self) -> None:
        self.entorno.stop()
        shutil.rmtree(self.dir)

    def test_cowrie_cfg_trae_un_tope_por_defecto(self) -> None:
        from cowrie.core.config import CowrieConfig

        with mock.patch.dict(os.environ):
            del os.environ["COWRIE_OUTPUT_JSONLOG_MAX_BYTES_DAY"]
            self.assertEqual(CowrieConfig.getint("output_jsonlog", "max_bytes_day"), 52428800)

    def test_login_con_contrasena_de_100_kb_y_lluvia_de_intentos(self) -> None:
        from cowrie.core.events import EventDispatcher, EventLog
        from cowrie.output.jsonlog import Output

        salida = Output()
        try:
            self.assertEqual(salida.outfile.tope, 300000)
            eventos = EventLog(EventDispatcher([salida]), session="s1", protocol="ssh", src_ip="203.0.113.9")
            for _ in range(2000):  # 200 MB de contraseñas desde una IP
                eventos.dispatch(
                    "cowrie.login.failed",
                    "login attempt [%(username)s/%(password)s] failed",
                    username="admin",
                    password="C" * 102400,
                )
        finally:
            salida.stop()
        self.assertLessEqual(os.path.getsize(self.ruta), 300000)
        with open(self.ruta, encoding="ascii") as f:
            lineas = [json.loads(x) for x in f]
        primero = lineas[0]
        self.assertEqual((primero["eventid"], primero["password"]), ("cowrie.login.failed", "C" * 256))
        self.assertEqual(primero["recortado"], "password (102400 bytes)")
        self.assertNotIn("time", primero)
        self.assertEqual(lineas[-1]["eventid"], sd.LOG_DROPPED)
        self.assertEqual(sum(x.get("omitidos", 0) for x in lineas), 2000 - sum(1 for x in lineas if x["eventid"] == "cowrie.login.failed"))


if __name__ == "__main__":
    unittest.main()
