#!/usr/bin/env python3
"""ai-live-to-usage: puente cauce-ai-live --json -> forma de entrada del quota-collector.

El binario `ai-usage` historico ya no existe en kratos (se perdio con el reinicio del
28-08); la medida real por cuenta la da `cauce-ai-live` (CDP + codex-probe), pero con otra
forma. Este puente la traduce para que el colector siga siendo el unico que normaliza.

group_key estable por CUENTA: la parte local del email (las etiquetas claude#N del TUI se
renumeran; los emails no). El binding a provider_accounts lo resuelve el colector con su
archivo de intencion, como siempre.

Uso: CAUCE_QUOTA_AI_USAGE_CMD=/ruta/ai-live-to-usage.py (sin argumentos). Respeta
CAUCE_AI_LIVE_BIN (default /home/stev/.local/bin/cauce-ai-live).
"""

import json
import os
import re
import subprocess
import sys

AI_LIVE_BIN = os.environ.get('CAUCE_AI_LIVE_BIN', '/home/stev/.local/bin/cauce-ai-live')
TIMEOUT = int(os.environ.get('CAUCE_AI_LIVE_TIMEOUT_SECONDS', '60'))
WINDOWS = (('5h', 300, 'libre_5h', 'reset_5h_iso'), ('7d', 10080, 'libre_7d', 'reset_7d_iso'))


def group_slug(cuenta: dict) -> str:
    email = str(cuenta.get('email') or '')
    email = email.removesuffix("'s Organization").strip()
    local = email.split('@', 1)[0] if '@' in email else str(cuenta.get('label') or 'default')
    slug = re.sub(r'[^A-Za-z0-9_.:-]', '_', local) or 'default'
    return slug if re.match(r'^[A-Za-z0-9]', slug) else 'x' + slug


def main() -> int:
    try:
        result = subprocess.run([AI_LIVE_BIN, '--json'], capture_output=True, text=True, timeout=TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f'ai-live-to-usage: no pude ejecutar {AI_LIVE_BIN}: {exc}', file=sys.stderr)
        return 1
    if result.returncode != 0:
        print(f'ai-live-to-usage: {AI_LIVE_BIN} salio {result.returncode}: {result.stderr[:300]}', file=sys.stderr)
        return 1
    try:
        cuentas = json.loads(result.stdout).get('cuentas') or []
    except json.JSONDecodeError as exc:
        print(f'ai-live-to-usage: salida no-JSON de {AI_LIVE_BIN}: {exc}', file=sys.stderr)
        return 1

    providers: dict[str, dict] = {}
    for cuenta in cuentas:
        if not isinstance(cuenta, dict):
            continue
        name = str(cuenta.get('provider') or '').strip() or 'desconocido'
        entry = providers.setdefault(name, {
            'ok': False, 'available': False, 'kind': 'subscription',
            'source': 'cauce-ai-live', 'windows': [], 'notas': [],
        })
        if not cuenta.get('ok'):
            entry['notas'].append(f"{cuenta.get('label')}: {cuenta.get('note') or 'sin dato'}")
            continue
        entry['ok'] = True
        entry['available'] = True
        if cuenta.get('tier'):
            entry.setdefault('plan', str(cuenta['tier']))
        slug = group_slug(cuenta)
        for key, minutes, libre_campo, reset_campo in WINDOWS:
            libre = cuenta.get(libre_campo)
            if not isinstance(libre, (int, float)):
                continue
            entry['windows'].append({
                'key': key, 'limitId': slug, 'label': str(cuenta.get('label') or slug),
                'remainingPercent': max(0, min(100, libre)),
                'resetAt': cuenta.get(reset_campo), 'windowMinutes': minutes,
            })

    for entry in providers.values():
        notas = entry.pop('notas')
        if notas:
            entry['note'] = '; '.join(notas)[:512]

    json.dump({'schemaVersion': 2, 'providers': providers}, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
