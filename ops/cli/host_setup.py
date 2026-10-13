from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

from host_channel_client import (
    HostChannel,
    HostFailure,
    NoRedirect,
    openssl,
    private_directory,
    private_file,
    save_private,
    stable_json,
)

UNIT_PREFIX = 'cauce-v3-host-executor-'
SAFE_ID = re.compile(r'[A-Za-z0-9_.-]{1,128}')
MAX_ARTIFACT = 512 * 1024 * 1024
MAX_IMAGE = 16 * 1024 * 1024 * 1024
DOCKER = '/usr/bin/docker'
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
DOWNLOAD_RETRY_SECONDS = (2, 5, 10, 20)
DOCKER_LOAD_SECONDS = 3600
MAX_PACKAGE_AGE_MS = 3600 * 1000
NAME = re.compile(r'[a-z][a-z0-9_-]{0,63}')
HEX = re.compile(r'[a-f0-9]{64}')
UNIT_TEMPLATE = '''[Unit]
Description=Cauce V3 executor de flota de este ordenador (@HOST_ID@)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=CAUCE_FLEET_PROJECT_ROOT=@RELEASE@
Environment=CAUCE_FLEET_HOST=@HOST_ID@
Environment=CAUCE_FLEET_WORKER_ID=host-@HOST_ID@
Environment=CAUCE_FLEET_IDENTITY_DIRECTORY=@IDENTITY@
Environment=CAUCE_FLEET_PYTHON=@PYTHON@
Environment=CAUCE_FLEET_EXECUTABLE=@RELEASE@/ops/cli/fleet-executor.py
Environment=CAUCE_FLEET_POLICY_FILE=@POLICY@
ExecStart=@NODE@ @RELEASE@/services/gateway/dist/fleet/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=default.target
'''
REQUIRED_IN_RELEASE = ('ops/cli/fleet-executor.py', 'services/gateway/dist/fleet/main.js')
PLACEHOLDER = re.compile(r'@(release|install|identity|user)@')
SIGNER_PIN = 'setup-signer.json'


def default_runner(command: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, timeout=timeout, check=False)


runner = default_runner


def verify_signature(package: dict, signature: str, signer: str) -> None:
    try:
        key, proof = base64.b64decode(signer, validate=True), base64.b64decode(signature, validate=True)
    except ValueError:
        raise HostFailure('setup package signature is malformed') from None
    if len(key) != 44 or not key.startswith(bytes.fromhex('302a300506032b6570032100')) or len(proof) != 64:
        raise HostFailure('setup package must be signed with Ed25519')
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        (root / 'key.der').write_bytes(key)
        (root / 'message').write_bytes(stable_json(package))
        (root / 'proof').write_bytes(proof)
        try:
            openssl(['pkeyutl', '-verify', '-rawin', '-pubin', '-keyform', 'DER', '-inkey', str(root / 'key.der'),
                '-in', str(root / 'message'), '-sigfile', str(root / 'proof')])
        except HostFailure:
            raise HostFailure('setup package signature is invalid; nothing was installed') from None


def anchor_signer(identity_directory: pathlib.Path, fingerprint: str) -> None:
    if HEX.fullmatch(fingerprint) is None:
        raise HostFailure('setup signer fingerprint must be 64 lowercase hex characters')
    save_private(identity_directory / SIGNER_PIN, {'fingerprint': fingerprint})


def pin_signer(identity_directory: pathlib.Path, signer: str, write: bool, explicit: str | None = None) -> None:
    pin = identity_directory / SIGNER_PIN
    if explicit is not None:
        if HEX.fullmatch(explicit) is None:
            raise HostFailure('setup signer fingerprint must be 64 lowercase hex characters')
        anchored = explicit
    elif pin.exists() or pin.is_symlink():
        anchored = json.loads(private_file(pin)).get('fingerprint')
    else:
        raise HostFailure('no setup signer is anchored for this computer: enroll with a fresh console invitation or pass '
            '--signer-fingerprint as shown in the console. Nothing was installed')
    if hashlib.sha256(base64.b64decode(signer)).hexdigest() != anchored:
        raise HostFailure('setup package signer differs from the anchored one; nothing was installed')
    if explicit is not None and write:
        anchor_signer(identity_directory, explicit)


def fetch_package(channel: HostChannel) -> tuple[dict, str]:
    try:
        reply = channel.request('POST', '/v3/fleet/hosts/' + channel.identity['host_id'] + '/setup', {'action': 'package'})
    except HostFailure as error:
        if 'HTTP 404' in str(error):
            raise HostFailure('this gateway does not serve setup packages (HTTP 404); the platform administrator must configure host setup. '
                'Nothing was installed') from None
        raise
    package = reply.get('package')
    if not isinstance(package, dict) or not isinstance(reply.get('signature'), str) or not isinstance(reply.get('signer_public_key'), str):
        raise HostFailure('gateway did not return a signed setup package')
    verify_signature(package, reply['signature'], reply['signer_public_key'])
    identity = channel.identity
    now = time.time_ns() // 1000000
    if package.get('version') != 1 or package.get('company_id') != identity['company_id'] or package.get('host_id') != identity['host_id'] \
            or not isinstance(package.get('issued_at'), int) or not now - MAX_PACKAGE_AGE_MS <= package['issued_at'] <= now + 60000:
        raise HostFailure('setup package is stale or belongs to another computer')
    artifacts = package.get('artifacts')
    if not isinstance(artifacts, list) or sum(1 for item in artifacts if isinstance(item, dict) and item.get('kind') == 'release') != 1 \
            or not isinstance(package.get('policy'), dict):
        raise HostFailure('setup package must carry one release and a policy')
    names = set()
    for item in artifacts:
        image = isinstance(item, dict) and item.get('kind') == 'image'
        if not isinstance(item, dict) or set(item) != {'name', 'kind', 'sha256', 'size', *(('image_id',) if image else ())} \
                or not isinstance(item['name'], str) or NAME.fullmatch(item['name']) is None or item['name'] in names \
                or item['kind'] not in ('release', 'file', 'image') or HEX.fullmatch(str(item['sha256'])) is None \
                or not isinstance(item['size'], int) or not 0 < item['size'] <= (MAX_IMAGE if image else MAX_ARTIFACT) \
                or image and IMAGE_ID.fullmatch(str(item['image_id'])) is None:
            raise HostFailure('setup package artifact is invalid')
        names.add(item['name'])
    images = [item['image_id'] for item in artifacts if item['kind'] == 'image']
    if len(images) > 1:
        raise HostFailure('setup package must carry at most one agent image')
    for template in package['policy'].get('container_templates') or []:
        if images and (not isinstance(template, dict) or template.get('image') != images[0]):
            harness = template.get('harness_id') if isinstance(template, dict) else None
            raise HostFailure(f'la plantilla de contenedor {harness} no usa la imagen de agentes que trae el paquete ({images[0]}); '
                'no se instaló nada')
    return package, reply['signer_public_key']


class Interrupted(Exception):
    pass


def receive(channel: HostChannel, item: dict, stream, digest) -> None:
    """One signed request for the bytes of `item` past what `stream` holds; a cut connection raises Interrupted."""
    path = '/v3/fleet/hosts/' + channel.identity['host_id'] + '/setup/artifact'
    offset = stream.tell()
    packet = channel.packet('POST', path, {'action': 'artifact', 'name': item['name'], 'sha256': item['sha256'], 'offset': offset})
    request = urllib.request.Request(channel.gateway + path, data=stable_json(packet), method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/octet-stream'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=120) as response:
            if response.status != (206 if offset else 200) \
                    or offset and not str(response.headers.get('Content-Range', '')).startswith(f'bytes {offset}-'):
                raise HostFailure(f'el gateway respondió a la descarga de {item["name"]} desde otra posición; no se instaló nada')
            while chunk := response.read(1024 * 1024):
                if stream.tell() + len(chunk) > item['size']:
                    raise HostFailure(f'{item["name"]} supera el tamaño firmado en el paquete; no se instaló nada')
                digest.update(chunk)
                stream.write(chunk)
    except urllib.error.HTTPError as error:
        if error.code in (429, 503):
            raise Interrupted() from None
        reasons = {404: 'el gateway no sirve ese fichero: la plataforma no publicó el paquete de este despliegue',
            409: 'el paquete cambió durante la descarga porque hubo un despliegue nuevo; repite cauce hosts setup',
            403: 'revisa la hora del sistema y que el ordenador siga habilitado en la consola'}
        raise HostFailure(f'el gateway rechazó la descarga de {item["name"]} (HTTP {error.code}): '
            + reasons.get(error.code, 'repite cauce hosts setup') + '; no se instaló nada') from None
    except (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError):
        raise Interrupted() from None
    if stream.tell() < item['size']:
        raise Interrupted()


def download(channel: HostChannel, item: dict, destination: pathlib.Path) -> None:
    """Fetches a signed artifact over the host channel; after a cut connection it resumes where the bytes stopped."""
    digest = hashlib.sha256()
    with open(destination, 'wb') as stream:
        for delay in (*DOWNLOAD_RETRY_SECONDS, None):
            try:
                receive(channel, item, stream, digest)
                break
            except Interrupted:
                if delay is None:
                    raise HostFailure(f'no se pudo descargar {item["name"]} del gateway tras {len(DOWNLOAD_RETRY_SECONDS) + 1} intentos; '
                        'revisa la conexión y repite cauce hosts setup (es seguro)') from None
                time.sleep(delay)
        size = stream.tell()
    if size != item['size'] or digest.hexdigest() != item['sha256']:
        raise HostFailure(f'{item["name"]} no coincide con el SHA-256 firmado en el paquete; no se instaló nada')


def docker_image(image_id: str) -> str | None:
    """The Id this Docker reports for `image_id`, or None when it is not loaded."""
    if not os.access(DOCKER, os.X_OK):
        raise HostFailure(f'Docker no está en {DOCKER}: instala el paquete docker.io o docker-ce (no el snap) y repite')
    result = runner([DOCKER, 'image', 'inspect', '--format', '{{.Id}}', image_id], 60)
    if result.returncode == 0:
        return result.stdout.decode().strip()
    detail = result.stderr.decode('utf-8', 'replace').strip()
    if 'no such image' in detail.lower() or 'not found' in detail.lower():
        return None
    raise HostFailure(f'Docker no respondió al consultar la imagen de agentes ({detail[-200:] or "sin detalle"}); '
        'comprueba que este usuario está en el grupo docker')


def ensure_image(channel: HostChannel, item: dict, scratch: pathlib.Path) -> bool:
    """Loads the signed agent image unless Docker already has it; returns whether it loaded it now."""
    if docker_image(item['image_id']) == item['image_id']:
        return False
    archive = scratch / (item['name'] + '.tar.gz')
    download(channel, item, archive)
    try:
        result = runner([DOCKER, 'load', '--input', str(archive)], DOCKER_LOAD_SECONDS)
    except subprocess.TimeoutExpired:
        raise HostFailure(f'docker load no terminó en {DOCKER_LOAD_SECONDS // 60} minutos; repite cauce hosts setup') from None
    finally:
        archive.unlink(missing_ok=True)
    if result.returncode:
        detail = result.stderr.decode('utf-8', 'replace').strip()[-200:] or 'sin detalle'
        raise HostFailure(f'docker load rechazó la imagen de agentes ({detail}); revisa el espacio en disco. No se arrancó el servicio')
    loaded = docker_image(item['image_id'])
    if loaded != item['image_id']:
        raise HostFailure(f'la imagen cargada tiene el Id {loaded}, no el {item["image_id"]} que fija la plantilla: este Docker guarda '
            'las imágenes en otro almacén (containerd o clásico) que la plataforma. No se arrancó el servicio')
    return True


def extract_release(archive: pathlib.Path, target: pathlib.Path) -> None:
    staging = pathlib.Path(tempfile.mkdtemp(prefix='.release-', dir=target.parent))
    try:
        total = 0
        with tarfile.open(archive, 'r:*') as bundle:
            for member in bundle:
                relative = pathlib.PurePosixPath(member.name)
                # The adapter's node_modules links its packages; a link may only point at another entry of the release.
                landing = os.path.normpath(os.path.join(os.path.dirname(member.name), member.linkname))
                inside_link = member.issym() and not member.linkname.startswith('/') and landing != '..' and not landing.startswith('../')
                if relative.is_absolute() or '..' in relative.parts or not (member.isfile() or member.isdir() or inside_link):
                    raise HostFailure('release archive contains an unsafe entry')
                total += member.size
                if total > 4 * MAX_ARTIFACT:
                    raise HostFailure('release archive expands beyond its limit')
            bundle.extractall(staging, filter='data')
            # The data filter leaves directories at the umask default, and approved bundle digests cover directory modes.
            for member in bundle.getmembers():
                if member.isdir():
                    (staging / member.name).chmod(member.mode & 0o755 | 0o700)
        for required in REQUIRED_IN_RELEASE:
            if not (staging / required).is_file():
                raise HostFailure(f'release does not contain {required}')
        os.rename(staging, target)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def substitute(value, replacements: dict[str, str]):
    if isinstance(value, str):
        return PLACEHOLDER.sub(lambda match: replacements[match.group(1)], value)
    if isinstance(value, list):
        return [substitute(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, replacements) for key, item in value.items()}
    return value


def compose_policy(package: dict, host_id: str, install_root: pathlib.Path, release: pathlib.Path, identity: pathlib.Path) -> dict:
    user = pwd.getpwuid(os.geteuid()).pw_name
    roots = {name: str(install_root / 'roots' / name) for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
    base = {'schemaVersion': 1, 'host_id': host_id, 'executor_user': user, 'roots': roots,
        'native': [{'runtime_user': user, 'systemd_user': user, 'home_directory': str(pathlib.Path.home()), 'state_root': roots['runtime']}],
        'containers': {}, 'profiles': {}, 'hooks': {}, 'bundles': {}}
    supplied = substitute(package['policy'], {'release': str(release), 'install': str(install_root), 'identity': str(identity), 'user': user})
    forbidden = {'schemaVersion', 'host_id', 'executor_user', 'roots', 'signer'}
    if forbidden & set(supplied):
        raise HostFailure('setup policy cannot override local identity or roots')
    if 'native' in supplied and supplied['native'] != []:
        raise HostFailure('setup policy cannot add native runtimes')
    supplied.pop('native', None)
    return {**base, **supplied}


def verify_bundles(policy: dict, release: pathlib.Path) -> None:
    if not policy['bundles']:
        return
    sys.path.insert(0, str(release / 'ops/container-runtime'))
    try:
        from cauce_container_base import bundle_digest
        from harness_operations import HarnessOperationFailure, read_descriptor
        for harness, bundle in policy['bundles'].items():
            if not pathlib.Path(bundle['directory']).resolve().is_relative_to(release.resolve()) or bundle_digest(bundle['directory']) != bundle['digest']:
                raise HostFailure('approved bundle digest differs from the release; nothing was activated')
            if 'descriptor_sha256' in bundle:
                pin = bundle['descriptor_sha256']
                if not isinstance(pin, str) or not HEX.fullmatch(pin):
                    raise HostFailure(f'approved descriptor pin is invalid for {harness}; nothing was activated')
                try:
                    _descriptor, fingerprint = read_descriptor(bundle['directory'], harness)
                except HarnessOperationFailure:
                    raise HostFailure(f'approved descriptor differs for {harness}; nothing was activated') from None
                if fingerprint != pin:
                    raise HostFailure(f'approved descriptor differs for {harness}; nothing was activated')
    except (ImportError, KeyError, TypeError, OSError):
        raise HostFailure('approved bundle cannot be verified in the release') from None
    finally:
        sys.path.pop(0)


# Provider login of an enrolled computer. The console login of an agent runs on this computer through its host process,
# which serves it only with a private auth policy: the signed profile templates (with their login recipe), the login
# helper of the verified release pinned by digest, and a private state root. It carries no credential.
PROVIDER_AUTH_POLICY = 'provider-auth-policy.json'
PROVIDER_LOGIN_STATE = 'provider-login'
LOGIN_HELPER_FILES = ('ops/cli/provider-login.py', 'ops/cli/provider_login_state.py', 'ops/cli/provider_login_native.py',
    'ops/cli/provider_login_container.py', 'ops/cli/fleet_executor_view.py', 'ops/container-runtime/cauce_container_base.py',
    'ops/container-runtime/cauce_container_proc.py', 'ops/container-runtime/cauce_container_tree.py')


def provider_login_approved(policy: dict) -> bool:
    return any(isinstance(row, dict) and 'login' in row for row in policy.get('profile_templates', []))


def provider_auth_policy(policy: dict, release: pathlib.Path, install_root: pathlib.Path) -> dict | None:
    """The host process compares profiles and templates with the executor policy, so they are copied verbatim."""
    if not provider_login_approved(policy):
        return None
    pins = {}
    for relative in LOGIN_HELPER_FILES:
        filename = release / relative
        if filename.is_symlink() or not filename.is_file() or filename.stat().st_mode & 0o022:
            raise HostFailure(f'release does not contain a private provider login helper ({relative}); service not started')
        pins[str(filename)] = hashlib.sha256(filename.read_bytes()).hexdigest()
    helper = str(release / LOGIN_HELPER_FILES[0])
    auth = {'schemaVersion': 1, 'host_id': policy['host_id'], 'state_root': str(install_root / PROVIDER_LOGIN_STATE),
        'helper': {'executable': helper, 'sha256': pins[helper], 'files': pins}, 'profiles': policy['profiles'], 'logins': {}}
    if 'profile_templates' in policy:
        auth['profile_templates'] = policy['profile_templates']
    return auth


def install_provider_auth(policy: dict, release: pathlib.Path, install_root: pathlib.Path) -> tuple[pathlib.Path | None, bool]:
    """Writes (or removes) the auth policy; returns its path when the unit must name it, and whether it changed."""
    filename = install_root / PROVIDER_AUTH_POLICY
    auth = provider_auth_policy(policy, release, install_root)
    if auth is None:
        if filename.is_file():
            filename.unlink()
            return None, True
        return None, False
    private_directory(install_root / PROVIDER_LOGIN_STATE).chmod(0o700)
    return filename, write_if_changed(filename, json.dumps(auth, indent=2, sort_keys=True) + '\n', 0o600)


def with_provider_auth(unit: str, auth_file: pathlib.Path | None) -> str:
    if auth_file is None:
        return unit
    anchor = 'Environment=CAUCE_FLEET_POLICY_FILE='
    return ''.join(line + (f'Environment=CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE={auth_file}\n' if line.startswith(anchor) else '')
        for line in unit.splitlines(keepends=True))


def render_unit(host_id: str, install_root: pathlib.Path, release: pathlib.Path, identity: pathlib.Path, policy_file: pathlib.Path) -> str:
    node = shutil.which('node')
    if node is None:
        raise HostFailure('Node.js 22 or newer is required to run the executor service')
    text = UNIT_TEMPLATE
    values = {'HOST_ID': host_id, 'INSTALL_ROOT': str(install_root), 'RELEASE': str(release), 'IDENTITY': str(identity),
        'PYTHON': shutil.which('python3') or sys.executable, 'POLICY': str(policy_file), 'NODE': node}
    return re.sub(r'@([A-Z_]+)@', lambda match: values[match.group(1)], text)


def write_if_changed(filename: pathlib.Path, content: str, mode: int) -> bool:
    if filename.is_file() and not filename.is_symlink() and filename.read_text() == content:
        return False
    filename.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.tmp-', dir=filename.parent)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(content)
    os.chmod(temporary, mode)
    os.replace(temporary, filename)
    return True


def capabilities_report(release: pathlib.Path, policy_file: pathlib.Path) -> dict:
    result = runner([shutil.which('python3') or sys.executable, str(release / 'ops/cli/fleet-executor.py'),
        '--policy', str(policy_file), '--capabilities'], 30)
    try:
        report = json.loads(result.stdout) if result.returncode == 0 else {}
    except ValueError:
        report = {}
    placements = report.get('placements') if isinstance(report, dict) else None
    templates = sum(len(item.get('runtimes', [])) for item in placements or [] if isinstance(item, dict))
    return {'available': bool(isinstance(report, dict) and report.get('available') is True), 'templates': templates,
        'reason': report.get('reason') if isinstance(report, dict) else 'executor_unreadable'}


def systemctl(*arguments: str) -> subprocess.CompletedProcess:
    return runner(['systemctl', '--user', *arguments])


def linger_enabled(user: str) -> bool:
    result = runner(['loginctl', 'show-user', user, '--property=Linger', '--value'])
    return result.returncode == 0 and result.stdout.strip() == b'yes'


def locate_identity(state_root: pathlib.Path, explicit: pathlib.Path | None) -> pathlib.Path:
    if explicit is not None:
        return explicit
    found = sorted(state_root.glob('*/*/identity.json'))
    if len(found) != 1:
        raise HostFailure('pass --identity-directory: expected exactly one enrolled identity under the state root')
    return found[0].parent


def paths_for(channel: HostChannel, install_base: pathlib.Path) -> dict:
    company, host = channel.identity['company_id'], channel.identity['host_id']
    if SAFE_ID.fullmatch(company) is None or SAFE_ID.fullmatch(host) is None:
        raise HostFailure('enrolled identity has ids that cannot name a service')
    root = install_base / company / host
    name = f'{UNIT_PREFIX}{company}-{host}.service'
    return {'install_root': root, 'policy': root / 'executor-policy.json', 'unit_name': name,
        'unit': pathlib.Path.home() / '.config/systemd/user' / name}


def reject_other_company(install_base: pathlib.Path, company: str, state_root: pathlib.Path | None = None) -> None:
    names = []
    if install_base.is_dir():
        names.extend(item.parent.parent.name for item in install_base.glob('*/*/executor-policy.json') if item.parent.parent.name != company)
    if state_root is not None and state_root.is_dir():
        names.extend(item.parent.parent.name for item in state_root.glob('*/*/identity.json') if item.parent.parent.name != company)
    others = sorted(set(names))
    if others:
        raise HostFailure(f'this system user already runs the executor of company {others[0]}; companies would share one UID and '
            'could read each other\'s host keys. Use one system user per company')


def setup(identity_directory: pathlib.Path, install_base: pathlib.Path, dry_run: bool, signer_fingerprint: str | None = None) -> dict:
    channel = HostChannel(identity_directory)
    paths = paths_for(channel, install_base)
    reject_other_company(install_base, channel.identity['company_id'], identity_directory.parent.parent)
    package, signer = fetch_package(channel)
    pin_signer(channel.directory, signer, not dry_run, signer_fingerprint)
    host_id, root = channel.identity['host_id'], paths['install_root']
    release_item = next(item for item in package['artifacts'] if item['kind'] == 'release')
    image_item = next((item for item in package['artifacts'] if item['kind'] == 'image'), None)
    release = root / 'release' / release_item['sha256']
    user = pwd.getpwuid(os.geteuid()).pw_name
    plan = {'host_id': host_id, 'dry_run': dry_run, 'release': str(release), 'release_installed': (release / '.verified').is_file(),
        'policy_file': str(paths['policy']), 'unit': str(paths['unit']), 'linger': linger_enabled(user),
        'artifacts': [item['name'] for item in package['artifacts']]}
    if image_item is not None:
        plan.update(image_id=image_item['image_id'], image_present=docker_image(image_item['image_id']) == image_item['image_id'])
    if dry_run:
        plan['actions'] = [step for step, needed in (
            ('download and extract release', not plan['release_installed']),
            ('download and load agent image ' + str(plan.get('image_id')), image_item is not None and not plan['image_present']),
            ('write executor policy', True), ('write provider auth policy', provider_login_approved(package['policy'])),
            ('install user unit ' + paths['unit_name'], True),
            ('enable linger for ' + user, not plan['linger']), ('enable and start the service', True)) if needed]
        return plan
    for directory in (install_base, install_base / channel.identity['company_id'], root):
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o700)
    for sub in ('release', 'roots'):
        private_directory(root / sub)
    for name in ('state', 'runtime', 'pki', 'tokens', 'identities'):
        private_directory(root / 'roots' / name)
    with tempfile.TemporaryDirectory(dir=private_directory(root)) as scratch:
        if not plan['release_installed']:
            archive = pathlib.Path(scratch) / 'release.tar'
            download(channel, release_item, archive)
            extract_release(archive, release)
            (release / '.verified').write_text(release_item['sha256'] + '\n')
        for item in package['artifacts']:
            if item['kind'] == 'file':
                target = root / 'files' / item['name']
                if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != item['sha256']:
                    private_directory(target.parent)
                    download(channel, item, pathlib.Path(scratch) / item['name'])
                    os.replace(pathlib.Path(scratch) / item['name'], target)
        if image_item is not None:
            plan['image_loaded'] = ensure_image(channel, image_item, pathlib.Path(scratch))
    policy = compose_policy(package, host_id, root, release, channel.directory)
    verify_bundles(policy, release)
    changed = write_if_changed(paths['policy'], json.dumps(policy, indent=2, sort_keys=True) + '\n', 0o600)
    report = capabilities_report(release, paths['policy'])
    if not report['available'] or report['templates'] == 0:
        raise HostFailure('executor policy was written but the executor rejects it (' + str(report['reason']) + '); service not started')
    auth_file, auth_changed = install_provider_auth(policy, release, root)
    changed |= auth_changed
    changed |= write_if_changed(paths['unit'], with_provider_auth(render_unit(host_id, root, release, channel.directory, paths['policy']),
        auth_file), 0o644)
    if not plan['linger']:
        runner(['loginctl', 'enable-linger', user])
        plan['linger'] = linger_enabled(user)
    if changed:
        systemctl('daemon-reload')
    if systemctl('enable', '--now', paths['unit_name']).returncode != 0:
        raise HostFailure('could not start the user service; check XDG_RUNTIME_DIR and `systemctl --user status ' + paths['unit_name'] + '`')
    if changed:
        systemctl('restart', paths['unit_name'])
    plan.update(release_installed=True, service_active=systemctl('is-active', paths['unit_name']).stdout.strip() == b'active',
        policy_changed=changed, templates=report['templates'], provider_auth=auth_file is not None)
    if not plan['linger']:
        plan['warning'] = f'enable linger so the service survives logout: sudo loginctl enable-linger {user}'
    return plan


def status(identity_directory: pathlib.Path, install_base: pathlib.Path) -> dict:
    channel = HostChannel(identity_directory)
    paths = paths_for(channel, install_base)
    user = pwd.getpwuid(os.geteuid()).pw_name
    result = {'company_id': channel.identity['company_id'], 'host_id': channel.identity['host_id'],
        'policy_installed': paths['policy'].is_file(), 'unit_installed': paths['unit'].is_file(),
        'service_active': systemctl('is-active', paths['unit_name']).stdout.strip() == b'active',
        'linger': linger_enabled(user), 'templates': 0, 'executor_ready': False}
    result['provider_auth'] = result['unit_installed'] and 'CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE=' in paths['unit'].read_text()
    if result['policy_installed']:
        releases = sorted((paths['install_root'] / 'release').glob('*/.verified'))
        mentioned = [item.parent for item in releases if str(item.parent) in paths['unit'].read_text()] if result['unit_installed'] else []
        if mentioned:
            report = capabilities_report(mentioned[0], paths['policy'])
            result['templates'] = report['templates']
            result['executor_ready'] = report['available'] and report['templates'] > 0 and result['service_active']
            result['reason'] = None if result['executor_ready'] else report['reason'] or 'service_inactive'
    result.setdefault('reason', 'setup_required')
    return result
