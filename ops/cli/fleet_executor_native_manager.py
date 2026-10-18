from __future__ import annotations

import json
import os
import pathlib
import pwd
import subprocess

from fleet_adoption_probe_policy import load_policy as load_adoption_policy
from fleet_adoption_probe_policy import select
from fleet_executor_pki import checked_file
from fleet_executor_policy import SafeFailure, digest, path, private_directory

LAUNCH_FILE = 'native-executor-environment.json'


def systemctl(*arguments: str) -> str:
    runtime = pathlib.Path('/run/user') / str(os.geteuid())
    private_directory(str(runtime))
    environment = {'PATH': '/usr/bin:/bin', 'HOME': pwd.getpwuid(os.geteuid()).pw_dir,
                   'XDG_RUNTIME_DIR': str(runtime), 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + str(runtime / 'bus')}
    result = subprocess.run(['/usr/bin/systemctl', '--user', *arguments], capture_output=True, text=True,
                            timeout=60, check=False, env=environment)
    if result.returncode:
        raise SafeFailure('approved native systemd manager did not complete its operation')
    return result.stdout.strip()


def manager_for(policy: dict, agent: dict, identity: dict, bundle: dict | None = None) -> dict | None:
    manager = agent['_placement'].get('manager')
    if manager is None:
        if (identity['control'] / 'cauce-v3-adoption.sock').exists() or (identity['control'] / LAUNCH_FILE).exists():
            raise SafeFailure('adopted native supervisor requires an approved systemd manager')
        return None
    if not isinstance(manager, dict) or set(manager) != {'unit', 'files', 'adoption_policy'} \
            or manager['unit'] != 'cauce-v3-alias-' + agent['runtime_key'] + '.service' \
            or agent['_placement'].get('runtime_key') != agent['runtime_key'] \
            or agent['runtime_user'] != policy['executor_user'] or agent['systemd_user'] != policy['executor_user'] \
            or pwd.getpwnam(agent['runtime_user']).pw_uid != os.geteuid() or os.geteuid() == 0:
        raise SafeFailure('native systemd manager identity is not approved')
    properties = dict(line.split('=', 1) for line in systemctl('show', manager['unit'],
        '--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload').splitlines())
    files = manager['files']
    actual = {properties.get('FragmentPath', ''), *properties.get('DropInPaths', '').split()}
    if properties.get('LoadState') != 'loaded' or properties.get('NeedDaemonReload') != 'no' \
            or not isinstance(files, dict) or not files or set(files) != actual \
            or any(digest(path(filename)) != pin for filename, pin in files.items()):
        raise SafeFailure('native systemd unit files changed')
    row = select(load_adoption_policy(manager['adoption_policy']),
                 {key: agent[key] for key in ('tenant_id', 'alias')})
    placement, observation = row['placement'], row['observation']
    if row['runtime_key'] != agent['runtime_key'] or row['harness_id'] != agent['harness_id'] \
            or placement['mode'] != 'native' or any(placement.get(key) != agent.get(key)
                for key in ('host_id', 'runtime_user', 'systemd_user', 'home_directory', 'state_directory')) \
            or observation['control_directory'] != str(identity['control']) \
            or bundle is not None and (observation['bundle_directory'] != bundle['directory']
                or observation['bundle_digest'] != bundle['digest']
                or os.path.realpath(observation['node_command']) != os.path.realpath(bundle['executable'])
                or bundle['argv'] != [observation['adapter_entry']]):
        raise SafeFailure('native systemd launcher differs from its approved runtime')
    environment = systemctl('show', manager['unit'], '--property=Environment', '--value')
    expected = 'CAUCE_NATIVE_EXECUTOR_ENVIRONMENT=' + str(identity['control'] / LAUNCH_FILE)
    if expected not in environment.split():
        raise SafeFailure('native systemd launcher has no private executor environment')
    return manager


def publish_environment(identity: dict, agent: dict, environment: dict | None) -> None:
    from atomic_file import atomic_write
    private_directory(str(identity['control']))
    document = {'schemaVersion': 1, 'target': {key: agent[key] for key in ('tenant_id', 'alias')},
                'runtime_key': agent['runtime_key'], 'environment': environment}
    atomic_write(identity['control'] / LAUNCH_FILE, json.dumps(document, sort_keys=True), mode=0o600)


def launch_environment(row: dict, filename: str) -> dict | None:
    expected = pathlib.Path(row['observation']['control_directory']) / LAUNCH_FILE
    if path(filename) != expected:
        raise SafeFailure('native launch environment path changed')
    private_directory(str(expected.parent))
    document = json.loads(checked_file(expected, private=True))
    if not isinstance(document, dict) or set(document) != {'schemaVersion', 'target', 'runtime_key', 'environment'} \
            or document['schemaVersion'] != 1 or document['target'] != row['target'] or document['runtime_key'] != row['runtime_key']:
        raise SafeFailure('native launch environment identity changed')
    environment = document['environment']
    if environment is not None and (not isinstance(environment, dict) or not environment
            or any(not isinstance(key, str) or not isinstance(value, str) or '\0' in key + value
                   or key not in {'PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME'}
                   and not key.startswith('CAUCE_') for key, value in environment.items())):
        raise SafeFailure('native launch environment is invalid')
    if environment is not None and (environment.get('HOME') != row['placement']['home_directory']
            or environment.get('CAUCE_STATE_DIR') != row['placement']['state_directory']
            or environment.get('CAUCE_RUNTIME_KEY') != row['runtime_key']):
        raise SafeFailure('native launch environment placement changed')
    return environment
