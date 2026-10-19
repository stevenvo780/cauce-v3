from __future__ import annotations

import contextlib
import contextvars
import json
import os
import pathlib
import re
import sys

from fleet_executor_policy import SafeFailure, private_directory

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from atomic_file import atomic_write  # noqa: E402

OPERATION = contextvars.ContextVar('image_refresh_operation', default=None)
LEGACY_REFRESH = contextvars.ContextVar('image_refresh_legacy_target', default=False)


@contextlib.contextmanager
def image_operation(operation_id: str, *, legacy_target: bool = False):
    token = OPERATION.set(operation_id)
    legacy_token = LEGACY_REFRESH.set(legacy_target)
    try:
        yield
    finally:
        OPERATION.reset(token)
        LEGACY_REFRESH.reset(legacy_token)


@contextlib.contextmanager
def image_guard(container_id: str):
    from provider_login_container import LoginFailure, runtime_guard
    try:
        with runtime_guard(container_id):
            yield
    except LoginFailure:
        raise SafeFailure('provider login session is open or unverified; image refresh refused') from None


def receipt_path(policy: dict, agent: dict) -> pathlib.Path:
    directory = pathlib.Path(policy['roots']['state']) / 'image-refresh'
    directory.mkdir(mode=0o700, exist_ok=True)
    private_directory(str(directory))
    return directory / (agent['runtime_key'] + '.json')


def append_event(filename: pathlib.Path, event: dict) -> None:
    from provider_login_state import checked_file, private_state
    directory = private_state(str(filename.parent))
    try:
        descriptor = checked_file(directory, filename.name, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
        try:
            body = memoryview((json.dumps(event, sort_keys=True) + '\n').encode())
            while body:
                written = os.write(descriptor, body)
                if written <= 0:
                    raise SafeFailure('image refresh event could not be persisted')
                body = body[written:]
            os.fsync(descriptor)
            os.fsync(directory)
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)


def remember(policy: dict, agent: dict, receipt: dict) -> None:
    body = json.dumps(receipt, sort_keys=True).encode()
    filename = receipt_path(policy, agent)
    atomic_write(filename, body, mode=0o600)
    operation = OPERATION.get()
    event = {'event': 'container_image_refresh', **receipt, 'operation_id': operation}
    append_event(filename.with_suffix('.events.jsonl'), event)
    if operation is not None:
        directory = pathlib.Path(policy['roots']['state']) / 'operations' / operation
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        private_directory(str(directory))
        atomic_write(directory / ('image-refresh-' + agent['runtime_key'] + '.json'), body, mode=0o600)
        append_event(directory / ('image-refresh-' + agent['runtime_key'] + '.events.jsonl'), event)
    print(json.dumps(event, sort_keys=True), file=sys.stderr)


def previous_agent(agent: dict, image: str) -> dict:
    if not isinstance(image, str) or re.fullmatch(r'sha256:[0-9a-f]{64}', image) is None:
        raise SafeFailure('previous container has no exact image digest')
    return {**agent, '_placement': {**agent['_placement'], 'image': image}}


def validate_previous(policy: dict, agent: dict, observed: dict, release: pathlib.Path | None = None) -> dict:
    from fleet_executor_container import RELEASE_ROOT, runtime_mounts, validate_container
    from fleet_executor_rebind import bound_release
    previous = previous_agent(agent, observed.get('Image'))
    release = release or RELEASE_ROOT
    root = bound_release(observed, release)
    validate_container(policy, previous, observed, runtime_mounts(policy, agent, root or release, release))
    return previous


def assert_persistent_profile(policy: dict, agent: dict) -> None:
    if agent.get('primary_account_id') is None:
        return
    from fleet_executor_templates import resolve_profile
    binding = resolve_profile(policy, agent)
    profile = pathlib.PurePosixPath(binding['path'])
    roots = [agent['_placement'][key] for key in ('state_root', 'profile_root') if agent['_placement'].get(key)]
    if not any(profile.is_relative_to(pathlib.PurePosixPath(root)) for root in roots):
        raise SafeFailure('provider session is outside persistent runtime volumes; image refresh refused')


def assert_no_login(agent: dict, observed: dict) -> None:
    from provider_login_container import assert_unreserved
    assert_unreserved(observed['Id'])
    if not observed['State']['Running']:
        return
    from fleet_executor_container import docker
    # Older login helpers do not hold the host guard; pending metadata also blocks replacement.
    script = ('import os,sys; p="/run/cauce-provider-login"; '
              'sys.exit(1) if os.path.lexists(p) and (os.path.islink(p) or not os.path.isdir(p) '
              'or any(n.endswith((".lock",".json")) for n in os.listdir(p))) else print("clear")')
    if docker('exec', '-w', '/', '--user', '0', observed['Id'], agent['_placement']['python'], '-I', '-B', '-c', script).strip() != b'clear':
        raise SafeFailure('provider login session is open or unverified; image refresh refused')


def restore_previous(policy: dict, agent: dict, receipt: dict, release: pathlib.Path | None = None) -> None:
    from fleet_executor_container import docker, inspect_container, ownership_labels_match
    name = agent['container_name']
    backup = inspect_container(name + '-image-rollback')
    current = inspect_container(name)
    original = backup or current
    if original is None or original['Id'] != receipt['previous_id'] or original['Image'] != receipt['previous_image']:
        raise SafeFailure('image refresh rollback requires the preserved original container')
    validate_previous(policy, agent, original, release)
    if backup is not None:
        if current is not None:
            with image_guard(current['Id']):
                if not ownership_labels_match(policy, agent, current) or current['Image'] != receipt['image']:
                    raise SafeFailure('image refresh rollback found another runtime owner or image')
                assert_no_login(agent, current)
                docker('rm', '-f', current['Id'])
        docker('rename', backup['Id'], name)
    current = inspect_container(name)
    if receipt['was_running'] and not current['State']['Running']:
        docker('start', current['Id'])
        current = inspect_container(name)
        if current is None or not current['State']['Running'] or current['State']['Pid'] <= 0:
            raise SafeFailure('restored original container is not observed running')
    remember(policy, agent, {**receipt, 'status': 'rolled_back'})


def recover_image(policy: dict, agent: dict, release: pathlib.Path | None = None) -> None:
    from fleet_executor_container import docker, inspect_container, validate_container
    root = policy.get('roots', {}).get('state')
    if root is None:
        return
    filename = pathlib.Path(root) / 'image-refresh' / (agent['runtime_key'] + '.json')
    if not filename.exists():
        return
    if filename.is_symlink():
        raise SafeFailure('image refresh receipt is not a regular owned file')
    receipt = json.loads(filename.read_bytes())
    expected = {'host_id': policy['host_id'], 'tenant_id': agent['tenant_id'],
                'runtime_key': agent['runtime_key'], 'container_name': agent['container_name']}
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise SafeFailure('image refresh recovery belongs to another runtime')
    if receipt['status'] == 'prepared':
        with image_guard(receipt['previous_id']):
            restore_previous(policy, agent, receipt, release)
    elif receipt['status'] == 'succeeded':
        backup = inspect_container(agent['container_name'] + '-image-rollback')
        if backup is not None:
            with image_guard(receipt['previous_id']):
                validate_container(policy, agent, inspect_container(agent['container_name']))
                validate_previous(policy, agent, backup)
                if backup['Id'] != receipt['previous_id'] or backup['State']['Running']:
                    raise SafeFailure('image refresh backup identity or state differs')
                docker('rm', backup['Id'])


def refresh_image(policy: dict, agent: dict, observed: dict, release: pathlib.Path | None = None) -> dict:
    from fleet_executor_container import (
        create_container,
        docker,
        inspect_container,
        owned_volumes,
        runtime_mounts,
        stop_running_adapter,
        validate_container,
    )
    from provider_login_container import LoginFailure
    with image_guard(observed['Id']):
        current = inspect_container(agent['container_name'])
        if current is None or current['Id'] != observed['Id']:
            raise SafeFailure('container changed before image refresh')
        previous = validate_previous(policy, agent, current, release)
        executor = next(row['Source'] for row in current['Mounts'] if row['Destination'] == '/cauce/executor')
        if current['State']['Running'] and not (pathlib.Path(executor) / 'fleet_executor_image.py').is_file() \
                and not LEGACY_REFRESH.get():
            raise SafeFailure('legacy login reservations are unavailable; refresh requires an explicit agent operation')
        assert_persistent_profile(policy, agent)
        owned_volumes(policy, agent)
        try:
            assert_no_login(agent, current)
        except (SafeFailure, LoginFailure):
            raise SafeFailure('provider login session is open or unverified; image refresh refused') from None
        image = agent['_placement']['image']
        if json.loads(docker('image', 'inspect', image))[0]['Id'] != image:
            raise SafeFailure('approved image digest is unavailable')
        backup = agent['container_name'] + '-image-rollback'
        if inspect_container(backup) is not None:
            raise SafeFailure('image refresh backup already exists; recovery required')
        receipt = {'host_id': policy['host_id'], 'tenant_id': agent['tenant_id'], 'runtime_key': agent['runtime_key'],
                   'container_name': agent['container_name'], 'previous_id': current['Id'], 'previous_image': current['Image'],
                   'image': image, 'was_running': current['State']['Running'], 'status': 'prepared'}
        remember(policy, agent, receipt)
        try:
            stop_running_adapter(previous, current)
            if current['State']['Running']:
                docker('stop', current['Id'])
            docker('rename', current['Id'], backup)
            binds = runtime_mounts(policy, agent, release, release) if release else None
            # Keep the operation that created it: cancelling that operation must still find and discard it.
            replacement = create_container(policy, agent, binds,
                                           operation_id=(current['Config'].get('Labels') or {}).get('cauce.fleet.operation'))
            if receipt['was_running']:
                docker('start', replacement['Id'])
                replacement = inspect_container(agent['container_name'])
                if replacement is None or not replacement['State']['Running'] or replacement['State']['Pid'] <= 0:
                    raise SafeFailure('refreshed container is not observed running')
            validate_container(policy, agent, replacement, binds)
        except BaseException as error:
            try:
                restore_previous(policy, agent, receipt, release)
            except BaseException:
                raise SafeFailure('image refresh failed; original container preserved for recovery') from error
            raise SafeFailure('image refresh failed; original container restored and volumes preserved') from error
        remember(policy, agent, {**receipt, 'status': 'succeeded', 'container_id': replacement['Id']})
        docker('rm', current['Id'])
        return replacement
