#!/usr/bin/env python3
"""`conversaciones_paralelas`: an alias answered from more than one native conversation is the second TUI.

kratos (2026-10-08) answered Steven's console turns from a headless copy while the console showed the
TUI. The probe must report exactly the aliases with more than one conversation, grouped per alias, and
declare its column contract so a schema drift fails loudly instead of misreading rows.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import pathlib
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "guardias" / "cauce-v3-medico-monitor"
_loader = importlib.machinery.SourceFileLoader("medico_monitor_paralelas", str(SCRIPT))
_spec = importlib.util.spec_from_file_location("medico_monitor_paralelas", SCRIPT, loader=_loader)
assert _spec and _spec.loader
MODULE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MODULE)


class ConversacionesParalelas(unittest.TestCase):
    def test_agrupa_por_alias_y_pide_seis_columnas(self) -> None:
        filas = [["Miguel", "kratos", "2e47628d", "19", "adapter,telegram", "10-08 16:38"],
                 ["Miguel", "kratos", "1702d085", "5", "console", "10-08 18:04"]]
        with mock.patch.object(MODULE, "sql", return_value=filas) as consulta:
            paralelas = MODULE.conversaciones_paralelas(24)
        self.assertEqual(paralelas, {("Miguel", "kratos"): [("2e47628d", 19, "adapter,telegram", "10-08 16:38"),
                                                            ("1702d085", 5, "console", "10-08 18:04")]})
        texto, = consulta.call_args.args
        self.assertEqual(consulta.call_args.kwargs, {"columnas": 6})
        self.assertIn("having count(*) > 1", texto)
        self.assertIn("interval '24 hours'", texto)
        self.assertIn("harness_consumption_v1", texto)

    def test_sin_alias_con_dos_conversaciones_no_hay_nada(self) -> None:
        with mock.patch.object(MODULE, "sql", return_value=[]):
            self.assertEqual(MODULE.conversaciones_paralelas(), {})


if __name__ == "__main__":
    unittest.main()
