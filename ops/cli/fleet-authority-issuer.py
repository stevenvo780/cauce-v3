#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import ssl
import stat
import subprocess
import sys
import tempfile
from contextlib import ExitStack

AUTHORITIES = ('base_mtls', 'base_token', 'fleet_mtls', 'fleet_token')
HEX = re.compile(r'[a-f0-9]{64}\Z')
WIRE = re.compile(r'[a-z][a-z0-9_-]{0,63}\Z')
RUNTIME = re.compile(r'[a-z][a-z0-9-]{0,63}\Z')


class AuthorityError(ValueError):
    pass


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def path(value) -> pathlib.Path:
    if not isinstance(value, str) or not value.startswith('/') or '..' in pathlib.PurePosixPath(value).parts \
            or str(pathlib.PurePosixPath(value)) != value or any(ord(c) < 32 for c in value):
        raise AuthorityError('authority path is unavailable')
    return pathlib.Path(value)


def directory(location: pathlib.Path, private=False, owners: frozenset[int] | None = None) -> int:
    owners = owners or frozenset({os.geteuid()})
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in location.parts[1:]:
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
            details = os.fstat(descriptor)
            sticky = component in {'tmp'} and details.st_uid == 0 and details.st_mode & stat.S_ISVTX
            if details.st_uid not in {0} | owners or details.st_mode & 0o022 and not sticky:
                raise AuthorityError('authority directory is unsafe')
        details = os.fstat(descriptor)
        if details.st_uid not in owners or private and details.st_mode & 0o077:
            raise AuthorityError('authority directory has a different owner or mode')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read(location: pathlib.Path, private=False, owners: frozenset[int] | None = None) -> tuple[bytes, os.stat_result]:
    owners = owners or frozenset({os.geteuid()})
    parent = directory(location.parent, owners=owners)
    try:
        descriptor = os.open(location.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_uid not in owners or details.st_nlink != 1 \
                or details.st_mode & (0o077 if private else 0o022) or details.st_size > 8388608:
            raise AuthorityError('authority file is unsafe')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(8388609)
        if len(raw) > 8388608:
            raise AuthorityError('authority file exceeds limit')
        return raw, details
    finally:
        os.close(descriptor)


def identity(details):
    return (details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns, details.st_ctime_ns, details.st_mode)


def publish(location: pathlib.Path, document: dict, original=None, owners: frozenset[int] | None = None):
    parent = directory(location.parent, owners=owners)
    temporary = '.' + location.name + '.' + secrets.token_hex(16)
    try:
        raw = (json.dumps(document, sort_keys=True, separators=(',', ':')) + '\n').encode()
        output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(output, 'wb', closefd=False) as stream:
                stream.write(raw)
                stream.flush()
            if original is not None:
                os.fchown(output, original.st_uid, original.st_gid)
            os.fchmod(output, 0o600 if original is None else stat.S_IMODE(original.st_mode))
            os.fsync(output)
        finally:
            os.close(output)
        if original is None:
            try:
                os.stat(location.name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise AuthorityError('authority publication conflict')
        elif identity(os.stat(location.name, dir_fd=parent, follow_symlinks=False)) != identity(original):
            raise AuthorityError('authority publication conflict')
        os.replace(temporary, location.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def openssl(*arguments, input_data=None):
    result = subprocess.run(['/usr/bin/openssl', *map(str, arguments)], input=input_data, capture_output=True, timeout=30)
    if result.returncode:
        raise AuthorityError('authority certificate validation failed')
    return result.stdout


def target(agent, record):
    principal = record.get('principal')
    return isinstance(principal, dict) and all(principal.get(field) == agent[field] for field in ('tenant_id', 'alias'))


def policy_paths(policy):
    if not {'version', 'state_root', 'registries', 'signer'} <= set(policy) <= {'version', 'state_root', 'registries', 'signer', 'base_registry_owner_uid'} \
            or policy['version'] != 1 \
            or set(policy['registries']) != set(AUTHORITIES) \
            or set(policy['signer']) != {'certificate', 'key', 'certificate_sha256', 'key_sha256'}:
        raise AuthorityError('authority policy is invalid')
    registries = {name: path(location) for name, location in policy['registries'].items()}
    if len(set(registries.values())) != 4:
        raise AuthorityError('authority paths overlap')
    for name, location in registries.items():
        if location.name != ('mtls_identities.json' if name.endswith('mtls') else 'token_hashes.json'):
            raise AuthorityError('authority filename is invalid')
    owner = policy.get('base_registry_owner_uid', os.geteuid())
    if type(owner) is not int or not 0 <= owner < 2 ** 32:
        raise AuthorityError('authority policy is invalid')
    base = frozenset({os.geteuid(), owner})
    owners = {location: base if name.startswith('base_') else frozenset({os.geteuid()}) for name, location in registries.items()}
    return path(policy['state_root']), registries, owners


def validate_packet(packet):
    scope, agent = packet['scope'], packet['agent']
    if set(scope) != {'operation_id', 'host_id', 'scope_sha256', 'runtime_key'} \
            or re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', scope['operation_id']) is None \
            or WIRE.fullmatch(scope['host_id']) is None or HEX.fullmatch(scope['scope_sha256']) is None \
            or RUNTIME.fullmatch(scope['runtime_key']) is None or set(agent) != {'tenant_id', 'alias'} \
            or re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', agent['tenant_id']) is None or WIRE.fullmatch(agent['alias']) is None:
        raise AuthorityError('authority scope is invalid')
    required = {'action', 'scope', 'agent'}
    fields = {'inventory': set(), 'verify_absent': set(), 'revoke': {'expected_inventory'},
              'issue': {'phase', 'csr_pem', 'csr_sha256', 'idempotency_key'}}
    if packet['action'] not in fields or set(packet) != required | fields[packet['action']]:
        raise AuthorityError('authority request is invalid')


def inventory(registries, owners, agent):
    rows = []
    for name in AUTHORITIES:
        raw, original = read(registries[name], owners=owners[registries[name]])
        document = json.loads(raw)
        if not isinstance(document, dict) or set(document) != {'version', 'identities'} or document['version'] != 1 \
                or not isinstance(document['identities'], list) or len(document['identities']) > 20000 \
                or not all(isinstance(row, dict) for row in document['identities']):
            raise AuthorityError('authority registry is invalid')
        matching = [row for row in document['identities'] if target(agent, row)]
        if len(matching) > 64:
            raise AuthorityError('authority target inventory exceeds limit')
        rows.append((name, document, original, {'id': name, 'sha256': digest(raw), 'matching_records': matching}))
    return rows


def observation(rows):
    return {'authorities': [row[3] for row in rows]}


def principal(packet):
    bootstrap = packet['phase'] == 'bootstrap'
    return {**packet['agent'], 'channel': 'bootstrap' if bootstrap else 'adapter',
            'session_id': ('bootstrap-' if bootstrap else 'adapter-') + packet['scope']['runtime_key'],
            'roles': [] if bootstrap else ['adapter'], 'permissions': [] if bootstrap else ['route', 'read']}


def issue_certificate(policy, packet):
    csr = packet['csr_pem']
    if packet['phase'] not in {'bootstrap', 'normal'} or not isinstance(csr, str) or len(csr.encode()) > 16384 \
            or re.fullmatch(r'-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE REQUEST-----\n', csr) is None \
            or digest(csr.encode()) != packet['csr_sha256'] or re.fullmatch(r'[A-Za-z0-9_-]{8,128}', packet['idempotency_key']) is None:
        raise AuthorityError('authority issuance request is invalid')
    openssl('req', '-verify', '-noout', input_data=csr.encode())
    subject = openssl('req', '-subject', '-nameopt', 'RFC2253', '-noout', input_data=csr.encode()).strip()
    text = openssl('req', '-text', '-noout', input_data=csr.encode())
    bits = re.search(rb'Public-Key: \((\d+) bit\)', text)
    extensions = text.split(b'Requested Extensions:', 1)[-1].split(b'Signature Algorithm:', 1)[0].strip()
    if subject != ('subject=CN=agent-' + packet['scope']['runtime_key']).encode() or extensions \
            or b'Public Key Algorithm: rsaEncryption' not in text or bits is None or not 2048 <= int(bits[1]) <= 4096:
        raise AuthorityError('authority CSR is outside its canonical runtime')
    ca_pem, _ = read(path(policy['signer']['certificate']))
    key_pem, _ = read(path(policy['signer']['key']), private=True)
    if digest(ca_pem) != policy['signer']['certificate_sha256'] or digest(key_pem) != policy['signer']['key_sha256']:
        raise AuthorityError('authority signer pin changed')
    if b'CA:TRUE' not in openssl('x509', '-text', '-noout', input_data=ca_pem) \
            or openssl('x509', '-pubkey', '-noout', input_data=ca_pem) != openssl('pkey', '-pubout', input_data=key_pem):
        raise AuthorityError('authority signer does not match its CA')
    end = openssl('x509', '-enddate', '-noout', input_data=ca_pem).decode().strip()
    expiry = datetime.datetime.strptime(end, 'notAfter=%b %d %H:%M:%S %Y GMT').replace(tzinfo=datetime.timezone.utc)
    days = min(1 if packet['phase'] == 'bootstrap' else 730,
               (expiry - datetime.datetime.now(datetime.timezone.utc)).days)
    if days < 1:
        raise AuthorityError('authority signer validity is too short')
    with tempfile.TemporaryDirectory(prefix='.authority-csr-', dir=policy['state_root']) as temporary:
        root = pathlib.Path(temporary)
        request, extension = root / 'request.pem', root / 'extensions'
        ca, key = root / 'ca.crt', root / 'ca.key'
        ca.write_bytes(ca_pem)
        key.write_bytes(key_pem)
        key.chmod(0o600)
        request.write_text(csr)
        extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
                             'extendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:cauce:runtime:' + packet['scope']['runtime_key'] + '\n')
        certificate = openssl('x509', '-req', '-sha256', '-in', request, '-CA', ca, '-CAkey', key,
                              '-set_serial', '0x' + secrets.token_hex(16), '-days', str(days), '-extfile', extension).decode()
    expires = openssl('x509', '-enddate', '-noout', input_data=certificate.encode()).decode().strip()
    leaf_expiry = datetime.datetime.strptime(expires, 'notAfter=%b %d %H:%M:%S %Y GMT').replace(tzinfo=datetime.timezone.utc)
    token = secrets.token_hex(32)
    return {'certificate_pem': certificate, 'ca_pem': ca_pem.decode(), 'token': token,
            'certificate_sha256': digest(ssl.PEM_cert_to_DER_cert(certificate)), 'token_sha256': digest(token.encode()),
            'expires_at': min(expiry, leaf_expiry).strftime('%Y-%m-%dT%H:%M:%SZ')}


def issue(policy, packet, rows, journal, journal_path, journal_stat):
    if journal.get('revoked'):
        raise AuthorityError('revoked authority journal cannot issue credentials')
    request_hash = digest(json.dumps(packet, sort_keys=True, separators=(',', ':')).encode())
    existing = journal.setdefault('issued', {}).get(packet['phase'])
    if existing is not None:
        if existing['request_hash'] != request_hash:
            raise AuthorityError('authority replay changed its issuance request')
        receipt = existing['receipt']
    else:
        receipt = issue_certificate(policy, packet)
        journal['issued'][packet['phase']] = {'request_hash': request_hash, 'receipt': receipt}
        publish(journal_path, journal, journal_stat)
    selected = principal(packet)
    for name, document, original, _ in rows:
        if not name.startswith('fleet_'):
            continue
        field = 'certificate_sha256' if name.endswith('mtls') else 'token_sha256'
        record = {field: receipt[field], 'principal': selected, 'expires_at': receipt['expires_at']}
        related = [row for row in document['identities'] if row.get('principal') == selected or row.get(field) == receipt[field]]
        if existing is not None and existing.get('registered') and related != [record]:
            raise AuthorityError('issued authority record was removed or replaced')
        if related and related != [record]:
            raise AuthorityError('authority registration is ambiguous or changed')
        if not related:
            publish(path(policy['registries'][name]), {**document, 'identities': [*document['identities'], record]}, original)
    journal['issued'][packet['phase']]['registered'] = True
    _, current_stat = read(journal_path, private=True)
    publish(journal_path, journal, current_stat)
    return receipt


def perform(policy, packet):
    validate_packet(packet)
    state, registries, owners = policy_paths(policy)
    with ExitStack() as stack:
        parent = directory(state, private=True)
        stack.callback(os.close, parent)
        lock = os.open('.authority.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        stack.callback(os.close, lock)
        details = os.fstat(lock)
        if details.st_uid != os.geteuid() or not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o600:
            raise AuthorityError('authority lock is unsafe')
        fcntl.flock(lock, fcntl.LOCK_EX)
        for location in sorted(registries.values()):
            registry_parent = directory(location.parent, owners=owners[location])
            stack.callback(os.close, registry_parent)
            descriptor = os.open('.' + location.name + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=registry_parent)
            stack.callback(os.close, descriptor)
            details = os.fstat(descriptor)
            if details.st_uid != os.geteuid() or not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_mode & 0o077:
                raise AuthorityError('authority registry lock is unsafe')
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        binding = {'scope': packet['scope'], 'agent': packet['agent']}
        journal_path = state / (digest(json.dumps(packet['scope'], sort_keys=True).encode()) + '.json')
        try:
            raw, journal_stat = read(journal_path, private=True)
            journal = json.loads(raw)
        except FileNotFoundError:
            journal, journal_stat = {'binding': binding}, None
        if journal.get('binding') != binding:
            raise AuthorityError('authority journal scope changed')
        rows = inventory(registries, owners, packet['agent'])
        action = packet['action']
        if action == 'inventory':
            return observation(rows)
        if action == 'issue':
            return issue(policy, packet, rows, journal, journal_path, journal_stat)
        if action == 'revoke':
            expected = packet['expected_inventory']
            actual = [{'id': row[3]['id'], 'sha256': row[3]['sha256']} for row in rows]
            if 'revoked' in journal:
                if journal['revoked'] != expected:
                    raise AuthorityError('authority replay changed its revocation request')
                planned = journal['revoke_records']
                if any(any(record not in planned[name] for record in row[3]['matching_records'])
                       for row in rows for name in [row[0]]):
                    raise AuthorityError('authority records changed after revocation preparation')
                if journal.get('revoke_complete') and any(row[3]['matching_records'] for row in rows):
                    raise AuthorityError('credentials reappeared after observed revocation')
            else:
                if expected != actual:
                    raise AuthorityError('authority inventory changed before revocation')
                journal['revoked'] = expected
                journal['revoke_records'] = {row[0]: row[3]['matching_records'] for row in rows}
                publish(journal_path, journal, journal_stat)
            for name, document, original, _ in rows:
                kept = [row for row in document['identities'] if not target(packet['agent'], row)]
                if kept != document['identities']:
                    publish(registries[name], {**document, 'identities': kept}, original, owners[registries[name]])
            rows = inventory(registries, owners, packet['agent'])
            journal['revoke_complete'] = True
            _, current_stat = read(journal_path, private=True)
            publish(journal_path, journal, current_stat)
        if any(row[3]['matching_records'] for row in rows):
            raise AuthorityError('authority absence was not observed')
        return observation(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    parser.add_argument('--policy-sha256', required=True)
    args = parser.parse_args()
    raw, _ = read(path(args.policy), private=True)
    if digest(raw) != args.policy_sha256:
        raise AuthorityError('authority policy pin changed')
    encoded = sys.stdin.buffer.read(65537)
    if len(encoded) > 65536:
        raise AuthorityError('authority payload exceeds limit')
    result = perform(json.loads(raw), json.loads(encoded))
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('fleet authority effect is unverified\n')
        sys.exit(2)
