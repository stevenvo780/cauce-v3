"""Move one PTY identity privately and fence its previous manager before activation."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import pwd
import re
import ssl
import stat
import subprocess
import sys
import tempfile

MATERIAL = {'client.crt': 0o600, 'client.key': 0o600, 'ca.crt': 0o600, 'alias-key.hex': 0o400}


def owned_file(path, mode=None):
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError('PTY path contains an unsafe directory')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > 65536 \
                or (stat.S_IMODE(info.st_mode) != mode if mode is not None else info.st_mode & 0o022):
            raise ValueError('PTY material has an unsafe owner, mode or size')
        return reader.read()


def config_values(path):
    values = {}
    for line in owned_file(path, 0o600).decode().splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in values:
            raise ValueError('PTY environment has duplicate or invalid entries')
        values[key] = value
    if not re.fullmatch(r'[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\]', values.get('RELAY_HOST', '')) \
            or not values.get('RELAY_PORT', '').isdigit() or not 1 <= int(values['RELAY_PORT']) <= 65535:
        raise ValueError('PTY relay endpoint is invalid')
    if 'RELAY_SERVER_NAME' in values and not re.fullmatch(r'[A-Za-z0-9.-]+', values['RELAY_SERVER_NAME']):
        raise ValueError('PTY relay server name is invalid')
    return values


def systemctl(*arguments):
    result = subprocess.run(['systemctl', '--user', *arguments], capture_output=True, text=True, timeout=120, check=False)
    if result.returncode and not ('--property=LoadState' in arguments and result.stdout.strip() == 'not-found'):
        raise RuntimeError('PTY systemctl ' + arguments[0] + ' failed')
    return result.stdout.strip()


def destination_runtime(request, pin=None, *, missing=False):
    from v4_mover_host import docker
    placement = request['placement']
    if placement['container_name'] not in docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines():
        if missing:
            return None
        raise ValueError('PTY destination runtime is missing')
    info = json.loads(docker('inspect', placement['container_name']))[0]
    labels = {'cauce.fleet.runtime_key': request['runtime_key'], 'cauce.fleet.tenant': request['tenant'],
              'cauce.fleet.alias': request['alias'], 'cauce.fleet.host': placement['host_id'],
              'cauce.fleet.owner': placement['systemd_user']}
    if any((info['Config'].get('Labels') or {}).get(key) != value for key, value in labels.items()) \
            or pin and info['Id'] != pin or request.get('image') and info['Image'] != request['image']:
        raise ValueError('PTY destination runtime belongs to another identity')
    return info


def verify_files(paths, hashes):
    if not isinstance(hashes, dict) or set(hashes) != set(paths):
        raise ValueError('PTY destination has no complete material pins')
    for name, (path, mode) in paths.items():
        if path.exists() or path.is_symlink():
            if hashlib.sha256(owned_file(path, mode)).hexdigest() != hashes[name]:
                raise ValueError('PTY destination material changed after installation')


def units(alias):
    result = {}
    for prefix in ('pty@', 'profile-expectation@'):
        name = 'cauce-v3-' + prefix + alias + '.service'
        loaded = systemctl('show', '--property=LoadState', '--value', name)
        if loaded == 'not-found':
            continue
        if loaded != 'loaded':
            raise ValueError('PTY source unit is not loaded')
        enabled = systemctl('show', '--property=UnitFileState', '--value', name)
        active = systemctl('show', '--property=ActiveState', '--value', name)
        if enabled not in ('enabled', 'enabled-runtime', 'disabled', 'static', '') or active not in ('active', 'inactive', 'failed'):
            raise ValueError('PTY source unit has an unsupported state')
        result[name] = {'enabled': enabled, 'active': active == 'active'}
    return result


def reap(request, entry, values, reaper):
    from v4_mover_host import docker
    if request.get('terminal_container_id'):
        info = destination_runtime(request, request['terminal_container_id'], missing=True)
        if info is None:
            return
    else:
        info = None
    names = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
    if entry['container'] not in names:
        if request['source'].get('container_id'):
            raise ValueError('PTY source runtime disappeared')
        return
    info = info or json.loads(docker('inspect', entry['container']))[0]
    pin = request['source'].get('container_id')
    if pin and info['Id'] != pin:
        raise ValueError('PTY source runtime differs from its pin')
    if info['State']['Running'] is not True:
        return
    identity = [docker('exec', info['Id'], 'id', flag, entry['user']).decode().strip() for flag in ('-u', '-g')]
    if any(not value.isdigit() or int(value) == 0 for value in identity):
        raise ValueError('PTY source runtime identity must be non-root')
    alias = request['alias']
    paths = ['/var/tmp/.cauce-pty-bundle-' + alias + '.json']
    runtime_dir = values.get('CONTAINER_RUNTIME_DIR')
    if runtime_dir:
        if not re.fullmatch(r'/[A-Za-z0-9._/-]+', runtime_dir) or '..' in pathlib.PurePosixPath(runtime_dir).parts:
            raise ValueError('PTY runtime directory is invalid')
        paths.append(runtime_dir.rstrip('/') + '/cauce-pty-' + alias + '/bundle.json')
    paths = list(dict.fromkeys([*paths, '/run/cauce-pty-' + alias + '/bundle.json']))
    for path in paths:
        result = subprocess.run(['docker', 'exec', '-i', '--user', ':'.join(identity), info['Id'], '/usr/bin/python3',
                                 '-', path, alias], input=reaper, capture_output=True, timeout=60, check=False)
        if result.returncode:
            raise RuntimeError('PTY source orphan cleanup was not verified')


def mapping(request, config):
    alias, placement = request['alias'], request['placement']
    entry = dict(config['aliases'][alias])
    entry.update(container=placement['container_name'], user=placement['runtime_user'], home=placement['home_directory'],
                 stateDirectory=placement['state_directory'], dockerHost=placement['host_id'],
                 systemdUser=placement['systemd_user'])
    if entry['harness'] in ('openclaw', 'muse'):
        entry['workspace'] = placement['state_directory'] + '/space/projects'
    else:
        entry.pop('workspace', None)
    return {**config, 'aliases': {**config['aliases'], alias: entry}}


def become_manager(user, code_root):
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', user):
        raise ValueError('PTY manager user is invalid')
    account = pwd.getpwnam(user)
    if not account.pw_uid:
        raise ValueError('PTY manager must be non-root')
    if account.pw_uid != os.geteuid():
        if os.geteuid() != 0:
            raise ValueError('PTY route does not reach its manager user')
        if code_root.parent != pathlib.Path(tempfile.gettempdir()) or not code_root.name.startswith('cauce-move-'):
            raise ValueError('PTY privilege drop requires the disposable transfer bundle')
        for path in [*code_root.rglob('*'), code_root]:
            os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
        os.initgroups(user, account.pw_gid)
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    os.environ.update(HOME=account.pw_dir, XDG_RUNTIME_DIR='/run/user/' + str(account.pw_uid),
                      DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/' + str(account.pw_uid) + '/bus')
    for name in ('XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'CAUCE_PTY_OPS_ROOT', 'CAUCE_PTY_CONFIG_ROOT', 'CAUCE_PTY_PKI_ROOT'):
        os.environ.pop(name, None)
    return pathlib.Path(account.pw_dir)


def terminal_action(request):
    action, alias = request['action'].removeprefix('terminal-'), request['alias']
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', alias):
        raise ValueError('PTY alias is invalid')
    source_action = action in ('preflight', 'export', 'stop', 'start')
    entry = request['config']['aliases'][alias]
    user = request['source'].get('systemd_user', entry.get('systemdUser', 'stev')) if source_action \
        else request['placement']['systemd_user']
    if source_action and user != entry.get('systemdUser', 'stev'):
        raise ValueError('PTY source manager differs from its inventory')
    root = pathlib.Path(__file__).parent
    sys.path.insert(0, str(root / 'pty-release' / 'pty-agent'))
    from rollout_pty_lib import ManagerWorker, ReleaseBundle, atomic_write, canonical_json, safe_directory
    release = None
    if action == 'install':
        release = ReleaseBundle.from_ops_root(root / 'pty-release')
        config = mapping(request, request['config'])
        files = {**release.files, 'container-aliases.json': canonical_json(config)}
        from rollout_pty_lib import SCHEMA_VERSION, sha256
        digests = {name: sha256(body) for name, body in sorted(files.items())}
        digest = sha256(canonical_json({'schemaVersion': SCHEMA_VERSION, 'files': digests}))
        release = ReleaseBundle(digest, digests['container-aliases.json'], files, digests, canonical_json({
            'schemaVersion': SCHEMA_VERSION, 'releaseSha': digest, 'mappingSha256': digests['container-aliases.json'], 'files': digests}))
    reaper = (root / 'pty-release/pty-agent/reap_orphan_agent.py').read_bytes()
    home = become_manager(user, root)
    config_root, pki = home / '.config/cauce-v3/pty', home / '.config/cauce-v3/pty-pki' / alias
    for path in (config_root, pki, home / '.config/systemd/user', home / '.local/share/cauce-v3/pty-releases'):
        for parent in (path, *path.parents):
            if parent.exists() or parent.is_symlink():
                info = parent.lstat()
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                    raise ValueError('PTY operational path contains an unsafe directory')
    env = config_root / (alias + '.env')
    marker = config_root / (alias + '.migration.json')
    worker = ManagerWorker(request.get('placement', {}).get('host_id', 'source'), home=home)
    if source_action:
        state = units(alias)
        present = env.exists()
        if any(name.startswith('cauce-v3-pty@') for name in state) and not present:
            raise ValueError('PTY source unit has no environment')
        values = config_values(env) if present else {}
        if present and (values.get('PKI_DIR') != str(pki) or values.get('ALIAS_KEY_FILE') != str(pki / 'alias-key.hex')):
            raise ValueError('PTY source material must use its canonical private paths')
        material = {name: owned_file(pki / name, mode) for name, mode in MATERIAL.items()} if present else {}
        if action == 'preflight':
            return {'verified': True, 'present': present, 'units': state}
        if action == 'export':
            if not present:
                raise ValueError('PTY source identity is missing')
            payload = {'relay': {key: values[key] for key in ('RELAY_HOST', 'RELAY_PORT', 'RELAY_SERVER_NAME') if key in values},
                       'material': {name: base64.b64encode(body).decode() for name, body in material.items()}}
            sys.stdout.buffer.write(canonical_json(payload))
            return None
        expected = request['terminal_source']['units']
        if set(state) != set(expected):
            raise ValueError('PTY source units changed after preflight')
        if action == 'stop':
            for name in reversed(state):
                systemctl('disable', *(['--runtime'] if state[name]['enabled'] == 'enabled-runtime' else []), '--now', name)
            if present:
                reap(request, entry, values, reaper)
            remaining = units(alias)
            if any(item['active'] or item['enabled'] in ('enabled', 'enabled-runtime') for item in remaining.values()):
                raise ValueError('PTY source is still enabled or active')
        elif action == 'start':
            for name, item in expected.items():
                if item['enabled'] in ('enabled', 'enabled-runtime'):
                    systemctl('enable', *(['--runtime'] if item['enabled'] == 'enabled-runtime' else []), name)
                systemctl('start' if item['active'] else 'stop', name)
        return {'verified': True, 'units': units(alias)}
    identity = {key: request[key] for key in ('tenant', 'alias', 'runtime_key', 'migration_id')}
    paths = {name: (pki / name, mode) for name, mode in MATERIAL.items()}
    paths.update(env=(env, 0o600), selector=(worker._selector_path(alias), 0o600))
    previous = None
    if marker.exists():
        previous = json.loads(owned_file(marker, 0o600))
        if any(previous.get(key) != value for key, value in identity.items()):
            raise ValueError('PTY destination belongs to another migration')
        verify_files(paths, previous.get('file_sha256'))
    elif env.exists() or pki.exists() or worker._selector_path(alias).exists():
        raise ValueError('PTY destination already has an unowned identity')
    if action == 'destination-preflight':
        return {'verified': True}
    if action == 'cleanup':
        if not marker.exists():
            return {'verified': True, 'absent': True}
        destination_runtime(request, previous.get('container_id'), missing=True)
        if systemctl('show', '--property=LoadState', '--value', worker._unit(alias)) != 'not-found':
            systemctl('disable', '--now', worker._unit(alias))
        reap({**request, 'source': {}, 'terminal_container_id': previous['container_id']},
             mapping(request, request['config'])['aliases'][alias], {'CONTAINER_RUNTIME_DIR': '/run'}, reaper)
        for name, mode in MATERIAL.items():
            path = pki / name
            if path.exists():
                owned_file(path, mode)
                path.unlink()
        if pki.exists():
            pki.rmdir()
        for path in (env, worker._selector_path(alias), marker):
            if path.exists():
                owned_file(path)
                path.unlink()
        systemctl('daemon-reload')
        return {'verified': True, 'absent': True}
    if action != 'install':
        raise ValueError('unknown PTY migration action')
    raw = sys.stdin.buffer.read(524289)
    if len(raw) > 524288:
        raise ValueError('PTY transfer exceeds its size bound')
    payload = json.loads(raw)
    if set(payload) != {'relay', 'material'} or set(payload['material']) != set(MATERIAL):
        raise ValueError('PTY transfer does not contain the exact identity')
    if not {'RELAY_HOST', 'RELAY_PORT'} <= payload['relay'].keys() \
            or set(payload['relay']) - {'RELAY_HOST', 'RELAY_PORT', 'RELAY_SERVER_NAME'} \
            or any(not isinstance(value, str) or '\n' in value or '\r' in value for value in payload['relay'].values()):
        raise ValueError('PTY transfer relay configuration is invalid')
    material = {name: base64.b64decode(value, validate=True) for name, value in payload['material'].items()}
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(material['client.crt'].decode())).hexdigest()
    values = {**payload['relay'], 'PKI_DIR': str(pki), 'ALIAS_KEY_FILE': str(pki / 'alias-key.hex'), 'CONTAINER_RUNTIME_DIR': '/run'}
    if not re.fullmatch(r'[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\]', values['RELAY_HOST']) \
            or not values['RELAY_PORT'].isdigit() or not 1 <= int(values['RELAY_PORT']) <= 65535 \
            or 'RELAY_SERVER_NAME' in values and not re.fullmatch(r'[A-Za-z0-9.-]+', values['RELAY_SERVER_NAME']):
        raise ValueError('PTY transfer relay endpoint is invalid')
    env_body = ''.join(key + '=' + value + '\n' for key, value in values.items()).encode()
    selector = worker._selector(release.release_sha, worker.release_path(release.release_sha))
    files = {**material, 'env': env_body, 'selector': selector}
    metadata = {**identity, 'schema_version': 1, 'client_cert_sha256': fingerprint,
                'container_id': destination_runtime(request)['Id'],
                'file_sha256': {name: hashlib.sha256(body).hexdigest() for name, body in files.items()}}
    if marker.exists() and json.loads(owned_file(marker, 0o600)) != metadata:
        raise ValueError('PTY destination certificate differs from the migration')
    safe_directory(config_root, create=True)
    atomic_write(marker, canonical_json(metadata), 0o600)
    safe_directory(pki, create=True)
    for name, body in material.items():
        atomic_write(pki / name, body, MATERIAL[name])
    atomic_write(env, env_body, 0o600)
    config_values(env)
    published = worker.publish(release)
    safe_directory(worker.unit_root, create=True)
    template = worker.unit_root / 'cauce-v3-pty@.service'
    if template.exists() and owned_file(template) != release.files['pty-agent/systemd/cauce-v3-pty@.service']:
        raise ValueError('PTY template differs from the approved release')
    atomic_write(template, release.files['pty-agent/systemd/cauce-v3-pty@.service'], 0o644)
    from rollout_pty_lib import Fleet
    fleet = Fleet.load(release.files['container-aliases.json'])
    applied = worker.apply(release.release_sha, alias, request['placement']['host_id'], fleet.entry_digest(alias), frozenset({'shell'}))
    return {'verified': True, 'release': published, 'pty': applied, 'client_cert_sha256': fingerprint}
