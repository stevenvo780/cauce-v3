#!/usr/bin/env python3
"""Regression test: `cauce-esfuerzo` must not keep its own copy of the fleet.

The tool used to carry a hand-written table of alias -> (tenant, harness, config file). It drifted:
four aliases of a retired tenant survived in it, three live aliases were missing -- so `all` and
`@<harness>` skipped them without a word -- and four harness labels disagreed with the inventory,
which made `salva high` write a codex knob into a file salva does not read while silently changing
three other aliases. This test pins the tool's alias set and harness labels to
ops/container-aliases.json, the reconciled inventory, in both directions; pins the half the
inventory cannot supply (which file each harness writes to) to the harness; and drives the refusals
-- unknown configuration file, harness with no known knob -- from a fixture fleet, so they keep
proving something the day every live alias has a path.

Scope is deliberately this one tool: aliases named anywhere else under ops/ (QA fixtures, test
fixtures, runbook prose) are not fleet inventory and are none of this test's business.
"""
from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = OPS / "guardias" / "cauce-esfuerzo"
_loader = importlib.machinery.SourceFileLoader("cauce_esfuerzo", str(SCRIPT))
_spec = importlib.util.spec_from_file_location("cauce_esfuerzo", SCRIPT, loader=_loader)
assert _spec and _spec.loader
MODULE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MODULE)

INVENTORY = json.loads((OPS / "container-aliases.json").read_text(encoding="utf-8"))["aliases"]
CONFIG_SUFFIX_BY_HARNESS = {
    "claude": "settings.json",
    "codex": "config.toml",
    "openclaw": "openclaw.json",
}
FIXTURE_FLEET = {
    "sinfichero": ("Steven", "claude", None),
    "conocido": ("Steven", "claude", "/tmp/cauce-esfuerzo-no-existe/settings.json"),
}


def run_main(argv):
    output = io.StringIO()
    with mock.patch.object(MODULE.sys, "argv", ["cauce-esfuerzo", *argv]), contextlib.redirect_stdout(output):
        MODULE.main()
    return output.getvalue()


class TestFleetMatchesInventory(unittest.TestCase):
    def test_every_alias_it_knows_exists_in_the_inventory(self):
        self.assertEqual(sorted(set(MODULE.FLEET) - set(INVENTORY)), [])
        self.assertEqual(sorted(set(MODULE.CONFIG) - set(INVENTORY)), [],
                         "a configuration path is pinned to an alias the fleet no longer has")

    def test_no_inventory_alias_is_absent_from_the_tool(self):
        self.assertEqual(sorted(set(INVENTORY) - set(MODULE.FLEET)), [],
                         "`all` and `@<harness>` would skip these aliases in silence")

    def test_reported_harness_and_tenant_are_the_inventory_s(self):
        reported = {alias: (tenant, harness) for alias, (tenant, harness, _p) in MODULE.FLEET.items()}
        expected = {alias: (entry["tenant"], entry["harness"]) for alias, entry in INVENTORY.items()}
        self.assertEqual(reported, expected)

    def test_selector_by_harness_covers_the_whole_inventory(self):
        for harness in sorted({entry["harness"] for entry in INVENTORY.values()}):
            expected = sorted(a for a, e in INVENTORY.items() if e["harness"] == harness)
            self.assertEqual(sorted(MODULE.targets(f"@{harness}")), expected)
        self.assertEqual(sorted(MODULE.targets("all")), sorted(INVENTORY))


class TestConfigPathMatchesHarness(unittest.TestCase):
    def test_each_known_file_is_the_one_its_harness_reads(self):
        self.assertTrue(MODULE.CONFIG, "the tool would have nothing to write to")
        for alias, path in MODULE.CONFIG.items():
            harness = INVENTORY[alias]["harness"]
            suffix = CONFIG_SUFFIX_BY_HARNESS.get(harness)
            self.assertIsNotNone(suffix, f"{alias} is {harness}: this tool has no knob for it, so it needs no path")
            self.assertTrue(path.endswith(f"/{suffix}"),
                            f"{alias} is {harness} but writes to {path}, which that harness does not read")


class TestAliasWithoutKnownConfig(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(MODULE, "FLEET", FIXTURE_FLEET)
        patch.start()
        self.addCleanup(patch.stop)

    def test_it_is_still_selectable(self):
        self.assertEqual(MODULE.targets("sinfichero"), ["sinfichero"])

    def test_it_is_named_instead_of_skipped(self):
        self.assertIn("no se conoce el fichero de configuración de sinfichero", run_main(["sinfichero", "high"]))

    def test_it_is_not_treated_as_sharing_one_file(self):
        self.assertEqual(MODULE.sharers(None, "sinfichero"), [])


class TestHarnessWithoutKnownKnob(unittest.TestCase):
    def test_an_unhandled_harness_is_refused_by_name_and_nothing_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "opencode.json"
            path.write_text('{"agents": {}}\n', encoding="utf-8")
            fleet = {"stub": ("Steven", "opencode", str(path))}
            with mock.patch.object(MODULE, "FLEET", fleet):
                output = run_main(["stub", "high"])
            self.assertIn("✗", output)
            self.assertIn("opencode", output)
            self.assertEqual(path.read_text(encoding="utf-8"), '{"agents": {}}\n')
            self.assertEqual(sorted(p.name for p in pathlib.Path(tmp).iterdir()), ["opencode.json"])


class TestOpsRootLookup(unittest.TestCase):
    def test_the_first_candidate_carrying_the_inventory_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(MODULE.find_ops_root([None, tmp, str(OPS)]), OPS)

    def test_a_candidate_without_the_reader_is_not_enough(self):
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "container-aliases.json").write_text("{}", encoding="utf-8")
            self.assertEqual(MODULE.find_ops_root([tmp, str(OPS)]), OPS)

    def test_no_reachable_candidate_is_a_legible_refusal(self):
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(SystemExit) as refusal:
            MODULE.find_ops_root([None, tmp])
        message = str(refusal.exception)
        self.assertIn("no encuentro el inventario de la flota", message)
        self.assertIn(MODULE.OPS_ROOT_ENV, message)
        self.assertIn(tmp, message)


if __name__ == "__main__":
    unittest.main()
