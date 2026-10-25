from __future__ import annotations

import hashlib
import json
import pathlib
import sys

sys.path[:0] = [str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'), str(pathlib.Path(__file__).resolve().parent)]
from container_alias_lib import FIELDS, RUNTIME_KEY_PATTERN, TENANT_RE, WIRE_ALIAS_RE  # noqa: E402
from fleet_executor_pki import checked_file  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402
from fleet_runtime_materialization import load_applied_fleet, load_desired_fleet  # noqa: E402


def row_identity(key: str, row: dict) -> dict:
    return {'runtime_key': key, 'alias': row.get('alias', key), **{name: row[name] for name in FIELDS}}


def identity_digest(key: str, row: dict) -> str:
    return hashlib.sha256(json.dumps(row_identity(key, row), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def generation_row(state: pathlib.Path, receipt: dict, key: str) -> dict:
    root = state / 'generations' / receipt['generation']
    body = checked_file(root / 'container-aliases.json')
    if hashlib.sha256(body).hexdigest() != receipt['files']['container-aliases.json']:
        raise SafeFailure('terminal fleet mapping differs from its verified receipt')
    document = json.loads(body)
    if not isinstance(document, dict) or type(document.get('schemaVersion')) is not int or document['schemaVersion'] != 2 \
            or set(document) != {'schemaVersion', 'systemPrincipals', 'historicalAliases', 'aliases'} \
            or not isinstance(document['aliases'], dict):
        raise SafeFailure('terminal fleet mapping schema is invalid')
    row = document['aliases'].get(key)
    if not isinstance(row, dict) or RUNTIME_KEY_PATTERN.fullmatch(key) is None:
        raise SafeFailure('terminal identity is absent from its verified fleet generation')
    if any(not isinstance(row.get(name), str) or not row[name] or any(ord(char) < 32 for char in row[name]) for name in FIELDS) \
            or TENANT_RE.fullmatch(row['tenant']) is None or not isinstance(row.get('alias', key), str) \
            or WIRE_ALIAS_RE.fullmatch(row.get('alias', key)) is None \
            or {'bootstrap', 'admission', 'enabled'} & set(row):
        raise SafeFailure('terminal fleet mapping has an invalid admitted identity')
    return row


def desired_agent(policy: dict, generation: pathlib.Path, agent: dict) -> tuple[dict, str]:
    state = pathlib.Path(policy['roots']['state'])
    receipt = load_desired_fleet(state)
    if generation != state / 'generations' / receipt['generation']:
        raise SafeFailure('terminal desired generation changed before provisioning')
    row = generation_row(state, receipt, agent['runtime_key'])
    expected = {'tenant': agent['tenant_id'], 'alias': agent['alias'], 'container': agent['container_name'],
                'user': agent['runtime_user'], 'home': agent['home_directory'], 'stateDirectory': agent['state_directory'],
                'harness': agent['harness_id']}
    if any(row.get(name, agent['runtime_key'] if name == 'alias' else None) != value for name, value in expected.items()):
        raise SafeFailure('terminal fleet generation has another physical or wire identity')
    return row, identity_digest(agent['runtime_key'], row)


def launcher_row(state: pathlib.Path, generation: str, key: str, expected_digest: str) -> dict:
    desired = load_desired_fleet(state)
    if desired['generation'] == generation:
        row = generation_row(state, desired, key)
    else:
        row = generation_row(state, load_applied_fleet(state), key)
    if identity_digest(key, row) != expected_digest:
        raise SafeFailure('terminal applied identity changed from its approved placement')
    return row


def main() -> int:
    if len(sys.argv) != 5:
        raise SafeFailure('terminal inventory arguments are invalid')
    state, generation, key, expected = sys.argv[1:]
    row = launcher_row(pathlib.Path(state), generation, key, expected)
    print('\t'.join([*(row[field] for field in FIELDS), row.get('alias', key)]))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, SafeFailure):
        print('terminal verified fleet identity is unavailable', file=sys.stderr)
        raise SystemExit(2) from None
