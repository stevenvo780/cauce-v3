from __future__ import annotations

import json
import os
import pathlib
import re
import stat

from secure_path import open_absolute_directory, open_regular_at

TENANT = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}\Z')
WIRE = re.compile(r'[a-z][a-z0-9_-]{0,63}\Z')
PHYSICAL = re.compile(r'[a-z][a-z0-9-]{0,63}\Z')


def principal_for(snapshot: pathlib.Path, runtime_key: str, bootstrap: bool, error_type=ValueError) -> dict:
    if (PHYSICAL if bootstrap else WIRE).fullmatch(runtime_key) is None:
        raise error_type('invalid runtime identity')
    parent = open_absolute_directory(snapshot.parent)
    try:
        descriptor = open_regular_at(parent, snapshot.name, os.O_RDONLY)
    finally:
        os.close(parent)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid not in {0, os.geteuid()} or details.st_mode & 0o022:
            raise error_type('fleet identity snapshot has unsafe owner, link or mode')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            body = stream.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise error_type('fleet identity snapshot exceeds the limit')
        document = json.loads(body)
    finally:
        os.close(descriptor)
    rows = document.get('bootstrap' if bootstrap else 'fleet') if isinstance(document, dict) else None
    row = rows.get(runtime_key) if isinstance(rows, dict) else None
    if not isinstance(row, dict) or (row.get('enabled') is not False if bootstrap else row.get('enabled') is not True):
        raise error_type('runtime identity is not admitted by the explicit snapshot')
    if bootstrap and (row.get('admission') is not False or row.get('lifecycleState') not in
                      {'draft', 'provisioning', 'auth_pending', 'verifying'}):
        raise error_type('runtime identity is not a bootstrap preparation')
    tenant, wire = row.get('tenant'), row.get('alias', runtime_key)
    if not isinstance(tenant, str) or TENANT.fullmatch(tenant) is None or not isinstance(wire, str) or WIRE.fullmatch(wire) is None:
        raise error_type('fleet wire identity is invalid')
    return {'tenant_id': tenant, 'alias': wire, 'session_id': f'{"bootstrap" if bootstrap else "adapter"}-{runtime_key}',
            'channel': 'bootstrap' if bootstrap else 'adapter', 'roles': [] if bootstrap else ['adapter'],
            'permissions': [] if bootstrap else ['route', 'read']}
