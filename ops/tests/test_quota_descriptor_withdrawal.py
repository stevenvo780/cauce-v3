import copy
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


def _changed_pin_fixture(tmp_path):
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
    policy = {'host_id': 'fixture-host', 'executor_user': 'fixture-user', 'roots': {'runtime': '/fixture/runtime'},
              'bundles': {'codex': bundle},
              'quota_environments': {'image': 'sha256:' + 'a' * 64, 'network': 'fixture-network', 'providers': ['codex']}}
    environment = {'id': '1c647dc7-e3f3-4287-af89-7a6597e5a40c', 'company_id': 'fixture-company',
                   'account_id': 'fixture-account', 'host_id': 'fixture-host', 'provider': 'codex',
                   'container_name': 'cauce-quota-1c647dc7e3f34287af897a6597e5a40c'}
    document = {'operation_id': '2c647dc7-e3f3-4287-af89-7a6597e5a40c', 'action': 'create', 'consent': False,
                'environment': environment}
    return runtime, policy, environment, document


def test_changed_pin_rejects_perform_create_before_any_inspection_or_effect(tmp_path):
    runtime, policy, _environment, document = _changed_pin_fixture(tmp_path)
    with patch.object(runtime, 'inspect_container', side_effect=AssertionError('unexpected container inspection')) as inspect, \
            patch.object(runtime, 'docker', side_effect=AssertionError('unexpected physical effect')) as execute:
        with pytest.raises(runtime.SafeFailure, match='quota provider operation or pinned descriptor is unavailable') as rejected:
            runtime.perform(policy, document)
    assert str(rejected.value.__cause__) == 'approved harness descriptor changed'
    inspect.assert_not_called()
    execute.assert_not_called()


def test_changed_pin_rejects_perform_create_without_compensating_a_container_that_appears_between_inspections(tmp_path):
    runtime, policy, environment, document = _changed_pin_fixture(tmp_path)
    labels = runtime.labels(policy, environment)
    volume = environment['container_name'] + '-profile'
    observed = {'Id': 'fixture-container', 'Image': policy['quota_environments']['image'],
                'State': {'Running': True, 'StartedAt': '2026-01-01T00:00:00Z'},
                'Config': {'User': '1000:1000', 'Labels': labels},
                'Mounts': [{'Destination': '/home/node', 'Type': 'volume', 'Name': volume, 'RW': True},
                           {'Destination': '/cauce/executor', 'Type': 'bind', 'Source': str(runtime.EXECUTOR_SOURCE), 'RW': False},
                           {'Destination': '/cauce/lifecycle', 'Type': 'bind', 'Source': str(runtime.LIFECYCLE_SOURCE), 'RW': False}],
                'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'NetworkMode': 'fixture-network',
                               'Memory': 512 * 1024 * 1024, 'PidsLimit': 128, 'Tmpfs': dict(runtime.TMPFS),
                               'CapDrop': ['ALL'], 'CapAdd': list(runtime.CAPABILITIES), 'SecurityOpt': ['no-new-privileges']}}
    observations = iter([None, copy.deepcopy(observed), None])
    trace = []

    def inspect(name):
        trace.append(['inspect', name])
        return next(observations)

    def docker(*args):
        trace.append(list(args))
        if args[:2] == ('volume', 'ls'):
            return (volume + '\n').encode()
        if args[:2] == ('volume', 'inspect'):
            return json.dumps([{'Labels': labels}]).encode()
        if args == ('rm', '-f', environment['container_name']):
            return b''
        raise AssertionError(f'unexpected docker operation: {args}')

    with patch.object(runtime, 'inspect_container', side_effect=inspect), patch.object(runtime, 'docker', side_effect=docker):
        with pytest.raises(runtime.SafeFailure, match='quota provider operation or pinned descriptor is unavailable') as rejected:
            runtime.perform(policy, document)
    assert str(rejected.value.__cause__) == 'approved harness descriptor changed'
    assert trace == []


def test_pin_rejection_inside_creation_attempt_does_not_compensate(tmp_path):
    sys.path.insert(0, str(ROOT / 'ops/cli'))
    import quota_runtime as runtime
    from fleet_executor_runtime import bundle_digest
    descriptors = tmp_path / 'packages/adapter-sdk/dist/descriptors'
    descriptors.mkdir(parents=True)
    descriptor = descriptors / 'codex.json'
    approved = (ROOT / 'packages/adapter-sdk/descriptors/codex.json').read_bytes()
    descriptor.write_bytes(approved)
    bundle = {'directory': str(tmp_path), 'digest': bundle_digest(str(tmp_path)),
              'executable': '/usr/local/bin/codex', 'executable_sha256': None, 'argv': [],
              'descriptor_sha256': hashlib.sha256(approved).hexdigest()}
    policy = {'host_id': 'fixture-host', 'executor_user': 'fixture-user', 'roots': {'runtime': '/fixture/runtime'},
              'bundles': {'codex': bundle},
              'quota_environments': {'image': 'sha256:' + 'a' * 64, 'network': 'fixture-network', 'providers': ['codex']}}
    environment = {'id': '1c647dc7-e3f3-4287-af89-7a6597e5a40c', 'company_id': 'fixture-company',
                   'account_id': 'fixture-account', 'host_id': 'fixture-host', 'provider': 'codex',
                   'container_name': 'cauce-quota-1c647dc7e3f34287af897a6597e5a40c'}
    volume = environment['container_name'] + '-profile'
    with patch.object(runtime, 'inspect_container', return_value=None) as inspect, \
            patch.object(runtime, 'docker', return_value=(volume + '\n').encode()) as execute, \
            patch.object(runtime, 'create_runtime', side_effect=runtime.SafeFailure('quota provider operation or pinned descriptor is unavailable')), \
            patch.object(runtime, 'remove') as remove:
        with pytest.raises(runtime.SafeFailure, match='quota provider operation or pinned descriptor is unavailable'):
            runtime.create(policy, environment)
    remove.assert_not_called()
    assert inspect.call_count == 1
    assert execute.call_count == 1


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
