#!/usr/bin/env python3

import datetime
import json
import math
import os
import re
import subprocess
import sys
import time

WINDOWS = (('5h', 300, 'libre_5h', 'reset_5h_iso'), ('7d', 10080, 'libre_7d', 'reset_7d_iso'))


def group_slug(account: dict) -> str:
    email = str(account.get('email') or '').removesuffix("'s Organization").strip()
    group = account.get('group_key') or (email.split('@', 1)[0] if '@' in email else account.get('label'))
    slug = re.sub(r'[^A-Za-z0-9_.:-]', '_', str(group or 'default'))[:128]
    return slug if slug[0].isalnum() else 'x' + slug[:127]


def observed_time(value: object) -> float | None:
    try:
        if isinstance(value, str):
            value = datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return float(value)
    except (ValueError, OverflowError):
        pass
    return None


def normalize(data: object, now: float, max_age: float) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get('cuentas'), list):
        raise ValueError('expected cuentas array')
    providers = {}
    for account in data['cuentas']:
        if not isinstance(account, dict):
            continue
        name = str(account.get('provider') or 'desconocido')
        entry = providers.setdefault(name, {
            'ok': False, 'available': False, 'kind': 'subscription',
            'source': 'account-http', 'windows': [], 'notes': [], 'observations': [],
        })
        stamp = observed_time(account.get('observedAt', account.get('fetched_at')))
        reason = account.get('note') if not account.get('ok') else None
        if not account.get('ok'):
            reason = reason or 'sin dato'
        elif stamp is None or stamp > now + 30 or now - stamp > max_age:
            reason = 'medición sin fecha válida o caducada'
        if reason:
            entry['notes'].append(f"{account.get('label', 'cuenta')}: {reason}")
            continue
        windows = account.get('windows')
        if not isinstance(windows, list):
            windows = [
                {'key': key, 'remainingPercent': account.get(field),
                 'resetAt': account.get(reset), 'windowMinutes': minutes}
                for key, minutes, field, reset in WINDOWS
            ]
        valid = []
        for window in windows:
            if not isinstance(window, dict):
                continue
            remaining = window.get('remainingPercent')
            used = window.get('usedPercent')
            numbers = [value for value in (remaining, used) if value is not None]
            if not numbers or not all(
                isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value) and 0 <= value <= 100 for value in numbers
            ):
                continue
            valid.append({**window, 'limitId': group_slug(account),
                'label': str(account.get('label') or group_slug(account)),
            })
        if not valid:
            entry['notes'].append(f"{account.get('label', 'cuenta')}: sin ventanas válidas")
            continue
        entry['windows'].extend(valid)
        entry['observations'].append(stamp)
        entry['ok'] = True
        entry['available'] = entry['available'] or bool(account.get('available', True))
        if account.get('tier'):
            entry.setdefault('plan', str(account['tier']))
    for entry in providers.values():
        notes = entry.pop('notes')
        stamps = entry.pop('observations')
        if notes:
            entry['note'] = '; '.join(notes)[:512]
        if stamps:
            entry['observedAt'] = datetime.datetime.fromtimestamp(
                min(stamps), datetime.UTC,
            ).isoformat().replace('+00:00', 'Z')
    return {'schemaVersion': 2, 'providers': providers}


def main() -> int:
    binary = os.environ.get('CAUCE_AI_LIVE_BIN', '/home/stev/.local/bin/cauce-ai-live')
    timeout = int(os.environ.get('CAUCE_AI_LIVE_TIMEOUT_SECONDS', '60'))
    max_age = float(os.environ.get('CAUCE_AI_LIVE_MAX_AGE_SECONDS', '180'))
    try:
        result = subprocess.run([binary, '--json'], capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode != 0:
            raise ValueError(f'producer exited {result.returncode}')
        payload = normalize(json.loads(result.stdout), time.time(), max_age)
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        print(f'ai-live-to-usage: {exc}', file=sys.stderr)
        return 1
    json.dump(payload, sys.stdout, allow_nan=False)
    return 0


if __name__ == '__main__':
    sys.exit(main())
