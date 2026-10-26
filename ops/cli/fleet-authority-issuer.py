#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import datetime
import fcntl
import hashlib
import hmac
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
    principal = record if 'fingerprint_sha256' in record else record.get('principal')
    return isinstance(principal, dict) and all(principal.get(field) == agent[field] for field in ('tenant_id', 'alias'))


def policy_paths(policy):
    if not {'version', 'state_root', 'registries', 'signer'} <= set(policy) <= {'version', 'state_root', 'registries', 'signer', 'base_registry_owner_uid', 'terminal'} \
            or policy['version'] != 1 \
            or set(policy['registries']) not in (set(AUTHORITIES), {*AUTHORITIES, 'pty'}) \
            or set(policy['signer']) != {'certificate', 'key', 'certificate_sha256', 'key_sha256'}:
        raise AuthorityError('authority policy is invalid')
    registries = {name: path(location) for name, location in policy['registries'].items()}
    if len(set(registries.values())) != len(registries):
        raise AuthorityError('authority paths overlap')
    for name, location in registries.items():
        expected = 'pty_agent_identities.json' if name == 'pty' else \
            'mtls_identities.json' if name.endswith('mtls') else 'token_hashes.json'
        if location.name != expected:
            raise AuthorityError('authority filename is invalid')
    owner = policy.get('base_registry_owner_uid', os.geteuid())
    if type(owner) is not int or not 0 <= owner < 2 ** 32:
        raise AuthorityError('authority policy is invalid')
    base = frozenset({os.geteuid(), owner})
    owners = {location: base if name.startswith('base_') or name == 'pty' else frozenset({os.geteuid()})
              for name, location in registries.items()}
    return path(policy['state_root']), registries, owners


def validate_scope(scope, agent):
    if not isinstance(scope, dict) or not isinstance(agent, dict) \
            or set(scope) != {'operation_id', 'host_id', 'scope_sha256', 'runtime_key'} \
            or not all(isinstance(value, str) for value in (*scope.values(), *agent.values())) \
            or re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', scope['operation_id']) is None \
            or WIRE.fullmatch(scope['host_id']) is None or HEX.fullmatch(scope['scope_sha256']) is None \
            or RUNTIME.fullmatch(scope['runtime_key']) is None or set(agent) != {'tenant_id', 'alias'} \
            or re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', agent['tenant_id']) is None or WIRE.fullmatch(agent['alias']) is None:
        raise AuthorityError('authority scope is invalid')


def validate_packet(packet):
    validate_scope(packet['scope'], packet['agent'])
    required = {'action', 'scope', 'agent'}
    if 'preserve_legacy' in packet:
        if packet['preserve_legacy'] is not True:
            raise AuthorityError('invalid legacy preservation authority')
        required.add('preserve_legacy')
    if 'preserve_terminal' in packet:
        if packet['preserve_terminal'] is not True:
            raise AuthorityError('invalid terminal preservation authority')
        required.add('preserve_terminal')
    fields = {'inventory': set(), 'verify_absent': set(), 'revoke': {'expected_inventory'}, 'revoke_issued': set(),
              'issue': {'phase', 'csr_pem', 'csr_sha256', 'idempotency_key'},
              'checkpoint_credentials': {'expected_inventory', 'snapshot_sha256', 'original_container_id',
                                         'normal_certificate_sha256', 'normal_token_sha256'},
              'rollback_credentials': {'expected_inventory', 'snapshot_sha256', 'original_container_id', 'checkpoint_sha256'},
              'issue_terminal': {'csr_pem', 'csr_sha256', 'idempotency_key'},
              'terminal_receipt': {'csr_pem', 'csr_sha256', 'idempotency_key'},
              'revoke_terminal': {'grant_id', 'certificate_sha256'}}
    if packet['action'] not in fields or set(packet) != required | fields[packet['action']]:
        raise AuthorityError('authority request is invalid')


def registry(location, owners):
    raw, original = read(location, owners=owners)
    document = json.loads(raw)
    field = 'agents' if location.name == 'pty_agent_identities.json' else 'identities'
    if not isinstance(document, dict) or set(document) != {'version', field} or document['version'] != 1 \
            or not isinstance(document[field], list) or len(document[field]) > 20000 \
            or not all(isinstance(row, dict) for row in document[field]):
        raise AuthorityError('authority registry is invalid')
    if field == 'agents':
        fingerprints = set()
        for row in document[field]:
            fingerprint = row.get('fingerprint_sha256')
            if set(row) != {'tenant_id', 'alias', 'fingerprint_sha256', 'expires_at'} \
                    or not isinstance(fingerprint, str) or re.fullmatch(r'[A-Fa-f0-9]{64}', fingerprint) is None \
                    or not all(isinstance(row.get(key), str) and row[key] for key in ('tenant_id', 'alias', 'expires_at')) \
                    or fingerprint.lower() in fingerprints:
                raise AuthorityError('terminal authority identity is ambiguous')
            fingerprints.add(fingerprint.lower())
    return raw, document, original


def inventory(registries, owners, agent, preserve_legacy=False, preserve_terminal=False):
    rows = []
    for name in (*AUTHORITIES, *(['pty'] if 'pty' in registries else [])):
        raw, document, original = registry(registries[name], owners[registries[name]])
        matching = [row for row in document['agents' if name == 'pty' else 'identities'] if target(agent, row)]
        if len(matching) > 64:
            raise AuthorityError('authority target inventory exceeds limit')
        rows.append((name, document, original, {'id': name, 'sha256': digest(raw), 'matching_records': matching,
            **({'preserved': True} if preserve_legacy and name.startswith('base_')
               or preserve_terminal and name == 'pty' else {})}))
    return rows


def resolve_runtime_authority(policy, packet):
    if set(packet) != {'action', 'certificate_sha256'} or not isinstance(packet['certificate_sha256'], str) \
            or HEX.fullmatch(packet['certificate_sha256']) is None:
        raise AuthorityError('authority lookup request is invalid')
    state, registries, owners = policy_paths(policy)
    location = registries['fleet_mtls']
    matches, snapshots = [], []
    with ExitStack() as stack:
        parent = directory(state, private=True)
        stack.callback(os.close, parent)
        state_stat = os.fstat(parent)
        registry_parent = directory(location.parent, owners=owners[location])
        stack.callback(os.close, registry_parent)
        _, document, registry_stat = registry(location, owners[location])
        names = []
        with os.scandir(parent) as entries:
            for count, entry in enumerate(entries, 1):
                if count > 8192:
                    raise AuthorityError('authority journal snapshot exceeds limit')
                if re.fullmatch(r'[a-f0-9]{64}\.json', entry.name):
                    names.append(entry.name)
                    if len(names) > 4096:
                        raise AuthorityError('authority journal snapshot exceeds limit')
        size = 0
        for name in names:
            raw, original = read(state / name, private=True)
            size += len(raw)
            if size > 33554432:
                raise AuthorityError('authority journal snapshot exceeds limit')
            snapshots.append((name, original))
            journal = json.loads(raw)
            binding = journal.get('binding') if isinstance(journal, dict) else None
            if not isinstance(binding, dict):
                raise AuthorityError('authority journal is invalid')
            scope, agent = binding.get('scope'), binding.get('agent')
            validate_scope(scope, agent)
            if name != digest(json.dumps(scope, sort_keys=True).encode()) + '.json':
                raise AuthorityError('authority journal scope changed')
            normal = journal.get('issued', {}).get('normal')
            if normal is None:
                continue
            receipt = normal.get('receipt') if isinstance(normal, dict) else None
            if not isinstance(receipt, dict):
                raise AuthorityError('authority journal receipt is invalid')
            if receipt.get('certificate_sha256') == packet['certificate_sha256']:
                matches.append((journal, scope, agent, normal, receipt))
        if identity(os.fstat(parent)) != identity(state_stat) \
                or identity(os.stat(location.name, dir_fd=registry_parent, follow_symlinks=False)) != identity(registry_stat) \
                or any(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(original)
                       for name, original in snapshots):
            raise AuthorityError('authority lookup snapshot changed')
    if len(matches) > 1:
        raise AuthorityError('authority runtime lookup is ambiguous')
    if not matches:
        return {'identity': None}
    journal, scope, agent, normal, receipt = matches[0]
    if 'revoked' in journal or normal.get('registered') is not True:
        return {'identity': None}
    selected = {**agent, 'channel': 'adapter', 'session_id': 'adapter-' + scope['runtime_key']}
    related = [row for row in document['identities'] if row.get('certificate_sha256') == packet['certificate_sha256']
               or isinstance(row.get('principal'), dict) and all(row['principal'].get(key) == value for key, value in selected.items())]
    if len(related) != 1:
        return {'identity': None}
    record = related[0]
    if record.get('certificate_sha256') != packet['certificate_sha256'] or not isinstance(record.get('principal'), dict) \
            or not all(record['principal'].get(key) == value for key, value in selected.items()) \
            or record.get('expires_at') != receipt.get('expires_at'):
        return {'identity': None}
    try:
        expiry = datetime.datetime.fromisoformat(receipt['expires_at'].replace('Z', '+00:00'))
        if expiry <= datetime.datetime.now(datetime.UTC):
            return {'identity': None}
    except (KeyError, TypeError, ValueError, AttributeError):
        return {'identity': None}
    return {'identity': {**{key: scope[key] for key in ('host_id', 'runtime_key')}, **agent, 'expires_at': receipt['expires_at']}}


def observation(rows):
    return {'authorities': [row[3] for row in rows]}


def compensation_hash(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


def compensation_normal(policy, packet, rows, normal):
    selected = principal({**packet, 'phase': 'normal'})
    for name, field in (('fleet_mtls', 'normal_certificate_sha256'), ('fleet_token', 'normal_token_sha256')):
        fingerprint = 'certificate_sha256' if name.endswith('mtls') else 'token_sha256'
        records = next(row[3]['matching_records'] for row in rows if row[0] == name)
        matching = [row for row in records if row.get('principal') == selected]
        if len(matching) != 1 or matching[0].get(fingerprint) != normal[field] or expired(matching[0]):
            raise AuthorityError('original normal authority is unavailable')
    identity = resolve_runtime_authority(policy, {'action': 'resolve_runtime_authority',
        'certificate_sha256': normal['normal_certificate_sha256']})['identity']
    if identity is None or any(identity.get(key) != value for key, value in packet['agent'].items()) \
            or any(identity.get(key) != packet['scope'][key] for key in ('host_id', 'runtime_key')):
        raise AuthorityError('original normal authority provenance changed')


def compensation_credentials(policy, packet, rows, journal, journal_path, journal_stat):
    _, registries, owners = policy_paths(policy)
    names = ('snapshot_sha256', 'original_container_id')
    if any(not isinstance(packet.get(name), str) or HEX.fullmatch(packet[name]) is None for name in names) \
            or packet['expected_inventory'] != [{'id': row[3]['id'], 'sha256': row[3]['sha256']} for row in rows]:
        raise AuthorityError('credential compensation inventory changed')
    checkpoint = journal.get('credential_checkpoint')
    if packet['action'] == 'checkpoint_credentials':
        normal = {name: packet[name] for name in ('normal_certificate_sha256', 'normal_token_sha256')}
        if any(not isinstance(value, str) or HEX.fullmatch(value) is None for value in normal.values()):
            raise AuthorityError('normal credential pins are invalid')
        if journal.get('issued') or journal.get('terminal') or 'revoked' in journal or 'issued_revoked' in journal:
            raise AuthorityError('credential checkpoint must precede issuance')
        compensation_normal(policy, packet, rows, normal)
        if checkpoint is None:
            checkpoint = {'version': 1, 'scope': packet['scope'], 'agent': packet['agent'], **normal,
                          **{name: packet[name] for name in names},
                          'authorities': [{'id': row[0], 'matching_records': row[3]['matching_records']} for row in rows]}
            journal['credential_checkpoint'] = checkpoint
            publish(journal_path, journal, journal_stat)
        elif any(checkpoint.get(name) != packet[name] for name in (*names, *normal)):
            raise AuthorityError('credential checkpoint replay changed')
        elif checkpoint['authorities'] != [{'id': row[0], 'matching_records': row[3]['matching_records']} for row in rows]:
            raise AuthorityError('credential checkpoint authority changed')
        return {'checkpoint_sha256': compensation_hash(checkpoint)}
    if not isinstance(checkpoint, dict) or packet.get('checkpoint_sha256') != compensation_hash(checkpoint) \
            or any(checkpoint.get(name) != packet[name] for name in names) \
            or checkpoint.get('scope') != packet['scope'] or checkpoint.get('agent') != packet['agent']:
        raise AuthorityError('credential rollback lacks its original checkpoint')
    compensation_normal(policy, packet, rows, checkpoint)
    prior = {row['id']: row['matching_records'] for row in checkpoint['authorities']}
    owned = {name: [] for name in prior}
    revoked = []
    for phase, issued in journal.get('issued', {}).items():
        if phase not in {'bootstrap', 'normal'}:
            raise AuthorityError('credential issuance phase changed')
        receipt = issued['receipt']
        selected = principal({**packet, 'phase': phase})
        for name, field in (('fleet_mtls', 'certificate_sha256'), ('fleet_token', 'token_sha256')):
            owned[name].append({field: receipt[field], 'principal': selected, 'expires_at': receipt['expires_at']})
        if owned['fleet_mtls'][-1] not in prior['fleet_mtls'] or owned['fleet_token'][-1] not in prior['fleet_token']:
            revoked.append({'phase': phase, **{name: receipt[name] for name in ('certificate_sha256', 'token_sha256')}})
    if set(prior) != {row[0] for row in rows}:
        raise AuthorityError('credential authority set changed')
    # Issuing a bootstrap retires the expired record of the same bootstrap principal (see issue); that record was this
    # operation's own effect, cannot be restored usefully and is not a change by another operation.
    retired = {name: [record for record in prior[name] if expired(record)
                      and any(record.get('principal') == mine['principal'] for mine in owned.get(name, []))]
               for name in prior}
    for name, _, _, observed in rows:
        current = observed['matching_records']
        if any(record not in current and record not in retired[name] for record in prior[name]) \
                or any(record not in prior[name] and record not in owned[name] for record in current):
            raise AuthorityError('shared authority was removed, replaced or changed by another operation')
    if 'credential_rollback_started' not in journal:
        journal['credential_rollback_started'] = True
        publish(journal_path, journal, journal_stat)
    for name, document, original, _ in rows:
        field = 'agents' if name == 'pty' else 'identities'
        kept = [record for record in document[field] if record not in owned[name] or record in prior[name]]
        if kept != document[field]:
            publish(registries[name], {**document, field: kept}, original, owners[registries[name]])
    restored = inventory(registries, owners, packet['agent'], packet.get('preserve_legacy', False),
                         packet.get('preserve_terminal', False))
    authorities = [{'id': row[0], 'matching_records': row[3]['matching_records']} for row in restored]
    if authorities != [{'id': row['id'], 'matching_records': [record for record in row['matching_records']
                                                              if record not in retired[row['id']]]}
                       for row in checkpoint['authorities']]:
        raise AuthorityError('shared authority restoration was not observed')
    compensation_normal(policy, packet, restored, checkpoint)
    proof = {'version': 1, **{name: packet[name] for name in names},
             'checkpoint_sha256': packet['checkpoint_sha256'], 'authorities': authorities}
    result = {'checkpoint_sha256': packet['checkpoint_sha256'], 'authority_sha256': compensation_hash(proof),
              'shared_authority_preserved': True, 'created_authority_revoked': True, 'revoked_credentials': revoked}
    journal['credential_rollback'] = result
    _, current_stat = read(journal_path, private=True)
    publish(journal_path, journal, current_stat)
    return result


def principal(packet):
    bootstrap = packet['phase'] == 'bootstrap'
    return {**packet['agent'], 'channel': 'bootstrap' if bootstrap else 'adapter',
            'session_id': ('bootstrap-' if bootstrap else 'adapter-') + packet['scope']['runtime_key'],
            'roles': [] if bootstrap else ['adapter'], 'permissions': [] if bootstrap else ['route', 'read']}


def read_signer(policy):
    ca_pem, _ = read(path(policy['signer']['certificate']))
    key_pem, _ = read(path(policy['signer']['key']), private=True)
    if digest(ca_pem) != policy['signer']['certificate_sha256'] or digest(key_pem) != policy['signer']['key_sha256']:
        raise AuthorityError('authority signer pin changed')
    if b'CA:TRUE' not in openssl('x509', '-text', '-noout', input_data=ca_pem) \
            or openssl('x509', '-pubkey', '-noout', input_data=ca_pem) != openssl('pkey', '-pubout', input_data=key_pem):
        raise AuthorityError('authority signer does not match its CA')
    end = openssl('x509', '-enddate', '-noout', input_data=ca_pem).decode().strip()
    expiry = datetime.datetime.strptime(end, 'notAfter=%b %d %H:%M:%S %Y GMT').replace(tzinfo=datetime.UTC)
    if (expiry - datetime.datetime.now(datetime.UTC)).days < 1:
        raise AuthorityError('authority signer validity is too short')
    return ca_pem, key_pem, expiry


def readiness(policy):
    state, registries, owners = policy_paths(policy)
    descriptor = directory(state, private=True)
    os.close(descriptor)
    inventory(registries, owners, {'tenant_id': '', 'alias': ''})
    read_signer(policy)
    return {'ready': True}


def issue_certificate(policy, packet, *, terminal=False):
    csr = packet['csr_pem']
    phase = 'normal' if terminal else packet['phase']
    if phase not in {'bootstrap', 'normal'} or not isinstance(csr, str) or len(csr.encode()) > 16384 \
            or re.fullmatch(r'-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE REQUEST-----\n', csr) is None \
            or digest(csr.encode()) != packet['csr_sha256'] or re.fullmatch(r'[A-Za-z0-9_-]{8,128}', packet['idempotency_key']) is None:
        raise AuthorityError('authority issuance request is invalid')
    openssl('req', '-verify', '-noout', input_data=csr.encode())
    subject = openssl('req', '-subject', '-nameopt', 'RFC2253', '-noout', input_data=csr.encode()).strip()
    text = openssl('req', '-text', '-noout', input_data=csr.encode())
    bits = re.search(rb'Public-Key: \((\d+) bit\)', text)
    extensions = text.split(b'Requested Extensions:', 1)[-1].split(b'Signature Algorithm:', 1)[0].strip()
    if subject != ('subject=CN=' + ('pty-' if terminal else 'agent-') + packet['scope']['runtime_key']).encode() or extensions \
            or b'Public Key Algorithm: rsaEncryption' not in text or bits is None or not 2048 <= int(bits[1]) <= 4096:
        raise AuthorityError('authority CSR is outside its canonical runtime')
    ca_pem, key_pem, expiry = read_signer(policy)
    days = min(1 if phase == 'bootstrap' else 730,
               (expiry - datetime.datetime.now(datetime.UTC)).days)
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
    leaf_expiry = datetime.datetime.strptime(expires, 'notAfter=%b %d %H:%M:%S %Y GMT').replace(tzinfo=datetime.UTC)
    result = {'certificate_pem': certificate, 'ca_pem': ca_pem.decode(),
              'certificate_sha256': digest(ssl.PEM_cert_to_DER_cert(certificate)),
              'expires_at': min(expiry, leaf_expiry).strftime('%Y-%m-%dT%H:%M:%SZ')}
    if not terminal:
        token = secrets.token_hex(32)
        result.update(token=token, token_sha256=digest(token.encode()))
    return result


def terminal_configuration(policy):
    value = policy.get('terminal')
    required = {'master_file', 'master_sha256', 'relay_host', 'relay_port'}
    if not isinstance(value, dict) or not required <= set(value) <= required | {'relay_server_name'} \
            or not isinstance(value.get('master_sha256'), str) or HEX.fullmatch(value['master_sha256']) is None \
            or not isinstance(value.get('relay_host'), str) \
            or re.fullmatch(r'(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])', value['relay_host']) is None \
            or type(value.get('relay_port')) is not int or not 1 <= value['relay_port'] <= 65535 \
            or 'relay_server_name' in value and (not isinstance(value['relay_server_name'], str)
                or re.fullmatch(r'[A-Za-z0-9.:-]+', value['relay_server_name']) is None) \
            or 'pty' not in policy['registries']:
        raise AuthorityError('terminal authority is unavailable')
    raw, _ = read(path(value['master_file']), private=True)
    if digest(raw) != value['master_sha256']:
        raise AuthorityError('terminal authority master pin changed')
    if len(raw) == 32:
        master = raw
    else:
        encoded = raw.decode('utf-8').strip()
        master = bytes.fromhex(encoded) if re.fullmatch(r'[A-Fa-f0-9]{64}', encoded) else base64.b64decode(encoded, validate=True)
    if len(master) != 32:
        raise AuthorityError('terminal authority master is invalid')
    return value, master


def terminal_record(packet, receipt):
    return {**packet['agent'], 'fingerprint_sha256': receipt['certificate_sha256'].upper(), 'expires_at': receipt['expires_at']}


def terminal_effect(policy, packet, rows, journal, journal_path, journal_stat):
    configuration, master = terminal_configuration(policy)
    current = next((row for row in rows if row[0] == 'pty'), None)
    if current is None:
        raise AuthorityError('terminal authority is unavailable')
    _, document, original, _ = current
    registry_owners = frozenset({os.geteuid(), original.st_uid})
    existing = journal.get('terminal')
    configuration_pin = digest(json.dumps(configuration, sort_keys=True).encode())
    if existing is not None and existing.get('configuration_sha256') != configuration_pin:
        raise AuthorityError('terminal authority configuration changed')
    if packet['action'] == 'terminal_receipt':
        if not isinstance(packet['csr_pem'], str) or len(packet['csr_pem'].encode()) > 16384 \
                or digest(packet['csr_pem'].encode()) != packet['csr_sha256'] \
                or not isinstance(packet['idempotency_key'], str) \
                or re.fullmatch(r'[A-Za-z0-9_-]{8,128}', packet['idempotency_key']) is None:
            raise AuthorityError('terminal receipt request is invalid')
        if existing is None:
            return {'grant': None, 'registered': False, 'revoked': False}
        request_hash = digest(json.dumps({**packet, 'action': 'issue_terminal'}, sort_keys=True, separators=(',', ':')).encode())
        if existing.get('request_hash') != request_hash:
            raise AuthorityError('terminal receipt request differs from its issued grant')
        record = terminal_record(packet, existing['receipt'])
        related = [row for row in document['agents'] if row['fingerprint_sha256'].lower() == existing['receipt']['certificate_sha256']]
        if related and related != [record] or existing.get('revocation_complete') and related:
            raise AuthorityError('terminal receipt registry identity changed')
        return {'grant': existing['receipt'], 'registered': related == [record], 'revoked': existing.get('revoked') is True}
    if packet['action'] == 'issue_terminal':
        ca_pem, _, _ = read_signer(policy)
        if journal.get('revoked') or existing is not None and existing.get('revoked'):
            raise AuthorityError('revoked terminal grant cannot issue')
        request_hash = digest(json.dumps(packet, sort_keys=True, separators=(',', ':')).encode())
        if existing is None:
            receipt = issue_certificate(policy, packet, terminal=True)
            prk = hmac.new(b'cauce-v3/pty-ticket/v1', master, hashlib.sha256).digest()
            info = ('pty:' + packet['agent']['tenant_id'] + ':' + packet['agent']['alias']).encode()
            receipt.update(alias_key_hex=hmac.new(prk, info + b'\x01', hashlib.sha256).hexdigest(),
                           grant_id=request_hash, relay_host=configuration['relay_host'], relay_port=configuration['relay_port'])
            if 'relay_server_name' in configuration:
                receipt['relay_server_name'] = configuration['relay_server_name']
            existing = {'request_hash': request_hash, 'receipt': receipt, 'configuration_sha256': configuration_pin}
            journal['terminal'] = existing
            publish(journal_path, journal, journal_stat)
        elif existing.get('request_hash') != request_hash:
            raise AuthorityError('terminal grant replay changed its request')
        receipt = existing['receipt']
        if receipt['ca_pem'] != ca_pem.decode():
            raise AuthorityError('terminal grant signer changed')
        record = terminal_record(packet, receipt)
        related = [row for row in document['agents'] if row['fingerprint_sha256'].lower() == receipt['certificate_sha256']]
        if related and related != [record] or existing.get('registered') and related != [record]:
            raise AuthorityError('terminal grant registry changed')
        if not related:
            location = pathlib.Path(policy['registries']['pty'])
            publish(location, {**document, 'agents': [*document['agents'], record]}, original, registry_owners)
        existing['registered'] = True
        publish(journal_path, journal, read(journal_path, private=True)[1])
        return receipt
    if any(not isinstance(packet.get(key), str) or HEX.fullmatch(packet[key]) is None
           for key in ('grant_id', 'certificate_sha256')) \
            or existing is None or existing['receipt'].get('grant_id') != packet.get('grant_id') \
            or existing['receipt'].get('certificate_sha256') != packet.get('certificate_sha256'):
        raise AuthorityError('terminal revocation is outside its issued grant')
    record = terminal_record(packet, existing['receipt'])
    related = [row for row in document['agents'] if row['fingerprint_sha256'].lower() == packet['certificate_sha256']]
    if related and related != [record] or existing.get('revocation_complete') and related:
        raise AuthorityError('terminal grant changed after revocation')
    existing['revoked'] = True
    publish(journal_path, journal, read(journal_path, private=True)[1])
    if related:
        publish(path(policy['registries']['pty']), {**document, 'agents': [row for row in document['agents'] if row != record]}, original, registry_owners)
    existing['revocation_complete'] = True
    publish(journal_path, journal, read(journal_path, private=True)[1])
    return {'revoked': True, 'grant_id': packet['grant_id'], 'certificate_sha256': packet['certificate_sha256']}


def expired(row) -> bool:
    try:
        return datetime.datetime.fromisoformat(row['expires_at'].replace('Z', '+00:00')) < datetime.datetime.now(datetime.UTC)
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def issue(policy, packet, rows, journal, journal_path, journal_stat):
    if journal.get('revoked') or journal.get('credential_rollback_started') or 'issued_revoked' in journal:
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
        # A bootstrap credential lives one day: an agent updated later gets a new one, and the expired record of the
        # same bootstrap principal is retired instead of making the registration ambiguous.
        if packet['phase'] == 'bootstrap' and existing is None:
            stale = [row for row in document['identities'] if row.get('principal') == selected and row != record and expired(row)]
            if stale:
                document = {**document, 'identities': [row for row in document['identities'] if row not in stale]}
                publish(path(policy['registries'][name]), document, original)
                original = read(path(policy['registries'][name]))[1]
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


def revoke_issued(policy, packet, rows, journal, journal_path, journal_stat):
    """Removes only the fleet records this scope issued (its journal names them) and refuses any later issuance in it.

    Cancelling an operation that never owned the runtime's other credentials (a start of a relocated identity keeps its
    legacy base records and the normal pair an earlier operation issued) must not revoke them: a full revoke would."""
    _, registries, owners = policy_paths(policy)
    revoked, owned = [], {'fleet_mtls': set(), 'fleet_token': set()}
    for phase, issued in sorted(journal.get('issued', {}).items()):
        receipt = issued.get('receipt') if isinstance(issued, dict) else None
        if phase not in {'bootstrap', 'normal'} or not isinstance(receipt, dict) \
                or any(not isinstance(receipt.get(name), str) or HEX.fullmatch(receipt[name]) is None
                       for name in ('certificate_sha256', 'token_sha256')):
            raise AuthorityError('credential issuance journal is invalid')
        revoked.append({'phase': phase, 'certificate_sha256': receipt['certificate_sha256'], 'token_sha256': receipt['token_sha256']})
        owned['fleet_mtls'].add(receipt['certificate_sha256'])
        owned['fleet_token'].add(receipt['token_sha256'])
    if 'issued_revoked' not in journal:
        journal['issued_revoked'] = revoked
        publish(journal_path, journal, journal_stat)
    elif journal['issued_revoked'] != revoked:
        raise AuthorityError('authority replay changed its issued revocation')
    for name, document, original, _ in rows:
        if not owned.get(name):
            continue
        field = 'certificate_sha256' if name.endswith('mtls') else 'token_sha256'
        if any(record.get(field) in owned[name] and not target(packet['agent'], record) for record in document['identities']):
            raise AuthorityError('an issued fingerprint is registered to another principal')
        kept = [record for record in document['identities'] if record.get(field) not in owned[name]]
        if kept != document['identities']:
            publish(registries[name], {**document, 'identities': kept}, original, owners[registries[name]])
    rows = inventory(registries, owners, packet['agent'], packet.get('preserve_legacy', False), packet.get('preserve_terminal', False))
    for name, _, _, observed in rows:
        field = 'certificate_sha256' if name.endswith('mtls') else 'token_sha256'
        if any(record.get(field) in owned.get(name, ()) for record in observed['matching_records']):
            raise AuthorityError('issued credentials remain after revocation')
    if not journal.get('issued_revoke_complete'):
        journal['issued_revoke_complete'] = True
        _, current_stat = read(journal_path, private=True)
        publish(journal_path, journal, current_stat)
    return {**observation(rows), 'revoked_credentials': revoked}


def perform(policy, packet):
    if packet.get('action') == 'resolve_runtime_authority':
        return resolve_runtime_authority(policy, packet)
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
            lock_name = ('' if location.name == 'pty_agent_identities.json' else '.') + location.name + '.lock'
            descriptor = os.open(lock_name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=registry_parent)
            stack.callback(os.close, descriptor)
            details = os.fstat(descriptor)
            if details.st_uid != os.geteuid() or not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_mode & 0o077:
                raise AuthorityError('authority registry lock is unsafe')
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        binding = {'scope': packet['scope'], 'agent': packet['agent'],
                   **({'preserve_legacy': True} if packet.get('preserve_legacy') else {}),
                   **({'preserve_terminal': True} if packet.get('preserve_terminal') else {})}
        journal_path = state / (digest(json.dumps(packet['scope'], sort_keys=True).encode()) + '.json')
        try:
            raw, journal_stat = read(journal_path, private=True)
            journal = json.loads(raw)
        except FileNotFoundError:
            journal, journal_stat = {'binding': binding}, None
        if journal.get('binding') != binding:
            raise AuthorityError('authority journal scope changed')
        rows = inventory(registries, owners, packet['agent'], packet.get('preserve_legacy', False),
                         packet.get('preserve_terminal', False))
        action = packet['action']
        if action in {'checkpoint_credentials', 'rollback_credentials'}:
            return compensation_credentials(policy, packet, rows, journal, journal_path, journal_stat)
        if action in {'issue_terminal', 'revoke_terminal', 'terminal_receipt'}:
            return terminal_effect(policy, packet, rows, journal, journal_path, journal_stat)
        if action == 'inventory':
            return observation(rows)
        if action == 'issue':
            return issue(policy, packet, rows, journal, journal_path, journal_stat)
        if action == 'revoke_issued':
            return revoke_issued(policy, packet, rows, journal, journal_path, journal_stat)
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
                if journal.get('revoke_complete') and any(row[3]['matching_records'] for row in rows if not row[3].get('preserved')):
                    raise AuthorityError('credentials reappeared after observed revocation')
            else:
                if expected != actual:
                    raise AuthorityError('authority inventory changed before revocation')
                journal['revoked'] = expected
                journal['revoke_records'] = {row[0]: row[3]['matching_records'] for row in rows}
                publish(journal_path, journal, journal_stat)
            for name, document, original, _ in rows:
                if packet.get('preserve_legacy') and name.startswith('base_'):
                    continue
                if packet.get('preserve_terminal') and name == 'pty':
                    continue
                field = 'agents' if name == 'pty' else 'identities'
                kept = [row for row in document[field] if not target(packet['agent'], row)]
                if kept != document[field]:
                    publish(registries[name], {**document, field: kept}, original, owners[registries[name]])
            rows = inventory(registries, owners, packet['agent'], packet.get('preserve_legacy', False),
                             packet.get('preserve_terminal', False))
            journal['revoke_complete'] = True
            _, current_stat = read(journal_path, private=True)
            publish(journal_path, journal, current_stat)
        if any(row[3]['matching_records'] for row in rows if not row[3].get('preserved')):
            raise AuthorityError('authority absence was not observed')
        return observation(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    parser.add_argument('--policy-sha256', required=True)
    parser.add_argument('--ready', action='store_true')
    args = parser.parse_args()
    raw, _ = read(path(args.policy), private=True)
    if digest(raw) != args.policy_sha256:
        raise AuthorityError('authority policy pin changed')
    if args.ready:
        result = readiness(json.loads(raw))
    else:
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
