from __future__ import annotations

import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'scripts'))
namespace_spec = importlib.util.spec_from_file_location("instance_namespace", OPS / "scripts/instance_namespace.py")
namespace = importlib.util.module_from_spec(namespace_spec)
namespace_spec.loader.exec_module(namespace)
unit_prefix = namespace.unit_prefix
validate_installation_id = namespace.validate_installation_id


class InstanceNamespaceTests(unittest.TestCase):
    def test_default_preserves_units(self):
        self.assertEqual(unit_prefix(None), 'cauce-v3')
        self.assertEqual(unit_prefix('empresa-a'), 'cauce-empresa-a')

    def test_unsafe_identifiers_fail_before_use(self):
        for value in ('', '../a', 'a/b', 'A', 'a\nEnvironment=bad', 'a b', 'a' * 49):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_installation_id(value)

    def test_same_alias_uses_independent_locks(self):
        spec = importlib.util.spec_from_file_location('alias_lock', OPS / 'scripts/alias-lock-exec.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with patch.dict(os.environ, {'CAUCE_INSTALLATION_ID': 'empresa-a'}):
                a = module.open_locks(root, 'operador')
                module_env = {module.FD_ENV: str(a[0]), module.LEGACY_FD_ENV: str(a[1]), module.ALIAS_ENV: 'operador'}
                with patch.dict(os.environ, module_env):
                    module.verify_inherited(root, 'operador')
                with self.assertRaises(module.LockError):
                    module.open_locks(root, 'operador')
            with patch.dict(os.environ, {'CAUCE_INSTALLATION_ID': 'empresa-b'}):
                b = module.open_locks(root, 'operador')
                self.assertNotEqual(os.fstat(a[0]).st_ino, os.fstat(b[0]).st_ino)
            for fd in (*a, *b):
                os.close(fd)

    def test_unit_generation_separates_inventory_and_code(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / 'units'
            result = subprocess.run([sys.executable, str(OPS / 'scripts/generate-container-units.py'), '--rootless', '--instance-id', 'empresa-a', '--inventory-prefix', '/srv/company-a/inventory/ops', '--install-prefix', '/srv/cauce-release', '--output', str(target), '--no-profile-expectation'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            units = list(target.glob('cauce-empresa-a-container-*.service'))
            self.assertTrue(units)
            self.assertFalse(list(target.glob('cauce-v3-container-*.service')))
            for unit in units:
                text = unit.read_text()
                self.assertIn('CAUCE_CONTAINER_OPS_ROOT=/srv/company-a/inventory/ops', text)
                self.assertIn('CAUCE_CONTAINER_CODE_ROOT=/srv/cauce-release/ops', text)
                self.assertIn('CAUCE_INSTALLATION_ID=empresa-a', text)

    def test_unit_path_injection_fails_before_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "units"
            result = subprocess.run([sys.executable, str(OPS / "scripts/generate-container-units.py"), "--output", str(output), "--inventory-prefix", "/srv/x\\nEnvironment=ATTACK=1"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_native_unit_does_not_create_global_state_for_private_root(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            result = subprocess.run([sys.executable, str(OPS / "scripts/generate-units.py"), "--instance-id", "empresa-a", "--state-root", "/srv/company-a/state/aliases", "--output", str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for generated in output.glob("*.service"):
                unit = generated.read_text()
                self.assertNotIn("StateDirectory=", unit)
                self.assertIn("CAUCE_INSTALLATION_STATE_ROOT=/srv/company-a/state/aliases", unit)
                self.assertIn("ReadWritePaths=/srv/company-a/state/aliases/", unit)

    def test_native_default_unit_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            result = subprocess.run([sys.executable, str(OPS / "scripts/generate-units.py"), "--output", str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for expected in (OPS / "generated/systemd").glob("cauce-v3-alias-*.service"):
                self.assertEqual((output / expected.name).read_bytes(), expected.read_bytes(), expected.name)

    def test_missing_descriptor_rejects_before_operating(self):
        result = subprocess.run(["bash", str(OPS / "cli/cauce"), "--instance-config", "/absent/config.json", "operador", "on"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid instance selection", result.stderr)

    def test_installed_cli_uses_distribution_selector(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            installed = home / "bin"
            installed.mkdir()
            cli = installed / "cauce"
            cli.write_bytes((OPS / "cli/cauce").read_bytes())
            getent = installed / "getent"
            getent.write_text("#!/bin/sh\nprintf 'fixture:x:1000:1000::%s:/bin/bash\\n' \"$CAUCE_TEST_OPERATOR_HOME\"\n")
            getent.chmod(0o755)
            distribution = home / ".local/share/cauce-v3"
            distribution.mkdir(parents=True)
            (distribution / "ops").symlink_to(OPS, target_is_directory=True)
            environment = {**os.environ, "CAUCE_TEST_OPERATOR_HOME": str(home), "PATH": str(installed) + ":" + os.environ["PATH"]}
            environment.pop("CAUCE_INSTALLATION_ID", None)
            environment.pop("CAUCE_INSTANCE_CONFIG", None)
            result = subprocess.run(["bash", str(cli), "--instance-config", "/absent/config.json", "operador", "on"], env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("invalid instance selection", result.stderr)
            self.assertNotIn("can't open file", result.stderr)

    def test_installation_without_descriptor_rejects_before_operating(self):
        environment = {**os.environ, "CAUCE_INSTALLATION_ID": "empresa-a"}
        environment.pop("CAUCE_INSTANCE_CONFIG", None)
        result = subprocess.run(["bash", str(OPS / "cli/cauce"), "operador", "on"], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--instance-config", result.stderr)

    def test_default_unit_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory)
            result = subprocess.run([sys.executable, str(OPS / 'scripts/generate-container-units.py'), '--rootless', '--output', str(target)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for expected in (OPS / 'generated/container-systemd/rootless').glob('*.service'):
                self.assertEqual((target / expected.name).read_bytes(), expected.read_bytes(), expected.name)


if __name__ == '__main__':
    unittest.main()
