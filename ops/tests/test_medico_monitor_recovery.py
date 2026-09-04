#!/usr/bin/env python3
"""Hermetic regressions for delivery-aware adapter recovery in the fleet doctor."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import pathlib
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "guardias" / "cauce-v3-medico-monitor"
LOADER = importlib.machinery.SourceFileLoader("medico_monitor_recovery", str(SCRIPT))
SPEC = importlib.util.spec_from_file_location("medico_monitor_recovery", SCRIPT, loader=LOADER)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

LEASED_ROW = ("Steven", "kant", "leased", "1", "21", "delivery-1", "21", "-1")
CAPTURE_ROW = (
    "delivery-1", "message-1", "socrates", "Steven", "grp.steven", "interactive", "7",
    "request-1",
)
CAPTURED = {
    "delivery": "delivery-1",
    "message": "message-1",
    "actor": "socrates",
    "tenant": "Steven",
    "room": "grp.steven",
    "lane": "interactive",
    "priority": "7",
    "request_id": "request-1",
}


class SqlProbe:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def __call__(self, query, entrada=None, columnas=None):
        self.calls.append({"query": query, "entrada": entrada, "columnas": columnas})
        return list(self.rows)


class TestDeliveryStateRecovery(unittest.TestCase):
    def test_leased_delivery_is_detected_as_in_flight(self):
        probe = SqlProbe([LEASED_ROW])
        with mock.patch.object(MODULE, "sql", probe):
            deliveries = MODULE.entregas_trabadas()

        self.assertEqual(deliveries[0]["status"], "leased")
        self.assertIn("status in ('leased','accepted','started')", probe.calls[0]["query"])
        self.assertNotIn("status in ('claimed',", probe.calls[0]["query"])

    def test_empty_delivery_scan_is_not_a_false_positive(self):
        probe = SqlProbe([])
        with mock.patch.object(MODULE, "sql", probe):
            self.assertEqual(MODULE.entregas_trabadas(), [])

    def test_capture_is_metadata_only(self):
        probe = SqlProbe([CAPTURE_ROW])
        with mock.patch.object(MODULE, "sql", probe):
            captured = MODULE.captura_en_vuelo("kant")

        query = probe.calls[0]["query"].lower()
        self.assertEqual(probe.calls[0]["columnas"], 8)
        self.assertIn("status in ('leased','accepted','started')", query)
        self.assertNotIn("status in ('claimed',", query)
        self.assertNotIn("body", query)
        self.assertNotIn("texto", query)
        self.assertNotIn("text", query)
        self.assertEqual(captured, [CAPTURED])
        self.assertNotIn("body", captured[0])
        self.assertNotIn("texto", captured[0])

    def test_leased_delivery_vetoes_restart_before_systemctl(self):
        probe = SqlProbe([CAPTURE_ROW])

        def forbidden_shell(*_args, **_kwargs):
            self.fail("ciclo_rescate invoked a shell command before applying the in-flight veto")

        adapter = {
            "bundle": MODULE.RELEASE_CON_FIX78,
            "digest": MODULE.DIGEST_CON_FIX78,
            "host": "vps",
        }
        with mock.patch.object(MODULE, "sql", probe), mock.patch.object(MODULE, "sh", forbidden_shell):
            result = MODULE.ciclo_rescate("kant", adapter, [])

        self.assertEqual(result["resultado"], "omitido")
        self.assertEqual(result["perdido"], [CAPTURED])

    def test_delivery_arriving_during_final_capture_vetoes_restart(self):
        def forbidden_shell(*_args, **_kwargs):
            self.fail("ciclo_rescate restarted after the final in-flight capture found work")

        adapter = {
            "bundle": MODULE.RELEASE_CON_FIX78,
            "digest": MODULE.DIGEST_CON_FIX78,
            "host": "vps",
        }
        captures = mock.Mock(side_effect=[[], [CAPTURED]])
        with (
            mock.patch.object(MODULE, "captura_en_vuelo", captures),
            mock.patch.object(MODULE, "clientes_tmux", return_value=0),
            mock.patch.object(MODULE, "sh", forbidden_shell),
        ):
            result = MODULE.ciclo_rescate("kant", adapter, [])

        self.assertEqual(captures.call_count, 2)
        self.assertEqual(result["resultado"], "omitido")
        self.assertEqual(result["perdido"], [CAPTURED])


if __name__ == "__main__":
    unittest.main()
