from __future__ import annotations

import argparse
import os
import pathlib
import pwd
import re
import stat

from fleet_executor_view import open_directory


def ensure_private(parent: int, name: str, uid: int, gid: int, *, initialize_empty: bool = False) -> int:
    created = False
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent)
        created = True
    except FileExistsError:
        pass
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        details = os.fstat(directory)
        if created or initialize_empty and details.st_uid == 0 and not os.listdir(directory):
            if (uid, gid) != (os.geteuid(), os.getegid()):
                if os.geteuid() != 0:
                    raise ValueError('profile executor cannot use the exact runtime owner')
                os.fchown(directory, uid, gid)
            os.fchmod(directory, 0o700)
            details = os.fstat(directory)
        if details.st_uid != uid or details.st_gid != gid or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError('provider profile directory owner or privacy differs')
        return directory
    except BaseException:
        os.close(directory)
        raise


def prepare_empty_profile(root: str, profile: str, uid: int, gid: int, *, initialize_empty: bool = False):
    root_path, destination = pathlib.Path(root), pathlib.Path(profile)
    if any(not value.startswith('/') or str(pathlib.PurePosixPath(value)) != value or '..' in pathlib.PurePosixPath(value).parts
            or any(ord(char) < 32 for char in value) for value in (root, profile)) or uid <= 0 or gid <= 0 \
            or not destination.is_relative_to(root_path) or len(destination.relative_to(root_path).parts) != 2:
        raise ValueError('invalid separate provider profile destination')
    runtime, account = destination.relative_to(root_path).parts
    if re.fullmatch(r'[a-z][a-z0-9-]{0,63}', runtime) is None or re.fullmatch(r'[0-9a-f]{64}', account) is None:
        raise ValueError('provider profile destination identity is not canonical')
    parent = open_directory(root_path.parent)
    try:
        current = ensure_private(parent, root_path.name, uid, gid, initialize_empty=initialize_empty)
    finally:
        os.close(parent)
    try:
        for component in destination.relative_to(root_path).parts:
            following = ensure_private(current, component, uid, gid)
            os.close(current)
            current = following
        os.fsync(current)
    finally:
        os.close(current)


def prepare_profile(policy: dict, raw_agent: dict):
    from fleet_executor_policy import approve_agent
    from fleet_executor_templates import resolve_profile
    agent = approve_agent(policy, raw_agent)
    account = agent.get('primary_account_id')
    if account is None or account in policy['profiles']:
        return
    binding = resolve_profile(policy, agent)
    template = next(row for row in policy['profile_templates'] if row['provider'] == binding['provider']
                    and row['runtime_user'] == agent['runtime_user'])
    if agent['runtime_mode'] == 'native':
        from fleet_runtime_materialization import external_directory
        external_directory(pathlib.Path(template['path_root']))
        user = pwd.getpwnam(agent['runtime_user'])
        prepare_empty_profile(template['path_root'], binding['path'], user.pw_uid, user.pw_gid)
        return
    from fleet_executor_container import (
        EXECUTOR_DESTINATION,
        docker,
        identity_for,
        inspect_container,
        user_identity,
        validate_container,
    )
    observed = inspect_container(agent['container_name'])
    validate_container(policy, agent, observed)
    identity = identity_for(agent, observed)
    uid, gid = user_identity(agent, identity)
    docker('exec', '--user', '0', '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'], agent['_placement']['python'],
        f'{EXECUTOR_DESTINATION}/fleet_executor_profiles.py', '--root', template['path_root'], '--profile', binding['path'],
        '--uid', uid, '--gid', gid, '--initialize-empty')


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--root', required=True)
        parser.add_argument('--profile', required=True)
        parser.add_argument('--uid', type=int, required=True)
        parser.add_argument('--gid', type=int, required=True)
        parser.add_argument('--initialize-empty', action='store_true')
        args = parser.parse_args()
        prepare_empty_profile(args.root, args.profile, args.uid, args.gid, initialize_empty=args.initialize_empty)
    except Exception:
        raise SystemExit('provider profile preparation was not verified') from None
