"""Quiesce an exclusive pinned legacy container and recover its unit on rollback."""
from __future__ import annotations

import json
import os
import pwd
import re
import subprocess
import uuid


def legacy_manager(source, alias, entry):
    unit = source['legacy_unit']
    user = source['systemd_user']
    scope = source.get('systemd_scope', 'user')
    if unit != 'cauce-v3-container-' + alias + '.service' or user != entry.get('systemdUser', 'stev') \
            or scope not in ('user', 'system') or scope != entry.get('systemdScope', 'user'):
        raise ValueError('legacy manager differs from the alias inventory')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', user):
        raise ValueError('invalid legacy manager user')
    if scope == 'system' and user != 'root':
        raise ValueError('the system legacy manager must be root')
    return scope, user


def legacy_unit(request, action):
    from v4_mover_host import docker
    source, alias = request['source'], request['alias']
    entry = request['config']['aliases'][alias]
    scope, user = legacy_manager(source, alias, entry)
    unit = source['legacy_unit']
    pin = source['container_id']
    info = json.loads(docker('inspect', entry['container']))[0]
    if action not in {'status', 'stopped', 'stop', 'start'}:
        raise ValueError('invalid legacy unit action')
    siblings = [other for other, item in request['config']['aliases'].items() if other != alias
                and item.get('container') == entry['container']
                and item.get('dockerHost', 'local') == entry.get('dockerHost', 'local')]
    if not re.fullmatch(r'[0-9a-f]{64}', pin) or info['Id'] != pin:
        raise ValueError('legacy container differs from its pinned original')
    if siblings and (source.get('shared_container') != entry['container'] or source.get('container_must_remain_running') is not True
                     or sorted(source.get('siblings_must_remain_running') or []) != sorted(siblings)):
        raise ValueError('legacy container is shared; stopping it requires an alias-only consistency plan')
    if scope == 'system':
        command = ['systemctl', '--system'] if os.geteuid() == 0 else ['sudo', '-n', '--', 'systemctl', '--system']
    else:
        uid = pwd.getpwnam(user).pw_uid
        command = ['env', 'XDG_RUNTIME_DIR=/run/user/' + str(uid),
                   'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/' + str(uid) + '/bus', 'systemctl', '--user']
        if uid != os.geteuid():
            if os.geteuid() != 0:
                raise ValueError('the source route must reach the legacy manager user')
            command = ['runuser', '-u', user, '--', *command]

    def run(*args):
        result = subprocess.run([*command, *args], capture_output=True, text=True, check=False, timeout=120)
        if result.returncode:
            raise RuntimeError('legacy unit ' + args[0] + ' failed')
        return result.stdout.strip()

    def inspect():
        current = json.loads(docker('inspect', entry['container']))[0]
        if current['Id'] != pin:
            raise ValueError('legacy container differs from its pinned original')
        return current

    if scope == 'system' and run('show', '--property=User', '--value', unit) not in {'', 'root'}:
        raise ValueError('legacy system unit does not run as root')
    if siblings:
        return shared_unit(action, alias, entry, pin, unit, run, inspect)
    if action == 'start':
        if info['State']['Running'] is not True:
            docker('start', pin)
        if inspect()['State']['Running'] is not True:
            raise ValueError('legacy container did not start before its unit')
    if action in {'stop', 'start'}:
        run(action, unit)
    state = run('show', '--property=ActiveState', '--value', unit)
    expected = 'inactive' if action in {'stop', 'stopped'} else 'active'
    if state != expected:
        raise ValueError('legacy unit did not reach ' + expected)
    if action == 'stop' and inspect()['State']['Running'] is True:
        docker('stop', pin)
    running = inspect()['State']['Running']
    if running is not (action not in {'stop', 'stopped'}):
        raise ValueError('legacy container did not reach the requested running state')
    return {'verified': True, 'unit': unit, 'systemd_user': user, 'systemd_scope': scope, 'active_state': state, 'container_id': pin,
            'container_running': running, 'container_exclusive': True}


def shared_unit(action, alias, entry, pin, unit, run, inspect):
    """Quiesce one alias inside a container its siblings keep using: its adapter and PTY units, and its tmux session."""
    from v4_mover_host import docker
    units = [unit] + [name for name in ('cauce-v3-pty@' + alias + '.service',)
                      if run('show', '--property=LoadState', '--value', name) == 'loaded']
    session, user = 'cauce-' + alias, entry.get('user', 'dev')
    markers = ('/opt/cauce-v3-adapter/' + alias + '/', '--alias ' + alias + ' ', '.cauce-pty-bundle-' + alias + '.json',
               '-t ' + session + ':', '/cauce-v3/' + alias + ' ')

    def processes():
        table = {}
        for line in docker('exec', pin, 'ps', '-eo', 'pid=,ppid=,args=').decode().splitlines():
            parts = line.split(None, 2)
            if len(parts) >= 2:
                table[int(parts[0])] = (int(parts[1]), parts[2] if len(parts) == 3 else '')
        return table

    def owned(table, roots):
        found, frontier = set(roots) & set(table), list(set(roots) & set(table))
        while frontier:
            parent = frontier.pop()
            for pid, (ppid, _) in table.items():
                if ppid == parent and pid not in found:
                    found.add(pid)
                    frontier.append(pid)
        return found | {pid for pid, (_, args) in table.items() if any(marker in args + ' ' for marker in markers)}

    def panes():
        result = subprocess.run(['docker', 'exec', '--user', user, pin, 'tmux', '-L', 'cauce', 'list-panes', '-t', '=' + session,
                                 '-F', '#{pane_pid}'], capture_output=True, text=True, check=False, timeout=30)
        if result.returncode == 0:
            return [int(pid) for pid in result.stdout.split()]
        if re.search(r"can't find session|no server running|error connecting to", result.stderr):
            return []
        raise ValueError('alias tmux session could not be inspected')

    if action == 'start':
        for name in units:
            run('start', name)
    elif action == 'stop':
        for name in reversed(units):
            run('stop', name)
        roots = panes()
        doomed = owned(processes(), roots)
        if roots:
            docker('exec', '--user', user, pin, 'tmux', '-L', 'cauce', 'kill-session', '-t', '=' + session)
        for signal in ('TERM', 'KILL'):
            alive = sorted(owned(processes(), roots) | (doomed & set(processes())))
            if not alive:
                break
            subprocess.run(['docker', 'exec', '--user', '0', pin, 'sh', '-c', 'kill -' + signal + ' "$@"', 'sh', *map(str, alive)],
                           capture_output=True, check=False, timeout=30)
            subprocess.run(['sleep', '3'], check=False)
    states = {name: run('show', '--property=ActiveState', '--value', name) for name in units}
    expected = 'inactive' if action in {'stop', 'stopped'} else 'active'
    if any(state != expected for state in states.values()):
        raise ValueError('legacy unit did not reach ' + expected)
    remaining = owned(processes(), panes())
    if expected == 'inactive' and (remaining or panes()):
        raise ValueError('alias processes remain in the shared container')
    if inspect()['State']['Running'] is not True:
        raise ValueError('shared legacy container must keep running for its siblings')
    return {'verified': True, 'unit': unit, 'units': states, 'container_id': pin, 'container_running': True,
            'container_exclusive': False, 'alias_processes': len(remaining)}


def cleanup_destination(request):
    from v4_mover_host import docker
    placement = request['placement']
    if placement['mode'] != 'container':
        raise ValueError('legacy rollback requires an owned container destination')
    labels = {'cauce.fleet.runtime_key': request['runtime_key'], 'cauce.fleet.tenant': request['tenant'],
              'cauce.fleet.alias': request['alias'], 'cauce.fleet.host': placement['host_id'],
              'cauce.fleet.owner': placement['systemd_user']}
    name = placement['container_name']
    containers = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
    if name in containers:
        info = json.loads(docker('inspect', name))[0]
        owned = info['Config'].get('Labels') or {}
        if any(owned.get(key) != value for key, value in labels.items()) \
                or not request.get('create_operation_id') or owned.get('cauce.fleet.operation') != request['create_operation_id']:
            raise ValueError('rollback container belongs to another identity')
        if info['State']['Running'] is True:
            docker('stop', info['Id'])
        docker('rm', info['Id'])
    existing = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    removed = []
    for volume in (name + '-state', name + '-provider-profiles'):
        if volume in existing:
            info = json.loads(docker('volume', 'inspect', volume))[0]
            owned = info.get('Labels') or {}
            marker = owned.get('cauce.migration.cut') == request['migration_id'] if volume.endswith('-state') \
                else bool(request.get('create_operation_id')) and owned.get('cauce.fleet.operation') == request['create_operation_id']
            if any(owned.get(key) != value for key, value in labels.items()) or not marker:
                raise ValueError('rollback volume belongs to another identity')
            docker('volume', 'rm', volume)
            removed.append(volume)
    return {'verified': True, 'container_absent': name, 'removed_volumes': removed}


def terminal_probe(request):
    from v4_mover_host import docker
    placement = request['placement']
    info = json.loads(docker('inspect', placement['container_name']))[0]
    labels = {'cauce.fleet.runtime_key': request['runtime_key'], 'cauce.fleet.tenant': request['tenant'],
              'cauce.fleet.alias': request['alias'], 'cauce.fleet.host': placement['host_id']}
    if any((info['Config'].get('Labels') or {}).get(key) != value for key, value in labels.items()) \
            or info['State']['Running'] is not True or info['Image'] != request['image']:
        raise ValueError('terminal runtime differs from the restored destination')
    marker = 'CAUCE_TERMINAL_' + uuid.uuid4().hex
    output = docker('exec', '--tty', '--user', placement['runtime_user'], info['Id'],
                    '/bin/sh', '-c', 'test -t 1 && printf "%s\\n" "$1"', 'sh', marker).decode().strip()
    if output != marker:
        raise ValueError('destination PTY shell did not echo its nonce')
    return {'pty_verified': True, 'shell_nonce_verified': True, 'mode': 'shell', 'transport': 'docker-exec'}
