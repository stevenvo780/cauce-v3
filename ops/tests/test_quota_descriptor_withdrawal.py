import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import sys
from unittest.mock import patch

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXECUTOR = ROOT / 'ops/cli/fleet-executor.py'


@pytest.mark.parametrize('mutation', ['invalid_json', 'missing', 'no_quota', 'changed_bytes'])
def test_fresh_executor_withdraws_changed_descriptor_and_recovers(tmp_path, mutation):
    sys.path.insert(0, str(ROOT / 'ops/cli'))
    from fleet_executor_runtime import bundle_digest
    roots = {}
    for name in ('state', 'runtime', 'pki', 'tokens', 'identities'):
        directory = tmp_path / name
        directory.mkdir(mode=0o700)
        roots[name] = str(directory)
    bundle = tmp_path / 'bundle'
    descriptors = bundle / 'packages/adapter-sdk/dist/descriptors'
    descriptors.mkdir(parents=True, mode=0o700)
    descriptor = descriptors / 'codex.json'
    approved = (ROOT / 'packages/adapter-sdk/descriptors/codex.json').read_bytes()
    descriptor.write_bytes(approved)
    descriptor.chmod(0o600)
    policy = {'schemaVersion': 1, 'host_id': 'fixture-host', 'executor_user': pwd.getpwuid(os.geteuid()).pw_name,
              'roots': roots, 'native': [], 'containers': {}, 'profiles': {}, 'hooks': {},
              'bundles': {'codex': {'directory': str(bundle), 'digest': bundle_digest(str(bundle)),
                  'executable': '/usr/local/bin/codex', 'executable_sha256': None, 'argv': [],
                  'descriptor_sha256': hashlib.sha256(approved).hexdigest()}},
              'quota_environments': {'image': 'sha256:' + 'a' * 64, 'network': 'fixture', 'providers': ['codex']}}
    policy_file = tmp_path / 'policy.json'
    policy_file.write_text(json.dumps(policy))
    policy_file.chmod(0o600)

    def capabilities():
        response = subprocess.run([sys.executable, '-B', str(EXECUTOR), '--policy', str(policy_file), '--capabilities'],
                                  capture_output=True, text=True, timeout=15, check=False)
        assert response.returncode == 0, response.stderr
        assert response.stderr == ''
        return json.loads(response.stdout)['quota_environments']

    original = capabilities()
    assert original == {'providers': ['codex'], 'actions': {'codex': ['create', 'authenticate', 'query', 'update_cli', 'delete']}}
    if mutation == 'missing':
        descriptor.unlink()
    elif mutation == 'invalid_json':
        descriptor.write_text('{')
    elif mutation == 'no_quota':
        changed = json.loads(approved)
        del changed['operations']['quota']
        del changed['provider']['quota_argv']
        descriptor.write_text(json.dumps(changed))
    else:
        descriptor.write_bytes(approved + b'\n')
    assert capabilities() == {'providers': [], 'actions': {}}
    descriptor.write_bytes(approved)
    descriptor.chmod(0o600)
    assert capabilities() == original


def test_changed_pin_rejects_create_before_any_container_inspection_or_effect(tmp_path):
    sys.path.insert(0, str(ROOT / 'ops/cli'))
    import quota_runtime as runtime
    from fleet_executor_runtime import bundle_digest
    descriptors = tmp_path / 'packages/adapter-sdk/dist/descriptors'
    descriptors.mkdir(parents=True)
    descriptor = descriptors / 'codex.json'
    approved = (ROOT / 'packages/adapter-sdk/descriptors/codex.json').read_bytes()
    descriptor.write_bytes(approved + b'\n')
    bundle = {'directory': str(tmp_path), 'digest': bundle_digest(str(tmp_path)),
              'executable': '/usr/local/bin/codex', 'executable_sha256': None, 'argv': [],
              'descriptor_sha256': hashlib.sha256(approved).hexdigest()}
    with patch.object(runtime, 'inspect_container', side_effect=AssertionError('unexpected container inspection')) as inspect, \
            patch.object(runtime, 'docker', side_effect=AssertionError('unexpected physical effect')) as execute:
        with pytest.raises(runtime.SafeFailure, match='quota provider operation or pinned descriptor is unavailable') as rejected:
            runtime.create({'bundles': {'codex': bundle}}, {'provider': 'codex'})
    assert str(rejected.value.__cause__) == 'approved harness descriptor changed'
    inspect.assert_not_called()
    execute.assert_not_called()
