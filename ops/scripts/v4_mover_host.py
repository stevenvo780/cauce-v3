"""Bounded data-plane effects for the migration command, sent through SSH without installing a release."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import zipfile

BOOTSTRAP = '''import base64,io,json,pathlib,sys,tempfile,zipfile
request=json.loads(sys.stdin.buffer.readline())
with tempfile.TemporaryDirectory(prefix='cauce-move-') as work:
 with zipfile.ZipFile(io.BytesIO(base64.b64decode(request.pop('bundle')))) as archive:
  archive.extractall(work)
 sys.path.insert(0,work)
 from v4_mover_host import dispatch
 dispatch(request)
'''


# A full copy of a large agent (Argos: 10 GB, 207 000 files) takes over an hour to unpack and hash on the destination.
TRANSFER_SECONDS = 4 * 3600

def filtered_stderr(raw):
    from v4_copia_migracion import fold_text, sensitive_bytes
    value = raw.decode('utf-8', 'replace')
    value = re.sub(r'-----BEGIN [A-Z0-9 ]+-----.*?(?:-----END [A-Z0-9 ]+-----|$)',
                   '[redacted]', value, flags=re.S)
    lines = []
    for line in value.splitlines():
        fields = r'''["']?[\w.-]*(?:password|passwd|passphrase|secret|token|credential|api[-_]?key|private[-_]?key|contrasena|clave)[\w.-]*["']?\s*[:=]'''
        if sensitive_bytes(line.encode()) or re.search(fields, fold_text(line)) \
                or re.search(r'\b(?:authorization|(?:set-)?cookie)\s*:|\bbearer(?:\s|[=:])', fold_text(line)):
            lines.append('[redacted sensitive diagnostic]')
            continue
        line = re.sub(r'([a-z]+://[^\s?#]+)[?#][^\s]+', r'\1[redacted]', line, flags=re.I)
        line = re.sub(r'[A-Za-z0-9_+/=-]{32,}', '[redacted]', line)
        lines.append(''.join(character for character in line if character == '\t' or ord(character) >= 32))
    return '\n'.join(lines)[-4096:]


class RemoteFailure(RuntimeError):
    def __init__(self, action, code, stderr):
        self.remote_error = {'action': action, 'exit_code': code, 'stderr': filtered_stderr(stderr)}
        detail = self.remote_error['stderr'].splitlines()
        super().__init__('remote ' + action + ' failed' + (': ' + detail[-1][:160] if detail else ''))


def checked(arguments, **kwargs):
    result = subprocess.run(arguments, check=False, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RemoteFailure('host effect ' + arguments[0], result.returncode, result.stderr)
    return result.stdout


def docker(*arguments):
    return checked(['docker', *arguments], stdout=subprocess.PIPE)


def observed_host():
    return {'hostname': socket.gethostname(), 'dockerName': docker('info', '--format', '{{.Name}}').decode().strip(),
            'machineIdSha256': hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes().strip()).hexdigest()[:16]}


def volume(request, create=False):
    placement = request['placement']
    name = placement['container_name'] + '-state'
    labels = {'cauce.fleet.runtime_key': request['runtime_key'], 'cauce.fleet.tenant': request['tenant'],
              'cauce.fleet.alias': request['alias'], 'cauce.fleet.host': placement['host_id'],
              'cauce.fleet.owner': placement['systemd_user']}
    if request.get('require_new'):
        labels['cauce.migration.cut'] = request['migration_id']
    listed = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    if name not in listed:
        if not create:
            return None
        docker('volume', 'create', *[part for key, value in labels.items() for part in ('--label', key + '=' + value)], name)
    info = json.loads(docker('volume', 'inspect', name))[0]
    if any((info.get('Labels') or {}).get(key) != value for key, value in labels.items()):
        raise ValueError('destination volume belongs to another identity')
    return name


def idle_destination(request):
    name = request['placement']['container_name']
    existing = docker('ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^/' + name + '$').decode().splitlines()
    if name in existing:
        raise ValueError('destination runtime already exists; retain it and investigate before a fresh cut')
    image = json.loads(docker('image', 'inspect', request['image']))[0]
    if image['Id'] != request['image']:
        raise ValueError('destination image differs from its pin')
    volume(request)
    if request.get('require_new') and volume(request) is not None:
        raise ValueError('legacy migration requires a new destination volume')


def unpack(request, work):
    from v4_copia_integral import main
    archive = pathlib.Path(work) / 'copy.tar'
    with archive.open('xb') as writer:
        os.chmod(archive, 0o600)
        shutil.copyfileobj(sys.stdin.buffer, writer)
    arguments = ['unpack', '--archivo', str(archive), '--destino', request['directory'],
                 '--alias', request['alias'], '--empresa', request['tenant']]
    for item in request['roots']:
        arguments += ['--mapa', item['name'] + '=' + item['target']]
    from v4_copia_integral import descend, directory
    parent = pathlib.Path(request['directory']).parent
    descriptor = directory(str(parent.parent))
    try:
        os.close(descend(descriptor, parent.name, create=True))
    finally:
        os.close(descriptor)
    # The copier's CLI stays the single validator for archives and restoration receipts.
    previous = sys.argv
    sys.argv = ['v4_copia_integral.py', *arguments]
    try:
        result = main()
        if result:
            raise ValueError('restore did not verify')
    finally:
        sys.argv = previous
    if 'owner' in request:
        uid, gid = request['owner']
        root = pathlib.Path(request['directory']).parent
        for directory, children, files in os.walk(root, followlinks=False):
            os.chown(directory, uid, gid, follow_symlinks=False)
            for name in children + files:
                os.chown(os.path.join(directory, name), uid, gid, follow_symlinks=False)


def restore_container(request):
    idle_destination(request)
    name = volume(request, create=True)
    user = request['placement']['runtime_user']
    owner = [int(docker('run', '--rm', '--network', 'none', '--entrypoint', '/usr/bin/id', request['image'], flag, user))
             for flag in ('-u', '-g')]
    inner = {**request, 'action': 'unpack', 'owner': owner, 'bundle': bundle(),
             'directory': '/restore/' + request['runtime_key'] + '/space'}
    # A full copy runs to many GB: spool it on disk, never in a /tmp tmpfs with a per-user quota or in RAM.
    with tempfile.TemporaryFile(dir=str(pathlib.Path.home())) as incoming:
        incoming.write((json.dumps(inner) + '\n').encode())
        shutil.copyfileobj(sys.stdin.buffer, incoming)
        incoming.seek(0)
        checked(['docker', 'run', '--rm', '-i', '--user', '0:0', '--network', 'none', '--read-only',
            '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777',
            '--mount', 'type=volume,source=' + name + ',destination=/restore', '--env', 'TMPDIR=/restore',
            '--entrypoint', request.get('python', '/usr/bin/python3'), request['image'], '-I', '-B', '-c', BOOTSTRAP],
            stdin=incoming, stdout=sys.stdout.buffer, timeout=TRANSFER_SECONDS)


def excluded_roots(request, scope, roots):
    from v4_alcance_copia import under
    exclusions = request.get('excluded_roots', [])
    if not isinstance(exclusions, list):
        raise ValueError('excluded_roots must be a list of paths with reasons')
    known = set(scope['allowed']) | set(scope['mounted'])
    seen = set()
    for item in exclusions:
        if not isinstance(item, dict) or set(item) != {'path', 'reason'}:
            raise ValueError('each excluded root requires only path and reason')
        path, reason = item['path'], item['reason']
        if not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or '\x00' in path \
                or os.path.normpath(path) != path or os.path.realpath(path) != path:
            raise ValueError('an excluded root must be an absolute canonical path')
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError('an excluded root requires a nonempty reason')
        if path not in known or path in seen:
            raise ValueError('an excluded root must identify a distinct alias data root or mount')
        if any(under(path, root) or under(root, path) for root in roots.values()):
            raise ValueError('an excluded root overlaps a copy source')
        seen.add(path)
    return exclusions


def dispatch(request):
    action = request['action']
    with tempfile.TemporaryDirectory(prefix='cauce-move-data-') as work:
        if action == 'identity':
            print(json.dumps(observed_host()))
        elif action == 'measure':
            from v4_medicion_migracion import measure
            print(json.dumps(measure(request['label'], request['scope'], request['route'])))
        elif action.startswith('legacy-'):
            from v4_mover_legado import legacy_unit
            print(json.dumps(legacy_unit(request, action.removeprefix('legacy-'))))
        elif action == 'cleanup-destination':
            from v4_mover_legado import cleanup_destination
            print(json.dumps(cleanup_destination(request)))
        elif action in {'inventory-destination', 'clean-idle-destination'}:
            from v4_mover_destino import clean_destination, destination_inventory
            print(json.dumps(destination_inventory(request) if action == 'inventory-destination' else clean_destination(request)))
        elif action == 'terminal-probe':
            from v4_mover_legado import terminal_probe
            print(json.dumps(terminal_probe(request)))
        elif action == 'repair-migration-shape':
            from v4_mover_recursos import repair_shape
            print(json.dumps(repair_shape(request)))
        elif action == 'clone-repositories':
            from v4_mover_repos import clone_repositories
            print(json.dumps(clone_repositories(request)))
        elif action == 'preflight-source':
            from v4_alcance_copia import check_sources, host_containers, tenant_scope, under
            containers = host_containers()
            scope = tenant_scope(request['config'], request['alias'], request['tenant'], containers)
            scope['mounted'] = sorted({mount[0] for mount in containers[scope['container']]})
            placement = request['original']['placement']
            if (placement.get('mode') == 'container' or request.get('legacy')) and placement.get('container_name') != scope['container']:
                raise ValueError('copy scope differs from the current original runtime')
            roots = {item['name']: item['path'] for item in request['roots']}
            check_sources(roots, scope)
            exclusions = excluded_roots(request, scope, roots)
            required = []
            for path in scope['allowed']:
                if any(under(path, item['path']) for item in exclusions):
                    continue
                if pathlib.Path(path).is_dir():
                    required.append(path)
            if any(not any(under(path, root) for root in roots.values()) for path in required):
                raise ValueError('copy plan omits a complete alias data root')
            print(json.dumps({'verified': True, 'required_roots': sorted(required), 'roots': roots,
                              'excluded_roots': exclusions, 'shared_readers': scope.get('sharedReaders', [])}))
        elif action == 'preflight':
            if request['placement']['mode'] == 'container':
                idle_destination(request)
            else:
                destination = pathlib.Path(request['directory'])
                if destination.exists() and any(destination.iterdir()):
                    raise ValueError('destination space is not empty')
            print(json.dumps({'verified': True, 'host': observed_host()}))
        elif action == 'pack':
            from v4_copia_integral import main
            if request.get('legacy'):
                from v4_mover_legado import legacy_unit
                legacy_unit(request, 'stopped')
            config = pathlib.Path(work) / 'aliases.json'
            config.write_text(json.dumps(request['config']))
            archive = pathlib.Path(work) / 'copy.tar'
            args = ['pack', '--config', str(config), '--alias', request['alias'], '--empresa', request['tenant'],
                    '--destino', str(archive)]
            for item in request['roots']:
                args += ['--origen', item['name'] + '=' + item['path']]
            previous, sys.argv = sys.argv, ['v4_copia_integral.py', *args]
            try:
                import contextlib
                with contextlib.redirect_stdout(io.StringIO()):
                    if main():
                        raise ValueError('copy did not verify')
            finally:
                sys.argv = previous
            if request.get('legacy'):
                legacy_unit(request, 'stopped')
            with archive.open('rb') as reader:
                shutil.copyfileobj(reader, sys.stdout.buffer)
        elif action == 'restore':
            if request['placement']['mode'] == 'container':
                restore_container(request)
            else:
                unpack(request, work)
        elif action == 'unpack':
            unpack(request, work)
        else:
            raise ValueError('unknown host action')


def bundle():
    output = io.BytesIO()
    root = pathlib.Path(__file__).parent
    names = ['v4_mover_host.py', 'v4_mover_legado.py', 'v4_mover_repos.py', 'v4_mover_destino.py', 'v4_mover_recursos.py', 'v4_copia_integral.py', 'v4_copia_migracion.py',
             'v4_git_migracion.py', 'v4_alcance_copia.py', 'v4_medicion_migracion.py']
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            archive.writestr(name, (root / name).read_bytes())
    return base64.b64encode(output.getvalue()).decode()


class Remote:
    def __init__(self, route, *, sudo=False):
        if type(sudo) is not bool or sudo and route == 'local':
            raise ValueError('sudo requires an explicit SSH route')
        self.route, self.sudo = route, sudo

    def call(self, action, payload, source=None, destination=None):
        import shlex
        command = ['python3', '-I', '-B', '-c', BOOTSTRAP]
        if self.sudo:
            command = ['sudo', '-n', '--', *command]
        if self.route != 'local':
            command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
                       '-o', 'ServerAliveCountMax=3', self.route.removeprefix('ssh:'), shlex.join(command)]
        request = {**payload, 'action': action, 'bundle': bundle()}
        # A full copy runs to many GB: spool it on disk, never in a /tmp tmpfs with a per-user quota or in RAM.
        with tempfile.TemporaryFile(dir=str(pathlib.Path.home())) as incoming:
            incoming.write((json.dumps(request) + '\n').encode())
            if source:
                with open(source, 'rb') as reader:
                    shutil.copyfileobj(reader, incoming)
            incoming.seek(0)
            result = subprocess.run(command, stdin=incoming, stdout=destination or subprocess.PIPE,
                                    stderr=subprocess.PIPE, check=False, timeout=TRANSFER_SECONDS)
            if result.returncode:
                raise RemoteFailure(action, result.returncode, result.stderr)
            return json.loads(result.stdout) if result.stdout else None
