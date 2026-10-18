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
    if siblings:
        raise ValueError('legacy container is shared; stopping it requires an alias-only consistency plan')
    if not re.fullmatch(r'[0-9a-f]{64}', pin) or info['Id'] != pin:
        raise ValueError('legacy container differs from its pinned original')
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
