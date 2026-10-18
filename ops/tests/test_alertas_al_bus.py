#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import copy
import datetime
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

RAIZ = pathlib.Path(__file__).resolve().parents[2]
GUARDIA = RAIZ / "ops/guardias/cauce-alertas-al-bus.py"
FIXTURE = RAIZ / "ops/tests/fixtures/prometheus-alerts.json"
FIXTURE_API = RAIZ / "ops/tests/fixtures/prometheus-alerts-api.json"


def cargar_guardia():
    spec = importlib.util.spec_from_file_location("cauce_alertas_al_bus", GUARDIA)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


bus = cargar_guardia()
AHORA = datetime.datetime(2026, 9, 2, 9, 30, tzinfo=datetime.UTC)


def alertas_de(fichero=FIXTURE):
    return copy.deepcopy(json.loads(fichero.read_text(encoding="utf-8"))["data"]["alerts"])


def texto(payload):
    return payload["body"]["text"]


def nombres_del_digesto(payload):
    return [linea.split(" ", 2)[2].split(":", 1)[0]
            for linea in texto(payload).split("\n") if linea.startswith("- ")]


class TestFiltrado(unittest.TestCase):
    def test_solo_firing_llega_al_bus(self):
        vivas = bus.alertas_firing(alertas_de())
        self.assertEqual(len(vivas), 3)
        nombres = [bus.identidad(a)[0] for a in vivas]
        self.assertNotIn("CauceReaperIdle", nombres)
        self.assertNotIn("CauceTelegramBridgeDown", nombres)

class TestFormaDelEndpointReal(unittest.TestCase):
    """La forma que devuelve `/api/v1/alerts`: `activeAt` y SIN `fingerprint`."""

    def test_usa_active_at_cuando_no_hay_starts_at(self):
        alerta = alertas_de(FIXTURE_API)[2]
        self.assertNotIn("startsAt", alerta)
        self.assertNotIn("fingerprint", alerta)
        nombre, huella, inicio = bus.identidad(alerta)
        self.assertEqual(nombre, "CauceGatewayDown")
        self.assertEqual(inicio, "2026-09-02T08:58:30.123456789Z")
        self.assertEqual(len(huella), 16)

class TestClaveIdempotente(unittest.TestCase):
    def test_estable_aunque_cambien_los_campos_volatiles(self):
        segunda = alertas_de()
        for alerta in segunda:
            alerta["value"] = "9999e+00"
            alerta["updatedAt"] = "2026-09-02T09:29:59.000Z"
        primero = bus.planificar(alertas_de(), {}, AHORA)[0]
        segundo = bus.planificar(segunda, {}, AHORA + datetime.timedelta(minutes=5))[0]
        self.assertEqual(primero["idempotency_key"], segundo["idempotency_key"])
        self.assertEqual(texto(primero), texto(segundo))

class TestDigesto(unittest.TestCase):
    def alertas_de_sobra(self):
        base = alertas_de()[1]
        muchas = []
        for indice in range(bus.TOPE_DETALLADO + 2):
            alerta = copy.deepcopy(base)
            alerta["labels"]["alertname"] = f"CauceRegla{indice:02d}"
            alerta["fingerprint"] = f"{indice:016x}"
            muchas.append(alerta)
        return muchas

    def test_una_sola_entrega_aunque_haya_doce_alertas(self):
        payloads = bus.planificar(self.alertas_de_sobra(), {}, AHORA)
        self.assertEqual(len(payloads), 1)
        self.assertIn("ALERTAS FIRING: 12 (12 críticas)", texto(payloads[0]))

class TestResueltas(unittest.TestCase):
    def test_sin_cambios_no_avisa(self):
        conocidas = [bus.identidad_texto(a) for a in bus.alertas_firing(alertas_de())]
        payloads = bus.planificar(alertas_de(), {"firing_conocidas": conocidas}, AHORA)
        self.assertEqual(len(payloads), 1)

class TestGuardiaDetenido(unittest.TestCase):
    def viejo(self):
        return (AHORA - datetime.timedelta(seconds=bus.PERIODO_TIMER_SEG * 4)).isoformat()

    def test_avisa_cuando_la_ultima_lectura_es_vieja(self):
        payloads = bus.planificar(alertas_de(), {"ultima_corrida_ok": self.viejo()}, AHORA)
        self.assertIn("POLLER DETENIDO", texto(payloads[-1]))

class TestEstadoSiguiente(unittest.TestCase):
    def test_un_despacho_fallido_no_congela_la_marca_de_lectura(self):
        vivas = bus.alertas_firing(alertas_de())
        nuevo = bus.estado_siguiente({}, vivas, AHORA, lectura_ok=True, fallos=1)
        self.assertEqual(nuevo["ultima_corrida_ok"], AHORA.isoformat())
        self.assertNotIn("ultimo_despacho_ok", nuevo)
        self.assertNotIn("firing_conocidas", nuevo)

class TestFicheroDeEstado(unittest.TestCase):
    def test_ida_y_vuelta(self):
        with tempfile.TemporaryDirectory() as carpeta:
            ruta = pathlib.Path(carpeta) / "estado.json"
            with mock.patch.dict("os.environ", {"CAUCE_ALERTAS_ESTADO": str(ruta)}):
                self.assertEqual(bus.leer_estado(), {})
                bus.guardar_estado({"ultima_corrida_ok": "2026-09-02T09:30:00+00:00"})
                self.assertEqual(bus.leer_estado()["ultima_corrida_ok"],
                                 "2026-09-02T09:30:00+00:00")
                ruta.write_text("{no es json")
                self.assertEqual(bus.leer_estado(), {})


class TestCorrida(unittest.TestCase):
    @contextlib.contextmanager
    def corrida(self, publicaciones=(True, 202)):
        with tempfile.TemporaryDirectory() as carpeta:
            entorno = {"CAUCE_ALERTAS_ESTADO": str(pathlib.Path(carpeta) / "estado.json")}
            salida = io.StringIO()
            with mock.patch.dict("os.environ", entorno), \
                    mock.patch.object(bus, "publicar", return_value=publicaciones) as envio, \
                    contextlib.redirect_stdout(salida):
                yield envio, salida

    def test_un_despacho_fallido_devuelve_uno(self):
        with self.corrida(publicaciones=(False, 500)) as (_, salida):
            codigo = bus.main(["--desde-fichero", str(FIXTURE)])
        self.assertEqual(codigo, 1)
        self.assertIn("FALLO", salida.getvalue())
        self.assertIn("HTTP 500", salida.getvalue())

    def test_excepcion_de_lectura_no_filtra_detalle_al_log_ni_al_bus(self):
        sentinela = "SECRETO-ID-RUTA-NO-IMPRIMIR"
        salida, errores = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as carpeta:
            entorno = {"CAUCE_ALERTAS_ESTADO": str(pathlib.Path(carpeta) / "estado.json")}
            with mock.patch.dict("os.environ", entorno), \
                    mock.patch.object(bus, "obtener_alertas",
                                      side_effect=RuntimeError(sentinela)) as lectura, \
                    mock.patch.object(bus, "publicar", return_value=(True, 202)) as envio, \
                    contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
                codigo = bus.main([])
        self.assertEqual(codigo, 1)
        lectura.assert_called_once()
        payload = envio.call_args[0][0]
        expuesto = salida.getvalue() + errores.getvalue() + json.dumps(payload)
        self.assertNotIn(sentinela, expuesto)
        self.assertIn("unexpected_read_failure", texto(payload))

class TestPublicacionSegura(unittest.TestCase):
    def test_descarta_el_cuerpo_y_stderr_del_gateway(self):
        sentinela = "SECRETO-ID-RUTA-NO-IMPRIMIR"
        salida, errores = io.StringIO(), io.StringIO()
        with mock.patch.object(bus, "sh", return_value=(0, f"500\n{sentinela}", sentinela)), \
                contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            ok, codigo = bus.publicar(bus.payload_de("alerta", "clave"))
        self.assertFalse(ok)
        self.assertIsNone(codigo)
        self.assertNotIn(sentinela, salida.getvalue() + errores.getvalue())
        self.assertNotIn("r.read", bus.DESPACHO)

if __name__ == "__main__":
    unittest.main(verbosity=2)
