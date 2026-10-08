from __future__ import annotations

import fcntl
import hashlib
import json
import os
import pathlib
import re
import ssl
import stat
from contextlib import ExitStack

from fleet_executor_pki import checked_file
from fleet_executor_policy import SafeFailure, open_absolute_directory, open_regular_at, path
from update_alias_lib import publish_json_document_cas

DIGEST = re.compile(r'[a-f0-9]{64}\Z')
KINDS = {'mtls': ('mtls_identities.json', 'certificate_sha256'), 'token': ('token_hashes.json', 'token_sha256')}


def target_principal(agent: dict, principal) -> bool:
    return isinstance(principal, dict) and all(principal.get(field) == agent[field] for field in ('tenant_id', 'alias'))


def validate_legacy_credentials(policy: dict):
    rows = policy.get('legacy_credentials', {})
    if not isinstance(rows, dict) or len(rows) > 1000:
        raise SafeFailure('invalid bounded legacy credential allowlist')
    for key, row in rows.items():
        if not isinstance(key, str) or re.fullmatch(r'[a-z][a-z0-9-]{0,63}', key) is None \
                or not isinstance(row, dict) or set(row) != {'tenant_id', 'alias', 'registries', 'credentials', 'expected_absent'} \
                or re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', row.get('tenant_id', '')) is None \
                or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', row.get('alias', '')) is None \
                or type(row['expected_absent']) is not bool or not isinstance(row['credentials'], list) \
                or len(row['credentials']) > 16 or not isinstance(row['registries'], list) or len(row['registries']) != 2:
            raise SafeFailure('invalid legacy credential identity')
        kinds = set()
        declared = {'mtls': set(), 'token': set()}
        for registry in row['registries']:
            if not isinstance(registry, dict) or set(registry) != {'kind', 'path', 'entries'} \
                    or registry['kind'] not in KINDS or registry['kind'] in kinds \
                    or not isinstance(registry['entries'], list) or len(registry['entries']) > 16:
                raise SafeFailure('invalid legacy authority pin')
            kind = registry['kind']
            kinds.add(kind)
            filename, field = KINDS[kind]
            location = path(registry['path'])
            if location.name != filename or location == pathlib.Path(policy['roots']['identities']) / filename:
                raise SafeFailure('legacy and fleet authority paths must be distinct')
            for entry in registry['entries']:
                if not isinstance(entry, dict) or set(entry) != {field, 'expires_at', 'principal'} \
                        or not isinstance(entry[field], str) or DIGEST.fullmatch(entry[field]) is None \
                        or not isinstance(entry['expires_at'], str) or not 1 <= len(entry['expires_at']) <= 64 \
                        or not target_principal(row, entry['principal']) or entry['principal'].get('channel') != 'adapter' \
                        or entry[field] in declared[kind]:
                    raise SafeFailure('legacy authority principal or fingerprint differs')
                principal = entry['principal']
                if set(principal) != {'tenant_id', 'alias', 'channel', 'session_id', 'roles', 'permissions'} \
                        or not isinstance(principal['session_id'], str) or not 1 <= len(principal['session_id']) <= 128 \
                        or any(not isinstance(principal[field], list) or len(principal[field]) > 16 \
                            or any(not isinstance(value, str) or not 1 <= len(value) <= 64 for value in principal[field])
                            for field in ('roles', 'permissions')):
                    raise SafeFailure('legacy authority requires the full measured principal')
                declared[kind].add(entry[field])
        actual = {'mtls': set(), 'token': set()}
        files = set()
        for credential in row['credentials']:
            required = {'phase', 'certificate_path', 'key_path', 'certificate_fingerprint'}
            if not isinstance(credential, dict) or not required.issubset(credential) \
                    or set(credential) - required not in (set(), {'token_path', 'token_sha256'}) \
                    or credential['phase'] != 'normal' or not isinstance(credential['certificate_fingerprint'], str) \
                    or DIGEST.fullmatch(credential['certificate_fingerprint']) is None:
                raise SafeFailure('invalid bounded legacy Cauce credential reference')
            for field in ('certificate_path', 'key_path', 'token_path'):
                if field in credential:
                    filename = str(path(credential[field]))
                    if filename in files:
                        raise SafeFailure('duplicate legacy credential reference')
                    files.add(filename)
            actual['mtls'].add(credential['certificate_fingerprint'])
            if 'token_path' in credential:
                if not isinstance(credential['token_sha256'], str) or DIGEST.fullmatch(credential['token_sha256']) is None:
                    raise SafeFailure('invalid legacy Cauce token fingerprint')
                actual['token'].add(credential['token_sha256'])
        if declared != actual or row['expected_absent'] != (not row['credentials']):
            raise SafeFailure('legacy authority pins require every concrete credential or explicit measured absence')


def approved_legacy(policy: dict, agent: dict) -> dict | None:
    validate_legacy_credentials(policy)
    row = policy.get('legacy_credentials', {}).get(agent['runtime_key'])
    baseline = agent.get('fleet_baseline')
    if baseline is not None and type(baseline) is not bool:
        raise SafeFailure('fleet baseline authority is invalid')
    if baseline is True and row is None:
        raise SafeFailure('baseline retirement requires an exact legacy credential inventory')
    if row is not None and (baseline is not True or not target_principal(agent, row)):
        raise SafeFailure('legacy credentials are outside the durable baseline identity')
    return row


def observe_references(policy: dict, agent: dict) -> dict | None:
    row = approved_legacy(policy, agent)
    if row is None:
        return None
    for credential in row['credentials']:
        pem = checked_file(path(credential['certificate_path']))
        checked_file(path(credential['key_path']), True)
        fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))).hexdigest()
        if fingerprint != credential['certificate_fingerprint']:
            raise SafeFailure('legacy Cauce certificate fingerprint changed')
        if 'token_path' in credential:
            token = checked_file(path(credential['token_path']), True).strip()
            if re.fullmatch(rb'[a-f0-9]{64}', token) is None or hashlib.sha256(token).hexdigest() != credential['token_sha256']:
                raise SafeFailure('legacy Cauce token fingerprint changed')
    return row


def read_registry(location: pathlib.Path, parent: int) -> tuple[dict, os.stat_result]:
    descriptor = open_regular_at(parent, location.name, os.O_RDONLY | os.O_NONBLOCK)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1 \
                or details.st_mode & 0o022 or details.st_size > 1048576:
            raise SafeFailure('legacy authority file has unsafe ownership or mode')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            encoded = stream.read(1048577)
    finally:
        os.close(descriptor)
    document = json.loads(encoded)
    if len(encoded) > 1048576 or not isinstance(document, dict) or set(document) != {'version', 'identities'} \
            or document['version'] != 1 or not isinstance(document['identities'], list) \
            or len(document['identities']) > 20_000 or not all(isinstance(entry, dict) for entry in document['identities']):
        raise SafeFailure('legacy authority document is unavailable')
    return document, details


def planned_records(registry: dict, document: dict, agent: dict) -> list[dict]:
    field = KINDS[registry['kind']][1]
    expected = {entry[field]: entry for entry in registry['entries']}
    seen = set()
    kept = []
    for record in document['identities']:
        fingerprint = record.get(field)
        target = target_principal(agent, record.get('principal'))
        if target or fingerprint in expected:
            if fingerprint not in expected or record != expected[fingerprint] or fingerprint in seen:
                raise SafeFailure('legacy authority changed outside its exact approved records')
            seen.add(fingerprint)
        else:
            kept.append(record)
    return kept


def remove_base_principals(policy: dict, agent: dict):
    row = observe_references(policy, agent)
    if row is None:
        return
    with ExitStack() as stack:
        changes = []
        for registry in sorted(row['registries'], key=lambda registry: registry['path']):
            location = path(registry['path'])
            parent = open_absolute_directory(location.parent)
            stack.callback(os.close, parent)
            parent_identity = os.fstat(parent)
            if parent_identity.st_uid != os.geteuid() or parent_identity.st_mode & 0o022:
                raise SafeFailure('legacy authority parent has unsafe ownership or mode')
            lock = open_regular_at(parent, '.' + location.name + '.lock', os.O_RDWR | os.O_CREAT, mode=0o600)
            stack.callback(os.close, lock)
            details = os.fstat(lock)
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1 or details.st_mode & 0o077:
                raise SafeFailure('legacy authority lock has unsafe ownership or mode')
            fcntl.flock(lock, fcntl.LOCK_EX)
            document, original = read_registry(location, parent)
            kept = planned_records(registry, document, agent)
            changes.append((location, parent, lock, document, original, kept))
        for location, parent, lock, document, original, kept in changes:
            if kept != document['identities']:
                publish_json_document_cas(parent, lock, location.name, {**document, 'identities': kept}, original,
                    mode=stat.S_IMODE(original.st_mode), error_type=SafeFailure, operation='legacy runtime revocation')


def verify_absence(references: dict, agent: dict, read) -> list[dict]:
    legacy = references.get('legacy')
    registries = [{'kind': kind, 'path': str(path(references['identities_directory']) / filename)}
        for kind, (filename, _) in KINDS.items()]
    if legacy is not None:
        registries += legacy['registries']
    observations = []
    for registry in registries:
        encoded = read(registry['path'])
        document = json.loads(encoded)
        if not isinstance(document, dict) or set(document) != {'version', 'identities'} or document['version'] != 1 \
                or not isinstance(document['identities'], list) or len(document['identities']) > 20_000 \
                or not all(isinstance(entry, dict) for entry in document['identities']):
            raise SafeFailure('Cauce authority absence was not measured')
        for entry in document['identities']:
            principal = entry.get('principal')
            if target_principal(agent, principal) and (legacy is not None or (principal.get('channel'), principal.get('session_id')) in {
                ('bootstrap', 'bootstrap-' + agent['runtime_key']), ('adapter', 'adapter-' + agent['runtime_key'])}):
                raise SafeFailure('Cauce credential remains in a measured authority')
            if legacy is not None and any(entry.get(KINDS[registry['kind']][1]) == expected[KINDS[registry['kind']][1]]
                    for source in legacy['registries'] if source['kind'] == registry['kind'] for expected in source['entries']):
                raise SafeFailure('legacy Cauce fingerprint remains provisioned')
        observations.append({'path': registry['path'], 'sha256': hashlib.sha256(encoded).hexdigest()})
    return observations


def capture_absence(references: dict, agent: dict) -> list[dict]:
    return verify_absence(references, agent, lambda filename: checked_file(path(filename)))
