from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

VALID = ("a", "operador_uno", "operador-a", "a" + "_" * 63)
INVALID = ("_operador", "Operador", "operador.uno", "a" * 65, "a/b", "a\\nb")


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


class AliasConsumerCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-alias-consumers-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.ops = self.root / "ops"
        (self.ops / "scripts").mkdir(parents=True)

    def run_script(self, script, *arguments, env=None):
        return subprocess.run([script, *arguments], capture_output=True, text=True,
                              timeout=20, env={**os.environ, **(env or {})})

    def test_agent_identity_alias_validation_precedes_own_missing_signer(self):
        script = self.ops / "scripts/provision-agent-identity.sh"
        shutil.copyfile(SCRIPTS / script.name, script)
        script.chmod(0o700)
        (self.ops / "flota.json").write_text(json.dumps({"fleet": {alias: {"enabled": True} for alias in VALID}}))
        output = self.root / "identity-output"
        env = {"CAUCE_CLIENT_CA_CERT": str(self.root / "absent-ca.crt"),
               "CAUCE_CLIENT_CA_KEY": str(self.root / "absent-ca.key")}
        for alias in (*VALID, *INVALID):
            with self.subTest(alias=alias):
                result = self.run_script(str(script), alias, str(output), env=env)
                self.assertEqual(result.returncode, 2)
                expected = "CA cert must" if alias in VALID else "invalid alias"
                self.assertIn(expected, result.stderr)
                self.assertFalse(output.exists())

    def test_pin_alias_validation_precedes_existing_cas_guards(self):
        pin = module("compatibility_pin", "pin-container-release.py")
        for alias in (*VALID, *INVALID):
            arguments = ["pin", alias, "--release", "new", "--sha256", "sha256:" + "a" * 64,
                         "--expected-release", "invalid!", "--expected-sha256", "sha256:" + "b" * 64,
                         "--config-root", str(self.root / "config"), "--bundle-root", str(self.root / "bundles")]
            with self.subTest(alias=alias), patch.object(sys, "argv", ["pin", *arguments]):
                with patch.object(pin, "load_container_aliases", return_value={alias: {}}):
                    expected = "expected release name" if alias in VALID else "adapter alias"
                    with self.assertRaisesRegex(pin.PinError, expected):
                        pin.main()
                self.assertFalse((self.root / "config").exists())
                self.assertFalse((self.root / "bundles").exists())

    def test_update_alias_cli_and_backup_journal_accept_the_same_alias_limits(self):
        update = module("compatibility_update", "update-alias-config.py")
        import update_alias_lib

        for alias in (*VALID, *INVALID):
            with self.subTest(alias=alias):
                backup = alias + "." + "a" * 64 + "." + "1" * 16 + "." + "b" * 16 + ".env"
                matched = update_alias_lib.BACKUP_RE.fullmatch(backup)
                self.assertEqual(matched is not None, alias in VALID)
                if matched:
                    self.assertEqual(matched.group("alias"), alias)
                with patch.object(update, "load_inventory", side_effect=RuntimeError("inventory reached")):
                    if alias in VALID:
                        with self.assertRaisesRegex(RuntimeError, "inventory reached"):
                            update.main(["inspect", "--alias", alias])
                    else:
                        with self.assertRaisesRegex(update.ConfigUpdateError, "formato invalido"):
                            update.main(["inspect", "--alias", alias])

    def test_config_separation_remains_a_pure_plan_for_canonical_aliases(self):
        for alias in (*VALID, *INVALID):
            with self.subTest(alias=alias):
                result = self.run_script("node", str(SCRIPTS / "separar-config-alias.mjs"),
                                         "--alias", alias, "--home", str(self.root / "profile"), "--arnes", "codex")
                self.assertEqual(result.returncode, 0 if alias in VALID else 2)
                if alias in VALID:
                    plan = json.loads(result.stdout)
                    self.assertEqual(plan["alias"], alias)
                    self.assertIn("/config/" + alias + "/.codex", plan["directorioDestino"])
                    self.assertEqual(plan["borrados"], [])
                    auth = next(item for item in plan["copias"] if item["origen"].endswith("/auth.json"))
                    self.assertEqual(auth["tipo"], "enlace")
                self.assertFalse((self.root / "profile").exists())

    def test_hermes_alias_validation_precedes_harness_and_runtime_guards(self):
        entry = {"tenant": "EmpresaNueva", "room": "Sala propia", "container": "own-container",
                 "user": "dev", "home": "/home/dev", "stateDirectory": "/state/own",
                 "harness": "codex", "membershipRole": "agent", "systemdUser": "stev"}
        document = {"schemaVersion": 2, "systemPrincipals": {}, "historicalAliases": {},
                    "aliases": {alias: entry for alias in VALID}}
        (self.ops / "container-aliases.json").write_text(json.dumps(document))
        (self.ops / "hermes-runtime.json").write_text("{}")
        for alias in (*VALID, *INVALID):
            with self.subTest(alias=alias):
                result = self.run_script("bash", str(SCRIPTS / "provision-hermes-runtime.sh"), "--check", alias,
                                         env={"CAUCE_CONTAINER_OPS_ROOT": str(self.ops)})
                self.assertEqual(result.returncode, 2)
                expected = "no usa Hermes" if alias in VALID else "alias inválido"
                self.assertIn(expected, result.stderr)
        self.assertFalse((self.root / "locks").exists())


if __name__ == "__main__":
    unittest.main()
