import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock
from test_fleet_runtime_materialization import dynamic_source
from fleet_runtime_materialization import materialize

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('fleet_runtime_apply', SCRIPTS / 'fleet_runtime_apply.py')
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FleetRuntimeApplyTests(unittest.TestCase):
    def test_real_generation_application_checks_every_artifact(self):
        with tempfile.TemporaryDirectory(dir="/var/tmp") as directory:
            state = pathlib.Path(directory)
            receipt = materialize(dynamic_source(), {}, state)
            applied = module.publish_applied(state, receipt['generation'], None)
            self.assertEqual(module.load_applied_fleet(state), applied)
            artifact = state / 'generations' / receipt['generation'] / 'flota.json'
            artifact.write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                module.publish_applied(state, receipt['generation'], receipt['generation'])
    def test_publishes_only_verified_exact_generation_with_cas(self):
        with tempfile.TemporaryDirectory(dir="/var/tmp") as directory:
            state = pathlib.Path(directory)
            receipt = {'schemaVersion': 1, 'generation': 'a' * 64, 'snapshotSha256': 'b' * 64,
                       'files': {'flota.json': 'b' * 64}}
            with mock.patch.object(module, 'load_desired_fleet', return_value=receipt):
                try:
                    result = module.publish_applied(state, 'a' * 64, None)
                except ValueError as error:
                    self.fail(str(error))
                self.assertEqual(result, receipt)
                self.assertEqual(json.loads((state / 'applied-fleet.json').read_bytes()), receipt)
                with mock.patch.object(module, 'load_applied_fleet', return_value=receipt):
                    self.assertEqual(module.publish_applied(state, 'a' * 64, 'a' * 64), receipt)
                    with mock.patch.object(module, 'load_desired_fleet', return_value={**receipt, 'generation': 'b' * 64}):
                        with self.assertRaises(ValueError):
                            module.publish_applied(state, 'b' * 64, 'c' * 64)
    def test_rejects_desired_swap_and_failed_integrity_without_publication(self):
        with tempfile.TemporaryDirectory(dir="/var/tmp") as directory:
            state = pathlib.Path(directory)
            with mock.patch.object(module, 'load_desired_fleet', return_value={'generation': 'b' * 64}):
                with self.assertRaises(ValueError):
                    module.publish_applied(state, 'a' * 64, None)
            with mock.patch.object(module, 'load_desired_fleet', side_effect=ValueError('integrity failed')):
                with self.assertRaises(ValueError):
                    module.publish_applied(state, 'a' * 64, None)
            self.assertFalse((state / 'applied-fleet.json').exists())
    def test_rejects_symlink_receipt_and_lock_before_opening(self):
        with tempfile.TemporaryDirectory(dir="/var/tmp") as directory, tempfile.TemporaryDirectory(dir="/var/tmp") as victim:
            state = pathlib.Path(directory)
            receipt = {'generation': 'a' * 64}
            target = pathlib.Path(victim) / 'private'; target.write_bytes(b'untouched')
            with mock.patch.object(module, 'load_desired_fleet', return_value=receipt):
                for name in ['applied-fleet.json', '.fleet-apply.lock']:
                    link = state / name; link.symlink_to(target)
                    with self.assertRaises((OSError, ValueError)):
                        module.publish_applied(state, 'a' * 64, None)
                    link.unlink()
            self.assertEqual(target.read_bytes(), b'untouched')
