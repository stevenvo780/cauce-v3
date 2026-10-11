from __future__ import annotations

import datetime
import importlib.util
import pathlib


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
    normalized['note'] = ('quota probe unavailable' if not successful else None)
    return {'provider_report': normalized, 'captured_at': now, 'observation_status': 'ok' if successful else 'error'}
