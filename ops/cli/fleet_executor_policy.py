from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import re
import stat
import sys
import uuid
from urllib.parse import urlsplit

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from fleet_runtime_materialization import external_directory
from secure_path import open_absolute_directory, open_regular_at


class SafeFailure(ValueError):
    pass


def digest(path: pathlib.Path) -> str:
    parent = open_absolute_directory(path.parent)
    try:
        descriptor = open_regular_at(parent, path.name, os.O_RDONLY)
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid not in {0, os.geteuid()} or details.st_mode & 0o022:
                raise SafeFailure('unapproved file ownership or mode')
            result = hashlib.sha256()
            while chunk := os.read(descriptor, 1024 * 1024):
                result.update(chunk)
            return result.hexdigest()
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def path(value) -> pathlib.Path:
    if not isinstance(value, str) or not value.startswith('/') or str(pathlib.PurePosixPath(value)) != value \
            or '..' in pathlib.PurePosixPath(value).parts or any(ord(character) < 32 for character in value):
        raise SafeFailure('noncanonical policy path')
    return pathlib.Path(value)


def private_directory(value) -> pathlib.Path:
    directory = external_directory(path(value))
    descriptor = open_absolute_directory(path(value))
    try:
        details = os.fstat(descriptor)
        if details.st_uid != os.geteuid() or details.st_mode & 0o077:
            raise SafeFailure('executor root must be private and owned by its execution user')
    finally:
        os.close(descriptor)
    return directory


def load_policy(filename: pathlib.Path) -> dict:
    parent = open_absolute_directory(path(str(filename)).parent)
    try:
        descriptor = open_regular_at(parent, filename.name, os.O_RDONLY)
        try:
            details = os.fstat(descriptor)
            if details.st_uid != os.geteuid() or details.st_nlink != 1 or details.st_mode & 0o022:
                raise SafeFailure('unsafe policy ownership or mode')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                body = stream.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                raise SafeFailure('policy exceeds its limit')
            policy = json.loads(body)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)
    required = {'schemaVersion', 'host_id', 'executor_user', 'roots', 'native', 'containers', 'bundles', 'profiles', 'hooks'}
    if not isinstance(policy, dict) or set(policy) - {'signer', 'authority', 'transport', 'container_templates', 'profile_templates', 'shared_containers', 'legacy_credentials'} != required or type(policy['schemaVersion']) is not int or policy['schemaVersion'] != 1:
        raise SafeFailure('invalid executor policy schema')
    if policy['executor_user'] != pwd.getpwuid(os.geteuid()).pw_name or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', policy['host_id']) is None:
        raise SafeFailure('executor host or execution user differs')
    if not isinstance(policy['roots'], dict) or set(policy['roots']) != {'state', 'runtime', 'pki', 'tokens', 'identities'}:
        raise SafeFailure('invalid executor roots')
    for value in policy['roots'].values():
        private_directory(value)
    if len(set(policy['roots'].values())) != len(policy['roots']):
        raise SafeFailure('executor roots must be distinct')
    roots = [path(value) for value in policy['roots'].values()]
    if any(left.is_relative_to(right) for left in roots for right in roots if left != right):
        raise SafeFailure('executor roots must not overlap')
    if not isinstance(policy['native'], list) or not all(isinstance(policy[field], dict) for field in ('containers', 'bundles', 'profiles', 'hooks')):
        raise SafeFailure('invalid executor allowlists')
    if 'transport' in policy:
        transport = policy['transport']
        if not isinstance(transport, dict) or set(transport) - {'registry_directory'} != {'bootstrap_url', 'gateway_url', 'ca_certificate', 'network'}:
            raise SafeFailure('invalid approved runtime transport')
        for field in ('bootstrap_url', 'gateway_url'):
            parsed = urlsplit(transport[field])
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise SafeFailure('runtime transport requires credential-free verified TLS URLs')
        if not isinstance(transport['network'], str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', transport['network']) is None:
            raise SafeFailure('runtime network is not approved')
        digest(path(transport['ca_certificate']))
        if 'registry_directory' in transport:
            path(transport['registry_directory'])
    if 'authority' in policy:
        if details.st_mode & 0o077:
            raise SafeFailure('central authority policy must remain private')
        if 'signer' in policy:
            raise SafeFailure('central authority cannot carry a local signer')
        from fleet_executor_authority import validate_authority
        validate_authority(policy['authority'], policy['host_id'])
    from fleet_executor_templates import validate_templates
    validate_templates(policy)
    from fleet_executor_legacy import validate_shared_containers
    validate_shared_containers(policy)
    from fleet_executor_legacy_credentials import validate_legacy_credentials
    validate_legacy_credentials(policy)
    return policy


def validate_payload(document) -> dict:
    required = {'operation_id', 'request', 'fenced_targets', 'previous_agents', 'desired_memberships'}
    if not isinstance(document, dict) or set(document) - {'snapshot', 'trusted_accounts', 'fleet_scope', 'global_desired_memberships'} != required:
        raise SafeFailure('invalid execution payload')
    if str(uuid.UUID(document['operation_id'])) != document['operation_id']:
        raise SafeFailure('invalid operation identity')
    if 'fleet_scope' in document:
        scope = document['fleet_scope']
        fields = {'operation_id', 'host_id', 'scope_sha256', 'prepared_revision', 'worker_id', 'claim_token', 'claim_epoch'}
        if not isinstance(scope, dict) or set(scope) != fields or scope['operation_id'] != document['operation_id'] \
                or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', scope.get('host_id', '')) is None \
                or re.fullmatch(r'[a-f0-9]{64}', scope.get('scope_sha256', '')) is None \
                or re.fullmatch(r'[A-Za-z0-9_-]{1,128}', scope.get('worker_id', '')) is None \
                or type(scope['prepared_revision']) is not int or scope['prepared_revision'] < 1 \
                or type(scope['claim_epoch']) is not int or scope['claim_epoch'] < 0 \
                or str(uuid.UUID(scope['claim_token'])) != scope['claim_token']:
            raise SafeFailure('invalid coordinated host scope')
    request = document['request']
    if not isinstance(request, dict) or set(request) != {'kind', 'target', 'parameters', 'expected_revision', 'idempotency_key'}:
        raise SafeFailure('invalid declarative request')
    if request['kind'] not in {'create', 'update', 'start', 'stop', 'retire', 'restore', 'purge'}:
        raise SafeFailure('unsupported declarative request')
    for field in ('previous_agents', 'desired_memberships', 'fenced_targets'):
        if not isinstance(document[field], list) or len(document[field]) > 1000:
            raise SafeFailure('invalid bounded execution list')
    from fleet_executor_templates import validate_accounts
    validate_accounts(document.get('trusted_accounts', []))
    target = request['target']
    if not isinstance(target, dict) or target.get('resource') not in {'agent', 'room', 'tenant'}:
        raise SafeFailure('invalid target')
    if re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', target.get('tenant_id', '')) is None:
        raise SafeFailure('invalid target tenant')
    if target['resource'] == 'agent' and (set(target) != {'resource', 'tenant_id', 'alias'}
            or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', target.get('alias', '')) is None):
        raise SafeFailure('invalid target wire identity')
    if target['resource'] == 'tenant' and set(target) != {'resource', 'tenant_id'}:
        raise SafeFailure('invalid target tenant fields')
    if target['resource'] == 'room' and (set(target) != {'resource', 'tenant_id', 'room_id'} or not bounded_text(target.get('room_id'), 128)):
        raise SafeFailure('invalid target room')
    if type(request['expected_revision']) is not int or request['expected_revision'] < 0 \
            or not isinstance(request['idempotency_key'], str) or re.fullmatch(r'[A-Za-z0-9_-]{8,128}', request['idempotency_key']) is None:
        raise SafeFailure('invalid request revision or idempotency key')
    if request['kind'] in {'create', 'update', 'start', 'stop'} and target['resource'] != 'agent':
        raise SafeFailure('requested lifecycle requires an agent')
    if 'global_desired_memberships' in document:
        rows = document['global_desired_memberships']
        if request['kind'] != 'restore' or target['resource'] not in {'room', 'tenant'} \
                or not isinstance(rows, list) or len(rows) > 1000:
            raise SafeFailure('global membership intent requires a bounded group restore')
        identities = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'tenant_id', 'alias', 'room_id', 'role', 'enabled'} \
                    or row['tenant_id'] != target['tenant_id'] \
                    or not isinstance(row['alias'], str) or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', row['alias']) is None \
                    or not bounded_text(row['room_id'], 128) or not bounded_text(row['role'], 64) \
                    or type(row['enabled']) is not bool \
                    or (target['resource'] == 'room' and row['room_id'] != target['room_id']):
                raise SafeFailure('global membership intent is outside the group target')
            identity = (row['tenant_id'], row['alias'], row['room_id'])
            if identity in identities:
                raise SafeFailure('global membership intent is ambiguous')
            identities.add(identity)
        if any(row not in rows for row in document['desired_memberships']):
            raise SafeFailure('local membership intent differs from global intent')
    parameters = request['parameters']
    if not isinstance(parameters, dict):
        raise SafeFailure('invalid request parameters')
    if request['kind'] in {'create', 'update'}:
        fields = {'runtime_key', 'harness_id', 'primary_room_id', 'memberships', 'placement'}
        if fields - set(parameters) or set(parameters) - fields - {'display_name', 'primary_account_id', 'model_id', 'reasoning_effort'}:
            raise SafeFailure('request may only contain declarative agent fields')
        if parameters.get('reasoning_effort') is not None and parameters['reasoning_effort'] not in {'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}:
            raise SafeFailure('unsupported declarative reasoning effort')
        placement = parameters['placement']
        if not isinstance(placement, dict) or set(placement) - {'host_id', 'mode', 'container_name', 'runtime_user', 'systemd_user', 'home_directory', 'state_directory'}:
            raise SafeFailure('request may only contain declarative placement fields')
        memberships = parameters['memberships']
        if not isinstance(memberships, list) or not 1 <= len(memberships) <= 100 \
                or any(not isinstance(row, dict) or set(row) - {'room_id', 'role', 'enabled'} or not bounded_text(row.get('room_id'), 128)
                       or not bounded_text(row.get('role'), 64) or ('enabled' in row and type(row['enabled']) is not bool) for row in memberships):
            raise SafeFailure('invalid membership intent')
        rooms = [row['room_id'] for row in memberships]
        if len(rooms) != len(set(rooms)) or parameters['primary_room_id'] not in rooms:
            raise SafeFailure('membership intent must include an unambiguous primary room')
    elif parameters:
        raise SafeFailure('request parameters must be empty')
    return document


def bounded_text(value, maximum: int) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= maximum and all(ord(character) >= 32 and not 127 <= ord(character) <= 159 for character in value)


def target_agent(context: dict) -> dict:
    request = context['request']
    target, parameters = request['target'], request['parameters']
    if target['resource'] != 'agent':
        raise SafeFailure('agent effect requires an agent target')
    if request['kind'] in {'create', 'update'}:
        placement = parameters['placement']
        identities = [row for row in context.get('snapshot', {}).get('agents', []) if row.get('tenant_id') == target['tenant_id']
            and row.get('alias') == target['alias'] and row.get('runtime_key') == parameters['runtime_key']]
        baseline = identities[0].get('fleet_baseline') if len(identities) == 1 else None
        return {'tenant_id': target['tenant_id'], 'alias': target['alias'], 'runtime_key': parameters['runtime_key'],
            'harness_id': parameters['harness_id'], 'primary_room_id': parameters['primary_room_id'],
            'host_id': placement['host_id'], 'runtime_mode': placement['mode'],
            'container_name': placement.get('container_name', 'host:' + placement['host_id']),
            'runtime_user': placement['runtime_user'], 'systemd_user': placement.get('systemd_user'),
            'home_directory': placement['home_directory'], 'state_directory': placement['state_directory'],
            'primary_account_id': parameters.get('primary_account_id'), 'model_id': parameters.get('model_id'),
            'reasoning_effort': parameters.get('reasoning_effort'), '_trusted_accounts': context.get('trusted_accounts', []),
            '_trusted_accounts_present': 'trusted_accounts' in context, 'fleet_baseline': baseline}
    rows = context.get('snapshot', {}).get('agents', [])
    matches = [row for row in rows if row.get('tenant_id') == target['tenant_id'] and row.get('alias') == target['alias']]
    if len(matches) != 1:
        matches = [row for row in context['previous_agents'] if row.get('tenant_id') == target['tenant_id'] and row.get('alias') == target['alias']]
    if len(matches) != 1:
        raise SafeFailure('target agent placement is missing or ambiguous')
    return {**matches[0], '_trusted_accounts': context.get('trusted_accounts', []), '_trusted_accounts_present': 'trusted_accounts' in context}


def approve_agent(policy: dict, agent: dict) -> dict:
    if re.fullmatch(r'[a-z][a-z0-9-]{0,63}', agent.get('runtime_key') or '') is None or agent['host_id'] != policy['host_id']:
        raise SafeFailure('runtime key or host is not approved')
    if agent['harness_id'] not in policy['bundles']:
        raise SafeFailure('harness bundle is not approved')
    if agent['runtime_mode'] == 'native':
        candidates = policy['native']
    elif agent['runtime_mode'] == 'container':
        from fleet_executor_legacy import shared_placement
        shared = shared_placement(policy, agent)
        if shared is not None:
            candidates = [shared]
        elif agent['container_name'] in policy['containers']:
            candidates = [policy['containers'][agent['container_name']]]
        else:
            candidates = [row for row in policy.get('container_templates', []) if row['harness_id'] == agent['harness_id']
                and agent['container_name'] == row['prefix'] + agent['runtime_key']]
            if len(candidates) != 1:
                raise SafeFailure('container name has no unique approved runtime template')
    else:
        raise SafeFailure('runtime mode is not approved')
    for candidate in candidates:
        if candidate.get('runtime_user') != agent['runtime_user'] or candidate.get('home_directory') != agent['home_directory']:
            continue
        manager = agent.get('systemd_user') or candidate.get('systemd_user')
        if manager != candidate.get('systemd_user'):
            continue
        state_root = path(candidate['state_root'])
        expected = state_root / agent['runtime_key']
        if path(agent['state_directory']) != expected:
            continue
        return {**agent, 'systemd_user': manager, '_placement': candidate}
    raise SafeFailure('runtime user, manager, home or state directory is not approved')
