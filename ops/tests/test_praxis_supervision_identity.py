import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

PATH = pathlib.Path(__file__).resolve().parents[1] / 'instances/hospital/praxis-supervision-identity.py'
SPEC = importlib.util.spec_from_file_location('supervision_identity', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class IdentityAuthorityTest(unittest.TestCase):
    def test_active_monitor_pass_prevents_all_renewal_mutations(self):
        with mock.patch.object(MODULE.os, 'geteuid', return_value=0), \
                mock.patch.object(MODULE.pathlib.Path, 'open', mock.mock_open()), \
                mock.patch.object(MODULE.fcntl, 'flock', side_effect=BlockingIOError), \
                mock.patch.object(MODULE, 'maintain_identity') as maintain:
            self.assertEqual(MODULE.main(), 0)
            maintain.assert_not_called()

    def test_foreign_identity_added_during_signing_is_preserved(self):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        foreign = {'principal': {'alias': 'operador'}, 'certificate_sha256': 'b' * 64}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'registry.json'
            path.write_text(json.dumps({'version': 1, 'identities': [own, foreign]}))
            replacement = {**own, 'certificate_sha256': 'c' * 64}
            with mock.patch.object(MODULE, 'atomic_json') as write:
                MODULE.replace_owned_record(path, own, replacement, path.stat())
            self.assertEqual(write.call_args.args[1]['identities'][1], foreign)
            self.assertEqual(write.call_args.args[1]['identities'][0], replacement)

    def test_key_mismatch_prevents_registry_changes(self):
        with mock.patch.object(MODULE.subprocess, 'check_output', side_effect=[b'key-one', b'key-two']):
            with self.assertRaises(ValueError):
                MODULE.verify_owned_leaf(pathlib.Path('key'), pathlib.Path('cert'))

    def test_concurrent_change_of_service_authority_is_rejected(self):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'registry.json'
            path.write_text(json.dumps({'version': 1, 'identities': [{**own, 'certificate_sha256': 'b' * 64}]}))
            with self.assertRaises(ValueError):
                MODULE.replace_owned_record(path, own, {**own, 'certificate_sha256': 'c' * 64}, path.stat())

    def test_only_one_exact_service_authority_is_renewable(self):
        own = {'principal': dict(MODULE.PRINCIPAL), 'certificate_sha256': 'a' * 64}
        foreign = {'principal': {'alias': 'operador', 'permissions': ['read', 'route']}}
        document = {'version': 1, 'identities': [foreign, own]}
        self.assertIs(MODULE.validate_record(document), own)
        self.assertEqual(document['identities'][0], foreign)
        altered = {'version': 1, 'identities': [{**own, 'principal': {**own['principal'], 'permissions': ['control']}}]}
        with self.assertRaises(ValueError):
            MODULE.validate_record(altered)

    def test_ambiguous_or_missing_service_is_rejected(self):
        own = {'principal': dict(MODULE.PRINCIPAL)}
        for identities in ([], [own, own]):
            with self.assertRaises(ValueError):
                MODULE.validate_record({'version': 1, 'identities': identities})


if __name__ == '__main__':
    unittest.main()
