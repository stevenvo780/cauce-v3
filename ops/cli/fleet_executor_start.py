from __future__ import annotations

import json
import pathlib
import re
import time
import uuid

from fleet_executor_policy import SafeFailure

STARTUP_STDERR = '''import os,stat,sys
action,control,name=sys.argv[1:4]
directory=os.open(control,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
details=os.fstat(directory)
if details.st_uid!=0 or details.st_mode&0o077:
    raise SystemExit('controller diagnostic directory is unsafe')
flags=os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
try:
    fd=os.open(name,flags|(os.O_WRONLY|os.O_CREAT|os.O_EXCL if action=='run' else os.O_RDONLY),0o600,dir_fd=directory)
except FileNotFoundError:
    raise SystemExit(0)
details=os.fstat(fd)
if not stat.S_ISREG(details.st_mode) or details.st_uid!=0 or details.st_nlink!=1 or stat.S_IMODE(details.st_mode)!=0o600:
    raise SystemExit('controller diagnostic file is unsafe')
if action=='run':
    os.dup2(fd,2)
    os.close(fd)
    os.close(directory)
    os.execv(sys.argv[4],sys.argv[4:])
elif action=='read':
    os.lseek(fd,max(0,details.st_size-8192),os.SEEK_SET)
    sys.stdout.buffer.write(os.read(fd,8192))
elif action=='remove':
    current=os.stat(name,dir_fd=directory,follow_symlinks=False)
    if (current.st_dev,current.st_ino)!=(details.st_dev,details.st_ino):
        raise SystemExit('controller diagnostic file changed')
    os.unlink(name,dir_fd=directory)
else:
    raise SystemExit('controller diagnostic action is invalid')
os.close(fd)
os.close(directory)
'''


def startup_stderr(agent: dict, identity: dict, name: str, action: str) -> bytes:
    import fleet_executor_container as runtime

    return runtime.docker('exec', '-w', '/', '--user', '0', identity['container_id'],
        agent['_placement']['python'], '-I', '-B', '-c', STARTUP_STDERR, action, str(identity['control']), name)


def retirement_arguments(policy: dict, agent: dict, observed: dict) -> list[str]:
    if agent['_placement'].get('ownership') == 'shared':
        return []
    import fleet_executor_container as runtime

    volume = agent['container_name'] + '-state'
    container_id = observed.get('Id')
    if not isinstance(container_id, str) or re.fullmatch(r'[0-9a-f]{64}', container_id) is None:
        raise SafeFailure('consumer lease retirement requires an exact managed container')
    labels = runtime.expected_labels(policy, agent)
    if any((observed.get('Config', {}).get('Labels') or {}).get(key) != value for key, value in labels.items()):
        raise SafeFailure('consumer lease retirement container ownership differs')
    mounts = [row for row in observed.get('Mounts', []) if row.get('Destination') == agent['_placement']['state_root']]
    if len(mounts) != 1 or mounts[0].get('Type') != 'volume' or mounts[0].get('Name') != volume or mounts[0].get('RW') is not True:
        raise SafeFailure('consumer lease retirement requires the managed state volume')
    try:
        volumes = json.loads(runtime.docker('volume', 'inspect', volume))
    except (ValueError, TypeError) as error:
        raise SafeFailure('consumer lease retirement volume observation is invalid') from error
    if not isinstance(volumes, list) or len(volumes) != 1 or not isinstance(volumes[0], dict) \
            or volumes[0].get('Name') != volume or any((volumes[0].get('Labels') or {}).get(key) != value for key, value in labels.items()):
        raise SafeFailure('consumer lease retirement volume ownership differs')
    try:
        users = runtime.docker('ps', '-a', '-q', '--no-trunc', '--filter', 'volume=' + volume).decode('ascii').splitlines()
    except UnicodeError as error:
        raise SafeFailure('consumer lease retirement volume users are invalid') from error
    if len(users) != len(set(users)) or container_id not in users \
            or any(re.fullmatch(r'[0-9a-f]{64}', item) is None for item in users):
        raise SafeFailure('consumer lease retirement volume users are ambiguous')
    return ['--retire-consumer-lease'] if users == [container_id] else []


def start_existing_adapter(policy: dict, agent: dict, observed: dict, bundle: dict, *,
                           bootstrap: bool, operation_id: str | None = None) -> dict:
    import fleet_executor_container as runtime

    identity = runtime.identity_for(agent, observed)
    uid, gid = runtime.user_identity(agent, identity)
    try:
        return runtime.process_proof(policy, agent, identity, bundle, bootstrap=bootstrap, operation_id=operation_id)
    except runtime.NamespaceMismatch:
        raise
    except runtime.SafeFailure:
        runtime.helper(agent, identity, 'stopped', *runtime.lifecycle_arguments(agent, identity))
    runtime.verify_executable(agent, observed, bundle)
    runtime.helper(agent, identity, 'prepare-state', '--mount', agent['_placement']['state_root'], '--state', agent['state_directory'], '--uid', uid, '--gid', gid)
    workspace = str(pathlib.Path(agent['state_directory']) / 'space' / 'projects')
    managed = agent['_placement'].get('ownership') != 'shared'
    if managed:
        runtime.helper(agent, identity, 'prepare-state', '--mount', agent['_placement']['state_root'], '--state', workspace, '--uid', uid, '--gid', gid)
    runtime.helper(agent, identity, 'prepare-state', '--mount', agent['_placement']['state_root'],
           '--state', str(pathlib.Path(agent['state_directory']) / 'space' / 'tmp'), '--uid', uid, '--gid', gid)
    if (fallback := runtime.pairing(agent)) is not None and fallback['server']:
        runtime.helper(agent, identity, 'prepare-state', '--mount', fallback['destination'], '--state', fallback['destination'], '--uid', uid, '--gid', gid)
    from fleet_executor_profiles import prepare_profile
    # Only a bundle outside the current release (the sibling one a preserved original binds) accepts those mounts.
    sibling = not pathlib.PurePosixPath(bundle['directory']).is_relative_to(runtime.RELEASE_ROOT)
    prepare_profile(policy, agent, operation_id=operation_id, previous_release_ok=sibling)
    runtime.helper(agent, identity, 'prepare-control', '--base', str(identity['control'].parent), '--alias', agent['runtime_key'])
    view = pathlib.Path('/run/cauce-credentials') / agent['runtime_key'] / ('bootstrap' if bootstrap else 'normal')
    runtime.checked_command([runtime.DOCKER, 'exec', '-i', '-w', '/', '--user', '0', identity['container_id'],
        *runtime.isolated_python(agent['_placement']['python'], f'{runtime.EXECUTOR_DESTINATION}/fleet_executor_view.py',
                         '--root', str(view), '--uid', uid, '--gid', gid)],
        input_data=json.dumps(runtime.payload_for(policy, agent, bootstrap)).encode())
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': agent['home_directory'], 'CAUCE_ALIAS': agent['alias'], 'CAUCE_RUNTIME_KEY': agent['runtime_key'], 'CAUCE_TENANT_ID': agent['tenant_id'],
                   'CAUCE_TENANT': agent['tenant_id'], 'CAUCE_STATE_DIR': agent['state_directory'], 'CAUCE_CONTROL_DIR': str(identity['control']),
                   'CAUCE_CONTAINER_ID': identity['container_id'], 'CAUCE_CONTAINER_GENERATION': identity['generation'],
                   'CAUCE_BOOTSTRAP': '1' if bootstrap else '0', 'PYTHONDONTWRITEBYTECODE': '1'}
    environment.update(runtime.credential_environment(view, policy, bootstrap))
    environment.update(runtime.sdk_environment(policy, agent, bootstrap, operation_id))
    environment.update(runtime.provider_environment(policy, agent))
    environment.update(runtime.sidecar_shape(runtime.validate_sidecars(policy, agent))[1])
    environment.update(runtime.adapter_environment(agent))
    if operation_id is not None:
        environment['CAUCE_FLEET_OPERATION_ID'] = operation_id
    arguments = [f'{key}={value}' for key, value in environment.items()]
    diagnostic_name = '.startup-' + uuid.uuid4().hex + '.stderr'
    try:
        runtime.docker('exec', '-d', '-w', '/', '--user', '0', identity['container_id'], '/usr/bin/env', '-i', *arguments,
               agent['_placement']['python'], '-I', '-B', '-c', STARTUP_STDERR, 'run', str(identity['control']), diagnostic_name,
               *runtime.isolated_python(agent['_placement']['python'], f'{runtime.HELPER_DESTINATION}/{runtime.HELPER.name}', 'run', *runtime.lifecycle_arguments(agent, identity),
               *retirement_arguments(policy, agent, observed),
               '--wire-alias', agent['alias'], '--tenant', agent['tenant_id'], '--runtime-uid', uid, '--runtime-gid', gid,
               '--bundle', bundle['directory'], '--bundle-digest', bundle['digest'], bundle['executable'], *bundle['argv'],
               cwd=workspace if managed else observed.get('Config', {}).get('WorkingDir') or '/'))
        deadline = time.monotonic() + 10
        last: runtime.SafeFailure | None = None
        while time.monotonic() < deadline:
            try:
                return runtime.process_proof(policy, agent, identity, bundle, bootstrap=bootstrap, operation_id=operation_id)
            except runtime.SafeFailure as error:
                last = error
                time.sleep(0.1)
        from fleet_executor_image import failure_details
        try:
            raw = startup_stderr(agent, identity, diagnostic_name, 'read')
            details = '; controller stderr: ' + failure_details(SafeFailure(raw.decode('utf-8', 'replace'))) if raw.strip() else ''
        except Exception as error:
            details = '; controller stderr unavailable: ' + failure_details(error)
        raise runtime.SafeFailure(f'container adapter identity was not observed ({last}){details}; see {agent["state_directory"]}/.cauce-adapter.log')
    except BaseException as error:
        try:
            runtime.helper(agent, identity, 'stop', *runtime.lifecycle_arguments(agent, identity))
        except Exception as stop_error:
            from fleet_executor_image import failure_details
            raise SafeFailure(f'{error}; cleanup failed: {failure_details(stop_error)}') from error
        raise
    finally:
        try:
            startup_stderr(agent, identity, diagnostic_name, 'remove')
        except Exception:
            pass
