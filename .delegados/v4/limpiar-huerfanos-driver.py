#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import secrets
import stat
import sys
import urllib.parse
import uuid

OPERATIONS = '/v3/console/fleet/operations'
OPEN = {'queued', 'running', 'awaiting_auth', 'cancelling'}
TERMINAL = {'succeeded', 'failed', 'cancelled'}
IDENTITY = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
RESOURCE_TYPES = {'container', 'volume', 'image', 'network', 'release', 'context', 'operation',
                  'publish_intent', 'lease', 'room', 'human', 'account', 'directory'}
DOCKER_KINDS = {'test_volume', 'test_container', 'test_network', 'test_image'}
CONTEXT_API = '/v3/console/context-repository/retirements'
REASONS = {
    'praxis_inventory_only': 'Ámbito protegido: solo inventario y retención, sin efectos externos.',
    'no_canonical_cleanup': 'No hay una vía canónica acotada y verificada en este guion; se conserva el recurso.',
    'volume_retained': 'No hay copia real verificada del volumen; se conserva y no se encola la purga.',
    'offline_unvalidated': 'Sin autoridad nominal aportada no se revalidaron las referencias ni los pins; sólo inventario.',
    'not_test_candidate': 'La identidad no es una candidata de pruebas explícita; no se autoriza retirarla por este guion.',
    'open_operation': 'Existe una operación abierta o cancelling; se conserva sin cancelarla ni forzar settlement.',
    'history_incomplete': 'El historial alcanzó su límite; no se puede acreditar ausencia de trabajo abierto.',
    'dependencies_present': 'La previsualización canónica bloquea por referencias o dependencias vigentes.',
    'preview_review_required': 'El hash de la previsualización falta en el plan; revisa el recibo y prepara otro plan antes de aplicar.',
    'preview_changed': 'La previsualización o sus recursos cambiaron respecto del pin revisado; se exige otro plan.',
    'stale_or_unavailable': 'La API rechazó la revisión, el alcance o la capacidad; no se reintenta por otra vía.',
    'canonical_pending': 'La operación fue aceptada y sigue pendiente; no acredita limpieza completada.',
    'canonical_succeeded': 'La API acredita succeeded para la operación exacta del plan.',
    'canonical_failed': 'La operación terminó failed o cancelled; se conserva su recibo y no se recrea automáticamente.',
    'ready': 'La revisión, el historial y la previsualización canónicos coinciden con el plan revisado.',
    'invalid_receipt': 'La API o el recibo local no acreditan la operación exacta; se bloquea el reintento.',
}


class Blocked(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Blocked('JSON con campos duplicados')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


def shape(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise Blocked('El documento no tiene el esquema acotado requerido')


def text(value, limit=512):
    if not isinstance(value, str) or not 1 <= len(value) <= limit or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise Blocked('Un identificador de metadatos no es válido')


def directory(path, private=False, owners=None):
    if not path.is_absolute() or str(path) != os.path.normpath(path):
        raise Blocked('Las rutas deben ser absolutas y canónicas')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        info = os.fstat(descriptor)
        if info.st_uid not in (owners or {os.geteuid()}) or info.st_mode & (0o077 if private else 0o022):
            raise Blocked('El directorio no tiene dueño o permisos autorizados')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def file_pin(info):
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_size, info.st_mtime_ns]


def read_private(path):
    parent = directory(path.parent, private=True)
    try:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_mode & 0o077 \
                    or before.st_nlink != 1 or before.st_size > 1_048_576:
                raise Blocked('El plan y el recibo deben ser ficheros privados regulares del operador')
            raw = os.read(descriptor, 1_048_577)
            if len(raw) > 1_048_576 or file_pin(before) != file_pin(os.fstat(descriptor)):
                raise Blocked('El documento cambió durante su lectura')
            return parse(raw), file_pin(before)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


class Receipt:
    def __init__(self, path, plan):
        self.path = path
        self.parent = directory(path.parent, private=True)
        self.pin = None
        self.lock = os.open(path.name + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.parent)
        info = os.fstat(self.lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise Blocked('El lock del recibo no es privado y propio')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            saved, self.pin = read_private(path)
        except FileNotFoundError:
            saved = {'version': 1, 'plan_sha256': digest(plan), 'company_id': plan['company_id'], 'items': []}
        if not isinstance(saved, dict) or saved.get('version') != 1 or saved.get('plan_sha256') != digest(plan) \
                or saved.get('company_id') != plan['company_id'] or not isinstance(saved.get('items'), list):
            raise Blocked('El recibo existente corresponde a otro plan; usa un recibo nuevo')
        self.document = saved

    def save(self):
        try:
            info = os.stat(self.path.name, dir_fd=self.parent, follow_symlinks=False)
            current = file_pin(info)
        except FileNotFoundError:
            current = None
        if current != self.pin:
            raise Blocked('El recibo cambió fuera de esta invocación')
        temporary = '.h10-receipt-' + secrets.token_hex(12)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(canonical(self.document) + b'\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path.name, src_dir_fd=self.parent, dst_dir_fd=self.parent)
            os.fsync(self.parent)
            self.pin = file_pin(os.stat(self.path.name, dir_fd=self.parent, follow_symlinks=False))
        finally:
            try:
                os.unlink(temporary, dir_fd=self.parent)
            except FileNotFoundError:
                pass

    def close(self):
        os.close(self.lock)
        os.close(self.parent)


def validate_plan(plan):
    shape(plan, {'version', 'company_id', 'expected_revision', 'items'})
    text(plan['company_id'], 128)
    if plan['version'] != 1 or type(plan['expected_revision']) is not int or plan['expected_revision'] < 0 \
            or not isinstance(plan['items'], list) or not 1 <= len(plan['items']) <= 200:
        raise Blocked('La versión, revisión o lista del plan no es válida')
    identities, agents = set(), 0
    for item in plan['items']:
        if not isinstance(item, dict) or item.get('kind') not in {'agent', 'resource', 'test_context'} | DOCKER_KINDS:
            raise Blocked('El plan sólo admite agentes canónicos y recursos retenidos')
        text(item.get('id'), 128)
        if item['id'] in identities:
            raise Blocked('El plan repite una identidad')
        identities.add(item['id'])
        if item['kind'] in DOCKER_KINDS:
            docker_engine().validate(item, plan)
            continue
        if item['kind'] == 'test_context':
            agents += 1
            shape(item, {'id', 'kind', 'company_id', 'action', 'pin'}, {'retirement_commit'})
            if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', item['company_id']) or item['action'] not in {'retire', 'restore'}:
                raise Blocked('La compañía o acción de contexto no es válida')
            shape(item['pin'], {'head', 'preview_sha256'})
            if item['pin']['head'] is not None and not re.fullmatch(r'[a-f0-9]{40,64}', str(item['pin']['head'])) \
                    or item['pin']['preview_sha256'] is not None and not HASH.fullmatch(str(item['pin']['preview_sha256'])):
                raise Blocked('El pin de contexto no es válido')
            if item['action'] == 'restore':
                if not re.fullmatch(r'[a-f0-9]{40,64}', str(item.get('retirement_commit'))):
                    raise Blocked('La restauración requiere el commit exacto de retirada')
            elif 'retirement_commit' in item:
                raise Blocked('La retirada no admite un commit de restauración')
            continue
        if item['kind'] == 'resource':
            shape(item, {'id', 'kind', 'resource_type', 'name', 'scope'}, {'size_bytes', 'reference_sha256', 'reason'})
            if item['resource_type'] not in RESOURCE_TYPES:
                raise Blocked('Tipo de recurso no admitido')
            text(item['name'])
            shape(item['scope'], {'company_id'}, {'tenant_id', 'host_id', 'alias'})
            for value in item['scope'].values():
                text(value, 128)
            if 'size_bytes' in item and item['size_bytes'] is not None \
                    and (type(item['size_bytes']) is not int or item['size_bytes'] < 0):
                raise Blocked('El tamaño debe ser metadato no negativo o null')
            if 'reference_sha256' in item and not HASH.fullmatch(str(item['reference_sha256'])):
                raise Blocked('El pin de referencias no es válido')
            if 'reason' in item:
                text(item['reason'])
            continue
        agents += 1
        shape(item, {'id', 'kind', 'request'}, {'preview_sha256', 'host_id'})
        if item.get('preview_sha256') is not None and not HASH.fullmatch(str(item['preview_sha256'])):
            raise Blocked('El pin de previsualización no es válido')
        if 'host_id' in item:
            text(item['host_id'], 128)
        request = item['request']
        shape(request, {'kind', 'target', 'parameters', 'expected_revision', 'idempotency_key'})
        shape(request['target'], {'resource', 'tenant_id', 'alias'})
        target = request['target']
        if request['kind'] not in {'retire', 'purge'} or target['resource'] != 'agent' \
                or any(not isinstance(target[key], str) or not IDENTITY.fullmatch(target[key]) for key in ('tenant_id', 'alias')) \
                or request['expected_revision'] != plan['expected_revision'] \
                or not isinstance(request['idempotency_key'], str) \
                or re.fullmatch(r'[A-Za-z0-9_-]{8,128}', request['idempotency_key']) is None \
                or request['parameters'] != ({} if request['kind'] == 'retire' else {'confirm_alias': target['alias']}):
            raise Blocked('La solicitud no es un retiro o purga exactos de la revisión del plan')
    if agents > 1:
        raise Blocked('Un plan admite una sola acción canónica de agente o contexto; prepara la revisión siguiente')


def docker_engine():
    filename = pathlib.Path(__file__).absolute().with_name('limpiar-huerfanos-volumes.py')
    details = filename.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_uid not in {0, os.geteuid()} \
            or details.st_mode & 0o022 or details.st_nlink != 1:
        raise Blocked('El auxiliar Docker no tiene dueño o modos autorizados')
    specification = importlib.util.spec_from_file_location('cauce_orphan_docker', filename)
    if specification is None or specification.loader is None:
        raise Blocked('El auxiliar Docker no está disponible')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def protected_scope(*values):
    identities = {identity.casefold() for identity in docker_engine().retention_policy()["protected_identifiers"]}
    return any(isinstance(value, str) and value.casefold() in identities for value in values)


def held(item, reason):
    result = {'id': item['id'], 'status': 'retained', 'reason_code': reason, 'reason': REASONS[reason]}
    if item['kind'] == 'resource':
        result.update({key: item[key] for key in ('resource_type', 'name', 'scope')})
        if 'size_bytes' in item:
            result['size_bytes'] = item['size_bytes']
    return result


def load_client(args):
    owners = {0, os.geteuid()}
    parent = directory(args.ops_root / 'cli', owners=owners)
    try:
        info = os.stat('context_client.py', dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o022 or info.st_nlink != 1:
            raise Blocked('El cliente canónico no tiene dueño y modos autorizados')
    finally:
        os.close(parent)
    sys.path.insert(0, str(args.ops_root / 'cli'))
    from context_client import ConsoleSessionClient, trusted_origin
    if args.authority_fd < 3:
        raise Blocked('La autoridad debe llegar por un descriptor heredado explícito, distinto de stdin/stdout/stderr')
    with os.fdopen(os.dup(args.authority_fd), 'rb') as stream:
        raw = stream.read(16_385)
    if len(raw) > 16_384:
        raise Blocked('El documento de autoridad excede el límite')
    authority = parse(raw)
    shape(authority, {'version', 'gateway', 'origin', 'cookie', 'csrf_token'})
    if authority['version'] != 1 or not isinstance(authority['cookie'], str) or not authority['cookie'] \
            or len(authority['cookie']) > 12_000 or any(ord(char) < 32 or ord(char) == 127 for char in authority['cookie']) \
            or not isinstance(authority['csrf_token'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', authority['csrf_token']):
        raise Blocked('La autoridad nominal aportada no es utilizable')
    client = ConsoleSessionClient.__new__(ConsoleSessionClient)
    client.gateway, client.origin = trusted_origin(authority['gateway']), trusted_origin(authority['origin'])
    client.cookie, client.csrf, client.ca_file = authority['cookie'], authority['csrf_token'], args.ca_file
    return client


def assert_company(client, company):
    session = client.request('GET', '/v3/auth/session')
    authority = session.get('authority') if isinstance(session, dict) else None
    if not isinstance(authority, dict) or session.get('authenticated') is not True \
            or authority.get('acting_company') != company or authority.get('scope') not in {'company', 'platform', 'tenant'}:
        raise Blocked('La sesión no acredita el alcance de empresa exacto del plan')


def verified_operation(value, request):
    if not isinstance(value, dict) or value.get('target') != request['target'] or value.get('kind') != request['kind'] \
            or value.get('request_sha256') != digest(request) or value.get('expected_revision') != request['expected_revision'] \
            or value.get('status') not in OPEN | TERMINAL or type(value.get('version')) is not int or value['version'] < 0:
        raise Blocked(REASONS['invalid_receipt'])
    try:
        uuid.UUID(value['id'])
    except (KeyError, ValueError, TypeError, AttributeError):
        raise Blocked(REASONS['invalid_receipt']) from None
    return {key: value[key] for key in ('id', 'kind', 'target', 'request_sha256', 'expected_revision', 'status', 'version')}


def observe_operation(item, operation):
    status = operation['status']
    reason = 'canonical_succeeded' if status == 'succeeded' else 'canonical_failed' if status in TERMINAL else 'canonical_pending'
    return {'id': item['id'], 'status': 'succeeded' if status == 'succeeded' else 'failed' if status in TERMINAL else 'pending',
            'reason_code': reason, 'reason': REASONS[reason], 'operation': operation}


def preview(client, item, plan):
    request = item['request']
    capability = client.request('GET', '/v3/console/fleet/capability')
    if not isinstance(capability, dict) or capability.get('available') is not True or request['kind'] not in capability.get('actions', []):
        raise Blocked(REASONS['stale_or_unavailable'])
    value = client.request('POST', OPERATIONS + '/preview', request)
    if not isinstance(value, dict) or value.get('target') != request['target'] or value.get('kind') != request['kind'] \
            or value.get('expected_revision') != plan['expected_revision'] or value.get('request_sha256') != digest(request) \
            or type(value.get('can_apply')) is not bool or not isinstance(value.get('resources'), list) \
            or not isinstance(value.get('dependencies'), list):
        raise Blocked(REASONS['invalid_receipt'])
    for resource in value['resources']:
        if not isinstance(resource, dict) or resource.get('action') not in {'delete', 'keep'} \
                or resource.get('type') not in {'container', 'volume', 'directory', 'network', 'unit', 'file'}:
            raise Blocked(REASONS['invalid_receipt'])
        text(resource.get('name'))
    return value


def agent_action(client, item, plan, saved, journal, apply):
    request = item['request']
    target = request['target']
    if protected_scope(plan['company_id'], target['tenant_id'], target['alias'], item.get('host_id')):
        return held(item, 'praxis_inventory_only'), False
    if not re.fullmatch(r'(?:zz-[A-Za-z0-9_-]+|canario[A-Za-z0-9_-]*|v4_verificacion)', target['alias']):
        return held(item, 'not_test_candidate'), False
    if client is None:
        return held(item, 'offline_unvalidated'), False
    assert_company(client, plan['company_id'])
    if isinstance(saved.get('operation'), dict):
        prior = verified_operation(client.request('GET', OPERATIONS + '/' + saved['operation']['id']), request)
        if prior['id'] != saved['operation']['id']:
            raise Blocked(REASONS['invalid_receipt'])
        return observe_operation(item, prior), prior['status'] in {'failed', 'cancelled'}
    history = client.request('GET', OPERATIONS + '?' + urllib.parse.urlencode(target))
    rows = history.get('operations') if isinstance(history, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) or row.get('target') != target
                                       or row.get('status') not in OPEN | TERMINAL for row in rows):
        raise Blocked(REASONS['invalid_receipt'])
    matching = [row for row in rows if row.get('request_sha256') == digest(request)]
    if matching:
        if len(matching) != 1:
            raise Blocked(REASONS['invalid_receipt'])
        prior = verified_operation(matching[0], request)
        return observe_operation(item, prior), prior['status'] in {'failed', 'cancelled'}
    if any(row['status'] in OPEN for row in rows):
        return held(item, 'open_operation'), False
    if len(rows) >= 100:
        return held(item, 'history_incomplete'), False
    value = preview(client, item, plan)
    preview_hash = digest(value)
    result = {'id': item['id'], 'status': 'would_enqueue', 'request_sha256': digest(request),
              'preview_sha256': preview_hash, 'resources': value['resources'],
              'retained_dependencies': [row['type'] for row in value['dependencies'] if isinstance(row, dict) and isinstance(row.get('type'), str)]}
    if any(resource['type'] == 'volume' and resource['action'] == 'delete' for resource in value['resources']):
        return {**result, **held(item, 'volume_retained')}, False
    if not value['can_apply']:
        return {**result, **held(item, 'dependencies_present')}, False
    pin = item.get('preview_sha256')
    if pin is None:
        result.update(held(item, 'preview_review_required'))
        return result, apply
    if pin != preview_hash:
        return {**result, **held(item, 'preview_changed')}, True
    result.update(reason_code='ready', reason=REASONS['ready'])
    if not apply:
        return result, False
    assert_company(client, plan['company_id'])
    renewed = preview(client, item, plan)
    if digest(renewed) != preview_hash:
        return {**result, **held(item, 'preview_changed')}, True
    result['status'] = 'prepared'
    journal(result)
    accepted = client.request('POST', OPERATIONS, request)
    if not isinstance(accepted, dict) or not isinstance(accepted.get('operation'), dict) \
            or accepted.get('operation_id') != accepted['operation'].get('id') \
            or accepted.get('status') != accepted['operation'].get('status'):
        raise Blocked(REASONS['invalid_receipt'])
    operation = verified_operation(accepted['operation'], request)
    return observe_operation(item, operation), operation['status'] in {'failed', 'cancelled'}


def context_fresh(saved, pin):
    try:
        observed = datetime.datetime.fromisoformat(saved['observed_at'])
        age = (datetime.datetime.now(datetime.UTC) - observed).total_seconds()
        return observed.tzinfo is not None and 0 <= age <= 120 and saved['status'] == 'would_change' \
            and saved['head'] == pin['head'] and saved['preview_sha256'] == pin['preview_sha256']
    except (KeyError, TypeError, ValueError):
        return False


def context_action(client, item, plan, saved, journal, apply):
    company, action, pin = item['company_id'], item['action'], item['pin']
    policy = docker_engine().retention_policy()
    if protected_scope(plan['company_id'], company) or re.search(policy["protected_pattern"], company, re.I):
        return held(item, 'praxis_inventory_only'), False
    if company == policy["inventory_company"]:
        return {**held(item, 'no_canonical_cleanup'), 'reason_code': 'active_campaign_144'}, False
    if client is None:
        return held(item, 'offline_unvalidated'), False
    if plan['company_id'] != policy["platform_company"]:
        raise Blocked('context cleanup requires the configured platform company')
    assert_company(client, plan['company_id'])
    operation = str(uuid.uuid5(uuid.NAMESPACE_URL, 'cauce:h10b:context:' + digest({'plan': plan, 'item': item['id']})))
    request = {'company_id': company, 'action': action}
    if action == 'restore':
        request['retirement_commit'] = item['retirement_commit']

    def checked_receipt(value):
        if not isinstance(value, dict) or value.get('operation_id') != operation or value.get('company_id') != company \
                or value.get('action') != action or value.get('before_head') != pin['head'] \
                or value.get('preview_sha256') != pin['preview_sha256'] \
                or value.get('retirement_commit') != item.get('retirement_commit') \
                or not re.fullmatch(r'[a-f0-9]{40,64}', str(value.get('commit'))) \
                or not re.fullmatch(r'[a-f0-9]{40,64}', str(value.get('tree_oid'))) \
                or type(value.get('pushed')) is not bool:
            raise Blocked(REASONS['invalid_receipt'])
        return value

    known = None
    if saved.get('status') in {'prepared', 'retired', 'restored'} or saved.get('context_receipt'):
        try:
            known = checked_receipt(client.request('GET', CONTEXT_API + '/' + operation + '?' + urllib.parse.urlencode({'company_id': company})))
        except Exception as error:
            if not re.search(r'HTTP 404\b', str(error)):
                raise
    if known and known['pushed']:
        return {'id': item['id'], 'status': 'retired' if action == 'retire' else 'restored',
                'reason_code': 'context_committed', 'context_receipt': known, 'idempotent_replay': True}, False
    if known is None:
        value = client.request('POST', CONTEXT_API + '/preview', request)
        if not isinstance(value, dict) or value.get('company_id') != company or value.get('action') != action \
                or value.get('retirement_commit') != item.get('retirement_commit') \
                or value.get('preview_sha256') != digest({key: child for key, child in value.items() if key != 'preview_sha256'}):
            raise Blocked(REASONS['invalid_receipt'])
        result = {'id': item['id'], 'status': 'would_change', 'reason_code': 'ready', 'preview': value,
                  'head': value['head'], 'preview_sha256': value['preview_sha256'], 'operation_id': operation,
                  'observed_at': datetime.datetime.now(datetime.UTC).isoformat()}
        if value.get('can_apply') is not True:
            return {**result, **held(item, 'dependencies_present')}, False
        if pin['head'] is None or pin['preview_sha256'] is None:
            return {**result, **held(item, 'preview_review_required')}, apply
        if value['head'] != pin['head'] or value['preview_sha256'] != pin['preview_sha256']:
            return {**result, **held(item, 'preview_changed')}, True
    else:
        result = {'id': item['id'], 'status': 'would_change', 'reason_code': 'context_local_commit_pending_push',
                  'head': pin['head'], 'preview_sha256': pin['preview_sha256'], 'operation_id': operation,
                  'context_receipt': known, 'observed_at': datetime.datetime.now(datetime.UTC).isoformat()}
    if not apply:
        return result, False
    if not context_fresh(saved, pin):
        return {**result, 'status': 'blocked', 'reason_code': 'fresh_simulation_required'}, True
    assert_company(client, plan['company_id'])
    result['status'] = 'prepared'
    journal(result)
    body = {'company_id': company, 'expected_head': pin['head'], 'preview_sha256': pin['preview_sha256'], 'operation_id': operation}
    if action == 'restore':
        body['retirement_commit'] = item['retirement_commit']
    receipt = checked_receipt(client.request('POST', CONTEXT_API + ('/apply' if action == 'retire' else '/revert'), body))
    return {**result, 'status': ('retired' if action == 'retire' else 'restored') if receipt['pushed'] else 'pending',
            'reason_code': 'context_committed' if receipt['pushed'] else 'context_local_commit_pending_push',
            'context_receipt': receipt}, False


def main():
    parser = argparse.ArgumentParser(description='Prepara una limpieza canónica acotada, simula por defecto y conserva recursos sin vía segura')
    parser.add_argument('--ops-root', required=True, type=pathlib.Path)
    parser.add_argument('--plan', required=True, type=pathlib.Path)
    parser.add_argument('--recibo', required=True, type=pathlib.Path)
    parser.add_argument('--authority-fd', type=int)
    parser.add_argument('--ca-file')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--simular', action='store_true')
    mode.add_argument('--aplicar', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    plan, _ = read_private(args.plan)
    validate_plan(plan)
    docker_engine().retention_policy()
    receipt = Receipt(args.recibo, plan)
    try:
        client = load_client(args) if args.authority_fd is not None else None
        if args.aplicar and client is None:
            raise Blocked('APPLY exige una autoridad nominal aportada explícitamente por descriptor')
        previous = {item['id']: item for item in receipt.document['items'] if isinstance(item, dict) and isinstance(item.get('id'), str)}
        prior_effects = receipt.document.get('external_mutations') == 'possible' \
            or receipt.document.get('prior_effects_possible') is True or any(item.get('operation') for item in previous.values())
        receipt.document.update(mode='apply' if args.aplicar else 'simulate', status='preparing',
                                external_mutations=False, prior_effects_possible=prior_effects,
                                observed_at=datetime.datetime.now(datetime.UTC).isoformat(), items=[])
        failed = False
        for item in plan['items']:
            def journal(result, identity=item['id']):
                receipt.document['items'] = [row for row in receipt.document['items'] if row['id'] != identity] + [result]
                if result['status'] == 'prepared':
                    receipt.document['external_mutations'] = 'possible'
                receipt.save()
            try:
                if item['kind'] == 'resource':
                    reason = 'praxis_inventory_only' if protected_scope(*item['scope'].values()) else \
                        'volume_retained' if item['resource_type'] == 'volume' else 'no_canonical_cleanup'
                    result, blocked = held(item, reason), False
                elif item['kind'] in DOCKER_KINDS:
                    if args.aplicar:
                        assert_company(client, plan['company_id'])
                    result, blocked = docker_engine().action(item, plan, previous.get(item['id'], {}), journal, args.aplicar)
                elif item['kind'] == 'test_context':
                    result, blocked = context_action(client, item, plan, previous.get(item['id'], {}), journal, args.aplicar)
                else:
                    result, blocked = agent_action(client, item, plan, previous.get(item['id'], {}), journal, args.aplicar)
            except Exception:
                prepared = next((row for row in receipt.document['items'] if row['id'] == item['id']), previous.get(item['id'], {}))
                result = {**prepared, 'id': item['id'], 'status': 'prepared' if prepared.get('status') == 'prepared' else 'blocked',
                          'error_code': 'stale_or_unavailable', 'reason': REASONS['stale_or_unavailable'],
                          'effects_possible': receipt.document['external_mutations'] == 'possible' or prepared.get('status') == 'prepared'}
                blocked = True
            journal(result)
            failed = failed or blocked
        states = {item['status'] for item in receipt.document['items']}
        receipt.document['status'] = 'blocked' if failed else 'pending' if 'pending' in states else \
            ('retained' if states == {'retained'} else 'applied') if args.aplicar else \
            'offline_unvalidated' if client is None and not any(item['kind'] in DOCKER_KINDS for item in plan['items']) else 'simulated'
        receipt.save()
        print(json.dumps({'status': receipt.document['status'], 'receipt': str(args.recibo),
                          'plan_sha256': receipt.document['plan_sha256'], 'items': receipt.document['items'],
                          'external_mutations': receipt.document['external_mutations']}, ensure_ascii=False, sort_keys=True))
        return 1 if failed else 0
    except Exception:
        receipt.document.update(status='blocked', reason_code='private_preflight_failed',
                                reason='No se pudo verificar la autoridad, el plan o su recibo privado; no se imprime su contenido.')
        receipt.save()
        print(json.dumps({'status': 'blocked', 'receipt': str(args.recibo),
                          'effects_possible': receipt.document.get('external_mutations') == 'possible',
                          'reason': receipt.document['reason']}, ensure_ascii=False))
        return 1
    finally:
        receipt.close()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'status': 'blocked', 'reason': 'El plan, la autoridad o el recibo privado no pudieron verificarse; no se imprime su contenido.'}))
        raise SystemExit(1) from None
