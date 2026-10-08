from __future__ import annotations

import datetime
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import secrets
import socket
import ssl
import stat
import struct
import sys
import tempfile
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from fleet_executor_identity import principal_for  # noqa: E402
from fleet_executor_pki import checked_file, expiry, openssl  # noqa: E402
from fleet_executor_policy import (  # noqa: E402
    SafeFailure,
    digest,
    open_absolute_directory,
    open_regular_at,
    path,
    private_directory,
)

AUTHORITIES = ('base_mtls', 'base_token', 'fleet_mtls', 'fleet_token')
HEX = re.compile(r'[a-f0-9]{64}\Z')
SCOPE_FIELDS = {'operation_id', 'host_id', 'scope_sha256', 'runtime_key', 'prepared_revision', 'worker_id', 'claim_token', 'claim_epoch'}
ISSUED_FIELDS = {'certificate_pem', 'ca_pem', 'token', 'certificate_sha256', 'token_sha256', 'expires_at'}


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def validate_authority(configuration: dict, host: str) -> dict:
    if not isinstance(configuration, dict) or set(configuration) != {'socket_path', 'owner_uid', 'host_id', 'ca_certificate'} \
            or type(configuration['owner_uid']) is not int or configuration['owner_uid'] < 0 \
            or configuration['host_id'] != host or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', host) is None:
        raise SafeFailure('central authority policy differs from the approved host')
    path(configuration['socket_path'])
    digest(path(configuration['ca_certificate']))
    return configuration


def validate_scope(scope: dict, host: str) -> dict:
    if not isinstance(scope, dict) or set(scope) != SCOPE_FIELDS or scope.get('host_id') != host \
            or re.fullmatch(r'[a-z][a-z0-9-]{0,63}', scope.get('runtime_key', '')) is None \
            or re.fullmatch(r'[A-Za-z0-9_-]{1,128}', scope.get('worker_id', '')) is None \
            or not isinstance(scope.get('scope_sha256'), str) or HEX.fullmatch(scope['scope_sha256']) is None:
        raise SafeFailure('central authority scope is not exact')
    for field in ('operation_id', 'claim_token'):
        try:
            parsed = uuid.UUID(scope[field])
        except (ValueError, TypeError, AttributeError):
            raise SafeFailure('central authority scope identity is invalid') from None
        if str(parsed) != scope[field] or parsed.version != 4:
            raise SafeFailure('central authority scope identity is invalid')
    if any(type(scope[field]) is not int or not 1 <= scope[field] <= 9007199254740991
           for field in ('claim_epoch', 'prepared_revision')):
        raise SafeFailure('central authority scope revision or claim is invalid')
    return scope


def scope_for(policy: dict, context: dict, agent: dict) -> dict:
    configuration = validate_authority(policy.get('authority'), policy['host_id'])
    source = context.get('fleet_scope')
    if not isinstance(source, dict) or set(source) != SCOPE_FIELDS - {'runtime_key'} \
            or source.get('operation_id') != context['operation_id'] or agent.get('host_id') != configuration['host_id']:
        raise SafeFailure('central authority requires the current durable host claim')
    return validate_scope({**source, 'runtime_key': agent['runtime_key']}, configuration['host_id'])


def socket_identity(configuration: dict) -> tuple:
    location = path(configuration['socket_path'])
    parent = open_absolute_directory(location.parent)
    try:
        details = os.fstat(parent)
        if details.st_uid != configuration['owner_uid'] or stat.S_IMODE(details.st_mode) != 0o700:
            raise SafeFailure('central authority socket parent is not private')
        details = os.stat(location.name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISSOCK(details.st_mode) or details.st_uid != configuration['owner_uid'] \
                or stat.S_IMODE(details.st_mode) != 0o600:
            raise SafeFailure('central authority socket has an unsafe owner or mode')
        return details.st_dev, details.st_ino, details.st_uid, details.st_mode
    finally:
        os.close(parent)


def call(configuration: dict, scope: dict, action: str, **fields) -> dict:
    validate_authority(configuration, scope.get('host_id'))
    validate_scope(scope, configuration['host_id'])
    allowed = {'inventory': set(), 'verify_absent': set(), 'revoke': {'expected_inventory'},
        'issue': {'phase', 'csr_pem', 'csr_sha256', 'idempotency_key'}}
    if action not in allowed or set(fields) != allowed[action]:
        raise SafeFailure('central authority action is invalid')
    packet = json.dumps({'action': action, 'scope': scope, **fields}, separators=(',', ':')).encode()
    if len(packet) > 65536:
        raise SafeFailure('central authority request exceeds its limit')
    connection = http.client.HTTPConnection('localhost', timeout=30)
    endpoint = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        before = socket_identity(configuration)
        endpoint.settimeout(30)
        endpoint.connect(configuration['socket_path'])
        _, uid, _ = struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if uid != configuration['owner_uid'] or socket_identity(configuration) != before:
            raise SafeFailure('central authority peer or socket identity changed')
        connection.sock = endpoint
        connection.request('POST', '/authority', body=packet, headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536 or socket_identity(configuration) != before:
            raise SafeFailure('central authority effect is unverified')
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise SafeFailure('central authority returned no bounded object')
        return result
    except (OSError, ValueError, http.client.HTTPException):
        raise SafeFailure('central authority effect is unverified') from None
    finally:
        connection.close()
        endpoint.close()


def inventory(result: dict, agent: dict | None = None, *, absent: bool = False) -> dict:
    if not isinstance(result, dict) or set(result) != {'authorities'} or not isinstance(result['authorities'], list) \
            or len(result['authorities']) != 4:
        raise SafeFailure('central authority inventory is not complete')
    ids = set()
    for row in result['authorities']:
        if not isinstance(row, dict) or set(row) != {'id', 'sha256', 'matching_records'} or row['id'] not in AUTHORITIES \
                or row['id'] in ids or not isinstance(row['sha256'], str) or HEX.fullmatch(row['sha256']) is None \
                or not isinstance(row['matching_records'], list) or len(row['matching_records']) > 64:
            raise SafeFailure('central authority inventory pins differ')
        ids.add(row['id'])
        field = 'certificate_sha256' if row['id'].endswith('mtls') else 'token_sha256'
        for record in row['matching_records']:
            if not isinstance(record, dict) or set(record) != {field, 'principal', 'expires_at'} \
                    or not isinstance(record[field], str) or HEX.fullmatch(record[field]) is None \
                    or not isinstance(record['expires_at'], str) or not isinstance(record['principal'], dict) \
                    or set(record['principal']) != {'tenant_id', 'alias', 'channel', 'session_id', 'roles', 'permissions'} \
                    or agent is not None and any(record['principal'].get(name) != agent[name] for name in ('tenant_id', 'alias')):
                raise SafeFailure('central authority inventory contains a foreign or invalid principal')
            try:
                expires = datetime.datetime.fromisoformat(record['expires_at'].replace('Z', '+00:00'))
                if expires.tzinfo is None:
                    raise ValueError
            except ValueError:
                raise SafeFailure('central authority inventory expiry is invalid') from None
        if absent and row['matching_records']:
            raise SafeFailure('Cauce credentials reappeared in the central authority')
    return result


def stable_scope(scope: dict) -> dict:
    return {name: scope[name] for name in sorted(SCOPE_FIELDS - {'worker_id', 'claim_token', 'claim_epoch'})}


def publish_once(filename: pathlib.Path, raw: bytes, *, private: bool) -> None:
    parent = open_absolute_directory(filename.parent)
    temporary = '.' + filename.name + '.' + secrets.token_hex(12)
    mode = 0o400 if private else 0o444
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            offset = 0
            while offset < len(raw):
                offset += os.write(descriptor, raw[offset:])
            os.fchmod(descriptor, mode)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.link(temporary, filename.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError:
            if checked_file(filename, private) != raw:
                raise SafeFailure('central credential publication changed existing material') from None
        os.fsync(parent)
    finally:
        os.unlink(temporary, dir_fd=parent)
        os.close(parent)


def public_ca(configuration: dict) -> bytes:
    filename = path(configuration['ca_certificate'])
    expected = digest(filename)
    parent = open_absolute_directory(filename.parent)
    try:
        descriptor = open_regular_at(parent, filename.name, os.O_RDONLY)
        try:
            raw = os.read(descriptor, 16385)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)
    if len(raw) > 16384 or sha256(raw) != expected:
        raise SafeFailure('approved central CA changed before observation')
    return raw


def pem_certificate(value) -> bytes:
    if not isinstance(value, str) or len(value.encode()) > 16384 or re.fullmatch(
            r'-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n', value) is None:
        raise SafeFailure('central certificate PEM is not exact')
    return ssl.PEM_cert_to_DER_cert(value)


def validate_certificate(configuration: dict, pair: pathlib.Path, runtime_key: str, pem: str) -> dict:
    pem_certificate(pem)
    ca = public_ca(configuration)
    private = checked_file(pair / ('agent-' + runtime_key + '.key'), True)
    with tempfile.TemporaryDirectory(prefix='.verify-', dir=pair) as temporary:
        root = pathlib.Path(temporary)
        certificate, ca_path = root / 'client.crt', root / 'ca.crt'
        certificate.write_text(pem)
        ca_path.write_bytes(ca)
        openssl('verify', '-purpose', 'sslclient', '-CAfile', str(ca_path), str(certificate))
        openssl('x509', '-in', str(certificate), '-noout', '-checkend', '30')
        subject = openssl('x509', '-in', str(certificate), '-noout', '-subject', '-nameopt', 'RFC2253').strip()
        san = openssl('x509', '-in', str(certificate), '-noout', '-ext', 'subjectAltName')
        if subject != ('subject=CN=agent-' + runtime_key).encode() \
                or san.splitlines()[-1].strip() != ('URI:urn:cauce:runtime:' + runtime_key).encode() \
                or openssl('x509', '-in', str(certificate), '-pubkey', '-noout') != openssl('pkey', '-pubout', input_data=private):
            raise SafeFailure('central certificate subject, SAN or key pair differs')
        expires = min(expiry(certificate), expiry(ca_path)).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {'certificate_fingerprint': sha256(pem_certificate(pem)), 'expires_at': expires,
        'ca_sha256': sha256(pem_certificate(ca.decode()))}


def proof_for(policy: dict, agent: dict, *, bootstrap: bool) -> dict:
    configuration = validate_authority(policy.get('authority'), policy['host_id'])
    key, phase = agent['runtime_key'], 'bootstrap' if bootstrap else 'normal'
    pair = pathlib.Path(policy['roots']['pki']) / phase / key
    private_directory(str(pair))
    return validate_certificate(configuration, pair, key, checked_file(pair / ('agent-' + key + '.crt')).decode())


def validate_manifest(agent: dict, snapshot: pathlib.Path, manifest: pathlib.Path, bootstrap: bool) -> dict:
    import yaml
    principal = principal_for(snapshot, agent['runtime_key'], bootstrap, SafeFailure)
    document = yaml.safe_load(checked_file(manifest))
    spec = document.get('spec', {}) if isinstance(document, dict) else {}
    if not isinstance(document, dict) or document.get('metadata', {}).get('name') != agent['runtime_key'] \
            or any(principal.get(field) != agent[field] for field in ('tenant_id', 'alias')) \
            or spec.get('tenant') != agent['tenant_id'] or spec.get('alias') != agent['alias'] \
            or (bootstrap and (spec.get('bootstrap') is not True or spec.get('admission') is not False)) \
            or (not bootstrap and ('bootstrap' in spec or 'admission' in spec)):
        raise SafeFailure('central credential manifest or principal differs')
    return principal


def present_inventory(observed: dict, principal: dict, proof: dict, token_hash: str) -> None:
    for name, field, fingerprint in (('fleet_mtls', 'certificate_sha256', proof['certificate_fingerprint']),
                                     ('fleet_token', 'token_sha256', token_hash)):
        records = next(row['matching_records'] for row in observed['authorities'] if row['id'] == name)
        selected = [record for record in records if record.get('principal') == principal or record.get(field) == fingerprint]
        if selected != [{field: fingerprint, 'principal': principal, 'expires_at': proof['expires_at']}]:
            raise SafeFailure('central credential records were removed, replaced or expired')


def prepare(policy: dict, context: dict, agent: dict, snapshot: pathlib.Path, manifest: pathlib.Path, *, bootstrap: bool) -> dict:
    try:
        return prepare_locked(policy, context, agent, snapshot, manifest, bootstrap)
    except (OSError, ValueError, KeyError):
        raise SafeFailure('central credential preparation is unverified') from None


def prepare_locked(policy: dict, context: dict, agent: dict, snapshot: pathlib.Path, manifest: pathlib.Path, bootstrap: bool) -> dict:
    scope = scope_for(policy, context, agent)
    configuration = policy['authority']
    socket_identity(configuration)
    principal = validate_manifest(agent, snapshot, manifest, bootstrap)
    key, phase = agent['runtime_key'], 'bootstrap' if bootstrap else 'normal'
    pki, tokens = (pathlib.Path(policy['roots'][name]) / phase for name in ('pki', 'tokens'))
    for directory in (pki, tokens):
        directory.mkdir(mode=0o700, exist_ok=True)
        private_directory(str(directory))
    lock_parent = open_absolute_directory(pki)
    try:
        lock = open_regular_at(lock_parent, '.' + key + '.authority.lock', os.O_RDWR | os.O_CREAT, mode=0o600)
        try:
            details = os.fstat(lock)
            if details.st_uid != os.geteuid() or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o600:
                raise SafeFailure('central credential lock is unsafe')
            fcntl.flock(lock, fcntl.LOCK_EX)
            pair = pki / key
            pair.mkdir(mode=0o700, exist_ok=True)
            private_directory(str(pair))
            return prepare_pair(policy, scope, agent, principal, pair, tokens / (key + '.token'), phase)
        finally:
            os.close(lock)
    finally:
        os.close(lock_parent)


def prepare_pair(policy: dict, scope: dict, agent: dict, principal: dict, pair: pathlib.Path, token_path: pathlib.Path, phase: str) -> dict:
    configuration, key = policy['authority'], agent['runtime_key']
    certificate, private, csr_path = (pair / ('agent-' + key + suffix) for suffix in ('.crt', '.key', '.csr'))
    request_path, receipt_path = pair / '.authority-request.json', pair / '.authority-receipt.json'
    if receipt_path.exists() or receipt_path.is_symlink():
        receipt = json.loads(checked_file(receipt_path, True))
        proof = validate_certificate(configuration, pair, key, checked_file(certificate).decode())
        token = checked_file(token_path, True).strip()
        if HEX.fullmatch(token.decode()) is None or receipt.get('proof') != proof or receipt.get('token_sha256') != sha256(token):
            raise SafeFailure('installed central credential receipt changed')
        observed = inventory(call(configuration, scope, 'inventory'), agent)
        present_inventory(observed, principal, proof, sha256(token))
        return {name: proof[name] for name in ('certificate_fingerprint', 'expires_at')}
    if not private.exists() and not private.is_symlink():
        if any(filename.exists() or filename.is_symlink() for filename in (csr_path, certificate, request_path, token_path)):
            raise SafeFailure('central credential key is missing; rotation is forbidden')
        publish_once(private, openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072'), private=True)
    private_bytes = checked_file(private, True)
    if not csr_path.exists() and not csr_path.is_symlink():
        if any(filename.exists() or filename.is_symlink() for filename in (certificate, request_path, token_path)):
            raise SafeFailure('central credential CSR is missing; rotation is forbidden')
        publish_once(csr_path, openssl('req', '-new', '-sha256', '-key', '/dev/stdin', '-subj', '/CN=agent-' + key,
            input_data=private_bytes), private=True)
    csr = checked_file(csr_path, True)
    openssl('req', '-verify', '-noout', input_data=csr)
    if openssl('req', '-pubkey', '-noout', input_data=csr) != openssl('pkey', '-pubout', input_data=private_bytes):
        raise SafeFailure('persisted central CSR no longer matches the local key')
    stable = {'scope': stable_scope(scope), 'phase': phase, 'csr_sha256': sha256(csr),
        'ca_sha256': sha256(pem_certificate(public_ca(configuration).decode()))}
    idempotency = sha256(json.dumps(stable, sort_keys=True, separators=(',', ':')).encode())
    request = {**stable, 'idempotency_key': idempotency}
    publish_once(request_path, json.dumps(request, sort_keys=True, separators=(',', ':')).encode(), private=True)
    issued = call(configuration, scope, 'issue', phase=phase, csr_pem=csr.decode(), csr_sha256=sha256(csr), idempotency_key=idempotency)
    if set(issued) != ISSUED_FIELDS or not isinstance(issued['token'], str) or HEX.fullmatch(issued['token']) is None \
            or sha256(issued['token'].encode()) != issued['token_sha256'] \
            or sha256(pem_certificate(issued['certificate_pem'])) != issued['certificate_sha256'] \
            or sha256(pem_certificate(issued['ca_pem'])) != stable['ca_sha256']:
        raise SafeFailure('central issuance response pins differ')
    proof = validate_certificate(configuration, pair, key, issued['certificate_pem'])
    if issued['expires_at'] != proof['expires_at'] or proof['ca_sha256'] != stable['ca_sha256']:
        raise SafeFailure('central issuance response expiry or CA differs')
    publish_once(certificate, issued['certificate_pem'].encode(), private=False)
    publish_once(token_path, (issued['token'] + '\n').encode(), private=True)
    receipt = {'proof': proof, 'token_sha256': issued['token_sha256']}
    publish_once(receipt_path, json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode(), private=True)
    return {name: proof[name] for name in ('certificate_fingerprint', 'expires_at')}


def revoke(policy: dict, context: dict, agent: dict, journal: dict, save) -> dict:
    scope = scope_for(policy, context, agent)
    configuration = policy['authority']
    observed = inventory(call(configuration, scope, 'inventory'), agent)
    entries = journal.setdefault('central_revocations', {})
    previous = entries.get(agent['runtime_key'])
    if previous is None:
        previous = {'scope': stable_scope(scope), 'expected_inventory': [
            {'id': row['id'], 'sha256': row['sha256']} for row in observed['authorities']]}
        entries[agent['runtime_key']] = previous
        save()
    if previous['scope'] != stable_scope(scope):
        raise SafeFailure('central revocation replay changed its durable scope')
    if previous.get('complete'):
        inventory(observed, agent, absent=True)
    else:
        inventory(call(configuration, scope, 'revoke', expected_inventory=previous['expected_inventory']), agent, absent=True)
    absence = inventory(call(configuration, scope, 'verify_absent'), agent, absent=True)
    previous.update(complete=True, absence=absence)
    save()
    return {'configuration': configuration, 'scope': scope, 'absence': absence}


def verify_absence(reference: dict, agent: dict, operation_id: str) -> dict:
    if not isinstance(reference, dict) or set(reference) != {'configuration', 'scope', 'absence'}:
        raise SafeFailure('central revocation reference is not exact')
    scope = reference['scope']
    if not isinstance(scope, dict) or scope.get('operation_id') != operation_id \
            or scope.get('runtime_key') != agent['runtime_key'] or scope.get('host_id') != agent['host_id']:
        raise SafeFailure('central revocation reference belongs to another operation or runtime')
    configuration = validate_authority(reference['configuration'], agent['host_id'])
    expected = inventory(reference['absence'], agent, absent=True)
    current = inventory(call(configuration, scope, 'verify_absent'), agent, absent=True)
    if current != expected:
        raise SafeFailure('central authority changed after its absence observation')
    return current
