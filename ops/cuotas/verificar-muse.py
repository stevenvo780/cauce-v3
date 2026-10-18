#!/usr/bin/python3
# Verifies the Muse credential stored in this environment without printing it:
# the id_token must verify against the Meta JWKS and carry the Muse client.
import base64
import hashlib
import hmac
import json
import os
import pathlib
import time
import urllib.request

ISSUER = 'https://auth.meta.com'
JWKS_URI = 'https://auth.meta.com/.well-known/oauth/openid/jwks/'
CLIENT_ID = '1031625952748946'
SHA256_DIGEST_INFO = bytes.fromhex('3031300d060960864801650304020105000420')


def emit(value):
    print(json.dumps(value, separators=(',', ':')))
    raise SystemExit(0)


def fail(code):
    emit({'ok': False, 'error_code': code})


def credential_path():
    configured = os.environ.get('MUSE_AUTH_PATH')
    if configured:
        return pathlib.Path(configured)
    config = os.environ.get('XDG_CONFIG_HOME')
    if config:
        return pathlib.Path(config) / 'muse' / 'auth.json'
    return pathlib.Path.home() / '.config' / 'muse' / 'auth.json'


def candidates(filename):
    try:
        raw = filename.read_bytes()
    except OSError:
        return []
    if len(raw) > 262144:
        return []
    try:
        document = json.loads(raw)
    except ValueError:
        return []
    found = []
    pending = [document]
    seen = 0
    while pending and seen < 256:
        value = pending.pop()
        seen += 1
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str) and value.count('.') == 2:
            found.append(value)
    return list(dict.fromkeys(found))


def segment(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def fetch_jwks():
    request = urllib.request.Request(JWKS_URI)
    opener = urllib.request.build_opener(type('NoRedirect', (urllib.request.HTTPRedirectHandler,),
                                               {'redirect_request': lambda self, *args, **kwargs: None}))
    with opener.open(request, timeout=10) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('jwks too large')
    value = json.loads(raw)
    if not isinstance(value, dict) or not isinstance(value.get('keys'), list):
        raise ValueError('jwks shape')
    return value


def verify(token, jwks):
    header_segment, payload_segment, signature_segment = token.split('.')
    header = json.loads(segment(header_segment))
    if not isinstance(header, dict) or header.get('alg') != 'RS256':
        raise ValueError('alg')
    keys = [key for key in jwks['keys'] if isinstance(key, dict) and key.get('kty') == 'RSA']
    if header.get('kid') is not None:
        keys = [key for key in keys if key.get('kid') == header['kid']]
    if len(keys) != 1:
        raise ValueError('kid')
    modulus = int.from_bytes(segment(keys[0]['n']), 'big')
    exponent = int.from_bytes(segment(keys[0]['e']), 'big')
    signature = int.from_bytes(segment(signature_segment), 'big')
    if signature >= modulus:
        raise ValueError('signature range')
    size = (modulus.bit_length() + 7) // 8
    encoded = pow(signature, exponent, modulus).to_bytes(size, 'big')
    digest = hashlib.sha256(f'{header_segment}.{payload_segment}'.encode()).digest()
    expected = b'\x00\x01' + b'\xff' * (size - len(SHA256_DIGEST_INFO) - len(digest) - 3) \
        + b'\x00' + SHA256_DIGEST_INFO + digest
    if not hmac.compare_digest(encoded, expected):
        raise ValueError('signature')
    claims = json.loads(segment(payload_segment))
    if not isinstance(claims, dict) or claims.get('iss') != ISSUER:
        raise ValueError('issuer')
    audience = claims.get('aud')
    if isinstance(audience, list):
        if CLIENT_ID not in audience or claims.get('azp') != CLIENT_ID:
            raise ValueError('audience')
    elif audience != CLIENT_ID:
        raise ValueError('audience')
    now = time.time()
    if not isinstance(claims.get('exp'), (int, float)) or claims['exp'] <= now:
        raise ValueError('expired')
    for claim in ('nbf', 'iat'):
        if claim in claims and (not isinstance(claims[claim], (int, float)) or claims[claim] > now + 60):
            raise ValueError('not yet valid')
    if not isinstance(claims.get('sub'), str) or not claims['sub']:
        raise ValueError('subject')
    return claims['sub']


def main():
    tokens = candidates(credential_path())
    if len(tokens) != 1:
        fail('not_authenticated')
    try:
        subject = verify(tokens[0], fetch_jwks())
    except Exception:
        fail('not_authenticated')
    emit({'ok': True, 'account_id': subject})


if __name__ == '__main__':
    main()
