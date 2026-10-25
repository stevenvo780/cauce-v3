#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import os
import pathlib
import runpy


def main():
    parser = argparse.ArgumentParser(description='Fija los pins de una simulación revisada en un plan nuevo, sin aplicar efectos')
    parser.add_argument('--plan', type=pathlib.Path, required=True)
    parser.add_argument('--recibo', type=pathlib.Path, required=True)
    parser.add_argument('--salida', type=pathlib.Path, required=True)
    args = parser.parse_args()
    core = runpy.run_path(str(pathlib.Path(__file__).absolute().with_name('limpiar-huerfanos-driver.py')))
    plan, _ = core['read_private'](args.plan)
    receipt, _ = core['read_private'](args.recibo)
    core['validate_plan'](plan)
    if receipt.get('plan_sha256') != core['digest'](plan) or receipt.get('mode') != 'simulate' \
            or receipt.get('status') != 'simulated' or receipt.get('external_mutations') is not False:
        raise ValueError('El recibo no es una simulación verificable del plan exacto')
    rows = receipt.get('items')
    if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get('id'), str) for row in rows):
        raise ValueError('Las filas del recibo no son verificables')
    identities = [row['id'] for row in rows]
    if len(set(identities)) != len(identities) or set(identities) != {item['id'] for item in plan['items']}:
        raise ValueError('El recibo debe identificar cada recurso exactamente una vez')
    saved = {row['id']: row for row in rows}
    result = copy.deepcopy(plan)
    for item in result['items']:
        row = saved[item['id']]
        if row.get('reason_code') not in {'ready', 'preview_review_required'}:
            raise ValueError('No se sellan recursos bloqueados o retenidos por referencias')
        ready_status = 'would_change' if item['kind'] == 'test_context' else 'would_remove'
        if row.get('status') != (ready_status if row['reason_code'] == 'ready' else 'retained'):
            raise ValueError('El estado del recurso no coincide con la previsualización')
        original_pin = item['pin']
        preview = row['preview']
        if item['kind'] == 'test_context':
            expected = {key: value for key, value in preview.items() if key != 'preview_sha256'}
            if preview['company_id'] != item['company_id'] or preview['action'] != item['action'] \
                    or preview.get('retirement_commit') != item.get('retirement_commit') \
                    or preview.get('can_apply') is not True or core['digest'](expected) != row['preview_sha256']:
                raise ValueError('La previsualización de contexto no coincide')
            item['pin'] = {'head': preview['head'], 'preview_sha256': row['preview_sha256']}
        elif item['kind'] in core['DOCKER_KINDS']:
            if any(preview[key] != item[key] for key in ('kind', 'name', 'scope', 'location')) \
                    or preview['company_id'] != plan['company_id'] or core['digest'](preview) != row['preview_sha256']:
                raise ValueError('La previsualización Docker no coincide')
            identity = 'volume_sha256' if item['kind'] == 'test_volume' else 'resource_sha256'
            resource = preview['volume' if item['kind'] == 'test_volume' else 'resource']
            if preview['daemon_id'] != original_pin['daemon_id'] or row[identity] != preview[identity] \
                    or row[identity] != core['digest'](resource):
                raise ValueError('La identidad Docker no coincide con el plan y la previsualización')
            item['pin'] = {'daemon_id': preview['daemon_id'], identity: row[identity],
                           'preview_sha256': row['preview_sha256']}
        else:
            raise ValueError('Este sellador sólo admite los tipos nuevos de retirada de pruebas')
        if any(value is not None and item['pin'][key] != value for key, value in original_pin.items()):
            raise ValueError('Sellar no puede sustituir pins ya fijados')
    core['validate_plan'](result)
    parent = core['directory'](args.salida.parent, private=True)
    try:
        descriptor = os.open(args.salida.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(core['canonical'](result) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(parent)
    finally:
        os.close(parent)
    print(json.dumps({'status': 'sealed_for_review', 'plan': str(args.salida),
                      'plan_sha256': core['digest'](result), 'external_mutations': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'blocked', 'reason': 'Plan, simulación o salida privada no verificables; sin efectos externos.'}))
        raise SystemExit(1) from None
