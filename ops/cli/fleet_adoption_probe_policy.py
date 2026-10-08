from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import stat


class ProbeFailure(ValueError):
    pass


def absolute(value: str) -> pathlib.Path:
    path = pathlib.Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts or any(ord(c) < 32 for c in value):
        raise ProbeFailure('invalid_path')
    return path


def open_directory(value: str) -> int:
    path = absolute(value)
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def private_parent(filename: str) -> int:
    descriptor = open_directory(str(absolute(filename).parent))
    details = os.fstat(descriptor)
    if details.st_uid != os.geteuid() or details.st_mode & 0o077:
        os.close(descriptor)
        raise ProbeFailure('private_parent_unavailable')
    return descriptor


def load_policy(filename: str) -> dict:
    parent = private_parent(filename)
    try:
        fd = os.open(absolute(filename).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        try:
            details = os.fstat(fd)
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_mode & 0o077 \
                    or details.st_nlink != 1 or details.st_size > 1024 * 1024:
                raise ProbeFailure('private_policy_unavailable')
            document = json.loads(os.read(fd, 1024 * 1024 + 1))
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    if not isinstance(document, dict) or set(document) != {'schemaVersion', 'host_id', 'targets'} \
            or document['schemaVersion'] != 1 or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', document['host_id']) \
            or not isinstance(document['targets'], list) or not 1 <= len(document['targets']) <= 100:
        raise ProbeFailure('invalid_policy')
    seen = set()
    for row in document['targets']:
        validate_row(row, document['host_id'])
        identity = (row['target']['tenant_id'], row['target']['alias'])
        if identity in seen:
            raise ProbeFailure('duplicate_policy_target')
        seen.add(identity)
    return document


def validate_target(target) -> tuple[str, str]:
    if not isinstance(target, dict) or set(target) != {'tenant_id', 'alias'} \
            or not isinstance(target['tenant_id'], str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', target['tenant_id']) \
            or not isinstance(target['alias'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', target['alias']):
        raise ProbeFailure('invalid_target')
    return target['tenant_id'], target['alias']


def validate_row(row, host: str) -> None:
    if not isinstance(row, dict) or set(row) != {'target', 'runtime_key', 'harness_id', 'placement', 'supervisor', 'observation', 'account'}:
        raise ProbeFailure('invalid_target_policy')
    validate_target(row['target'])
    if not isinstance(row['runtime_key'], str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', row['runtime_key']) \
            or not isinstance(row['harness_id'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', row['harness_id']):
        raise ProbeFailure('invalid_runtime_policy')
    placement = row['placement']
    if not isinstance(placement, dict) or set(placement) - {'container_name', 'systemd_user'} \
            != {'host_id', 'mode', 'runtime_user', 'home_directory', 'state_directory'} or placement['host_id'] != host \
            or placement['mode'] not in {'container', 'native'}:
        raise ProbeFailure('invalid_placement_policy')
    if not isinstance(placement['runtime_user'], str) or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', placement['runtime_user']):
        raise ProbeFailure('invalid_runtime_user')
    if placement['mode'] == 'container' and (not isinstance(placement.get('container_name'), str)
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', placement['container_name'])):
        raise ProbeFailure('container_name_unavailable')
    if 'systemd_user' in placement and (not isinstance(placement['systemd_user'], str)
            or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', placement['systemd_user'])):
        raise ProbeFailure('invalid_systemd_user')
    for key in ('home_directory', 'state_directory'):
        absolute(placement[key])
    supervisor = row['supervisor']
    if not isinstance(supervisor, dict) or set(supervisor) != {'socket', 'command', 'command_sha256'}:
        raise ProbeFailure('invalid_supervisor_policy')
    for key in ('socket', 'command'):
        absolute(supervisor[key])
    if not re.fullmatch(r'[0-9a-f]{64}', supervisor['command_sha256']):
        raise ProbeFailure('invalid_supervisor_pin')
    observation = row['observation']
    required = {'transport', 'control_directory', 'lifecycle_directory', 'pins', 'bundle_directory', 'bundle_digest',
                'node_command', 'node_sha256', 'provider_command', 'provider_sha256'}
    if not isinstance(observation, dict) or set(observation) - {'container_id', 'container_image', 'adapter_entry', 'adapter_sha256'} != required \
            or observation['transport'] not in {'local', 'docker'}:
        raise ProbeFailure('invalid_observation_policy')
    if (placement['mode'] == 'container') != (observation['transport'] == 'docker'):
        raise ProbeFailure('observation_transport_changed')
    if observation['transport'] == 'docker':
        if not isinstance(observation.get('container_id'), str) or not re.fullmatch(r'[a-f0-9]{64}', observation['container_id']) \
                or not isinstance(observation.get('container_image'), str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', observation['container_image']):
            raise ProbeFailure('invalid_container_pin')
    for key in ('node_sha256', 'provider_sha256'):
        if not isinstance(observation[key], str) or not re.fullmatch(r'[a-f0-9]{64}', observation[key]):
            raise ProbeFailure('invalid_command_pin')
    if not isinstance(observation['bundle_digest'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', observation['bundle_digest']):
        raise ProbeFailure('invalid_bundle_pin')
    for key in ('control_directory', 'lifecycle_directory', 'bundle_directory', 'node_command', 'provider_command'):
        absolute(observation[key])
    if placement['mode'] == 'native':
        absolute(observation['adapter_entry'])
        if not re.fullmatch(r'[0-9a-f]{64}', observation['adapter_sha256']):
            raise ProbeFailure('invalid_native_adapter_pin')
    if not isinstance(observation['pins'], dict) or not observation['pins']:
        raise ProbeFailure('missing_lifecycle_pins')
    for filename, pin in observation['pins'].items():
        absolute(filename)
        if not re.fullmatch(r'[0-9a-f]{64}', pin):
            raise ProbeFailure('invalid_code_pin')
    account = row['account']
    if account is not None:
        if not isinstance(account, dict) or set(account) != {'id', 'provider', 'environment_key', 'profile_path'} \
                or account['environment_key'] not in {'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME'} \
                or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', account['id']) \
                or not re.fullmatch(r'[a-z][a-z0-9_.-]{0,63}', account['provider']):
            raise ProbeFailure('invalid_account_binding')
        absolute(account['profile_path'])


def select(policy: dict, target: dict) -> dict:
    identity = validate_target(target)
    rows = [row for row in policy['targets'] if validate_target(row['target']) == identity]
    if len(rows) != 1:
        raise ProbeFailure('target_not_approved')
    return rows[0]


def digest_file(filename: str) -> str:
    path = absolute(filename)
    if path.name.lower() in {'auth.json', '.credentials.json', 'credentials.json'} \
            or path.suffix.lower() in {'.key', '.token', '.pem', '.p12', '.pfx'} \
            or any(part.lower() in {'credentials', 'container-pki'} for part in path.parts):
        raise ProbeFailure('credential_read_forbidden')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_mode & 0o022 or details.st_nlink != 1:
            raise ProbeFailure('unsafe_code_file')
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(fd)
