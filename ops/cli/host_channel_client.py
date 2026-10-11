from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class HostFailure(Exception):
    pass


def stable_json(value: object) -> bytes:
    def requires_javascript(item: object) -> bool:
        if isinstance(item, float):
            return True
        if isinstance(item, int) and abs(item) > 9007199254740991:
            raise HostFailure('host integer exceeds the interoperable safe range')
        if isinstance(item, dict):
            flags = [requires_javascript(child) for child in item.values()]
            return any(flags) or any(any(ord(char) > 65535 for char in key) for key in item)
        if isinstance(item, list):
            flags = [requires_javascript(child) for child in item]
            return any(flags)
        return False

    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    if not requires_javascript(value):
        return encoded
    canonical = """import {readFileSync} from 'node:fs';
function stable(v){if(v===null||typeof v!=='object')return JSON.stringify(v);
if(Array.isArray(v))return '['+v.map(stable).join(',')+']';
return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';}
process.stdout.write(stable(JSON.parse(readFileSync(0,'utf8'))));"""
    result = subprocess.run(['node', '--input-type=module', '--eval', canonical], input=encoded,
        capture_output=True, timeout=15, check=False)
    if result.returncode:
        raise HostFailure('JavaScript number canonicalization is unavailable')
    return result.stdout


def private_directory(directory: pathlib.Path) -> pathlib.Path:
    directory = directory.absolute()
    if any(part.is_symlink() for part in (directory, *directory.parents)):
        raise HostFailure('host identity directory cannot contain symlinks')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise HostFailure('host identity directory must belong to the current user with mode 0700')
    return directory


def private_file(filename: pathlib.Path) -> bytes:
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise HostFailure('host identity file must belong to the current user with mode 0600')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            result = stream.read(16385)
        if len(result) > 16384:
            raise HostFailure('host identity file exceeds its limit')
        return result
    finally:
        os.close(descriptor)


def save_private(filename: pathlib.Path, value: dict) -> None:
    directory = private_directory(filename.parent)
    descriptor, temporary = tempfile.mkstemp(prefix='.identity-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(stable_json(value) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, filename)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def openssl(arguments: list[str]) -> bytes:
    result = subprocess.run(['openssl', *arguments], capture_output=True, timeout=15, check=False)
    if result.returncode:
        raise HostFailure('local Ed25519 identity operation failed')
    return result.stdout


def public_key(directory: pathlib.Path) -> bytes:
    private_file(directory / 'private.pem')
    encoded = openssl(['pkey', '-in', str(directory / 'private.pem'), '-pubout', '-outform', 'DER'])
    if len(encoded) != 44 or not encoded.startswith(bytes.fromhex('302a300506032b6570032100')):
        raise HostFailure('host identity must use Ed25519')
    return encoded


def ensure_key(directory: pathlib.Path) -> bytes:
    directory = private_directory(directory)
    filename = directory / 'private.pem'
    if not filename.exists() and not filename.is_symlink():
        descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(openssl(['genpkey', '-algorithm', 'Ed25519']))
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            filename.unlink(missing_ok=True)
            raise
    return public_key(directory)


def sign(directory: pathlib.Path, message: bytes) -> str:
    public_key(directory)
    descriptor, temporary = tempfile.mkstemp(prefix='.challenge-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(message)
        signature = openssl(['pkeyutl', '-sign', '-rawin', '-inkey', str(directory / 'private.pem'), '-in', temporary])
        if len(signature) != 64:
            raise HostFailure('host signature has an invalid length')
        return base64.b64encode(signature).decode()
    finally:
        os.unlink(temporary)


def gateway_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise HostFailure('gateway must be an origin without credentials, query or path')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1', 'localhost')):
        raise HostFailure('gateway requires verified HTTPS; HTTP is restricted to loopback tests')
    if not parsed.hostname:
        raise HostFailure('gateway hostname is required')
    return value.rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _file, _code, _message, _headers, _url):
        raise HostFailure('host requests cannot follow redirects')


def post_json(gateway: str, path: str, payload: dict, method: str = 'POST') -> dict:
    if not path.startswith('/v3/fleet/hosts/') or any(char in path for char in ('?', '#', '\\')):
        raise HostFailure('host request path is not supported')
    request = urllib.request.Request(gateway_url(gateway) + path, data=stable_json(payload),
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'}, method=method)
    try:
        # Ignore ambient proxy settings so the invitation cannot be sent to another endpoint.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=30) as response:
            encoded = response.read(1048577)
        if len(encoded) > 1048576:
            raise HostFailure('host response exceeds its limit')
        value = json.loads(encoded)
        if not isinstance(value, dict):
            raise HostFailure('host response is invalid')
        return value
    except urllib.error.HTTPError as error:
        raise HostFailure(f'host request rejected (HTTP {error.code}); local identity retained') from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        raise HostFailure('host request unavailable; local identity retained for retry') from None


class HostChannel:
    def __init__(self, identity_directory: pathlib.Path):
        self.directory = private_directory(identity_directory)
        self.identity = json.loads(private_file(self.directory / 'identity.json'))
        if self.identity.get('state') != 'enrolled':
            raise HostFailure('host must finish enrollment before sending signed operations')
        for key in ('company_id', 'host_id'):
            if not isinstance(self.identity.get(key), str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', self.identity[key]) is None:
                raise HostFailure('host identity is invalid')
        self.gateway = gateway_url(self.identity['gateway'])
        if hashlib.sha256(public_key(self.directory)).hexdigest() != self.identity['key_fingerprint']:
            raise HostFailure('host key differs from its enrolled identity')

    def packet(self, method: str, path: str, payload: dict) -> dict:
        packet = {'company_id': self.identity['company_id'], 'host_id': self.identity['host_id'],
            'issued_at': time.time_ns() // 1000000, 'nonce': secrets.token_hex(32), 'payload': payload}
        packet['proof'] = sign(self.directory, stable_json({'version': 1, 'method': method, 'path': path, **packet}))
        return packet

    def request(self, method: str, path: str, payload: dict) -> dict:
        host_path = '/v3/fleet/hosts/' + self.identity['host_id'] + '/'
        if not path.startswith(host_path) or method != 'POST':
            raise HostFailure('signed channel requires this host and a supported POST operation')
        return post_json(self.gateway, path, self.packet(method, path, payload), method)
