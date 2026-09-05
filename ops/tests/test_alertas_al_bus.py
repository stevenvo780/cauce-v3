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
AHORA = datetime.datetime(2026, 9, 2, 9, 30, tzinfo=datetime.timezone.utc)


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

    def test_las_criticas_van_primero(self):
        payloads = bus.planificar(alertas_de(), {}, AHORA)
        self.assertEqual(nombres_del_digesto(payloads[0]), [
            "CauceDispatcherLoopStale", "CauceGatewayDown", "CauceOutboxBacklogGrowing"])

    def test_sin_alertas_no_hay_entrega(self):
        self.assertEqual(bus.planificar([], {}, AHORA), [])

    def test_el_sobre_es_el_del_medico(self):
        payload = bus.planificar(alertas_de(), {}, AHORA)[0]
        self.assertEqual(payload["room_id"], "grp.steven")
        self.assertEqual([r["alias"] for r in payload["recipients"]], ["zeus", "kant"])
        self.assertTrue(texto(payload).startswith(
            "[GUARDIA AUTOMATICO - cauce-alertas-al-bus - NO es kant]\n"))
        self.assertTrue(payload["body"]["es_automatico"])


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

    def test_la_huella_derivada_es_estable_y_distingue_alertas(self):
        primera, segunda = alertas_de(FIXTURE_API)[1], alertas_de(FIXTURE_API)[2]
        self.assertEqual(bus.identidad(primera)[1], bus.identidad(alertas_de(FIXTURE_API)[1])[1])
        self.assertNotEqual(bus.identidad(primera)[1], bus.identidad(segunda)[1])

    def test_el_digesto_sale_igual_de_bien_sin_huella(self):
        payloads = bus.planificar(alertas_de(FIXTURE_API), {}, AHORA)
        self.assertEqual(len(payloads), 1)
        self.assertEqual(nombres_del_digesto(payloads[0]), [
            "CauceDispatcherLoopStale", "CauceGatewayDown", "CauceOutboxBacklogGrowing"])
        self.assertIn("2026-09-02T08:58:30.123456789Z", texto(payloads[0]))

    def test_la_clave_cambia_si_cambia_active_at(self):
        vivas = bus.alertas_firing(alertas_de(FIXTURE_API))
        antes = bus.clave_de_digesto(vivas)
        vivas[0]["activeAt"] = "2026-09-02T10:45:00.000000001Z"
        self.assertNotEqual(antes, bus.clave_de_digesto(vivas))

    def test_la_clave_cambia_si_cambian_las_etiquetas(self):
        vivas = bus.alertas_firing(alertas_de(FIXTURE_API))
        antes = bus.clave_de_digesto(vivas)
        vivas[0]["labels"]["instance"] = "dispatcher:9082"
        self.assertNotEqual(antes, bus.clave_de_digesto(vivas))


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

    def test_el_cuerpo_no_lleva_relojes_ni_contadores(self):
        cuerpo = texto(bus.planificar(alertas_de(), {}, AHORA)[0])
        self.assertNotIn("hace", cuerpo)
        self.assertIn("2026-09-02T09:02:00.000Z", cuerpo)

    def test_cada_tipo_de_aviso_tiene_su_prefijo(self):
        self.assertTrue(bus.clave_de_digesto([]).startswith("alertas-digesto-"))
        self.assertTrue(bus.clave_de_resueltas([]).startswith("alertas-resueltas-"))
        self.assertTrue(bus.clave_de_poller_detenido("x").startswith("alertas-poller_detenido-"))
        self.assertTrue(
            bus.clave_de_despacho_fallando("x").startswith("alertas-despacho_fallando-"))


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

    def test_las_que_no_caben_van_por_nombre(self):
        payload = bus.planificar(self.alertas_de_sobra(), {}, AHORA)[0]
        self.assertEqual(len(nombres_del_digesto(payload)), bus.TOPE_DETALLADO)
        self.assertIn("Y 2 más sin detalle: CauceRegla10, CauceRegla11", texto(payload))

    def test_lane_interactive_solo_si_hay_criticas(self):
        solo_warning = [a for a in alertas_de() if a["labels"]["severity"] == "warning"]
        self.assertEqual(bus.planificar(alertas_de(), {}, AHORA)[0]["lane"], "interactive")
        self.assertEqual(bus.planificar(solo_warning, {}, AHORA)[0]["lane"], "batch")


class TestResueltas(unittest.TestCase):
    def test_avisa_de_las_que_se_apagaron(self):
        conocidas = [bus.identidad_texto(a) for a in bus.alertas_firing(alertas_de())]
        vivas = alertas_de()[:1]
        payloads = bus.planificar(vivas, {"firing_conocidas": conocidas}, AHORA)
        cerradas = [p for p in payloads if "YA NO ESTAN FIRING" in texto(p)]
        self.assertEqual(len(cerradas), 1)
        self.assertEqual(cerradas[0]["lane"], "batch")
        self.assertIn("CauceDispatcherLoopStale", texto(cerradas[0]))
        self.assertNotIn("CauceOutboxBacklogGrowing", texto(cerradas[0]).split("Cerradas:")[1])

    def test_sin_cambios_no_avisa(self):
        conocidas = [bus.identidad_texto(a) for a in bus.alertas_firing(alertas_de())]
        payloads = bus.planificar(alertas_de(), {"firing_conocidas": conocidas}, AHORA)
        self.assertEqual(len(payloads), 1)

    def test_estado_corrupto_no_inventa_resueltas(self):
        payloads = bus.planificar(alertas_de(), {"firing_conocidas": [None, "", 7]}, AHORA)
        self.assertEqual(len(payloads), 1)


class TestGuardiaDetenido(unittest.TestCase):
    def viejo(self):
        return (AHORA - datetime.timedelta(seconds=bus.PERIODO_TIMER_SEG * 4)).isoformat()

    def test_avisa_cuando_la_ultima_lectura_es_vieja(self):
        payloads = bus.planificar(alertas_de(), {"ultima_corrida_ok": self.viejo()}, AHORA)
        self.assertIn("POLLER DETENIDO", texto(payloads[-1]))

    def test_el_despacho_fallando_es_un_aviso_distinto(self):
        estado = {"ultima_corrida_ok": AHORA.isoformat(), "ultimo_despacho_ok": self.viejo()}
        payloads = bus.planificar(alertas_de(), estado, AHORA)
        self.assertNotIn("POLLER DETENIDO", "".join(texto(p) for p in payloads))
        self.assertIn("DESPACHO FALLANDO", texto(payloads[-1]))
        self.assertIn("journalctl", texto(payloads[-1]))

    def test_una_corrida_reciente_no_avisa(self):
        reciente = (AHORA - datetime.timedelta(seconds=60)).isoformat()
        estado = {"ultima_corrida_ok": reciente, "ultimo_despacho_ok": reciente}
        payloads = bus.planificar(alertas_de(), estado, AHORA)
        self.assertEqual(len(payloads), 1)

    def test_sin_estado_previo_no_avisa(self):
        self.assertEqual(len(bus.planificar(alertas_de(), {}, AHORA)), 1)

    def test_una_marca_sin_zona_no_tumba_la_corrida(self):
        self.assertFalse(bus.detenido("2026-09-02T09:00:00", AHORA))
        self.assertFalse(bus.detenido("no es una fecha", AHORA))
        self.assertFalse(bus.detenido(1234, AHORA))


class TestEstadoSiguiente(unittest.TestCase):
    def test_un_despacho_fallido_no_congela_la_marca_de_lectura(self):
        vivas = bus.alertas_firing(alertas_de())
        nuevo = bus.estado_siguiente({}, vivas, AHORA, lectura_ok=True, fallos=1)
        self.assertEqual(nuevo["ultima_corrida_ok"], AHORA.isoformat())
        self.assertNotIn("ultimo_despacho_ok", nuevo)
        self.assertNotIn("firing_conocidas", nuevo)

    def test_una_corrida_limpia_marca_las_tres_cosas(self):
        vivas = bus.alertas_firing(alertas_de())
        nuevo = bus.estado_siguiente({}, vivas, AHORA, lectura_ok=True, fallos=0)
        self.assertEqual(nuevo["ultimo_despacho_ok"], AHORA.isoformat())
        self.assertEqual(len(nuevo["firing_conocidas"]), 3)

    def test_sin_lectura_no_se_marca_la_lectura(self):
        anterior = {"ultima_corrida_ok": "2026-09-02T08:00:00+00:00"}
        nuevo = bus.estado_siguiente(anterior, [], AHORA, lectura_ok=False, fallos=0)
        self.assertEqual(nuevo["ultima_corrida_ok"], anterior["ultima_corrida_ok"])
        self.assertEqual(nuevo["ultimo_despacho_ok"], AHORA.isoformat())


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

    def test_dry_run_no_toca_subprocess(self):
        with tempfile.TemporaryDirectory() as carpeta:
            entorno = {"CAUCE_ALERTAS_ESTADO": str(pathlib.Path(carpeta) / "no-existe.json")}
            salida = io.StringIO()
            with mock.patch.dict("os.environ", entorno), \
                    mock.patch.object(bus.subprocess, "run") as corrida, \
                    contextlib.redirect_stdout(salida):
                codigo = bus.main(["--desde-fichero", str(FIXTURE), "--dry-run"])
            corrida.assert_not_called()
        self.assertEqual(codigo, 0)
        self.assertIn("1 entregas a publicar", salida.getvalue())
        self.assertIn("dry-run completo", salida.getvalue())
        self.assertNotIn("alertas-digesto-", salida.getvalue())

    def test_una_lectura_fallida_se_publica(self):
        with self.corrida() as (envio, salida):
            codigo = bus.main(["--desde-fichero", "/no/existe/alerts.json"])
        self.assertEqual(codigo, 1)
        envio.assert_called_once()
        cuerpo = texto(envio.call_args[0][0])
        self.assertIn("SIN LECTURA DE PROMETHEUS", cuerpo)
        self.assertIn("NO asumas que no hay ninguna", cuerpo)
        self.assertIn("file_read_failed", cuerpo)
        self.assertNotIn("/no/existe", cuerpo)
        self.assertIn("no se pudieron leer las alertas", salida.getvalue())

    def test_la_lectura_fallida_no_marca_la_corrida(self):
        with self.corrida():
            bus.main(["--desde-fichero", "/no/existe/alerts.json"])
            self.assertNotIn("ultima_corrida_ok", bus.leer_estado())

    def test_una_corrida_buena_deja_las_firing_en_el_estado(self):
        with self.corrida() as (envio, _):
            codigo = bus.main(["--desde-fichero", str(FIXTURE_API)])
            estado = bus.leer_estado()
        self.assertEqual(codigo, 0)
        envio.assert_called_once()
        self.assertEqual(len(estado["firing_conocidas"]), 3)

    def test_un_despacho_fallido_devuelve_uno(self):
        with self.corrida(publicaciones=(False, 500)) as (_, salida):
            codigo = bus.main(["--desde-fichero", str(FIXTURE)])
        self.assertEqual(codigo, 1)
        self.assertIn("FALLO", salida.getvalue())
        self.assertIn("HTTP 500", salida.getvalue())

    def test_el_log_no_confia_en_detalles_devuelto_por_el_despacho(self):
        sentinela = "SECRETO-ID-RUTA-NO-IMPRIMIR"
        with self.corrida(publicaciones=(False, sentinela)) as (_, salida):
            codigo = bus.main(["--desde-fichero", str(FIXTURE)])
        self.assertEqual(codigo, 1)
        self.assertNotIn(sentinela, salida.getvalue())
        self.assertIn("SIN CODIGO HTTP", salida.getvalue())

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

    def test_stderr_remoto_no_filtra_detalle_al_log_ni_al_bus(self):
        sentinela = "SECRETO-ID-RUTA-NO-IMPRIMIR"
        salida, errores = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as carpeta:
            entorno = {"CAUCE_ALERTAS_ESTADO": str(pathlib.Path(carpeta) / "estado.json")}
            with mock.patch.dict("os.environ", entorno), \
                    mock.patch.object(bus, "sh", return_value=(23, "", sentinela)), \
                    mock.patch.object(bus, "publicar", return_value=(True, 202)) as envio, \
                    contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
                codigo = bus.main([])
        self.assertEqual(codigo, 1)
        payload = envio.call_args[0][0]
        expuesto = salida.getvalue() + errores.getvalue() + json.dumps(payload)
        self.assertNotIn(sentinela, expuesto)
        self.assertIn("remote_read_failed", texto(payload))


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

    def test_acepta_unicamente_el_codigo_http_controlado(self):
        with mock.patch.object(bus, "sh", return_value=(0, "202\n", "ignorado")):
            self.assertEqual(bus.publicar(bus.payload_de("alerta", "clave")), (True, 202))
        with mock.patch.object(bus, "sh", return_value=(0, "500\n", "ignorado")):
            self.assertEqual(bus.publicar(bus.payload_de("alerta", "clave")), (False, 500))


if __name__ == "__main__":
    unittest.main(verbosity=2)
