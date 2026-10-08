from __future__ import annotations

import ctypes
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import secrets
import ssl
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from fleet_executor_identity import principal_for
from update_alias_lib import SafeArgumentParser, assert_secure_directory, open_absolute_directory, open_regular_at


def checked_file(path: pathlib.Path, private: bool = False) -> bytes:
    parent = open_absolute_directory(path.parent, 'credential parent')
    try:
        descriptor = open_regular_at(parent, path.name, os.O_RDONLY)
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.geteuid() or details.st_mode & (0o077 if private else 0o022):
                raise ValueError('unsafe credential ownership or mode')
            chunks = []
            while chunk := os.read(descriptor, 65536):
                chunks.append(chunk)
                if sum(map(len, chunks)) > 1024 * 1024:
                    raise ValueError('credential exceeds its limit')
            return b''.join(chunks)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def openssl(*arguments: str, input_data: bytes | None = None) -> bytes:
    result = subprocess.run(['/usr/bin/openssl', *arguments], input=input_data, capture_output=True, check=False, timeout=30)
    if result.returncode:
        raise ValueError('certificate validation or issuance failed')
    return result.stdout


def expiry(path: pathlib.Path) -> datetime.datetime:
    result = openssl('x509', '-in', str(path), '-noout', '-enddate').decode().strip()
    return datetime.datetime.strptime(result, 'notAfter=%b %d %H:%M:%S %Y GMT').replace(tzinfo=datetime.timezone.utc)


def pair_proof(directory: pathlib.Path, key: str, ca_cert: pathlib.Path) -> dict:
    certificate, private = directory / f'agent-{key}.crt', directory / f'agent-{key}.key'
    pem = checked_file(certificate)
    checked_file(private, True)
    openssl('verify', '-purpose', 'sslclient', '-CAfile', str(ca_cert), str(certificate))
    openssl('x509', '-in', str(certificate), '-noout', '-checkend', '86400')
    subject = openssl('x509', '-in', str(certificate), '-noout', '-subject', '-nameopt', 'RFC2253').strip()
    if subject != f'subject=CN=agent-{key}'.encode():
        raise ValueError('certificate physical subject differs')
    san = openssl('x509', '-in', str(certificate), '-noout', '-ext', 'subjectAltName')
    if san.splitlines()[-1].strip() != f'URI:urn:cauce:runtime:{key}'.encode():
        raise ValueError('certificate physical SAN differs')
    if openssl('x509', '-in', str(certificate), '-pubkey', '-noout') != openssl('pkey', '-in', str(private), '-pubout'):
        raise ValueError('certificate and private key differ')
    return {'certificate_fingerprint': hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))).hexdigest(),
            'expires_at': min(expiry(certificate), expiry(ca_cert)).strftime('%Y-%m-%dT%H:%M:%SZ')}


def provision(key: str, output: pathlib.Path, ca_cert: pathlib.Path, ca_key: pathlib.Path,
              snapshot: pathlib.Path, manifest: pathlib.Path, *, bootstrap: bool = True) -> dict:
    import yaml
    principal = principal_for(snapshot, key, bootstrap)
    document = yaml.safe_load(checked_file(manifest))
    if not isinstance(document, dict) or document.get('metadata', {}).get('name') != key:
        raise ValueError('bootstrap manifest physical identity differs')
    spec = document.get('spec', {})
    if (bootstrap and (spec.get('bootstrap') is not True or spec.get('admission') is not False)) \
            or (not bootstrap and ('bootstrap' in spec or 'admission' in spec)) \
            or spec.get('tenant') != principal['tenant_id'] or spec.get('alias') != principal['alias']:
        raise ValueError('bootstrap manifest wire identity differs')
    checked_file(ca_cert)
    parent = open_absolute_directory(output, 'certificate root')
    lock = None
    try:
        assert_secure_directory(parent, 'certificate root')
        lock = open_regular_at(parent, f'.{key}.pair.lock', os.O_RDWR | os.O_CREAT, mode=0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        destination = output / key
        if destination.exists() or destination.is_symlink():
            control = open_absolute_directory(destination, 'certificate pair')
            try:
                assert_secure_directory(control, 'certificate pair')
            finally:
                os.close(control)
            return pair_proof(destination, key, ca_cert)
        checked_file(ca_key, True)
        text = openssl('x509', '-in', str(ca_cert), '-noout', '-text')
        if b'CA:TRUE' not in text or openssl('x509', '-in', str(ca_cert), '-pubkey', '-noout') != openssl('pkey', '-in', str(ca_key), '-pubout'):
            raise ValueError('signer certificate/key is not the approved CA')
        days = min(730, (expiry(ca_cert) - datetime.datetime.now(datetime.timezone.utc)).days)
        if days < 2:
            raise ValueError('signer validity is too short')
        with tempfile.TemporaryDirectory(prefix=f'.{key}.pair-', dir=output) as temporary:
            work = pathlib.Path(temporary)
            pair = work / 'pair'
            pair.mkdir(mode=0o700)
            private, certificate = pair / f'agent-{key}.key', pair / f'agent-{key}.crt'
            csr = work / 'client.csr'
            openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', str(private))
            private.chmod(0o400)
            openssl('req', '-new', '-sha256', '-key', str(private), '-subj', f'/CN=agent-{key}', '-out', str(csr))
            extension = ('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
                         f'extendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:cauce:runtime:{key}\n')
            openssl('x509', '-req', '-sha256', '-in', str(csr), '-CA', str(ca_cert), '-CAkey', str(ca_key),
                    '-set_serial', '0x' + secrets.token_hex(16), '-days', str(days), '-extfile', '/dev/stdin',
                    '-out', str(certificate), input_data=extension.encode())
            certificate.chmod(0o444)
            proof = pair_proof(pair, key, ca_cert)
            for path in (private, certificate):
                with path.open('rb') as stream:
                    os.fsync(stream.fileno())
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.renameat2(-100, os.fsencode(pair), -100, os.fsencode(destination), 1):
                raise ValueError('certificate pair exclusive publication failed')
            os.fsync(parent)
            return proof
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)


def main() -> int:
    parser = SafeArgumentParser()
    parser.add_argument('--alias', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--snapshot', type=pathlib.Path, required=True)
    parser.add_argument('--manifest', type=pathlib.Path, required=True)
    args = parser.parse_args()
    proof = provision(args.alias, args.output, pathlib.Path(os.environ['CAUCE_CLIENT_CA_CERT']),
                      pathlib.Path(os.environ['CAUCE_CLIENT_CA_KEY']), args.snapshot, args.manifest)
    print(json.dumps(proof))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('bootstrap certificate preparation failed', file=sys.stderr)
        raise SystemExit(2) from None
