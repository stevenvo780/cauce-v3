from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request
import uuid

from fleet_provider_identity import (
    nonce_roundtrip,
    profile_jwt_candidates,
    read_profile_json,
    select_account_identity,
    validate_provider_binding,
    validate_provider_selection,
)

ISSUER = 'https://auth.meta.com'
JWKS_URI = 'https://auth.meta.com/.well-known/oauth/openid/jwks/'
# OAuth client id measured from the shipped Muse login flow.
CLIENT_ID = '1031625952748946'
CLOCK_SKEW_SECONDS = 60
SHA256_DIGEST_INFO = bytes.fromhex('3031300d060960864801650304020105000420')

EFFORTS = frozenset({'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'})
VERSION = '1.4.10-R6427.1'
BRIDGE = '/usr/local/bin/muse-cauce'


def validate_definition(value: dict, provider: str) -> None:
    from fleet_policy_paths import path
    if provider != 'muse' or not isinstance(value, dict) or set(value) != {'bridge', 'bridge_sha256'} \
            or not isinstance(value['bridge_sha256'], str) or re.fullmatch(r'[a-f0-9]{64}', value['bridge_sha256']) is None:
        raise ValueError('Muse bridge has no exact approved definition')
    path(value['bridge'])


def environment(binding: dict, agent: dict) -> dict:
    root = validate_provider_binding(binding, agent, 'muse')
    validate_provider_selection(agent, 'muse', EFFORTS)
    validate_definition(binding.get('muse'), binding['provider'])
    # The container root is read-only: Muse's reviewer sandbox needs a writable temp root inside the profile.
    return {'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'), 'MUSE_NO_AUTO_UPDATE': '1',
            'CAUCE_MUSE_CLI_COMMAND': binding['command'], 'CAUCE_MUSE_CLI_SHA256': binding['command_sha256'],
            'TMPDIR': str(root / 'tmp')}


def validate_binding(binding: dict, agent: dict) -> None:
    environment(binding, agent)


def login_command(binding: dict) -> list[str]:
    return [binding['command'], 'login']


def execution_arguments(agent: dict, prompt_file: str) -> list[str]:
    from fleet_policy_paths import path
    validate_provider_selection(agent, 'muse', EFFORTS)
    return ['exec', '--json', '--provider', 'meta', '--prompt-file', str(path(prompt_file)),
            '--disable-web-tools', '--disable-reminders', '--no-foreign-personal-context', '--no-session-log',
            '--disable-write', '--disable-shell', '--max-model-steps', '1',
            *(['--model', agent['model_id']] if agent.get('model_id') is not None else []),
            *(['--reasoning-effort', agent['reasoning_effort']] if agent.get('reasoning_effort') is not None else [])]


def authentication_supported() -> bool:
    return True


def direct_login(binding: dict) -> bool:
    login = binding.get('login')
    command = login.get('command') if isinstance(login, dict) else None
    try:
        validate_definition(binding.get('muse'), binding.get('provider'))
    except (ValueError, TypeError):
        return False
    return binding.get('provider') == 'muse' and 'openclaw' not in binding and isinstance(login, dict) \
        and login.get('method') == 'device' and isinstance(command, list) \
        and command[1:] == ['login'] and command[0] == binding.get('command') \
        and login.get('sha256') == binding.get('command_sha256') \
        and binding['muse']['bridge'] == BRIDGE


def measured_definition(binding: dict) -> bool:
    import tempfile

    from fleet_provider_identity import command_output, provider_command
    try:
        if not direct_login(binding):
            return False
        with tempfile.TemporaryDirectory(prefix='cauce-muse-capability-') as directory:
            home, state, profile = (directory + suffix for suffix in ('/home', '/state', '/profile'))
            for folder in (home, state, profile):
                os.mkdir(folder, 0o700)
            packet = {'profile_binding': {**binding, 'path': profile}, 'agent': {
                'harness_id': 'muse', 'runtime_user': binding['runtime_user'], 'runtime_key': 'capability-probe',
                'state_directory': state, 'home_directory': home, 'model_id': None}}
            version = command_output([provider_command(packet), '--version'], packet, timeout=20).decode().strip()
            return VERSION in version
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, UnicodeError):
        return False


def measured_container_definition(binding: dict, placement: dict) -> bool:
    name = 'cauce-muse-probe-' + uuid.uuid4().hex
    try:
        if not direct_login(binding) or re.fullmatch(r'sha256:[a-f0-9]{64}', placement.get('image', '')) is None:
            return False
        if ':' in str(pathlib.Path(__file__).resolve().parent):
            return False
        program = ('import json,sys;sys.path.insert(0,"/cauce/executor");'
                   'from fleet_provider_muse import measured_definition;'
                   'sys.exit(0 if measured_definition(json.load(sys.stdin)) else 1)')
        result = subprocess.run(['/usr/bin/docker', 'run', '--rm', '--pull=never', '--name', name, '-i',
            '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--user', placement['runtime_user'],
            '--volume', f'{pathlib.Path(__file__).resolve().parent}:/cauce/executor:ro,z',
            '--entrypoint', placement['python'], placement['image'], '-I', '-B', '-c', program],
            input=json.dumps(binding).encode(), capture_output=True, timeout=40, check=False)
        return result.returncode == 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return False
    finally:
        try:
            subprocess.run(['/usr/bin/docker', 'rm', '-f', name], capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            pass


def reply_text(output: bytes):
    candidate = None
    deltas = []
    failed = False
    for line in output.splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        payload = event.get('payload') if isinstance(event, dict) else None
        if not isinstance(payload, dict):
            continue
        if payload.get('kind') == 'run_output_delta' and isinstance(payload.get('text'), str):
            deltas.append(payload['text'])
        if payload.get('kind') == 'run_terminal':
            if payload.get('terminal') == 'completed':
                candidate = payload['text'] if isinstance(payload.get('text'), str) and payload['text'] else ''.join(deltas)
                failed = False
            else:
                failed = True
    if candidate is None and deltas:
        candidate = ''.join(deltas)
    return None if failed else candidate


def fetch_jwks() -> dict:
    """Verified identity anchor: the provider signing keys, over TLS, fixed URI."""
    request = urllib.request.Request(JWKS_URI)
    opener = urllib.request.build_opener(type('NoRedirect', (urllib.request.HTTPRedirectHandler,),
                                               {'redirect_request': lambda self, *args, **kwargs: None}))
    with opener.open(request, timeout=10) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('JWKS response exceeds limit')
    value = json.loads(raw)
    if not isinstance(value, dict) or not isinstance(value.get('keys'), list):
        raise ValueError('JWKS response is not a key set')
    return value


def base64_segment(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def verify_id_token(token: str, jwks: dict) -> dict:
    """RS256 verification against the provider JWKS; returns claims or raises."""
    header_segment, payload_segment, signature_segment = token.split('.')
    header = json.loads(base64_segment(header_segment))
    if not isinstance(header, dict) or header.get('alg') != 'RS256':
        raise ValueError('id_token is not RS256')
    keys = [key for key in jwks['keys'] if isinstance(key, dict) and key.get('kty') == 'RSA']
    if header.get('kid') is not None:
        keys = [key for key in keys if key.get('kid') == header['kid']]
    if len(keys) != 1:
        raise ValueError('id_token signing key is not in the provider JWKS')
    modulus = int.from_bytes(base64_segment(keys[0]['n']), 'big')
    exponent = int.from_bytes(base64_segment(keys[0]['e']), 'big')
    signature = int.from_bytes(base64_segment(signature_segment), 'big')
    if signature >= modulus:
        raise ValueError('id_token signature is out of range')
    size = (modulus.bit_length() + 7) // 8
    encoded = pow(signature, exponent, modulus).to_bytes(size, 'big')
    digest = hashlib.sha256(f'{header_segment}.{payload_segment}'.encode()).digest()
    expected = b'\x00\x01' + b'\xff' * (size - len(SHA256_DIGEST_INFO) - len(digest) - 3) \
        + b'\x00' + SHA256_DIGEST_INFO + digest
    if not hmac.compare_digest(encoded, expected):
        raise ValueError('id_token signature does not verify')
    claims = json.loads(base64_segment(payload_segment))
    if not isinstance(claims, dict) or claims.get('iss') != ISSUER:
        raise ValueError('id_token issuer differs')
    audience = claims.get('aud')
    if isinstance(audience, list):
        if CLIENT_ID not in audience or claims.get('azp') != CLIENT_ID:
            raise ValueError('id_token audience differs')
    elif audience != CLIENT_ID:
        raise ValueError('id_token audience differs')
    now = time.time()
    if not isinstance(claims.get('exp'), (int, float)) or claims['exp'] <= now:
        raise ValueError('id_token is expired')
    for claim in ('nbf', 'iat'):
        if claim in claims and (not isinstance(claims[claim], (int, float))
                                or claims[claim] > now + CLOCK_SKEW_SECONDS):
            raise ValueError('id_token is not yet valid')
    if not isinstance(claims.get('sub'), str) or not claims['sub']:
        raise ValueError('id_token has no subject')
    return claims


def credential_email(config: str) -> str | None:
    """The account email Muse 1.4 stores next to its Meta access token (that format carries no id_token)."""
    document = read_profile_json(str(config) + '/muse/auth.json')
    providers = document.get('providers') if isinstance(document, dict) else None
    meta = providers.get('meta') if isinstance(providers, dict) else None
    if not isinstance(meta, dict) or not isinstance(meta.get('access_token'), str) or not meta['access_token']:
        return None
    email = meta.get('user_email')
    return email if isinstance(email, str) and re.fullmatch(r'[^@\s]{1,128}@[^@\s]{1,127}\.[^@\s]{1,63}', email) else None


def verified_identities(config: str) -> set:
    # Exactly one active credential may vouch for the identity: a signed id_token when the file has one,
    # otherwise the email of the stored Meta token. The caller only asks after the nonce round trip proved
    # that this same credential answers the model.
    tokens = list(dict.fromkeys(profile_jwt_candidates(str(config) + '/muse/auth.json')))
    if len(tokens) == 1:
        try:
            return {verify_id_token(tokens[0], fetch_jwks())['sub']}
        except Exception:
            pass
    email = credential_email(config)
    return {email} if email else set()


def authenticated_identity(packet: dict) -> str | None:
    try:
        env = environment(packet['profile_binding'], packet['agent'])
        config = env['XDG_CONFIG_HOME']
        os.makedirs(env['TMPDIR'], mode=0o700, exist_ok=True)
        if not nonce_roundtrip(packet, lambda prompt: execution_arguments(packet['agent'], prompt), reply_text):
            return None
        return select_account_identity(packet['identity'], verified_identities(config))
    except Exception:
        return None


def authenticated(packet: dict) -> bool:
    return authenticated_identity(packet) is not None


authenticated_muse = authenticated


def prepare_extensions(agent: dict, profile, state=None) -> dict:
    from fleet_provider_identity import prepare_extensions as prepare_shared
    if agent.get('harness_id') not in (None, 'muse'):
        raise ValueError('muse extension prepare refuses another harness')
    return prepare_shared({**agent, 'harness_id': 'muse'}, pathlib.Path(profile), None if state is None else pathlib.Path(state))
