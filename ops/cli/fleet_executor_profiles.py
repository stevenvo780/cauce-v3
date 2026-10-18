from __future__ import annotations

import argparse
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys

from fleet_executor_view import open_directory


def ensure_private(parent: int, name: str, uid: int, gid: int, *, initialize_empty: bool = False) -> int:
    created = False
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent)
        created = True
    except FileExistsError:
        pass
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        details = os.fstat(directory)
        if created or initialize_empty and details.st_uid == 0 and not os.listdir(directory):
            if (uid, gid) != (os.geteuid(), os.getegid()):
                if os.geteuid() != 0:
                    raise ValueError('profile executor cannot use the exact runtime owner')
                os.fchown(directory, uid, gid)
            os.fchmod(directory, 0o700)
            details = os.fstat(directory)
        if details.st_uid != uid or details.st_gid != gid or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError('provider profile directory owner or privacy differs')
        return directory
    except BaseException:
        os.close(directory)
        raise


def prepare_empty_profile(root: str, profile: str, uid: int, gid: int, *, initialize_empty: bool = False, provider: str | None = None):
    root_path, destination = pathlib.Path(root), pathlib.Path(profile)
    if any(not value.startswith('/') or str(pathlib.PurePosixPath(value)) != value or '..' in pathlib.PurePosixPath(value).parts
            or any(ord(char) < 32 for char in value) for value in (root, profile)) or uid <= 0 or gid <= 0 \
            or not destination.is_relative_to(root_path) or len(destination.relative_to(root_path).parts) != 2 \
            or provider not in {None, 'grok', 'muse'}:
        raise ValueError('invalid separate provider profile destination')
    runtime, account = destination.relative_to(root_path).parts
    if re.fullmatch(r'[a-z][a-z0-9-]{0,63}', runtime) is None or re.fullmatch(r'[0-9a-f]{64}', account) is None:
        raise ValueError('provider profile destination identity is not canonical')
    parent = open_directory(root_path.parent)
    try:
        current = ensure_private(parent, root_path.name, uid, gid, initialize_empty=initialize_empty)
    finally:
        os.close(parent)
    try:
        for component in destination.relative_to(root_path).parts:
            following = ensure_private(current, component, uid, gid)
            os.close(current)
            current = following
        if provider == 'muse':
            for component in ('config', 'data'):
                os.close(ensure_private(current, component, uid, gid))
        os.fsync(current)
    finally:
        os.close(current)


PREPARE_EXTENSION_TIMEOUT = 240
OPERATION_ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def extension_packet(agent: dict, binding: dict) -> bytes:
    packet = {'agent': {key: value for key, value in agent.items() if not str(key).startswith('_')},
              'profile': binding['path'], 'state': agent.get('state_directory')}
    body = json.dumps(packet).encode()
    if len(body) > 262144:
        raise ValueError('extension prepare packet exceeds its bound')
    return body


def accept_extension_receipt(agent: dict, raw: bytes) -> dict:
    from fleet_provider_identity import RECEIPT_KEYS, extensions_sha256
    if len(raw) > 8192:
        raise ValueError('extension receipt exceeds its bound')
    receipt = json.loads(raw)
    rows = agent.get('extensions') or []
    if not isinstance(receipt, dict) or set(receipt) - RECEIPT_KEYS \
            or receipt.get('extensions_sha256') != extensions_sha256(rows if isinstance(rows, list) else []) \
            or any(key in receipt for key in ('nonce', 'identity', 'account_id')):
        raise ValueError('extension receipt is not bound to the extensions')
    text = raw.decode()
    if 'PRIVATE KEY' in text or 'BEGIN ' in text:
        raise ValueError('extension receipt contains private key material')
    return receipt


def remember_extension_receipt(policy: dict, agent: dict, receipt: dict) -> None:
    operation_id = agent.get('_operation_id')
    root = policy.get('roots', {}).get('state') if isinstance(policy.get('roots'), dict) else None
    if not isinstance(operation_id, str) or OPERATION_ID.fullmatch(operation_id) is None or not isinstance(root, str):
        return
    directory = pathlib.Path(root) / 'operations' / operation_id
    if not directory.is_dir():
        return
    temporary = directory / '.extension-receipt.json.tmp'
    body = (json.dumps(receipt, sort_keys=True) + '\n').encode()
    temporary.write_bytes(body)
    os.chmod(temporary, 0o600)
    os.replace(temporary, directory / 'extension-receipt.json')


def run_extension_prepare(policy: dict, agent: dict, binding: dict, identity: dict | None = None) -> dict:
    """Prepare every harness before the adapter starts. The timeout is independent of the probe deadline."""
    packet = extension_packet(agent, binding)
    script = pathlib.Path(__file__).with_name('fleet_provider_identity.py')
    if agent['runtime_mode'] == 'native':
        user = pwd.getpwnam(agent['runtime_user'])
        command = [str(pathlib.Path(sys.executable).resolve()), str(script), '--prepare-extensions']
        if user.pw_uid != os.geteuid():
            if os.geteuid() != 0:
                raise ValueError('extension prepare executor differs from the runtime owner')
            command = ['/usr/sbin/runuser', '-u', agent['runtime_user'], '--', *command]
        result = subprocess.run(command, input=packet, capture_output=True, timeout=PREPARE_EXTENSION_TIMEOUT,
                                env={'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory'], 'PYTHONDONTWRITEBYTECODE': '1'},
                                check=False)
        if result.returncode:
            raise ValueError('extension prepare failed')
        receipt = accept_extension_receipt(agent, result.stdout)
    else:
        from fleet_executor_container import (
            DOCKER,
            EXECUTOR_DESTINATION,
            checked_command,
            identity_for,
            inspect_container,
        )
        runtime = identity if identity is not None else identity_for(agent, inspect_container(agent['container_name']))
        stdout = checked_command([DOCKER, 'exec', '-i', '--user', agent['runtime_user'], '--env', 'PYTHONDONTWRITEBYTECODE=1',
            runtime['container_id'], agent['_placement']['python'], f'{EXECUTOR_DESTINATION}/fleet_provider_identity.py',
            '--prepare-extensions'], input_data=packet, timeout=PREPARE_EXTENSION_TIMEOUT)
        receipt = accept_extension_receipt(agent, stdout)
    remember_extension_receipt(policy, agent, receipt)
    return receipt


def prepare_profile(policy: dict, raw_agent: dict):
    from fleet_executor_policy import approve_agent
    from fleet_executor_templates import resolve_profile, resolved_template
    agent = approve_agent(policy, raw_agent)
    account = agent.get('primary_account_id')
    if account is None:
        if agent.get('extensions'):
            raise ValueError('extension prepare requires the provider profile')
        return None
    binding = resolve_profile(policy, agent)
    dynamic = account not in policy['profiles']
    if not dynamic and 'openclaw' not in binding:
        return run_extension_prepare(policy, agent, binding)
    template = resolved_template(policy, agent, binding['provider']) if dynamic else None
    if agent['runtime_mode'] == 'native':
        from fleet_runtime_materialization import external_directory
        if dynamic:
            external_directory(pathlib.Path(template['path_root']))
            user = pwd.getpwnam(agent['runtime_user'])
            prepare_empty_profile(template['path_root'], binding['path'], user.pw_uid, user.pw_gid,
                **({'provider': 'muse'} if binding['provider'] == 'muse' else {}))
        prepare_openclaw(binding, agent)
        return run_extension_prepare(policy, agent, binding)
    from fleet_executor_container import (
        DOCKER,
        EXECUTOR_DESTINATION,
        checked_command,
        docker,
        identity_for,
        inspect_container,
        user_identity,
        validate_container,
    )
    observed = inspect_container(agent['container_name'])
    validate_container(policy, agent, observed)
    identity = identity_for(agent, observed)
    uid, gid = user_identity(agent, identity)
    if dynamic:
        docker('exec', '--user', '0', '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'], agent['_placement']['python'],
            f'{EXECUTOR_DESTINATION}/fleet_executor_profiles.py', '--root', template['path_root'], '--profile', binding['path'],
            '--uid', uid, '--gid', gid, '--initialize-empty', *(['--provider', 'muse'] if binding['provider'] == 'muse' else []))
    if 'openclaw' in binding:
        checked_command([DOCKER, 'exec', '-i', '--user', agent['runtime_user'], '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'],
            agent['_placement']['python'], f'{EXECUTOR_DESTINATION}/fleet_provider_openclaw.py', '--prepare'],
            input_data=json.dumps({'profile_binding': binding, 'agent': {key: value for key, value in agent.items() if not key.startswith('_')}}).encode())
    return run_extension_prepare(policy, agent, binding, identity)


def prepare_openclaw(binding: dict, agent: dict):
    if 'openclaw' not in binding:
        return
    user = pwd.getpwnam(agent['runtime_user'])
    command = [str(pathlib.Path(sys.executable).resolve()), str(pathlib.Path(__file__).with_name('fleet_provider_openclaw.py')), '--prepare']
    if user.pw_uid != os.geteuid():
        if os.geteuid() != 0:
            raise ValueError('OpenClaw profile executor differs from the exact runtime owner')
        command = ['/usr/sbin/runuser', '-u', agent['runtime_user'], '--', *command]
    packet = {'profile_binding': binding, 'agent': {key: value for key, value in agent.items() if not key.startswith('_')}}
    result = subprocess.run(command, input=json.dumps(packet).encode(), capture_output=True, timeout=10,
                            env={'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory'], 'PYTHONDONTWRITEBYTECODE': '1'}, check=False)
    if result.returncode:
        raise ValueError('OpenClaw exact private configuration preparation failed')


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--root', required=True)
        parser.add_argument('--profile', required=True)
        parser.add_argument('--uid', type=int, required=True)
        parser.add_argument('--gid', type=int, required=True)
        parser.add_argument('--initialize-empty', action='store_true')
        parser.add_argument('--provider', choices=('grok', 'muse'))
        args = parser.parse_args()
        prepare_empty_profile(args.root, args.profile, args.uid, args.gid, initialize_empty=args.initialize_empty, provider=args.provider)
    except Exception:
        raise SystemExit('provider profile preparation was not verified') from None
