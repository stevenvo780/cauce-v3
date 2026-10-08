from __future__ import annotations

import argparse
import fcntl
import os
import pathlib
import re
import shutil
import sys


def absolute(value):
    if not isinstance(value, str) or not value.startswith('/') or value == '/' \
            or str(pathlib.PurePosixPath(value)) != value or '..' in pathlib.PurePosixPath(value).parts \
            or any(ord(character) < 32 for character in value):
        raise ValueError('invalid shared runtime path')
    return pathlib.Path(value)


def validate_shared_containers(policy: dict):
    from fleet_executor_policy import SafeFailure
    try:
        containers = policy.get('shared_containers', {})
        if not isinstance(containers, dict) or len(containers) > 100:
            raise ValueError('shared container allowlist exceeds its bound')
        reserved = set()
        fields = {'container_id', 'image', 'runtime_user', 'runtime_uid', 'runtime_gid', 'systemd_user',
            'home_directory', 'state_root', 'control_root', 'python', 'mounts', 'aliases'}
        for name, row in containers.items():
            if not isinstance(name, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name) is None \
                    or name in policy['containers'] or not isinstance(row, dict) or set(row) != fields \
                    or re.fullmatch(r'[a-f0-9]{64}', row.get('container_id', '')) is None \
                    or re.fullmatch(r'sha256:[a-f0-9]{64}', row.get('image', '')) is None \
                    or any(not isinstance(row[key], str) or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,63}', row[key]) is None
                        for key in ('runtime_user', 'systemd_user')) \
                    or any(type(row[key]) is not int or row[key] <= 0 for key in ('runtime_uid', 'runtime_gid')):
                raise ValueError('invalid shared container identity')
            for key in ('home_directory', 'state_root', 'control_root', 'python'):
                absolute(row[key])
            state, control = absolute(row['state_root']), absolute(row['control_root'])
            if state.is_relative_to(control) or control.is_relative_to(state):
                raise ValueError('shared state and control roots overlap')
            mounts = row['mounts']
            if not isinstance(mounts, list) or not 1 <= len(mounts) <= 100:
                raise ValueError('invalid shared mount pins')
            destinations = set()
            for mount in mounts:
                if not isinstance(mount, dict) or set(mount) != {'Destination', 'Source', 'Type', 'RW'} \
                        or mount['Type'] not in {'bind', 'volume'} or type(mount['RW']) is not bool:
                    raise ValueError('invalid shared mount pin')
                absolute(mount['Destination'])
                absolute(mount['Source'])
                if mount['Destination'] in destinations:
                    raise ValueError('ambiguous shared mount pin')
                destinations.add(mount['Destination'])
            readonly = {mount['Destination']: mount['Source'] for mount in mounts if mount['Type'] == 'bind' and mount['RW'] is False}
            directory = pathlib.Path(__file__).resolve().parent
            if readonly.get('/cauce/executor') != str(directory) or readonly.get('/cauce/lifecycle') != str(directory.parent / 'container-runtime'):
                raise ValueError('shared helper mounts are not pinned read only')
            if not any(mount['RW'] and state.is_relative_to(absolute(mount['Destination'])) for mount in mounts):
                raise ValueError('shared state root is outside its approved writable mount')
            if not isinstance(row['aliases'], dict) or not 1 <= len(row['aliases']) <= 1000:
                raise ValueError('invalid shared alias allowlist')
            accounts = {identity.get('account_id') for identity in row['aliases'].values() if isinstance(identity, dict)} - {None}
            profiles = [absolute(binding['path']) for account, binding in policy['profiles'].items()
                if account in accounts or binding.get('container_name') == name]
            for key, identity in row['aliases'].items():
                if not isinstance(key, str) or re.fullmatch(r'[a-z][a-z0-9-]{0,63}', key) is None or key in reserved \
                        or not isinstance(identity, dict) or set(identity) - {'account_id'} != {'tenant_id', 'alias', 'harness_id'} \
                        or re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', identity.get('tenant_id', '')) is None \
                        or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', identity.get('alias', '')) is None \
                        or identity.get('harness_id') not in policy['bundles']:
                    raise ValueError('invalid or duplicate shared alias identity')
                reserved.add(key)
                bundle = policy['bundles'][identity['harness_id']]
                if readonly.get(bundle['directory']) != bundle['directory']:
                    raise ValueError('shared alias bundle is not pinned read only')
                own = (state / key, control / key, pathlib.Path('/run/cauce-credentials') / key)
                if any(absolute(mount['Destination']).is_relative_to(root) for mount in mounts for root in own):
                    raise ValueError('shared alias subtree contains another mount')
                if any(profile.is_relative_to(root) or root.is_relative_to(profile) for profile in profiles for root in own):
                    raise ValueError('shared provider profile overlaps alias lifecycle state')
                account = identity.get('account_id')
                if account is not None:
                    binding = policy['profiles'].get(account)
                    if not isinstance(binding, dict) or binding.get('runtime_user') != row['runtime_user'] \
                            or binding.get('container_name', name) != name:
                        raise ValueError('shared alias has no approved existing account binding')
    except (KeyError, TypeError, ValueError) as error:
        raise SafeFailure('shared container policy is invalid') from error


def shared_placement(policy: dict, agent: dict) -> dict | None:
    from fleet_executor_policy import SafeFailure
    row = policy.get('shared_containers', {}).get(agent.get('container_name'))
    if row is None:
        return None
    validate_shared_containers(policy)
    identity = row['aliases'].get(agent.get('runtime_key'))
    if not identity or any(identity[field] != agent.get(field) for field in ('tenant_id', 'alias', 'harness_id')) \
            or agent.get('primary_account_id') is not None and identity.get('account_id') != agent['primary_account_id']:
        raise SafeFailure('agent is outside its approved shared alias identity')
    return {**row, 'ownership': 'shared'}


def validate_shared_observation(policy: dict, agent: dict, observed: dict):
    from fleet_executor_policy import SafeFailure
    row = agent['_placement']
    if not isinstance(observed, dict) or observed.get('Id') != row['container_id'] or observed.get('Image') != row['image']:
        raise SafeFailure('shared container identity changed')
    configuration = observed['HostConfig']
    if configuration.get('Privileged') is not False or configuration.get('PidMode') == 'host' \
            or 'SYS_ADMIN' in (configuration.get('CapAdd') or []):
        raise SafeFailure('shared container isolation changed')
    mounts = [{field: mount[field] for field in ('Destination', 'Source', 'Type', 'RW')} for mount in observed['Mounts']]
    if sorted(mounts, key=lambda mount: mount['Destination']) != sorted(row['mounts'], key=lambda mount: mount['Destination']):
        raise SafeFailure('shared container mount pins changed')


def assert_shared_start(policy: dict, agent: dict):
    from fleet_executor_policy import SafeFailure
    identity = agent['_placement']['aliases'][agent['runtime_key']]
    if agent.get('primary_account_id') is None or agent['primary_account_id'] != identity.get('account_id'):
        raise SafeFailure('shared runtime start requires its approved existing provider account')


def remove_owned(directory: pathlib.Path, uid: int):
    from cauce_container_base import open_directory
    try:
        parent = open_directory(str(directory.parent))
    except FileNotFoundError:
        return
    try:
        try:
            descriptor = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except FileNotFoundError:
            return
        try:
            details = os.fstat(descriptor)
            actual = os.stat(directory.name, dir_fd=parent, follow_symlinks=False)
            if details.st_uid != uid or (details.st_dev, details.st_ino) != (actual.st_dev, actual.st_ino) \
                    or not shutil.rmtree.avoids_symlink_attacks:
                raise ValueError('shared alias directory identity changed')
            shutil.rmtree(directory.name, dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def purge_alias(args):
    sys.path.insert(0, '/cauce/lifecycle')
    from cauce_container_base import open_control_directory
    from cauce_container_proc import alias_generation_pids, lock_control, read_metadata
    if re.fullmatch(r'[a-z][a-z0-9-]{0,63}', args.key) is None or args.uid <= 0:
        raise ValueError('invalid shared purge identity')
    state, control = absolute(args.state_root) / args.key, absolute(args.control_root) / args.key
    descriptor = open_control_directory(str(control))
    lock = lock_control(descriptor)
    try:
        document, _ = read_metadata(descriptor)
        if document is not None or alias_generation_pids(args.key, args.generation, str(state), exclude={os.getpid()}):
            raise ValueError('shared alias has not remained stopped')
        remove_owned(state, args.uid)
        remove_owned(pathlib.Path('/run/cauce-credentials') / args.key, os.geteuid())
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
        os.close(descriptor)


def purge_shared(policy: dict, agent: dict, observed: dict):
    from fleet_executor_container import EXECUTOR_DESTINATION, docker, helper, identity_for, user_identity
    from fleet_executor_policy import SafeFailure
    validate_shared_observation(policy, agent, observed)
    if observed['State']['Running'] is not True:
        raise SafeFailure('shared residual removal requires its observed running container')
    identity = identity_for(agent, observed)
    uid, _ = user_identity(agent, identity)
    helper(agent, identity, 'prepare-control', '--base', agent['_placement']['control_root'], '--alias', agent['runtime_key'])
    docker('exec', '--user', '0', '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'], agent['_placement']['python'],
        f'{EXECUTOR_DESTINATION}/fleet_executor_legacy.py', '--key', agent['runtime_key'], '--state-root', agent['_placement']['state_root'],
        '--control-root', agent['_placement']['control_root'], '--generation', identity['generation'], '--uid', uid)


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        for argument in ('key', 'state-root', 'control-root', 'generation'):
            parser.add_argument('--' + argument, required=True)
        parser.add_argument('--uid', required=True, type=int)
        purge_alias(parser.parse_args())
    except Exception:
        raise SystemExit('shared alias residual removal was not verified') from None
