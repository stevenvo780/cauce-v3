from __future__ import annotations

import hashlib
import json
import os
import pathlib
import stat

RECIPES = {'install': 'runtime-package', 'authenticate': 'provider-login', 'execute': 'native-execution',
           'update': 'provider-update', 'quota': 'quota-collector'}
HARNESSES = frozenset({'claude', 'codex', 'hermes', 'opencode', 'openclaw', 'grok', 'muse', 'fake'})
PACKAGES = {'claude': '@anthropic-ai/claude-code', 'codex': '@openai/codex', 'grok': '@xai-official/grok'}
LOGIN = {'claude': ('/usr/local/bin/claude', 'auth', 'login'),
         'codex': ('/usr/local/bin/codex', 'login', '--device-auth'),
         'grok': ('/usr/local/bin/grok', 'login', '--device-auth')}
QUOTA = {'claude': ('node', '/usr/local/bin/leer-cuota.mjs'),
         'codex': ('python3', '/usr/local/bin/codex-http-probe.py', '/home/node/.codex'),
         'grok': ('node', '/usr/local/bin/leer-cuota-grok.mjs')}


class HarnessOperationFailure(ValueError):
    pass


def read_descriptor(bundle_directory: str, harness: str) -> tuple[dict, str]:
    root = pathlib.PurePosixPath(bundle_directory)
    if harness not in HARNESSES or not root.is_absolute() or str(root) != bundle_directory or '..' in root.parts:
        raise HarnessOperationFailure('harness bundle scope is unavailable')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in (*root.parts[1:], 'packages', 'adapter-sdk', 'dist', 'descriptors'):
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
            details = os.fstat(descriptor)
            sticky = component == 'tmp' and details.st_uid == 0 and details.st_mode & stat.S_ISVTX
            if details.st_uid not in (0, os.geteuid()) or details.st_mode & 0o022 and not sticky:
                raise HarnessOperationFailure('harness bundle directory has an unsafe owner or mode')
        file_fd = os.open(harness + '.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            details = os.fstat(file_fd)
            if not stat.S_ISREG(details.st_mode) or details.st_uid not in (0, os.geteuid()) \
                    or details.st_mode & 0o022 or details.st_nlink != 1 or details.st_size > 16384:
                raise HarnessOperationFailure('harness descriptor has an unsafe identity')
            with os.fdopen(file_fd, 'rb', closefd=False) as stream:
                raw = stream.read(16385)
            if len(raw) > 16384 or os.fstat(file_fd).st_mtime_ns != details.st_mtime_ns:
                raise HarnessOperationFailure('harness descriptor changed during its read')
        finally:
            os.close(file_fd)
    finally:
        os.close(descriptor)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise HarnessOperationFailure('harness descriptor is invalid') from None
    if not isinstance(value, dict) or set(value) != {'schema_version', 'harness', 'operations', 'context'} \
            or type(value['schema_version']) is not int or value['schema_version'] != 1 or value['harness'] != harness:
        raise HarnessOperationFailure('harness descriptor identity differs')
    operations = value['operations']
    context = value['context']
    if not isinstance(operations, dict) or operations.get('execute') != RECIPES['execute'] \
            or any(name not in RECIPES or recipe != RECIPES[name] for name, recipe in operations.items()) \
            or not isinstance(context, dict) or set(context) != {'native_document', 'max_bytes'} \
            or context['native_document'] not in {'AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'none'} \
            or type(context['max_bytes']) is not int or not 1024 <= context['max_bytes'] <= 262144:
        raise HarnessOperationFailure('harness descriptor recipe or context is invalid')
    return value, hashlib.sha256(raw).hexdigest()


def resolve_operation(harness: str, operation: str, bundle_directory: str) -> dict:
    descriptor, fingerprint = read_descriptor(bundle_directory, harness)
    if operation not in RECIPES or operation not in descriptor['operations']:
        raise HarnessOperationFailure('harness lifecycle operation is unsupported')
    return {'harness': harness, 'operation': operation, 'recipe': descriptor['operations'][operation],
            'descriptor_sha256': fingerprint}


def lifecycle_plan(harness: str, operation: str, bundle_directory: str) -> dict:
    request = resolve_operation(harness, operation, bundle_directory)
    driver = {'install': ('fleet-runtime', 'artifacts'), 'execute': ('fleet-runtime', 'runtime'),
              'authenticate': ('fleet-provider-hook', 'authenticate'), 'update': ('quota-runtime', 'update_cli'),
              'quota': ('quota-runtime', 'query')}[operation]
    return {**request, 'driver': driver[0], 'action': driver[1]}


def provider_command(harness: str, operation: str, bundle_directory: str) -> list[str]:
    resolve_operation(harness, operation, bundle_directory)
    if operation == 'authenticate' and harness in LOGIN:
        return list(LOGIN[harness])
    if operation == 'quota' and harness in QUOTA:
        return list(QUOTA[harness])
    if operation == 'update' and harness in PACKAGES:
        return ['npm', 'install', '--global', '--prefix', '/home/node/.local', '--ignore-scripts', '--no-audit', '--no-fund', PACKAGES[harness]]
    raise HarnessOperationFailure('verified provider command is unavailable for this harness operation')
