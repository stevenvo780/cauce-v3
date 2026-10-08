#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import os
import pathlib
import pwd
import subprocess
import sys

from fleet_adoption_probe_policy import ProbeFailure, digest_file, load_policy, open_directory
from fleet_adoption_probe_supervisor import verify_control


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {'start', 'stop'}:
        raise ProbeFailure('invalid_native_command')
    filename = os.environ.get('CAUCE_ADOPTION_PROBE_POLICY_FILE')
    if not filename:
        raise ProbeFailure('native_policy_unavailable')
    policy = load_policy(filename)
    rows = [row for row in policy['targets'] if row['runtime_key'] == sys.argv[2]]
    if len(rows) != 1:
        raise ProbeFailure('native_target_ambiguous')
    row = rows[0]
    placement, observation = row['placement'], row['observation']
    user = pwd.getpwnam(placement['runtime_user'])
    if placement['mode'] != 'native' or user.pw_uid != os.geteuid() or user.pw_uid == 0 \
            or placement.get('systemd_user') != user.pw_name or os.environ.get('HOME') != placement['home_directory']:
        raise ProbeFailure('native_execution_identity_changed')
    for path, pin in observation['pins'].items():
        if digest_file(path) != pin:
            raise ProbeFailure('native_lifecycle_changed')
    if digest_file(os.path.realpath(observation['node_command'])) != observation['node_sha256'] \
            or digest_file(observation['adapter_entry']) != observation['adapter_sha256']:
        raise ProbeFailure('native_command_changed')
    control = pathlib.Path(observation['control_directory'])
    parent = open_directory(str(control.parent))
    try:
        details = os.fstat(parent)
        if details.st_uid != os.geteuid() or details.st_mode & 0o077:
            raise ProbeFailure('native_control_parent_unavailable')
        if sys.argv[1] == 'start':
            try:
                os.mkdir(control.name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
    finally:
        os.close(parent)
    host = hashlib.sha256(('host:' + policy['host_id']).encode()).hexdigest()
    boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    generation = hashlib.sha256((host + '\0' + boot + '\0' + placement['state_directory']).encode()).hexdigest()
    helper = str(pathlib.Path(observation['lifecycle_directory']) / 'cauce-container-runtime.py')
    base = [sys.executable, helper, 'run' if sys.argv[1] == 'start' else 'stop', '--alias', row['runtime_key'],
        '--state', placement['state_directory'], '--control-dir', str(control), '--container-id', host, '--generation', generation]
    if sys.argv[1] == 'stop':
        descriptor = os.environ.get('CAUCE_ADOPTION_CONTROL_FD', '')
        if not descriptor.isdecimal():
            raise ProbeFailure('native_stop_requires_control_lease')
        verify_control(int(descriptor), row['supervisor']['socket'], row['target'])
        return subprocess.run(base, check=False).returncode
    environment = dict(os.environ, CAUCE_ALIAS=row['target']['alias'], CAUCE_RUNTIME_KEY=row['runtime_key'],
        CAUCE_TENANT_ID=row['target']['tenant_id'], CAUCE_TENANT=row['target']['tenant_id'],
        CAUCE_STATE_DIR=placement['state_directory'], CAUCE_CONTROL_DIR=str(control),
        CAUCE_CONTAINER_ID=host, CAUCE_CONTAINER_GENERATION=generation, CAUCE_ADOPTION_LIFECYCLE_FENCE='1')
    for destination, source in {'CAUCE_RELAY_URL': 'CAUCE_RELAY_URL_ENV', 'CAUCE_TOKEN_FILE': 'CAUCE_TOKEN_PATH_ENV',
            'CAUCE_TLS_CERT_FILE': 'CAUCE_CERT_PATH_ENV', 'CAUCE_TLS_KEY_FILE': 'CAUCE_KEY_PATH_ENV',
            'CAUCE_TLS_CA_FILE': 'CAUCE_CA_PATH_ENV'}.items():
        selector = environment.get(source)
        if selector is not None:
            if not selector.replace('_', '').isalnum() or not environment.get(selector):
                raise ProbeFailure('native_transport_environment_unavailable')
            environment[destination] = environment[selector]
    base.extend(['--wire-alias', row['target']['alias'], '--tenant', row['target']['tenant_id'],
        '--runtime-uid', str(user.pw_uid), '--runtime-gid', str(user.pw_gid), '--bundle', observation['bundle_directory'],
        '--bundle-digest', observation['bundle_digest'], os.path.realpath(observation['node_command']), observation['adapter_entry']])
    os.execvpe(sys.executable, base, environment)
    raise ProbeFailure('native_exec_returned')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ProbeFailure, OSError, ValueError, KeyError):
        print('native adoption launcher is unavailable', file=sys.stderr)
        raise SystemExit(2) from None
