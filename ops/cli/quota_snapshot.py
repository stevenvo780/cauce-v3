from __future__ import annotations

import datetime
import importlib.util
import pathlib

# Closed failure codes stored in quota_provider_reports.note: not_authenticated (no usable
# credential), token_expired (re-authenticate), forbidden_credential_type (credential cannot
# query quota), rate_limited (429, never exhaustion), network, provider_error.
ERROR_CODES = frozenset({'not_authenticated', 'token_expired', 'forbidden_credential_type',
                         'rate_limited', 'network', 'provider_error'})


def failure_code(raw: dict) -> str:
    if raw.get('error_code') in ERROR_CODES:
        return raw['error_code']
    extra = raw.get('extra') if isinstance(raw.get('extra'), dict) else {}
    status = raw.get('http_status') or extra.get('http_status')
    estado = extra.get('estado')
    text = ' '.join(str(raw.get(field) or '') for field in ('nota', 'note', 'error')).lower()
    if raw.get('rateLimited') is True or status == 429 or '429' in text:
        return 'rate_limited'
    if 'api key' in text or status == 403:
        return 'forbidden_credential_type'
    if estado == 'token_invalidado' or status == 401 or any(word in text for word in ('caducad', 'vencid', 'expired', '401')):
        return 'token_expired'
    if estado == 'sin_credencial' or any(word in text for word in (
            'sin autenticar', 'sin credencial', 'no existe', 'falta ', 'no trae', 'sin tokens', 'sin access')):
        return 'not_authenticated'
    if isinstance(status, int) and status >= 400:
        return 'provider_error'
    if estado == 'fallo_de_red' and 'http ' not in text:
        return 'network'
    if any(word in text for word in ('http 5', 'http 4')):
        return 'provider_error'
    if estado == 'fallo_de_red' or any(word in text for word in (
            'fallo de red', 'fetch failed', 'timeout', 'timed out', 'timeouterror', 'urlerror',
            'econn', 'enotfound', 'eai_again', 'abort')):
        return 'network'
    return 'provider_error'


def normalize_cli_snapshot(provider: str, raw: dict, account_id: str) -> dict:
    source = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'quota-collector.py'
    specification = importlib.util.spec_from_file_location('cauce_quota_collector', source)
    collector = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(collector)
    now = datetime.datetime.now(datetime.UTC).isoformat().replace('+00:00', 'Z')
    successful = bool(raw.get('ok', not raw.get('error') and bool(raw.get('ventanas'))))
    normalized = collector.normalize_provider(provider, {**raw, 'ok': successful, 'available': raw.get('available', successful)}, collector.AccountBindings(None), now)
    normalized['account_id'] = account_id
    for window in normalized['windows']:
        window['account_id'] = account_id
        window['binding_note'] = None
    normalized['note'] = (None if successful else failure_code(raw))
    return {'provider_report': normalized, 'captured_at': now, 'observation_status': 'ok' if successful else 'error'}
