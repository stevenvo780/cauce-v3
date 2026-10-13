#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import difflib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import sys
import time

from fleet_controller_upgrade_lib import (
    Abort,
    directory_fd,
    dumps,
    require_root,
    restore_configs,
    run,
    safe_read,
    say,
    sha256_file,
    wait_until,
    write_new,
)
from secure_path import open_regular_at

TEMPLATES = pathlib.Path(__file__).resolve().parents[1] / 'systemd'
SERVICE_TEMPLATE = 'cauce-fleet-signed-authority.service'
TMPFILES_TEMPLATE = 'cauce-fleet-signed-authority.tmpfiles.conf'
ENTRY = 'app/services/gateway/dist/fleet/authority/signed-main.js'
SOCKET_NAME = 'authority.sock'
RELEASE_RE = re.compile(r'[0-9a-f]{40}')
HEX = re.compile(r'[0-9a-f]{64}')
SAFE_VALUE = re.compile(r'[A-Za-z0-9_./:+=@-]{1,4096}')
COPIED_ENVIRONMENT = ('NODE_ENV', 'PGSSLMODE', 'PGSSLROOTCERT')
AUTHORITY_UID = 0
PROBE_HOST = 'zz-canary-probe'
ISSUER_ENV = {'PATH': '/usr/bin:/bin', 'TMPDIR': '/var/tmp', 'PYTHONDONTWRITEBYTECODE': '1'}
PROBE = '''import http.client,json,socket,sys
endpoint=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);endpoint.settimeout(15);endpoint.connect(sys.argv[1])
connection=http.client.HTTPConnection('localhost',timeout=15);connection.sock=endpoint
connection.request('POST','/signed-authority',body=sys.argv[2],headers={'Content-Type':'application/json'})
response=connection.getresponse();print(json.dumps({'status':response.status,'body':json.loads(response.read(4097))}))
'''
GATEWAY_PROBE = '''const http = require('node:http');
const [socket, uid, gid, body] = process.argv.slice(1);
if (process.getuid() !== Number(uid) || process.getgid() !== Number(gid)
    || process.env.CAUCE_FLEET_AUTHORITY_SOCKET !== socket) process.exit(2);
const request = http.request({socketPath: socket, path: '/signed-authority', method: 'POST',
  headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, response => {
  let data = '';
  response.on('data', chunk => {data += chunk; if (Buffer.byteLength(data) > 4096) request.destroy();});
  response.on('end', () => {
    try {console.log(JSON.stringify({status: response.statusCode, body: JSON.parse(data)}));}
    catch {process.exitCode = 2;}
  });
});
request.on('error', () => {process.exitCode = 2;});
request.setTimeout(15000, () => request.destroy());
request.end(body);
'''


def absolute(value):
    if not isinstance(value, str) or not value.startswith('/') or os.path.normpath(value) != value or SAFE_VALUE.fullmatch(value) is None:
        raise Abort('expected a canonical absolute path: ' + repr(value)[:200])
    return pathlib.Path(value)


def environment_lines(body):
    values = {}
    for line in body.decode().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values.setdefault(key.strip(), []).append(value.strip().strip('"\''))
    return values


def single(values, key, source):
    found = values.get(key, [])
    if len(found) != 1:
        raise Abort(f'{source} must declare {key} exactly once')
    return found[0]


def systemctl_show(service, prop):
    return run(['systemctl', 'show', service, '-p', prop, '--value']).stdout.strip()


def executable_owned_by_root(location):
    descriptor = os.open(location, os.O_RDONLY | os.O_CLOEXEC)
    try:
        details = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if not stat.S_ISREG(details.st_mode) or details.st_uid != 0 or details.st_mode & 0o022 or not details.st_mode & 0o100:
        raise Abort(f'{location} is not a root-owned executable')


def controller_unit(args, root):
    commands = re.findall(r'\bargv\[\]=([^;]*) ;', systemctl_show(args.controller_service, 'ExecStart'))
    argv = commands[0].split() if len(commands) == 1 else []
    if len(argv) < 2 or argv[1] != str(root / 'app/services/gateway/dist/fleet/main.js'):
        raise Abort(f'{args.controller_service} must run exactly one node {root}/app/services/gateway/dist/fleet/main.js')
    node = absolute(argv[0])
    executable_owned_by_root(node)
    binds = []
    for token in systemctl_show(args.controller_service, 'BindReadOnlyPaths').split():
        parts = token.lstrip('-').split(':')
        if len(parts) >= 2 and parts[1] == '/etc/hosts':
            binds.append(absolute(parts[0]))
    if len(binds) > 1:
        raise Abort(f'{args.controller_service} binds /etc/hosts more than once')
    environment = {}
    for token in systemctl_show(args.controller_service, 'Environment').split():
        key, _, value = token.partition('=')
        environment.setdefault(key, []).append(value)
    return node, (binds[0] if binds else None), environment


def check_command(command):
    if not isinstance(command, dict) or not {'python', 'executable', 'sha256', 'policy_file', 'policy_sha256'} <= set(command) \
            <= {'python', 'executable', 'sha256', 'policy_file', 'policy_sha256', 'timeout_ms'} \
            or any(HEX.fullmatch(str(command[key])) is None for key in ('sha256', 'policy_sha256')) \
            or 'timeout_ms' in command and (type(command['timeout_ms']) is not int or not 1 <= command['timeout_ms'] <= 120_000):
        raise Abort('controller.v1.json has no valid authority_command; install the central issuer first')
    python = absolute(command['python'])
    if not os.access(python, os.X_OK):
        raise Abort(f'the issuer interpreter {python} is not executable')
    if sha256_file(absolute(command['executable'])) != command['sha256']:
        raise Abort('the issuer executable differs from its sha256 pin in controller.v1.json')
    if hashlib.sha256(safe_read(absolute(command['policy_file']), private=True)[0]).hexdigest() != command['policy_sha256']:
        raise Abort('the issuer policy differs from its sha256 pin in controller.v1.json')


def check_database_file(location):
    parent = directory_fd(location.parent)
    try:
        descriptor = open_regular_at(parent, location.name, os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        raise Abort(f'the database URL file {location} is unavailable or a symlink') from None
    finally:
        os.close(parent)
    try:
        details = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if not stat.S_ISREG(details.st_mode) or details.st_uid != 0 or details.st_nlink != 1 or details.st_mode & 0o077 \
            or details.st_size > 16_384:
        raise Abort(f'the database URL file {location} must be a root-owned private regular file')
    return stat.S_IMODE(details.st_mode)


def controller_state(args):
    body, _ = safe_read(args.controller / 'controller.env', private=True)
    values = environment_lines(body)
    root = absolute(single(values, 'CAUCE_FLEET_PROJECT_ROOT', 'controller.env'))
    if root.parent != args.tools_base or not RELEASE_RE.fullmatch(root.name):
        raise Abort('CAUCE_FLEET_PROJECT_ROOT is not a release tools root')
    os.close(directory_fd(root))
    entry = root / ENTRY
    if not entry.is_file():
        raise Abort(f'the controller release {root.name[:12]} lacks {ENTRY}; upgrade the controller first')
    entry_sha256 = sha256_file(entry)
    database = absolute(single(values, 'CAUCE_FLEET_DATABASE_URL_FILE', 'controller.env'))
    database_mode = check_database_file(database)
    controller = json.loads(safe_read(args.controller / 'controller.v1.json', private=True)[0])
    command = controller.get('authority_command') if isinstance(controller, dict) else None
    check_command(command)
    node, hosts, unit_environment = controller_unit(args, root)
    copied = {}
    for key in COPIED_ENVIRONMENT:
        found = values.get(key) or unit_environment.get(key) or []
        if len(found) > 1 or found and SAFE_VALUE.fullmatch(found[0]) is None:
            raise Abort(f'the controller declares {key} ambiguously')
        if found:
            copied[key] = found[0]
    say(f'  controller release {root.name}: {entry.name} sha256 {entry_sha256}')
    say(f"  node {node}; /etc/hosts {'from ' + str(hosts) if hosts else 'not bound by the controller'}")
    say(f'  database URL file {database} (root, {database_mode:04o}, shared with the controller; never read here)')
    say(f"  issuer {command['executable']} and policy {command['policy_file']} match their pins")
    say(f"  environment copied from the controller: {', '.join(sorted(copied)) or 'none'}")
    return {'root': root, 'node': node, 'hosts': hosts, 'database': database, 'command': command, 'environment': copied}


def issuer_ready(command):
    timeout = command.get('timeout_ms', 45_000) / 1000
    result = run([command['python'], command['executable'], '--policy', command['policy_file'], '--policy-sha256',
                  command['policy_sha256'], '--ready'], check=False, cwd='/', env=ISSUER_ENV, timeout=timeout + 5)
    try:
        ready = result.returncode == 0 and json.loads(result.stdout) == {'ready': True}
    except ValueError:
        ready = False
    if not ready:
        raise Abort('the central issuer is not ready (policy, registries, state root or CA pair)')


def render(name, values):
    lines = []
    for line in (TEMPLATES / name).read_text().splitlines():
        rendered = re.sub(r'@([A-Z_]+)@', lambda match: values[match.group(1)], line)
        if rendered or not line.startswith('@'):
            lines.append(rendered)
    return ('\n'.join(lines) + '\n').encode()


def issuer_write_paths(state):
    try:
        policy = json.loads(safe_read(absolute(state['command']['policy_file']), private=True)[0])
        root = absolute(policy['state_root'])
        registries = policy['registries']
    except (ValueError, KeyError, TypeError):
        raise Abort('the issuer policy must name an absolute state_root and registry paths') from None
    if not isinstance(registries, dict) or not registries:
        raise Abort('the issuer policy must name registry paths')
    paths = {root, *(absolute(location).parent for location in registries.values())}
    if any(len(path.parts) < 3 for path in paths):
        raise Abort('the issuer state_root and registry parents must be at least two levels below /')
    return {str(path) for path in paths}


def desired_files(args, state):
    files = {args.tmpfiles: (render(TMPFILES_TEMPLATE, {'SOCKET_DIRECTORY': str(args.socket_directory),
                                                        'GATEWAY_GID': str(args.gateway_gid)}), 0o644)}
    if state is None:
        return files
    write_paths = sorted(issuer_write_paths(state) | {str(args.socket_directory)})
    environment = {
        'CAUCE_FLEET_AUTHORITY_SOCKET': str(args.socket_directory / SOCKET_NAME),
        'CAUCE_FLEET_AUTHORITY_OWNER_UID': str(AUTHORITY_UID),
        'CAUCE_FLEET_AUTHORITY_PEER_UID': str(args.gateway_uid),
        'CAUCE_FLEET_AUTHORITY_GROUP_GID': str(args.gateway_gid),
        'CAUCE_FLEET_AUTHORITY_COMMAND_FILE': str(args.config_directory / 'command.v1.json'),
        'CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE': str(state['database']),
        **state['environment']}
    files[args.config_directory / 'command.v1.json'] = (dumps(state['command']), 0o600)
    files[args.config_directory / 'authority.env'] = (''.join(f'{key}={value}\n' for key, value in environment.items()).encode(), 0o600)
    files[args.unit] = (render(SERVICE_TEMPLATE, {
        'CONFIG_DIRECTORY': str(args.config_directory), 'NODE': str(state['node']), 'RELEASE': str(state['root']),
        'HOSTS_BIND': f"BindReadOnlyPaths={state['hosts']}:/etc/hosts" if state['hosts'] else '',
        'CONTROLLER_SERVICE': args.controller_service, 'READ_WRITE_PATHS': ' '.join(write_paths)}), 0o644)
    return files


def plan(files):
    changes = {}
    for filename, (body, mode) in files.items():
        try:
            details = os.lstat(filename)
        except FileNotFoundError:
            before = None
        else:
            if not stat.S_ISREG(details.st_mode):
                raise Abort(f'{filename} exists and is not a regular file')
            before = safe_read(filename, private=not mode & 0o077)[0]
            if before == body and stat.S_IMODE(details.st_mode) == mode:
                say(f'  {filename}: unchanged')
                continue
        say(f"  {filename}: {'new' if before is None else 'changed'}")
        for line in difflib.unified_diff((before or b'').decode().splitlines(), body.decode().splitlines(), lineterm='', n=0):
            if not line.startswith(('---', '+++', '@@')):
                say('    ' + line)
        changes[filename] = (before, body, mode)
    return changes


def service_active(unit):
    return run(['systemctl', 'is-active', unit], check=False).stdout.strip() == 'active'


def service_enabled(unit):
    result = run(['systemctl', 'is-enabled', unit], check=False)
    status = result.stdout.strip()
    if status == 'enabled' and result.returncode == 0:
        return True
    if status in ('disabled', 'not-found') and result.returncode != 0:
        return False
    raise Abort(f'the enclave has unsupported enablement: {status or "unknown"}')


def directory_ok(location, gid):
    try:
        details = os.lstat(location)
    except OSError:
        return False
    return stat.S_ISDIR(details.st_mode) and details.st_uid == AUTHORITY_UID and details.st_gid == gid \
        and stat.S_IMODE(details.st_mode) == 0o750


def socket_ok(location, gid, after_ns):
    try:
        details = os.lstat(location)
    except OSError:
        return False
    return stat.S_ISSOCK(details.st_mode) and details.st_uid == AUTHORITY_UID and details.st_gid == gid \
        and stat.S_IMODE(details.st_mode) == 0o660 and details.st_ctime_ns >= after_ns


def probe_body():
    packet = {'company_id': PROBE_HOST, 'host_id': PROBE_HOST, 'issued_at': time.time_ns() // 1_000_000,
              'nonce': secrets.token_hex(32), 'payload': {'action': 'ready'}, 'proof': 'AAAA'}
    return json.dumps({'host_id': PROBE_HOST, 'packet': packet})


def probe_reply(result):
    if result.returncode != 0:
        return None, None
    try:
        reply = json.loads(result.stdout)
        return reply['status'], reply['body']
    except (ValueError, KeyError, TypeError):
        return None, None


def probe(location, uid=None, gid=None):
    identity = {} if uid is None else {'user': uid, 'group': gid, 'extra_groups': []}
    result = run([sys.executable, '-I', '-c', PROBE, str(location), probe_body()],
                 check=False, cwd='/', env={'PATH': '/usr/bin:/bin'}, timeout=30, **identity)
    return probe_reply(result)


def gateway_probe(args, location):
    result = run(['docker', 'exec', '--workdir', '/', args.gateway_container, 'node', '-e', GATEWAY_PROBE,
                  str(location), str(args.gateway_uid), str(args.gateway_gid), probe_body()], check=False, timeout=30)
    return probe_reply(result)


def verify(args, state, started_ns):
    unit = args.unit.name
    if not wait_until(lambda: service_active(unit), 30):
        raise Abort(f'the enclave is not active; inspect journalctl -u {unit}')
    time.sleep(3)
    if not service_active(unit):
        raise Abort(f'the enclave stopped being active (restart loop); inspect journalctl -u {unit}')
    socket = args.socket_directory / SOCKET_NAME
    if not directory_ok(args.socket_directory, args.gateway_gid) or \
            not wait_until(lambda: socket_ok(socket, args.gateway_gid, started_ns), 30):
        raise Abort('the enclave socket is missing, stale or has the wrong owner or mode')
    issuer_ready(state['command'])
    gateway = probe(socket, args.gateway_uid, args.gateway_gid)
    if gateway == (409, {'error': 'AUTHORITY_UNAVAILABLE'}):
        raise Abort('the enclave cannot reach PostgreSQL with the controller connection')
    if gateway != (403, {'error': 'forbidden'}):
        raise Abort(f'the gateway uid did not get the expected refusal for an unenrolled host: {gateway}')
    if probe(socket) != (403, {'error': 'AUTHORITY_REVOKED'}):
        raise Abort('the enclave did not refuse a process that is not the gateway uid')
    if gateway_probe(args, socket) != (403, {'error': 'forbidden'}):
        raise Abort('the gateway container cannot reach the enclave with its configured socket, uid and gid')
    say(f'  ready: {unit} active, socket root:{args.gateway_gid} 0660, issuer ready, PostgreSQL reached '
        f'(unenrolled {PROBE_HOST} refused), other uids refused, gateway container {args.gateway_container} verified')


def write_files(changes, stamp, ctx):
    for filename, (before, body, mode) in changes.items():
        if before is None:
            write_new(filename, body, 0, 0, mode)
            ctx['created'].append(filename)
            say(f'  wrote {filename}')
            continue
        backup = filename.with_name(f'{filename.name}.pre-authority-{stamp}')
        write_new(backup, before, 0, 0, mode)
        ctx['rollback'].append((filename, backup, hashlib.sha256(before).hexdigest(), (0,)))
        write_new(filename, body, 0, 0, mode, replace=True)
        say(f'  rewrote {filename} (backup {backup.name})')


def rollback(args, ctx, was_active, failure):
    say(f'ROLLBACK: {failure}')
    unit, errors = args.unit.name, []
    if ctx.get('restarted'):
        run(['systemctl', 'stop', unit], check=False)
    if ctx.get('enable_attempted') and run(['systemctl', 'disable', unit], check=False).returncode != 0:
        say(f'ROLLBACK INCOMPLETE: the new {unit} enablement was not removed; every file is kept for recovery')
        return False
    if not restore_configs(ctx):
        say(f'ROLLBACK INCOMPLETE: a backup was not restored; {unit} is left stopped and every file is kept')
        return False
    try:
        for filename in reversed(ctx['created']):
            filename.unlink(missing_ok=True)
            say(f'  removed {filename}')
        if ctx.get('created_directory'):
            args.config_directory.rmdir()
    except OSError as error:
        errors.append(f'created files were not removed: {error}')
    run(['systemctl', 'daemon-reload'], check=False)
    if was_active:
        run(['systemctl', 'start', unit], check=False)
        if not wait_until(lambda: service_active(unit), 30):
            errors.append(f'the previous {unit} did not become active')
    if errors:
        say('ROLLBACK INCOMPLETE: ' + ' | '.join(errors))
    return not errors


def apply(args, state, changes):
    unit, ctx = args.unit.name, {'rollback': [], 'created': []}
    was_active = state is not None and service_active(unit)
    was_enabled = state is not None and service_enabled(unit)
    stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ-') + secrets.token_hex(3)
    tmpfiles = changes.pop(args.tmpfiles, None)
    write_files({args.tmpfiles: tmpfiles} if tmpfiles else {}, stamp, {'rollback': [], 'created': []})
    if tmpfiles or not directory_ok(args.socket_directory, args.gateway_gid):
        run(['systemd-tmpfiles', '--create', str(args.tmpfiles)])
    if not directory_ok(args.socket_directory, args.gateway_gid):
        raise Abort(f'{args.socket_directory} is not root:{args.gateway_gid} 0750 after systemd-tmpfiles')
    say(f'  socket directory {args.socket_directory} root:{args.gateway_gid} 0750')
    if state is None:
        return 'socket directory ready'
    try:
        if not args.config_directory.exists():
            args.config_directory.mkdir(mode=0o700)
            ctx['created_directory'] = True
        os.close(directory_fd(args.config_directory, private=True))
        write_files(changes, stamp, ctx)
        started_ns = 0
        if changes or not was_active:
            if changes:
                run(['systemctl', 'daemon-reload'])
            started_ns = time.time_ns() - 1_000_000_000
            ctx['restarted'] = True
            run(['systemctl', 'restart', unit])
        verify(args, state, started_ns)
        ctx['enable_attempted'] = not was_enabled
        run(['systemctl', 'enable', unit])
    except BaseException as error:
        rollback(args, ctx, was_active, str(error))
        raise Abort(f'installation reverted: {error}') from None
    return 'apply OK' if ctx.get('restarted') else 'no changes; the running enclave was verified'


def install(args):
    say(f"Signed fleet authority enclave ({'APPLY' if args.apply else 'preflight'})")
    state = None
    if not args.socket_directory_only:
        say('[1/4] controller configuration')
        state = controller_state(args)
        say('[2/4] central issuer readiness')
        issuer_ready(state['command'])
        say('  issuer ready')
    say('[3/4] plan')
    changes = plan(desired_files(args, state))
    if not args.apply:
        say('[4/4] skipped in preflight: no file written, no systemctl change')
        return 'preflight OK; nothing was written'
    say('[4/4] install, start and verify')
    return apply(args, state, changes)


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description='Install the signed fleet authority enclave next to the V3.5 fleet controller; '
                                                 'preflight by default')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--socket-directory-only', action='store_true',
                        help='install only the socket directory and its tmpfiles entry (needed before deploying the fleet overlay)')
    parser.add_argument('--fleet-config', type=pathlib.Path, default=pathlib.Path('/etc/cauce-v3/fleet-v35'))
    parser.add_argument('--tools-base', type=pathlib.Path, default=pathlib.Path('/usr/local/lib/cauce-v35'))
    parser.add_argument('--controller-service', default='cauce-fleet-v35-controller.service')
    parser.add_argument('--unit', type=pathlib.Path, default=pathlib.Path('/etc/systemd/system/cauce-fleet-signed-authority.service'))
    parser.add_argument('--tmpfiles', type=pathlib.Path, default=pathlib.Path('/etc/tmpfiles.d/cauce-fleet-signed-authority.conf'))
    parser.add_argument('--socket-directory', type=pathlib.Path, default=pathlib.Path('/run/cauce-fleet-signed-authority'))
    parser.add_argument('--gateway-uid', type=int, default=1000, help='uid of the gateway process (must match deploy/compose.fleet.yaml)')
    parser.add_argument('--gateway-gid', type=int, default=1000, help='gid of the gateway process (must match deploy/compose.fleet.yaml)')
    parser.add_argument('--gateway-container', default='cauce-v3-prod-gateway-1',
                        help='running gateway container used to verify the socket through its actual mount and user')
    args = parser.parse_args(argv)
    for name in ('fleet_config', 'tools_base', 'unit', 'tmpfiles', 'socket_directory'):
        value = str(getattr(args, name))
        if not value.startswith('/') or os.path.normpath(value) != value or SAFE_VALUE.fullmatch(value) is None:
            parser.error(f"--{name.replace('_', '-')} must be a canonical absolute path")
    if re.fullmatch(r'[A-Za-z0-9@._-]{1,200}\.service', args.controller_service) is None or not args.unit.name.endswith('.service'):
        parser.error('--controller-service and --unit must name .service units')
    if not 1 <= args.gateway_uid < 2 ** 31 or not 1 <= args.gateway_gid < 2 ** 31:
        parser.error('--gateway-uid and --gateway-gid must be non-root ids')
    if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', args.gateway_container) is None:
        parser.error('--gateway-container must be a container name or id')
    args.controller, args.config_directory = args.fleet_config / 'controller', args.fleet_config / 'signed-authority'
    return args


def main(argv=None):
    args = parse_arguments(argv)
    require_root()
    os.umask(0o077)
    lock = directory_fd(args.fleet_config)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Abort('another controller upgrade or authority install is in progress') from None
        say('\nRESULT: ' + install(args))
        return 0
    except Abort as error:
        say(f'\nRESULT: FAILED: {error}')
        return 2
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Abort as failure:
        print(f'FAILED: {failure}', file=sys.stderr)
        sys.exit(2)
    except (OSError, ValueError, KeyError) as failure:
        print(f'UNEXPECTED FAILURE ({type(failure).__name__}); inspect the state and the *.pre-authority-* backups', file=sys.stderr)
        sys.exit(3)
