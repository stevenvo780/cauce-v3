#!/usr/bin/env python3
from __future__ import annotations

import datetime
import importlib.util
import pathlib
import unittest

RAIZ = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "cauce_conversaciones_paralelas", RAIZ / "ops/guardias/cauce-conversaciones-paralelas.py")
guardia = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardia)

AHORA = datetime.datetime(2026, 10, 8, 20, 0, tzinfo=datetime.timezone.utc)
FILAS = [
    ["Steven", "jarvis", "9c81eaf2", "12", "console,human-mcp", "78c81e05", "10-08 19:00"],
    ["Steven", "jarvis", "ed834a0e", "4", "telegram", "telegram", "10-08 18:00"],
]


class Bus:
    def __init__(self, estado=202):
        self.estado, self.enviados = estado, []

    def __call__(self, payload):
        self.enviados.append(payload)
        return self.estado


class ConversacionesParalelas(unittest.TestCase):
    def test_avisa_a_zeus_con_alias_sesiones_y_canales(self):
        bus = Bus()
        memoria, avisado = guardia.corrida(FILAS, {}, AHORA, bus)
        self.assertEqual(len(bus.enviados), 1)
        payload = bus.enviados[0]
        self.assertEqual(payload["recipients"], [{"tenant_id": "Steven", "alias": "zeus"}])
        for dato in ("Steven/jarvis", "9c81eaf2", "ed834a0e", "telegram", "console,human-mcp"):
            self.assertIn(dato, avisado)
        self.assertEqual(list(memoria), ["Steven/jarvis:9c81eaf2,ed834a0e"])

    def test_no_repite_el_mismo_juego_hasta_que_pasa_el_silencio(self):
        bus = Bus()
        memoria, _ = guardia.corrida(FILAS, {}, AHORA, bus)
        _, otra = guardia.corrida(FILAS, memoria, AHORA + datetime.timedelta(hours=5), bus)
        self.assertIsNone(otra)
        _, despues = guardia.corrida(FILAS, memoria, AHORA + datetime.timedelta(hours=7), bus)
        self.assertIsNotNone(despues)
        self.assertEqual(len(bus.enviados), 2)

    def test_una_conversacion_nueva_es_otro_problema_y_avisa_aunque_el_alias_ya_avisara(self):
        bus = Bus()
        memoria, _ = guardia.corrida(FILAS, {}, AHORA, bus)
        tres = FILAS + [["Steven", "jarvis", "63645070", "1", "console", "aaaaaaaa", "10-08 19:30"]]
        _, avisado = guardia.corrida(tres, memoria, AHORA + datetime.timedelta(hours=1), bus)
        self.assertIn("63645070", avisado)

    def test_si_el_bus_no_acepta_no_apunta_el_aviso(self):
        with self.assertRaises(RuntimeError):
            guardia.corrida(FILAS, {}, AHORA, Bus(estado=503))

    def test_una_sola_conversacion_no_avisa(self):
        bus = Bus()
        memoria, avisado = guardia.corrida([], {}, AHORA, bus)
        self.assertEqual((memoria, avisado, bus.enviados), ({}, None, []))

    def test_la_consulta_cuenta_humanos_y_dms_de_telegram_no_continuaciones_de_agente(self):
        self.assertIn("human_message_initiators", guardia.CONSULTA)
        self.assertIn("m.body->>'type' = 'telegram.message'", guardia.CONSULTA)
        self.assertIn("harness_consumption_v1", guardia.CONSULTA)


if __name__ == "__main__":
    unittest.main()
