from __future__ import annotations

import hashlib
import importlib
import json
import math
import pathlib
import re
import subprocess
import sys
import time
import urllib.parse
import uuid

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli'
sys.path.insert(0, str(CLI))
session_client = importlib.import_module('context_client')
platform_client = importlib.import_module('v4_mover_plataforma')
OPERATIONS = '/v3/console/fleet/operations'
TERMINAL = frozenset({'succeeded', 'failed', 'cancelled'})
STATUSES = TERMINAL | {'queued', 'running', 'awaiting_auth', 'cancelling'}
IDENTIFIER = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}\Z')


class FleetFailure(RuntimeError):
    def __init__(self, message: str, operation: dict | None = None, *, settled: bool = True, status_code: int | None = None):
        super().__init__(message)
        self.operation = operation
        self.operation_id = operation.get('id') if operation else None
        self.settled = settled
        self.status_code = status_code


def digest(value: dict) -> str:
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(content.encode()).hexdigest()


def parameters(row: dict) -> dict:
    result = {key: row.get(key) for key in ('runtime_key', 'harness_id', 'display_name', 'primary_room_id',
                                          'primary_account_id', 'model_id', 'reasoning_effort')}
    result['memberships'] = [{key: member[key] for key in ('room_id', 'role', 'enabled') if key in member}
                             for member in row.get('memberships', [])]
    result['placement'] = dict(row.get('placement') or {
        key: row[source] for key, source in (('host_id', 'host_id'), ('mode', 'runtime_mode'),
            ('container_name', 'container_name'), ('runtime_user', 'runtime_user'),
            ('home_directory', 'home_directory'), ('state_directory', 'state_directory'),
            ('systemd_user', 'systemd_user')) if row.get(source) is not None})
    if result['placement'].get('mode') == 'native':
        result['placement'].pop('container_name', None)
    if not result['runtime_key'] or not result['primary_account_id'] or not result['memberships']:
        raise FleetFailure('migration requires the current runtime identity, provider account and memberships')
    return result


class Fleet:
    parameters = staticmethod(parameters)

    def __init__(self, base_url: str | None, session_file: str | None, company: str, *,
                 ca_file: str | None = None, platform_gateway: dict | None = None):
        if not isinstance(company, str) or not IDENTIFIER.fullmatch(company):
            raise FleetFailure('invalid company identifier')
        self.platform = platform_gateway is not None
        self.client = platform_client.PlatformClient(platform_gateway, company) if self.platform else \
            session_client.ConsoleSessionClient(session_file, gateway=base_url, ca_file=ca_file)
        self.session_file = str(session_file) if session_file else None
        self.company = company
        self.last_operation_id: str | None = None
        self.last_operation: dict | None = None
        self.acceptance_unknown = False
        self.on_operation = None
        self.targets: dict[str, dict] = {}
        self.operations: list[dict] = []
        self.pending_request: dict | None = None
        if not self.platform:
            state = self.client.request('GET', '/v3/auth/session')
            authority = state.get('authority', {}) if isinstance(state, dict) else {}
            if authority.get('acting_company') != company:
                raise FleetFailure('console session must already select the requested company')

    def request(self, method: str, path: str, payload=None):
        try:
            if self.platform:
                self.client.tenant = getattr(self, 'tenant', None)
            return self.client.request(method, path, payload)
        except platform_client.PlatformFailure as error:
            raise FleetFailure(str(error), status_code=error.status_code) from error
        except (session_client.ContextFailure, OSError, ValueError) as error:
            status = re.search(r'with HTTP ([0-9]{3})', str(error))
            raise FleetFailure('fleet gateway request could not be verified',
                               status_code=int(status[1]) if status else None) from error

    def snapshot(self) -> dict:
        snapshot = self.request('GET', '/v3/console/config')
        if not isinstance(snapshot, dict) or type(snapshot.get('revision')) is not int \
                or snapshot['revision'] < 0 or not isinstance(snapshot.get('agents'), list):
            raise FleetFailure('fleet configuration snapshot is invalid')
        return snapshot

    def agent(self, alias: str, *, include_retired: bool = False) -> dict:
        tenant, selected = self._identity(alias)
        if getattr(self, 'tenant', None) is not None:
            if tenant is not None and tenant != self.tenant:
                raise FleetFailure('agent tenant differs from the requested migration scope')
            tenant = self.tenant
        snapshot = self.snapshot()
        inventory = snapshot['agents']
        if include_retired:
            inventory = [*inventory, *(snapshot.get('retired') or {}).get('agents', [])]
        rows = [row for row in inventory if isinstance(row, dict) and row.get('alias') == selected
                and (tenant is None or row.get('tenant_id') == tenant)]
        if len(rows) != 1:
            raise FleetFailure('agent must identify exactly one active inventory row')
        result = dict(rows[0])
        if not isinstance(result.get('tenant_id'), str) or not IDENTIFIER.fullmatch(result['tenant_id']):
            raise FleetFailure('agent tenant identity is invalid')
        result['memberships'] = [dict(row) for row in snapshot.get('memberships', []) if isinstance(row, dict)
                                 and row.get('tenant_id') == result['tenant_id'] and row.get('alias') == selected]
        result['revision'] = snapshot['revision']
        target = {'resource': 'agent', 'tenant_id': result['tenant_id'], 'alias': result['alias']}
        if self.targets.setdefault(alias, target) != target:
            raise FleetFailure('agent identity changed during migration')
        return result

    @staticmethod
    def _identity(alias: str) -> tuple[str | None, str]:
        if not isinstance(alias, str):
            raise FleetFailure('invalid agent identifier')
        parts = alias.split('/')
        if len(parts) not in (1, 2) or any(not IDENTIFIER.fullmatch(part) for part in parts):
            raise FleetFailure('invalid agent identifier')
        return (None, parts[0]) if len(parts) == 1 else (parts[0], parts[1])

    def capabilities(self, tenant: str, alias: str) -> dict:
        self.agent(f'{tenant}/{alias}')
        result = self.request('GET', '/v3/console/fleet/capability')
        if not isinstance(result, dict) or result.get('available') is not True \
                or not isinstance(result.get('placements'), list):
            raise FleetFailure('fleet executor capability is unavailable')
        return result

    def account_provider(self, account_id: str) -> str:
        if not isinstance(account_id, str) or not IDENTIFIER.fullmatch(account_id):
            raise FleetFailure('invalid provider account identifier')
        rows = self.snapshot().get('provider_accounts', [])
        matches = [row for row in rows if isinstance(row, dict) and row.get('id') == account_id
                   and row.get('enabled') is True]
        provider = matches[0].get('provider') if len(matches) == 1 else None
        if not isinstance(provider, str) or not IDENTIFIER.fullmatch(provider):
            raise FleetFailure('the original provider account is not enabled in the authorized inventory')
        return provider

    def _receipt(self, row, target: dict, kind: str, operation_id: str | None = None) -> dict:
        if not isinstance(row, dict) or row.get('target') != target or row.get('kind') != kind \
                or row.get('status') not in STATUSES or type(row.get('version')) is not int:
            raise FleetFailure('fleet operation receipt is invalid', settled=False)
        try:
            valid_id = str(uuid.UUID(row.get('id', '')))
        except (ValueError, AttributeError, TypeError):
            raise FleetFailure('fleet operation identity is invalid', settled=False) from None
        if valid_id != row['id'] or operation_id is not None and row['id'] != operation_id:
            raise FleetFailure('fleet operation identity differs from the accepted operation', settled=False)
        self.last_operation_id = row['id']
        self.last_operation = row
        self.acceptance_unknown = False
        safe = {key: row[key] for key in ('id', 'status', 'target', 'kind', 'steps', 'version')}
        self.operations[:] = [entry for entry in self.operations if entry['id'] != row['id']] + [safe]
        if self.on_operation is not None:
            self.on_operation(row)
        return row

    def _read_operation(self, row: dict) -> dict:
        result = self.request('GET', OPERATIONS + '/' + row['id'])
        return self._receipt(result, row['target'], row['kind'], row['id'])

    def _cancel_and_settle(self, row: dict, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while row['status'] not in {'succeeded', 'cancelled'}:
            if row['status'] != 'cancelling':
                try:
                    result = self.request('POST', OPERATIONS + '/' + row['id'] + '/cancel',
                                          {'expected_version': row['version']})
                    row = self._receipt(result, row['target'], row['kind'], row['id'])
                except FleetFailure:
                    row = self._read_operation(row)
            if row['status'] in {'succeeded', 'cancelled'}:
                break
            if time.monotonic() >= deadline:
                raise FleetFailure('fleet cancellation has not settled; recovery must wait', row, settled=False)
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))
            row = self._read_operation(row)
        return row

    def _accepted(self, request: dict) -> dict:
        self.acceptance_unknown = True
        self.pending_request = request
        try:
            accepted = self.request('POST', OPERATIONS, request)
        except FleetFailure as error:
            query = urllib.parse.urlencode(request['target'])
            history = self.request('GET', OPERATIONS + '?' + query)
            rows = history.get('operations', []) if isinstance(history, dict) else []
            matches = [row for row in rows if isinstance(row, dict) and row.get('request_sha256') == digest(request)]
            if not matches and error.status_code in {400, 401, 403, 409}:
                self.acceptance_unknown = False
                self.pending_request = None
                raise error
            if len(matches) != 1:
                raise FleetFailure('operation acceptance is unknown; inspect durable history before recovery',
                                   settled=False) from error
            row = matches[0]
        else:
            row = accepted.get('operation') if isinstance(accepted, dict) else None
            if not isinstance(row, dict) or accepted.get('operation_id') != row.get('id') \
                    or accepted.get('status') != row.get('status'):
                raise FleetFailure('fleet acceptance receipt is invalid', settled=False)
        row = self._receipt(row, request['target'], request['kind'])
        if row.get('request_sha256') != digest(request) or row.get('expected_revision') != request['expected_revision']:
            raise FleetFailure('fleet acceptance differs from its preview', row, settled=False)
        return row

    def operation(self, kind: str, alias: str, parameters: dict, timeout: float = 300, *,
                  authentication_wait: float = 0, on_authentication=None) -> dict:
        if kind not in {'create', 'update', 'start', 'stop', 'retire'} or not isinstance(parameters, dict) \
                or not math.isfinite(timeout) or timeout <= 0 \
                or not math.isfinite(authentication_wait) or not 0 <= authentication_wait <= 1800:
            raise FleetFailure('invalid migration operation')
        agent = self.agent(alias)
        target = {'resource': 'agent', 'tenant_id': agent['tenant_id'], 'alias': agent['alias']}
        request = {'kind': kind, 'target': target, 'parameters': parameters,
                   'expected_revision': agent['revision'], 'idempotency_key': 'move-' + uuid.uuid4().hex}
        preview = self.request('POST', OPERATIONS + '/preview', request)
        if not isinstance(preview, dict) or preview.get('target') != target or preview.get('kind') != kind \
                or preview.get('expected_revision') != request['expected_revision'] \
                or preview.get('request_sha256') != digest(request) or preview.get('can_apply') is not True:
            raise FleetFailure('fleet preview does not authorize the exact migration operation')
        row = self._accepted(request)
        deadline = time.monotonic() + timeout
        authentication_deadline = None
        while row['status'] not in TERMINAL:
            waiting = row['status'] == 'awaiting_auth'
            if waiting and authentication_wait and authentication_deadline is None:
                authentication_deadline = time.monotonic() + authentication_wait
                deadline += authentication_wait
                if on_authentication is not None:
                    on_authentication(row)
            active_deadline = min(deadline, authentication_deadline) if waiting and authentication_deadline else deadline
            if waiting and not authentication_wait or time.monotonic() >= active_deadline:
                reason = 'provider authentication is required' if row['status'] == 'awaiting_auth' else 'fleet operation timed out'
                settled = self._cancel_and_settle(row, max(30, min(timeout, 180)))
                if settled['status'] == 'succeeded':
                    return settled
                raise FleetFailure(reason + '; operation cancellation settled', settled)
            time.sleep(min(120 if waiting else 0.5, max(0, active_deadline - time.monotonic())))
            try:
                row = self._read_operation(row)
            except FleetFailure as error:
                try:
                    settled = self._cancel_and_settle(row, max(30, min(timeout, 180)))
                except FleetFailure:
                    raise FleetFailure('operation observation and cancellation are unverified', row, settled=False) from error
                raise FleetFailure('operation observation failed; cancellation settled', settled) from error
        if row['status'] != 'succeeded':
            raise FleetFailure('fleet operation ended without completing the migration effect', row)
        return row

    def prepare_legacy(self, alias: str, original_row: dict, target: dict | None = None) -> dict:
        current = self.agent(alias)
        if current['tenant_id'] != original_row.get('tenant_id') or current['alias'] != original_row.get('alias'):
            raise FleetFailure('legacy preparation target differs from its snapshot')
        return self.request('POST', '/internal/migration/prepare-legacy',
                            {'original': original_row, 'target': target, 'expected_revision': current['revision']})

    def restore_legacy(self, alias: str, original_row: dict, target: dict) -> dict:
        current = self.agent(alias, include_retired=True)
        if current['tenant_id'] != original_row.get('tenant_id') or current['alias'] != original_row.get('alias'):
            raise FleetFailure('legacy rollback target differs from its snapshot')
        return self.request('POST', '/internal/migration/restore-legacy',
                            {'original': original_row, 'target': target, 'expected_revision': current['revision']})

    def rollback(self, alias: str, original_parameters: dict, timeout: float = 300) -> dict:
        self.settle_pending(max(30, min(timeout, 180)))
        return self.operation('update', alias, original_parameters, timeout)

    def settle_pending(self, timeout: float = 180) -> dict | None:
        if self.acceptance_unknown:
            request = self.pending_request
            if request is None:
                raise FleetFailure('operation acceptance cannot be recovered without its original request', settled=False)
            deadline = time.monotonic() + timeout
            while self.acceptance_unknown:
                history = self.request('GET', OPERATIONS + '?' + urllib.parse.urlencode(request['target']))
                rows = history.get('operations', []) if isinstance(history, dict) else []
                matches = [row for row in rows if isinstance(row, dict) and row.get('request_sha256') == digest(request)]
                if len(matches) == 1:
                    self._receipt(matches[0], request['target'], request['kind'])
                    break
                if len(matches) > 1 or time.monotonic() >= deadline:
                    raise FleetFailure('operation acceptance is unknown; recovery must inspect durable history', settled=False)
                time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        if self.last_operation and self.last_operation.get('status') not in {'succeeded', 'cancelled'}:
            return self._cancel_and_settle(self.last_operation, timeout)
        return self.last_operation

    @property
    def outstanding(self) -> bool:
        return self.acceptance_unknown or bool(self.last_operation and self.last_operation['status'] not in TERMINAL)

    def _nonce(self, row: dict, timeout: float) -> dict:
        nonce = 'CAUCE_MOVE_' + uuid.uuid4().hex
        if self.platform:
            receipt = self.request('POST', '/internal/migration/nonce',
                                   {'tenant_id': row['tenant_id'], 'alias': row['alias'], 'nonce': nonce})
            if not isinstance(receipt, dict) or not isinstance(receipt.get('message_id'), str):
                raise FleetFailure('internal migration nonce has no durable publication receipt')
            return self._nonce_delivery(row, nonce, receipt, timeout)
        command = {'room_id': row['primary_room_id'], 'recipients': [{'tenant_id': row['tenant_id'], 'alias': row['alias']}],
                   'body': {'text': 'Reply with exactly this nonce and no other text: ' + nonce}, 'lane': 'interactive', 'priority': 0}
        prepared = self.request('POST', '/v3/console/publish-intents', {**command, 'intent_nonce': str(uuid.uuid4())})
        if not isinstance(prepared, dict) or prepared.get('state') not in {'prepared', 'committed'} \
                or not isinstance(prepared.get('idempotency_key'), str):
            raise FleetFailure('nonce publish intent is invalid')
        receipt = prepared.get('receipt') if prepared['state'] == 'committed' else self.request(
            'POST', '/v3/console/messages', {**command, 'idempotency_key': prepared['idempotency_key']})
        if not isinstance(receipt, dict) or receipt.get('idempotency_key') != prepared['idempotency_key']:
            raise FleetFailure('nonce publish receipt is invalid')
        confirmation = {key: receipt[key] for key in ('idempotency_key', 'message_id', 'causal_hash')}
        confirmed = self.request('POST', '/v3/console/publish-intents/confirm', confirmation)
        if not isinstance(confirmed, dict) or confirmed.get('confirmed') is not True \
                or any(confirmed.get(key) != value for key, value in confirmation.items()):
            raise FleetFailure('nonce publish confirmation is invalid')
        return self._nonce_delivery(row, nonce, receipt, timeout)

    def _nonce_delivery(self, row: dict, nonce: str, receipt: dict, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            detail = self.request('GET', '/v3/console/messages/' + receipt['message_id'])
            deliveries = detail.get('deliveries', []) if isinstance(detail, dict) else []
            selected = [item for item in deliveries if isinstance(item, dict) and item.get('tenant_id') == row['tenant_id']
                        and item.get('alias') == row['alias']]
            if len(selected) == 1 and selected[0].get('status') == 'done':
                if selected[0].get('reply') != nonce:
                    raise FleetFailure('migrated agent did not return the exact nonce')
                return {'message_id': receipt['message_id'], 'delivery_id': selected[0].get('delivery_id'), 'nonce_verified': True}
            if time.monotonic() >= deadline:
                raise FleetFailure('migrated agent nonce response timed out')
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))

    def _terminal_ticket(self, row: dict) -> dict:
        if self.platform:
            return {'ticket_verified': False, 'websocket_verified': False, 'verification': 'external_required'}
        targets = self.request('GET', '/v3/console/terminal/targets')
        items = targets.get('items', []) if isinstance(targets, dict) else []
        selected = [item for item in items if isinstance(item, dict) and item.get('tenant_id') == row['tenant_id']
                    and item.get('alias') == row['alias']]
        if len(selected) != 1 or selected[0].get('authorized') is not True or selected[0].get('pty_state') != 'online' \
                or not any(mode in selected[0].get('modes', []) for mode in ('shell', 'harness')):
            raise FleetFailure('migrated agent terminal is not online and authorized')
        mode = 'shell' if 'shell' in selected[0]['modes'] else 'harness'
        marker = 'CAUCE_TERMINAL_' + uuid.uuid4().hex
        command = [sys.executable, '-B', str(CLI / 'context_client.py'), '--terminal', row['alias'],
                   '--tenant', row['tenant_id'], '--mode', mode, '--session-file', self.session_file,
                   '--gateway', self.client.gateway]
        if self.client.ca_file:
            command += ['--ca-file', self.client.ca_file]
        probe = "printf '%s%s\\n' 'CAUCE_TERMINAL_' '" + marker.removeprefix('CAUCE_TERMINAL_') + "'; exit\r"
        try:
            result = subprocess.run(command, input=probe if mode == 'shell' else '\x1d',
                                    text=True, capture_output=True, timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise FleetFailure('terminal CLI round trip did not complete') from None
        if result.returncode != 0 or 'Terminal conectado;' not in result.stderr \
                or mode == 'shell' and marker not in result.stdout:
            raise FleetFailure('terminal CLI did not verify the migrated agent WebSocket and shell')
        return {'ticket_verified': True, 'websocket_verified': True, 'shell_nonce_verified': mode == 'shell', 'mode': mode}

    def refresh_context(self, alias: str, reason: str, timeout: float = 120) -> dict:
        if not isinstance(reason, str) or len(reason.strip()) < 8 or len(reason) > 280 \
                or not math.isfinite(timeout) or timeout <= 0:
            raise FleetFailure('context refresh requires an attributed reason and a positive timeout')
        row = self.agent(alias)
        base = '/v3/console/tenants/' + urllib.parse.quote(row['tenant_id']) + '/agents/' + urllib.parse.quote(row['alias'])
        profile = self.request('GET', base + '/perfil')
        if not isinstance(profile, dict):
            raise FleetFailure('context refresh profile receipt is invalid')
        measured = profile.get('runtime_verification') or {}
        if profile.get('runtime_state') == 'applied' and measured.get('state') == 'current' \
                and profile.get('revision') is not None and profile.get('revision') == profile.get('applied_revision') \
                and profile.get('runtime_adoption'):
            return {'reloaded': False, 'state': 'applied', 'revision': profile['revision'], 'generation': measured.get('generation')}
        if self.platform:
            operation = self.last_operation
            if not operation or operation.get('status') != 'succeeded' \
                    or operation.get('kind') not in {'create', 'update', 'start', 'restore'} \
                    or operation.get('target') != {'resource': 'agent', 'tenant_id': row['tenant_id'], 'alias': row['alias']} \
                    or any(not any(step.get('name') == name and step.get('status') == 'succeeded'
                                   for step in operation.get('steps', [])) for name in ('profile', 'verify')):
                raise FleetFailure('context refresh requires the exact successful canonical fleet profile and verification')
            bootstrap = profile.get('bootstrap_verification') or {}
            if bootstrap.get('verified') is True and bootstrap.get('operation_id') == operation['id'] \
                    and bootstrap.get('profile_revision') == profile.get('revision') and bootstrap.get('documents'):
                return {'reloaded': False, 'state': 'pending_session_refresh', 'revision': profile['revision'],
                        'operation_id': operation['id'], 'evidence': 'fleet_bootstrap_normal_awaiting_delivery'}
            if measured.get('revision') != profile.get('revision') or not measured.get('generation') \
                    or not measured.get('documents'):
                raise FleetFailure('canonical fleet operation has not projected the desired migration profile')
            return {'reloaded': False, 'state': 'pending_session_refresh', 'revision': profile['revision'],
                    'generation': measured['generation'], 'operation_id': operation['id'],
                    'evidence': 'fleet_profile_projection_awaiting_delivery'}
        deadline = time.monotonic() + timeout
        while True:
            targets = self.request('GET', '/v3/console/terminal/targets')
            items = targets.get('items', []) if isinstance(targets, dict) else []
            online = [item for item in items if isinstance(item, dict) and item.get('tenant_id') == row['tenant_id']
                      and item.get('alias') == row['alias'] and item.get('pty_state') == 'online' and item.get('authorized') is True]
            if len(online) == 1:
                break
            if time.monotonic() >= deadline:
                raise FleetFailure('context refresh requires the migrated runtime PTY to be online')
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        receipt = self.request('POST', base + '/context/reload', {'reason': reason.strip()})
        verification = receipt.get('runtime_verification') or {} if isinstance(receipt, dict) else {}
        documents = verification.get('documents')
        if not isinstance(receipt, dict) or receipt.get('ok') is not True \
                or receipt.get('tenant_id') != row['tenant_id'] or receipt.get('alias') != row['alias'] \
                or receipt.get('revision') != profile.get('revision') \
                or receipt.get('state') not in {'pending_session_refresh', 'applied'} \
                or verification.get('state') != 'current' or not isinstance(verification.get('generation'), str) \
                or not verification['generation'] or not isinstance(documents, list) \
                or any(not isinstance(document, dict) or document.get('current') is not True for document in documents):
            raise FleetFailure('context reload did not acknowledge the exact migrated runtime profile')
        readback = self.request('GET', base + '/perfil')
        observed = readback.get('runtime_verification') or {} if isinstance(readback, dict) else {}
        if not isinstance(readback, dict) or readback.get('revision') != receipt['revision'] \
                or observed.get('state') != 'current' or observed.get('generation') != verification['generation']:
            raise FleetFailure('context reload readback differs from its runtime acknowledgement')
        return {'reloaded': True, 'state': receipt['state'], 'revision': receipt['revision'],
                'generation': verification['generation'], 'documents': len(documents)}

    def verify(self, alias: str, expected_parameters: dict, timeout: float = 120) -> dict:
        row = self.agent(alias)
        observed = parameters(row)
        for key, value in expected_parameters.items():
            actual = observed.get(key)
            if key == 'memberships':
                def members(items):
                    return sorted((item['room_id'], item['role'], item.get('enabled', True)) for item in items)
                actual, value = members(actual), members(value)
            if actual != value:
                raise FleetFailure('migrated agent configuration differs from its expected identity or placement')
        if row.get('enabled') is not True or row.get('lifecycle_state') != 'ready':
            raise FleetFailure('migrated agent is not admitted and ready')
        roundtrip = self._nonce(row, timeout)
        base = '/v3/console/context/agents/' + urllib.parse.quote(row['tenant_id']) + '/' + urllib.parse.quote(row['alias'])
        deadline = time.monotonic() + timeout
        while True:
            context = self.request('GET', base)
            version = context.get('desired_version') if isinstance(context, dict) else None
            version_ready = type(version) is int and version > 0 and context.get('applied_version') == version \
                and (context.get('application') or {}).get('state') == 'applied' \
                and isinstance(context.get('digest'), str) and re.fullmatch(r'[a-f0-9]{64}', context['digest']) is not None
            profile = self.request('GET', '/v3/console/tenants/' + urllib.parse.quote(row['tenant_id'])
                                   + '/agents/' + urllib.parse.quote(row['alias']) + '/perfil')
            profile_ready = isinstance(profile, dict) and profile.get('runtime_state') == 'applied' \
                and profile.get('revision') is not None and profile.get('revision') == profile.get('applied_revision') \
                and (profile.get('runtime_verification') or {}).get('state') == 'current' and profile.get('runtime_adoption')
            bootstrap = profile.get('bootstrap_verification') or {} if isinstance(profile, dict) else {}
            if self.platform and bootstrap.get('verified') is True and bootstrap.get('evidence') == 'fleet_bootstrap_normal' \
                    and bootstrap.get('profile_revision') == profile.get('revision') and bootstrap.get('documents') \
                    and self.last_operation and bootstrap.get('operation_id') == self.last_operation['id']:
                profile_ready = True
            if version_ready and profile_ready:
                break
            if time.monotonic() >= deadline:
                raise FleetFailure('migrated agent context version or live adoption is unverified')
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        return {'host_id': observed['placement']['host_id'], 'harness_id': observed['harness_id'],
                'primary_account_id': observed['primary_account_id'], 'context_version': version,
                'context_digest': context['digest'], 'profile_revision': profile['revision'],
                'profile_evidence': 'fleet_bootstrap_normal' if self.platform and bootstrap.get('verified') is True else 'adapter_delivery',
                'roundtrip': roundtrip, 'terminal': self._terminal_ticket(row)}
