#!/usr/bin/env python3
"""Renew only the dedicated supervision leaf; preserve every other identity."""
from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import ssl
import stat
import subprocess
import tempfile

LOCK_SPEC = importlib.util.spec_from_file_location("identity_registry_lock", pathlib.Path(__file__).with_name("identity-registry-lock.py"))
LOCK_MODULE = importlib.util.module_from_spec(LOCK_SPEC)
LOCK_SPEC.loader.exec_module(LOCK_MODULE)
RegistryLock = LOCK_MODULE.RegistryLock


ALIAS = 'praxis-supervisor'
PRINCIPAL = {'tenant_id': 'Hospital', 'alias': ALIAS, 'session_id': ALIAS,
             'channel': 'adapter', 'roles': ['operator'], 'permissions': ['read', 'route']}


def validate_record(document: dict) -> dict:
    matches = [x for x in document.get('identities', [])
               if x.get('principal', {}).get('alias') == ALIAS]
    if document.get('version') != 1 or len(matches) != 1 or matches[0]['principal'] != PRINCIPAL:
        raise ValueError('supervision identity does not match its fixed authority')
    return matches[0]


def private_path(path: pathlib.Path, mode: int | None = None) -> os.stat_result:
    details = path.lstat()
    if path.is_symlink() or details.st_uid not in (0, 1000) or details.st_nlink != 1:
        raise ValueError('unsafe identity path')
    if not stat.S_ISREG(details.st_mode) or (mode is not None and stat.S_IMODE(details.st_mode) != mode):
        raise ValueError('unsafe identity file')
    return details


def atomic_json(path: pathlib.Path, document: dict, uid: int, gid: int, mode: int) -> None:
    fd, name = tempfile.mkstemp(prefix='.supervision-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(document, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(name, uid, gid)
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def expiry(path: pathlib.Path) -> dt.datetime:
    value = subprocess.check_output(['openssl', 'x509', '-in', str(path), '-noout', '-enddate'], text=True)
    return dt.datetime.strptime(value.strip().split('=', 1)[1], '%b %d %H:%M:%S %Y %Z').replace(tzinfo=dt.timezone.utc)


def verify_owned_leaf(key: pathlib.Path, certificate: pathlib.Path) -> None:
    key_public = subprocess.check_output(['openssl', 'pkey', '-in', str(key), '-pubout'])
    leaf_public = subprocess.check_output(['openssl', 'x509', '-in', str(certificate), '-pubkey', '-noout'])
    if key_public != leaf_public:
        raise ValueError('renewed certificate does not match the owned key')


def replace_owned_record(registry: pathlib.Path, expected: dict, replacement: dict,
                         metadata: os.stat_result) -> None:
    with RegistryLock(registry) as lock:
        _replace_owned_record_locked(lock, expected, replacement)


def _replace_owned_record_locked(lock: RegistryLock, expected: dict, replacement: dict) -> None:
    latest_bytes, metadata = lock.read()
    latest = json.loads(latest_bytes)
    own = validate_record(latest)
    if own != expected:
        raise ValueError('supervision authority changed during renewal')
    own.update(replacement)
    validate_record(latest)
    lock.replace(latest, latest_bytes, metadata)


def maintain_identity() -> int:
    if os.geteuid() != 0:
        raise ValueError('identity maintenance requires the host owner')
    stop = pathlib.Path('/var/lib/praxis-supervision/STOP')
    if stop.exists():
        if private_path(stop, 0o600).st_uid != 0:
            raise ValueError('only the host owner may stop supervision')
        print(json.dumps({'action': 'stopped', 'changed': False}))
        return 0
    folder = pathlib.Path('/etc/cauce-v3-hospital/pki/praxis-supervisor')
    registry = pathlib.Path('/etc/cauce-v3-hospital/identities/mtls_identities.json')
    key, certificate = folder / 'client.key', folder / 'client.crt'
    if private_path(key, 0o600).st_uid != 0:
        raise ValueError('the service key must remain host-owned')
    private_path(certificate)
    if folder.is_symlink() or folder.stat().st_uid != 0 or folder.stat().st_mode & 0o077:
        raise ValueError('identity directory must be private and owner-managed')
    with RegistryLock(registry) as lock:
        document = json.loads(lock.read()[0])
        record = validate_record(document)
        expected_record = dict(record)
        temporary = folder / 'client-renewed.crt'
        if temporary.exists():
            private_path(temporary)
            pending_fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(temporary.read_text())).hexdigest()
            if pending_fingerprint != record['certificate_sha256']:
                raise ValueError('previous renewal needs owner reconciliation')
            subprocess.run(['openssl', 'verify', '-CAfile', '/etc/cauce-v3-hospital/pki/ca.crt',
                            '-purpose', 'sslclient', str(temporary)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            verify_owned_leaf(key, temporary)
            os.chmod(temporary, stat.S_IMODE(certificate.stat().st_mode))
            os.replace(temporary, certificate)
        current_fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate.read_text())).hexdigest()
        if record['certificate_sha256'] != current_fingerprint:
            raise ValueError('registered leaf differs from the owned certificate')
        remaining = expiry(certificate) - dt.datetime.now(dt.timezone.utc)
        if remaining < dt.timedelta(days=2):
            private_path(folder / 'client.csr', 0o600)
            private_path(folder / 'client.ext', 0o600)
            if temporary.exists():
                raise ValueError('previous renewal needs reconciliation')
            subprocess.run(['openssl', 'x509', '-req', '-in', str(folder / 'client.csr'),
                            '-CA', '/etc/cauce-v3-hospital/pki/ca.crt',
                            '-CAkey', '/etc/cauce-v3-hospital/pki/ca.key',
                            '-set_serial', '0x' + os.urandom(16).hex(), '-out', str(temporary),
                            '-days', '7', '-sha256', '-extfile', str(folder / 'client.ext')],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['openssl', 'verify', '-CAfile', '/etc/cauce-v3-hospital/pki/ca.crt',
                            '-purpose', 'sslclient', str(temporary)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            verify_owned_leaf(key, temporary)
            record['certificate_sha256'] = hashlib.sha256(ssl.PEM_cert_to_DER_cert(temporary.read_text())).hexdigest()
            record['expires_at'] = expiry(temporary).strftime('%Y-%m-%dT%H:%M:%SZ')
            _replace_owned_record_locked(lock, expected_record, record)
            os.chmod(temporary, stat.S_IMODE(certificate.stat().st_mode))
            os.replace(temporary, certificate)
        metadata = {'alias': ALIAS, 'cert_sha256': hashlib.sha256(certificate.read_bytes()).hexdigest(),
                    'expires_at': expiry(certificate).isoformat()}
        lock.validate()
        atomic_json(folder / 'identity.json', metadata, 0, 0, 0o600)
        lock.validate()
        print(json.dumps({'action': 'renewed' if remaining < dt.timedelta(days=2) else 'current',
                          'alias': ALIAS, 'expires_at': metadata['expires_at'], 'other_identities_changed': False}))
    return 0


def main() -> int:
    if os.geteuid() != 0:
        raise ValueError('identity maintenance requires the host owner')
    lock_path = pathlib.Path('/var/lib/praxis-supervision/pass.lock')
    with lock_path.open('a+') as pass_lock:
        try:
            fcntl.flock(pass_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'action': 'busy', 'changed': False}))
            return 0
        return maintain_identity()


if __name__ == '__main__':
    raise SystemExit(main())
