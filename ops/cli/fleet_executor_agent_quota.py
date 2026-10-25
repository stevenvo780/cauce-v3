from __future__ import annotations

import datetime
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import time
import uuid

PROVIDERS = frozenset({'codex', 'claude', 'grok'})
SECRET_MARKERS = ('refresh_token', 'access_token', 'user_code', 'sk-ant-', 'eyJ')
PROFILE_DIRECTORY = {'codex': '.codex', 'claude': '.claude', 'grok': '.grok'}
IDENTIFIER = re.compile(r'[a-z][a-z0-9_-]{0,63}')
TENANT = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}')
KEY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}')
MAX_READER_BYTES = 65536


def bounded_reader(command: list[str]) -> dict:
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        data = bytearray()
        deadline = time.monotonic() + 55
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError('quota_reader_unavailable')
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fd, MAX_READER_BYTES + 1 - len(data))
                    if not chunk:
                        selector.unregister(key.fd)
                    data.extend(chunk)
                    if len(data) > MAX_READER_BYTES:
                        raise ValueError('quota_reader_invalid')
        try:
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise ValueError('quota_reader_unavailable') from None
        raw = json.loads(data)
        if not isinstance(raw, dict) or code not in (0, 1) \
                or code == 1 and not raw.get('error') and raw.get('ok') is not False:
            raise ValueError('quota_reader_invalid')
        return raw
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()


def safe_observation(provider: str, raw: dict, error_codes: list[str]) -> dict:
    extra = raw.get('extra') if isinstance(raw.get('extra'), dict) else {}
    identity = extra.get('account_id') if provider == 'codex' else raw.get('account_id')
    if provider == 'grok' and identity is None:
        identity = raw.get('email')
    if not isinstance(identity, str) or not 1 <= len(identity.encode('utf-16-le')) <= 512 \
            or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in identity):
        raise ValueError('quota_identity_unavailable')
    if raw.get('provider', provider) != provider:
        raise ValueError('quota_provider_mismatch')
    if 'ok' in raw and type(raw['ok']) is not bool or 'error' in raw \
            and raw['error'] is not None and not isinstance(raw['error'], str):
        raise ValueError('quota_reader_invalid')
    successful = not raw.get('error') and bool(raw.get('ok', bool(raw.get('ventanas'))))
    observation = {'ok': successful, 'available': successful, 'windows': [],
        'error_code': None if successful else raw.get('error_code') if raw.get('error_code') in error_codes else 'provider_error'}
    windows = raw.get('windows', raw.get('ventanas', []))
    if not isinstance(windows, list) or len(windows) > 64:
        raise ValueError('quota_reader_invalid')
    for window in windows:
        if not isinstance(window, dict):
            raise ValueError('quota_reader_invalid')
        key = window.get('key', window.get('window_key', window.get('clave')))
        group = window.get('limitId', window.get('limit_id', 'default'))
        if not isinstance(key, str) or KEY.fullmatch(key) is None or not isinstance(group, str) \
                or KEY.fullmatch(group) is None or identity in key or identity in group:
            raise ValueError('quota_reader_invalid')
        safe = {'key': key, 'limitId': group}
        for destination, sources in {
            'usedPercent': ('usedPercent', 'used_percent', 'usado_pct'),
            'remainingPercent': ('remainingPercent', 'remaining_percent', 'restante_pct'),
            'usedUnits': ('usedUnits', 'used_units'), 'limitUnits': ('limitUnits', 'limit_units'),
            'windowMinutes': ('windowMinutes', 'window_minutes')}.items():
            value = next((window[field] for field in sources if field in window), None)
            if value is not None and (type(value) not in (int, float) or not -1e15 < value < 1e15):
                raise ValueError('quota_reader_invalid')
            if value is not None and (not 0 <= value <= 100 if destination.endswith('Percent') else
                    value != int(value) or value < (0 if destination == 'usedUnits' else 1)):
                raise ValueError('quota_reader_invalid')
            if destination == 'windowMinutes' and value is not None and value > 2147483647:
                raise ValueError('quota_reader_invalid')
            safe[destination] = value
        reset = window.get('resetAt', window.get('reset_at', window.get('reinicia_en')))
        if reset is not None:
            instant = datetime.datetime.fromisoformat(reset.replace('Z', '+00:00'))
            if instant.tzinfo is None:
                raise ValueError('quota_reader_invalid')
            safe['resetAt'] = instant.astimezone(datetime.UTC).isoformat().replace('+00:00', 'Z')
        status = window.get('status')
        if status not in (None, 'unknown', 'error', 'ok', 'rate-limited', 'exhausted'):
            raise ValueError('quota_reader_invalid')
        safe['status'] = status
        observation['windows'].append(safe)
    remaining = [window['remainingPercent'] if window['remainingPercent'] is not None else 100 - window['usedPercent']
        for window in observation['windows'] if window['status'] not in {'unknown', 'error', 'rate-limited'}
        and (window['remainingPercent'] is not None or window['usedPercent'] is not None)]
    if successful and remaining and len(remaining) == len(observation['windows']):
        observation['effectiveRemainingPercent'] = min(remaining)
    encoded = json.dumps([provider, identity], ensure_ascii=False, separators=(',', ':')).encode()
    return {'identity_hash': hashlib.sha256(encoded).hexdigest(), 'observation': observation}


def packet(policy: dict, document: dict) -> dict:
    from fleet_executor_policy import SafeFailure, approve_agent, path
    from fleet_executor_templates import validate_accounts
    if not isinstance(document, dict) or set(document) - {'trusted_accounts'} != {'operation_id', 'action', 'agent'} \
            or document['action'] != 'query_agent':
        raise SafeFailure('invalid typed agent quota operation')
    try:
        if str(uuid.UUID(document['operation_id'])) != document['operation_id']:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise SafeFailure('invalid agent quota operation identity') from None
    agent = document['agent']
    required = {'tenant_id', 'alias', 'runtime_key', 'harness_id', 'host_id', 'runtime_mode',
        'container_name', 'runtime_user', 'home_directory', 'state_directory'}
    if not isinstance(agent, dict) or set(agent) - {'systemd_user', 'primary_account_id', 'fleet_baseline'} != required \
            or any(not isinstance(agent[field], str) for field in required) \
            or TENANT.fullmatch(agent['tenant_id']) is None or any(IDENTIFIER.fullmatch(agent[field]) is None
                for field in ('alias', 'harness_id', 'host_id')) \
            or agent['runtime_mode'] != 'container' \
            or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', agent['container_name']) is None \
            or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,63}', agent['runtime_user']) is None \
            or agent.get('primary_account_id') is not None and (not isinstance(agent['primary_account_id'], str)
                or IDENTIFIER.fullmatch(agent['primary_account_id']) is None) \
            or 'fleet_baseline' in agent and type(agent['fleet_baseline']) is not bool \
            or agent.get('systemd_user') is not None and (not isinstance(agent['systemd_user'], str)
                or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,63}', agent['systemd_user']) is None):
        raise SafeFailure('invalid agent quota target')
    for field in ('home_directory', 'state_directory'):
        path(agent[field])
    validate_accounts(document.get('trusted_accounts', []))
    return approve_agent(policy, {**agent, '_trusted_accounts': document.get('trusted_accounts', []),
        '_trusted_accounts_present': 'trusted_accounts' in document})


def perform(policy: dict, document: dict) -> dict:
    from fleet_executor_container import DOCKER, EXECUTOR_DESTINATION, user_identity
    from fleet_executor_hooks import binding_for, container_binding
    from fleet_executor_policy import SafeFailure
    from fleet_executor_runtime import approved_bundle
    from fleet_executor_templates import resolve_profile
    from harness_operations import read_descriptor
    from quota_runtime import provider_operation
    from quota_snapshot import ERROR_CODES, normalize_cli_snapshot
    agent = packet(policy, document)
    bundle = approved_bundle(policy, agent)
    descriptor, _ = read_descriptor(bundle['directory'], agent['harness_id'], expected_sha256=bundle.get('descriptor_sha256'))
    captured_at = datetime.datetime.now(datetime.UTC).isoformat().replace('+00:00', 'Z')
    envelope = {'operation_id': document['operation_id'], 'tenant': agent['tenant_id'], 'alias': agent['alias'],
        'host_id': agent['host_id'], 'container_name': agent['container_name'], 'harness': agent['harness_id'],
        'captured_at': captured_at}
    provider = agent['harness_id']
    if 'quota' not in descriptor['operations'] or provider not in PROVIDERS:
        approved_bundle(policy, agent)
        return {**envelope, 'status': 'unsupported', 'reason': 'quota_reader_unavailable'}
    command = provider_operation(policy, provider, 'quota', command=True)
    if any(argument.lstrip('-').split('=', 1)[0] == 'refresh-own-session' for argument in command):
        raise SafeFailure('quota_refresh_forbidden')
    profile = str(pathlib.PurePosixPath(agent['home_directory']) / PROFILE_DIRECTORY[provider])
    binding = resolve_profile(policy, agent)
    if binding is not None:
        if binding.get('provider') != provider or not isinstance(binding.get('path'), str) \
                or not pathlib.PurePosixPath(binding['path']).is_absolute():
            raise SafeFailure('quota_profile_unsupported')
        binding_for(policy, agent)
        # A template binding keeps the provider session under the dedicated profile mount, not in $HOME.
        profile = binding['path']
    if provider == 'codex':
        if len(command) != 2 or command[1] != '/home/node/.codex':
            raise SafeFailure('quota_profile_unsupported')
        command[1] = profile
    agent, before = container_binding(policy, agent)
    uid, gid = user_identity(agent, before)
    profile_environment = {'claude': ['CLAUDE_CONFIG_DIR=' + profile], 'grok': ['GROK_HOME=' + profile]}.get(provider, [])
    arguments = [DOCKER, 'exec', '-i', '-w', '/', '--user', uid + ':' + gid, before['container_id'], '/usr/bin/env', '-i',
        'HOME=' + agent['home_directory'], 'PATH=/usr/local/bin:/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE=1',
        *profile_environment,
        agent['_placement']['python'], '-I', '-B', EXECUTOR_DESTINATION + '/fleet_executor_agent_quota.py', '--read']
    try:
        response = subprocess.run(arguments, input=json.dumps({'provider': provider, 'command': command,
            'error_codes': sorted(ERROR_CODES)}).encode(),
            capture_output=True, timeout=65, check=False)
        if response.returncode or len(response.stdout) > MAX_READER_BYTES:
            code = response.stderr.decode(errors='replace').strip()
            raise SafeFailure(code if code in {'quota_identity_unavailable', 'quota_provider_mismatch',
                'quota_reader_invalid', 'quota_reader_unavailable'} else 'quota_reader_unavailable')
        result = json.loads(response.stdout)
        if not isinstance(result, dict) or set(result) != {'identity_hash', 'observation'} \
                or not isinstance(result['identity_hash'], str) or re.fullmatch(r'[0-9a-f]{64}', result['identity_hash']) is None \
                or not isinstance(result['observation'], dict):
            raise SafeFailure('quota_reader_invalid')
    except SafeFailure:
        raise
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise SafeFailure('quota_reader_unavailable') from None
    _agent, after = container_binding(policy, agent)
    if before != after:
        raise SafeFailure('quota_container_changed')
    approved_bundle(policy, agent)
    normalized = normalize_cli_snapshot(provider, result['observation'], 'unbound-agent-quota')
    normalized['provider_report'].pop('account_id', None)
    for window in normalized['provider_report']['windows']:
        window.pop('account_id', None)
    return {**envelope, **normalized, 'status': 'measured', 'provider': provider, 'identity_hash': result['identity_hash']}


def _window_key(window: dict) -> str:
    for field in ('window_key', 'key', 'clave'):
        value = window.get(field)
        if isinstance(value, str) and value:
            return value
    raise ValueError('quota_window_invalid')


def _window_percent(window: dict) -> float:
    for field in ('remaining_percent', 'remainingPercent', 'restante_pct'):
        value = window.get(field)
        if type(value) in (int, float) and value == value:
            return float(value)
    for field in ('used_percent', 'usedPercent', 'usado_pct'):
        value = window.get(field)
        if type(value) in (int, float) and value == value:
            return 100.0 - float(value)
    raise ValueError('quota_window_invalid')


def _window_reset(window: dict) -> str | None:
    value = next((window[field] for field in ('reset_at', 'resetAt', 'reinicia_en') if field in window), None)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('quota_window_invalid')
    instant = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if instant.tzinfo is None:
        raise ValueError('quota_window_invalid')
    return instant.astimezone(datetime.UTC).isoformat().replace('+00:00', 'Z')


def _indexed_windows(document) -> dict:
    if isinstance(document, list):
        windows = document
    elif isinstance(document, dict):
        windows = document.get('windows', document.get('ventanas'))
    else:
        windows = None
    if not isinstance(windows, list):
        raise ValueError('quota_window_invalid')
    indexed = {}
    for window in windows:
        if not isinstance(window, dict):
            raise ValueError('quota_window_invalid')
        key = _window_key(window)
        if key in indexed:
            raise ValueError('quota_window_invalid')
        indexed[key] = window
    return indexed


def contrast_same_instant(web: dict, coutas: dict, *, tolerance: float = 1) -> dict:
    if not isinstance(web, dict) or not isinstance(coutas, dict) or set(web) != PROVIDERS or set(coutas) != PROVIDERS \
            or type(tolerance) not in (int, float) or not 0 <= tolerance <= 100:
        raise ValueError('quota_contrast_incomplete')
    mismatches = []
    for provider in sorted(PROVIDERS):
        left, right = _indexed_windows(web[provider]), _indexed_windows(coutas[provider])
        if set(left) != set(right):
            mismatches.append({'provider': provider, 'reason': 'windows', 'web': sorted(left), 'coutas': sorted(right)})
            continue
        for key in sorted(left):
            if abs(_window_percent(left[key]) - _window_percent(right[key])) > tolerance:
                mismatches.append({'provider': provider, 'window': key, 'reason': 'percent'})
            if _window_reset(left[key]) != _window_reset(right[key]):
                mismatches.append({'provider': provider, 'window': key, 'reason': 'reset'})
    return {'ok': not mismatches, 'tolerance': tolerance, 'mismatches': mismatches}


def secret_match_count(text: str) -> int:
    if not isinstance(text, str):
        raise ValueError('quota_audit_invalid')
    return sum(text.count(marker) for marker in SECRET_MARKERS)


def redact_secrets(text: str) -> str:
    if not isinstance(text, str):
        raise ValueError('quota_audit_invalid')
    redacted = text
    for marker in SECRET_MARKERS:
        redacted = redacted.replace(marker, '[redacted]')
    return redacted


def audit_quota_logs(gateway: list, host: list, audit_events: list) -> dict:
    groups = {'gateway': gateway, 'host': host, 'audit_events': audit_events}
    counts = {}
    for name, records in groups.items():
        if not isinstance(records, list):
            raise ValueError('quota_audit_invalid')
        total = 0
        for record in records:
            raw = record if isinstance(record, str) else json.dumps(record, ensure_ascii=False, default=str)
            total += secret_match_count(raw)
        counts[name] = total
    return {'matches': sum(counts.values()), **counts}


if __name__ == '__main__':
    try:
        if sys.argv[1:] != ['--read']:
            raise ValueError('quota_reader_invalid')
        document = json.loads(sys.stdin.buffer.read(16385))
        print(json.dumps(safe_observation(document['provider'], bounded_reader(document['command']), document['error_codes']),
            ensure_ascii=False, separators=(',', ':')))
    except Exception as error:
        code = str(error)
        print(code if code in {'quota_identity_unavailable', 'quota_provider_mismatch', 'quota_reader_invalid',
            'quota_reader_unavailable'} else 'quota_reader_invalid', file=sys.stderr)
        raise SystemExit(2) from None
