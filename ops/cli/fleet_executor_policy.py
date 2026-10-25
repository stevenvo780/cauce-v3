from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import pathlib
import pwd
import re
import stat
import sys
import uuid
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from fleet_policy_paths import SafeFailure, path
from fleet_runtime_materialization import external_directory
from secure_path import open_absolute_directory, open_regular_at

EXTENSION_TYPES = {'mount', 'network', 'resources', 'gpu', 'ssh', 'docker', 'browser', 'mcp', 'tools', 'full_control', 'model_fallback'}
EXTENSION_ALLOWED_FIELDS = {'types', 'mount_roots', 'networks', 'docker_access', 'docker_daemon_dedicated'}
NETWORK_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')


def admitted_docker_access(value) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise SafeFailure('computer does not admit docker access')
    if value == ['read'] or len(value) == 2 and set(value) == {'read', 'control'}:
        return tuple(value)
    raise SafeFailure('computer does not admit docker access')


def admitted_docker_daemon_dedicated(value) -> bool:
    if not isinstance(value, bool):
        raise SafeFailure('docker daemon dedication is outside the contract')
    return value


def extension_strings(value, pattern: str, *, minimum: int = 0) -> bool:
    return isinstance(value, list) and minimum <= len(value) <= 100 \
        and all(isinstance(item, str) and re.fullmatch(pattern, item) is not None for item in value) and len(set(value)) == len(value)


def extension_host(value) -> bool:
    if not isinstance(value, str) or not 1 <= len(value) <= 253:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*', value) is not None


def validate_prepared_extension(row: dict) -> None:
    kind = row['type']
    valid = False
    if kind == 'docker':
        valid = set(row) == {'type', 'access'} and row['access'] in ('read', 'control')
    elif kind == 'browser':
        valid = set(row) == {'type', 'mode'} and row['mode'] == 'sidecar' or \
            set(row) == {'type', 'mode', 'host', 'port'} and row['mode'] == 'ssh_tunnel' and extension_host(row['host']) \
            and type(row['port']) is int and 1 <= row['port'] <= 65535
    elif kind == 'ssh':
        valid = set(row) == {'type', 'hosts'} and extension_strings(row['hosts'], r'.{1,512}', minimum=1)
        for value in row.get('hosts', []) if valid else []:
            match = re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}@(\[[a-fA-F0-9:]+\]|[^:\s]+)(?::([0-9]{1,5}))?', value)
            if match is None or not extension_host(match[1].strip('[]')) or match[2] is not None and not 1 <= int(match[2]) <= 65535:
                valid = False
                break
    elif kind == 'mcp':
        valid = set(row) == {'type', 'name', 'command', 'args', 'env'} and isinstance(row['name'], str) \
            and NETWORK_NAME.fullmatch(row['name']) is not None and isinstance(row['command'], str) \
            and re.fullmatch(r'[^\s\x00-\x1f\x7f-\x9f]{1,512}', row['command']) is not None \
            and isinstance(row['args'], list) and len(row['args']) <= 100 \
            and all(isinstance(value, str) and re.fullmatch(r'[^\x00-\x1f\x7f-\x9f]{0,4096}', value) is not None for value in row['args']) \
            and extension_strings(row['env'], r'[A-Za-z_][A-Za-z0-9_]{0,127}')
    elif kind == 'tools':
        pattern = r'(?:npm:(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|pip:[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][A-Za-z0-9.!+_-]*)'
        valid = set(row) == {'type', 'packages'} and extension_strings(row['packages'], pattern, minimum=1) \
            and all(len(value) <= 512 for value in row['packages'])
    if not valid:
        raise SafeFailure('invalid ' + kind + ' extension fields')


def validate_extensions_allowed(value) -> dict:
    if not isinstance(value, dict) or not {'types', 'mount_roots', 'networks'} <= set(value) <= EXTENSION_ALLOWED_FIELDS:
        raise SafeFailure('invalid extensions_allowed policy')
    for field in ('types', 'mount_roots', 'networks'):
        rows = value[field]
        if not isinstance(rows, list) or len(rows) > (len(EXTENSION_TYPES) if field == 'types' else 100) or any(not isinstance(row, str) for row in rows) or len(set(rows)) != len(rows):
            raise SafeFailure('invalid extensions_allowed ' + field)
    if set(value['types']) - EXTENSION_TYPES:
        raise SafeFailure('unknown extension type in extensions_allowed')
    for root in value['mount_roots']:
        path(root)
        if any(char in root for char in (':', ',', '\x7f')):
            raise SafeFailure('invalid extensions_allowed mount root')
    if any(NETWORK_NAME.fullmatch(name) is None or name in {'host', 'none'} for name in value['networks']):
        raise SafeFailure('invalid network in extensions_allowed')
    if 'docker_access' in value:
        admitted_docker_access(value['docker_access'])
    if 'docker_daemon_dedicated' in value:
        admitted_docker_daemon_dedicated(value['docker_daemon_dedicated'])
    return value


def extension_resources(row: dict) -> tuple[int, int, int]:
    if set(row) - {'type', 'memory', 'cpus', 'pids'} or not set(row) & {'memory', 'cpus', 'pids'}:
        raise SafeFailure('invalid resources extension fields')
    memory, cpus, pids = 0, 0, row.get('pids', 128)
    if 'memory' in row:
        match = re.fullmatch(r'([1-9][0-9]*)([bkmgBKMG]?)', row['memory']) if isinstance(row['memory'], str) and len(row['memory']) <= 32 else None
        if match is None:
            raise SafeFailure('invalid resources memory')
        amount = Decimal(match[1]) * 1024 ** ('bkmg'.index(match[2].lower()) if match[2] else 0)
        if amount != int(amount) or not 0 < amount < 2 ** 63:
            raise SafeFailure('invalid resources memory limit')
        memory = int(amount)
    if 'cpus' in row:
        if isinstance(row['cpus'], bool) or not isinstance(row['cpus'], (int, float)):
            raise SafeFailure('invalid resources cpus')
        try:
            amount = Decimal(str(row['cpus'])) * 1_000_000_000
            if not amount.is_finite() or not 0 < amount < 2 ** 63 or amount != int(amount):
                raise SafeFailure('invalid resources cpus limit')
            cpus = int(amount)
        except InvalidOperation:
            raise SafeFailure('invalid resources cpus') from None
    if type(pids) is not int or not 1 <= pids <= 4096:
        raise SafeFailure('invalid resources pids (expected 1..4096)')
    return memory, cpus, pids


def agent_extensions(agent: dict) -> list[dict]:
    rows = agent.get('extensions', [])
    if not isinstance(rows, list) or len(rows) > 100:
        raise SafeFailure('invalid bounded agent extensions')
    identities = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('type'), str) or row['type'] not in EXTENSION_TYPES:
            raise SafeFailure('unknown agent extension type')
        kind = row['type']
        identity = (kind, row.get('target') if kind == 'mount' else row.get('name') if kind in {'network', 'mcp'} else None)
        if not isinstance(identity[1], (str, type(None))) or identity in identities:
            raise SafeFailure('duplicate or invalid ' + kind + ' extension')
        identities.add(identity)
        if kind == 'mount':
            if set(row) != {'type', 'source', 'target', 'mode'} or not isinstance(row['mode'], str) or row['mode'] not in {'ro', 'rw'}:
                raise SafeFailure('invalid mount extension fields')
            for field in ('source', 'target'):
                if len(str(row[field])) > 4096 or any(char in str(row[field]) for char in (':', ',')) or any(127 <= ord(char) <= 159 for char in str(row[field])):
                    raise SafeFailure('invalid mount extension path')
                path(row[field])
        elif kind == 'network' and (set(row) != {'type', 'name'} or not isinstance(row['name'], str)
                or NETWORK_NAME.fullmatch(row['name']) is None or row['name'] in {'none', 'host'}):
            raise SafeFailure('invalid network extension')
        elif kind == 'resources':
            extension_resources(row)
        elif kind in {'gpu', 'full_control'} and set(row) != {'type'}:
            raise SafeFailure('invalid ' + kind + ' extension fields')
        elif kind in {'ssh', 'docker', 'browser', 'mcp', 'tools'}:
            validate_prepared_extension(row)
        elif kind == 'model_fallback':
            from fleet_model_fallback import validate_row
            validate_row(row)
    if any(row['type'] == 'browser' and row['mode'] == 'ssh_tunnel' for row in rows) and not any(row['type'] == 'ssh' for row in rows):
        raise SafeFailure('browser SSH tunnel requires the ssh extension')
    return rows


def approve_extensions(policy: dict, agent: dict) -> list[dict]:
    rows = agent_extensions(agent)
    if not rows:
        return rows
    allowed = validate_extensions_allowed(policy.get('extensions_allowed', {'types': [], 'mount_roots': [], 'networks': []}))
    for row in rows:
        kind = row['type']
        if kind not in allowed['types']:
            raise SafeFailure('extension not allowed by host policy: ' + kind)
        if kind == 'mount':
            source = path(row['source'])
            try:
                if source.resolve(strict=True) != source:
                    raise SafeFailure('mount extension source must not contain symlinks')
                if not any(source.is_relative_to(path(root)) and path(root).resolve(strict=True) == path(root)
                           for root in allowed['mount_roots']):
                    raise SafeFailure('mount extension source is outside allowed host roots')
            except (OSError, RuntimeError):
                raise SafeFailure('mount extension source or allowed root is unavailable') from None
        elif kind == 'network' and row['name'] not in allowed['networks']:
            raise SafeFailure('network extension is not in allowed host networks')
    if agent.get('runtime_mode') != 'container' or agent.get('_placement', {}).get('ownership') == 'shared':
        raise SafeFailure('extensions require a dedicated container')
    from fleet_model_fallback import pairing
    pairing(agent)
    docker_rows = [row for row in rows if row['type'] == 'docker']
    if docker_rows:
        from fleet_executor_sidecars import admit_docker_level, refuse_shared_daemon
        admit_docker_level(policy, docker_rows[0]['access'])
        refuse_shared_daemon(policy, agent)
    return rows


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
    if not isinstance(policy, dict) or set(policy) - {'signer', 'authority', 'transport', 'terminal', 'container_templates', 'profile_templates', 'shared_containers', 'legacy_credentials', 'quota_environments', 'extensions_allowed', 'execution_scope'} != required or type(policy['schemaVersion']) is not int or policy['schemaVersion'] != 1:
        raise SafeFailure('invalid executor policy schema')
    if policy.get('execution_scope', 'full') not in ('full', 'backups'):
        raise SafeFailure('invalid executor execution scope')
    if policy.get('execution_scope') == 'backups' and (any(policy.get(key) for key in
            ('native', 'containers', 'bundles', 'profiles', 'hooks', 'container_templates', 'profile_templates'))
            or any(key in policy for key in ('authority', 'transport', 'signer', 'terminal', 'legacy_credentials', 'quota_environments', 'extensions_allowed'))
            or not isinstance(policy.get('shared_containers'), dict) or not policy['shared_containers']
            or any(not isinstance(row, dict) or row.get('backup_only') is not True
                                                        for row in policy['shared_containers'].values())):
        raise SafeFailure('backup-only executor policy grants another execution scope')
    if 'terminal' in policy and (not isinstance(policy['terminal'], dict) or set(policy['terminal']) != {'required'}
            or type(policy['terminal']['required']) is not bool
            or policy['terminal']['required'] and ('authority' not in policy or 'transport' not in policy)):
        raise SafeFailure('invalid approved terminal provisioning policy')
    if 'extensions_allowed' in policy:
        validate_extensions_allowed(policy['extensions_allowed'])
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
    for bundle in policy['bundles'].values():
        if isinstance(bundle, dict) and 'descriptor_sha256' in bundle and (not isinstance(bundle['descriptor_sha256'], str)
                or re.fullmatch(r'[a-f0-9]{64}', bundle['descriptor_sha256']) is None):
            raise SafeFailure('invalid approved descriptor digest')
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
    if 'quota_environments' in policy:
        from quota_runtime import configuration
        configuration(policy)
    return policy


def declarative_provider_module(row: dict):
    """Fleet driver module for declarative selection checks, when the harness
    descriptor (or executor fallback) names one with execution arguments."""
    from fleet_provider_identity import resolve_fleet_module
    try:
        module_name = resolve_fleet_module({}, row.get('harness_id'))
    except ValueError:
        raise SafeFailure('fleet descriptor is unavailable') from None
    if not module_name:
        return None
    from importlib import import_module
    try:
        module = import_module(module_name)
    except ImportError:
        raise SafeFailure('fleet provider module is unavailable') from None
    return module if hasattr(module, 'execution_arguments') else None


def validate_payload(document) -> dict:
    required = {'operation_id', 'request', 'fenced_targets', 'previous_agents', 'desired_memberships'}
    if not isinstance(document, dict) or set(document) - {'snapshot', 'trusted_accounts', 'fleet_scope', 'global_desired_memberships', 'restore_previous_runtime'} != required:
        raise SafeFailure('invalid execution payload')
    if 'restore_previous_runtime' in document and document['restore_previous_runtime'] is not True:
        raise SafeFailure('invalid runtime restoration request')
    if str(uuid.UUID(document['operation_id'])) != document['operation_id']:
        raise SafeFailure('invalid operation identity')
    if 'fleet_scope' in document:
        scope = document['fleet_scope']
        request = document['request']
        minimum_revision = 0 if isinstance(request, dict) and request.get('kind') == 'recover' \
            and request.get('parameters') == {'action': 'probe'} else 1
        fields = {'operation_id', 'host_id', 'scope_sha256', 'prepared_revision', 'worker_id', 'claim_token', 'claim_epoch'}
        if not isinstance(scope, dict) or set(scope) - {'placement_role'} != fields or scope['operation_id'] != document['operation_id'] \
                or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', scope.get('host_id', '')) is None \
                or re.fullmatch(r'[a-f0-9]{64}', scope.get('scope_sha256', '')) is None \
                or re.fullmatch(r'[A-Za-z0-9_-]{1,128}', scope.get('worker_id', '')) is None \
                or type(scope['prepared_revision']) is not int or scope['prepared_revision'] < minimum_revision \
                or type(scope['claim_epoch']) is not int or scope['claim_epoch'] < 0 \
                or str(uuid.UUID(scope['claim_token'])) != scope['claim_token']:
            raise SafeFailure('invalid coordinated host scope')
    request = document['request']
    if not isinstance(request, dict) or set(request) != {'kind', 'target', 'parameters', 'expected_revision', 'idempotency_key'}:
        raise SafeFailure('invalid declarative request')
    if request['kind'] not in {'create', 'update', 'start', 'stop', 'retire', 'restore', 'purge', 'recover'}:
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
    if request['kind'] in {'create', 'update', 'start', 'stop', 'recover'} and target['resource'] != 'agent':
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
        if fields - set(parameters) or set(parameters) - fields - {'display_name', 'primary_account_id', 'model_id', 'reasoning_effort', 'extensions'}:
            raise SafeFailure('request may only contain declarative agent fields')
        agent_extensions(parameters)
        from fleet_provider_openclaw import validate_execution_selection
        validate_execution_selection(parameters)
        provider_module = declarative_provider_module(parameters)
        if provider_module is not None:
            from fleet_provider_identity import validate_provider_selection
            validate_provider_selection(parameters, parameters['harness_id'],
                                         getattr(provider_module, 'EFFORTS', frozenset()))
        elif parameters.get('reasoning_effort') is not None and parameters['reasoning_effort'] not in {'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}:
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
    elif request['kind'] == 'recover':
        from fleet_executor_recovery import validate_parameters
        validate_parameters(parameters)
    elif request['kind'] == 'purge' and target['resource'] == 'agent':
        if set(parameters) - {'confirm_alias'}:
            raise SafeFailure('agent purge may only contain alias confirmation')
        if 'confirm_alias' in parameters and (not isinstance(parameters['confirm_alias'], str)
                or parameters['confirm_alias'] != target['alias']):
            raise SafeFailure('purge confirmation must exactly match target alias')
    elif parameters:
        raise SafeFailure('request parameters must be empty')
    if request['kind'] in {'start', 'restore'}:
        from fleet_provider_openclaw import validate_execution_selection
        scoped = document['fenced_targets'] + [target]
        for agent in document.get('snapshot', {}).get('agents', []):
            if any(row.get('resource') == 'agent' and row.get('tenant_id') == agent.get('tenant_id')
                    and row.get('alias') == agent.get('alias') for row in scoped):
                validate_execution_selection(agent)
                provider_module = declarative_provider_module(agent)
                if provider_module is not None:
                    from fleet_provider_identity import validate_provider_selection
                    validate_provider_selection(agent, agent['harness_id'],
                                                 getattr(provider_module, 'EFFORTS', frozenset()))
    from fleet_migration import placement_role
    placement_role(document)
    return document


def bounded_text(value, maximum: int) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= maximum and all(ord(character) >= 32 and not 127 <= ord(character) <= 159 for character in value)


def target_agent(context: dict) -> dict:
    request = context['request']
    target, parameters = request['target'], request['parameters']
    if target['resource'] != 'agent':
        raise SafeFailure('agent effect requires an agent target')
    from fleet_migration import placement_role
    if placement_role(context) == 'source':
        return {**context['previous_agents'][0], '_trusted_accounts': context.get('trusted_accounts', []),
                '_trusted_accounts_present': 'trusted_accounts' in context}
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
            '_trusted_accounts_present': 'trusted_accounts' in context, 'fleet_baseline': baseline,
            'extensions': parameters.get('extensions', identities[0].get('extensions', []) if len(identities) == 1 else [])}
    rows = context.get('snapshot', {}).get('agents', [])
    matches = [row for row in rows if row.get('tenant_id') == target['tenant_id'] and row.get('alias') == target['alias']]
    if len(matches) != 1:
        matches = [row for row in context['previous_agents'] if row.get('tenant_id') == target['tenant_id'] and row.get('alias') == target['alias']]
    if len(matches) != 1:
        raise SafeFailure('target agent placement is missing or ambiguous')
    return {**matches[0], '_trusted_accounts': context.get('trusted_accounts', []), '_trusted_accounts_present': 'trusted_accounts' in context}


def approve_agent(policy: dict, agent: dict) -> dict:
    if policy.get('execution_scope') == 'backups':
        raise SafeFailure('backup-only executor rejects fleet agents')
    if re.fullmatch(r'[a-z][a-z0-9-]{0,63}', agent.get('runtime_key') or '') is None or agent['host_id'] != policy['host_id']:
        raise SafeFailure('runtime key or host is not approved')
    if agent['harness_id'] not in policy['bundles']:
        raise SafeFailure('harness bundle is not approved')
    if agent['runtime_mode'] == 'native':
        scoped = [row for row in policy['native'] if row.get('runtime_key') == agent['runtime_key']]
        if len(scoped) > 1:
            raise SafeFailure('native runtime has ambiguous approved managers')
        candidates = scoped or [row for row in policy['native'] if 'runtime_key' not in row]
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
        if candidate.get('runtime_key', agent['runtime_key']) != agent['runtime_key']:
            continue
        if candidate.get('runtime_user') != agent['runtime_user'] or candidate.get('home_directory') != agent['home_directory']:
            continue
        manager = agent.get('systemd_user') or candidate.get('systemd_user')
        if manager != candidate.get('systemd_user'):
            continue
        state_root = path(candidate['state_root'])
        expected = state_root / agent['runtime_key']
        if path(agent['state_directory']) != expected:
            continue
        approved = {**agent, 'systemd_user': manager, '_placement': candidate}
        if agent_extensions(approved) and (agent['runtime_mode'] != 'container' or candidate.get('ownership') == 'shared'):
            raise SafeFailure('extensions require a dedicated container')
        return approved
    raise SafeFailure('runtime user, manager, home or state directory is not approved')
