from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import stat

RECIPES = {'install': 'runtime-package', 'authenticate': 'provider-login', 'execute': 'native-execution',
           'update': 'provider-update', 'quota': 'quota-collector'}
HARNESS_ID = re.compile(r'[a-z][a-z0-9_-]{0,63}')
ARGV0 = re.compile(r'/usr/local/bin/[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}')
ARGUMENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_@%+=:,./-]{0,255}|--[A-Za-z0-9][A-Za-z0-9_-]{0,253}|-[A-Za-z0-9_-]{1,254}|/[A-Za-z0-9_@%+=:,./-]{0,255}')
NPM_PACKAGE = re.compile(r'(@[a-z0-9][a-z0-9._-]{0,63}/)?[a-z0-9][a-z0-9._-]{0,127}')
PROVIDER_FIELDS = {'authenticate_argv', 'quota_argv', 'verify_argv', 'update_package', 'fleet_module'}
PIN = re.compile(r'[a-f0-9]{64}')


class HarnessOperationFailure(ValueError):
    pass


def fail(field: str, reason: str):
    raise HarnessOperationFailure(f'{field}: {reason}')


def open_descriptor_directory(bundle_directory: str) -> int:
    root = pathlib.PurePosixPath(bundle_directory)
    if not root.is_absolute() or str(root) != bundle_directory or '..' in root.parts:
        fail('bundle_directory', 'must be an absolute path without parent references')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in (*root.parts[1:], 'packages', 'adapter-sdk', 'dist', 'descriptors'):
            try:
                following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            except OSError as error:
                os.close(descriptor)
                fail('descriptors', f'cannot open {component!r} without following links ({error.__class__.__name__})')
            os.close(descriptor)
            descriptor = following
            details = os.fstat(descriptor)
            sticky = component == 'tmp' and details.st_uid == 0 and details.st_mode & stat.S_ISVTX
            if details.st_uid not in (0, os.geteuid()) or details.st_mode & 0o022 and not sticky:
                os.close(descriptor)
                fail('descriptors', f'directory {component!r} has an unsafe owner or mode')
        return descriptor
    except HarnessOperationFailure:
        raise
    except BaseException:
        os.close(descriptor)
        raise


def descriptor_names(bundle_directory: str) -> frozenset:
    descriptor = open_descriptor_directory(bundle_directory)
    try:
        return frozenset(entry[:-5] for entry in os.listdir(descriptor)
                         if entry.endswith('.json') and HARNESS_ID.fullmatch(entry[:-5]))
    finally:
        os.close(descriptor)


def validate_argv(field: str, value) -> list:
    if not isinstance(value, list) or not 1 <= len(value) <= 8:
        fail(field, 'must be a list of 1 to 8 arguments')
    for index, argument in enumerate(value):
        if not isinstance(argument, str):
            fail(f'{field}[{index}]', 'must be a string')
    if not ARGV0.fullmatch(value[0]):
        fail(f'{field}[0]', 'must be an absolute executable path under /usr/local/bin')
    for index, argument in enumerate(value[1:], 1):
        if not ARGUMENT.fullmatch(argument):
            fail(f'{field}[{index}]', 'contains shell metacharacters or unsafe characters')
        if '..' in pathlib.PurePosixPath(argument).parts:
            fail(f'{field}[{index}]', 'must not contain parent directory segments')
        if argument.startswith('/') and not argument.startswith(('/usr/local/bin/', '/home/node/')):
            fail(f'{field}[{index}]', 'absolute paths are limited to /usr/local/bin and /home/node')
    return list(value)


def validate_provider(operations: dict, provider, harness: str) -> dict:
    if not isinstance(provider, dict):
        fail('provider', 'must be an object')
    for field in provider:
        if field not in PROVIDER_FIELDS:
            fail(f'provider.{field}', 'unknown field')
    validated = {}
    if 'authenticate_argv' in provider:
        validated['authenticate_argv'] = validate_argv('provider.authenticate_argv', provider['authenticate_argv'])
    if 'quota_argv' in provider:
        validated['quota_argv'] = validate_argv('provider.quota_argv', provider['quota_argv'])
    if 'verify_argv' in provider:
        validated['verify_argv'] = validate_argv('provider.verify_argv', provider['verify_argv'])
    if 'update_package' in provider:
        package = provider['update_package']
        if not isinstance(package, str) or not NPM_PACKAGE.fullmatch(package) or package.endswith('.tgz'):
            fail('provider.update_package', 'must be an npm package name')
        validated['update_package'] = package
    if 'fleet_module' in provider:
        module = provider['fleet_module']
        if module is not None and module != f'fleet_provider_{harness}':
            fail('provider.fleet_module', f"must be null or exactly 'fleet_provider_{harness}'")
        validated['fleet_module'] = module
    if 'authenticate' in operations and 'authenticate_argv' not in validated and not validated.get('fleet_module'):
        fail('provider.authenticate_argv', 'required when operations.authenticate is declared without a fleet module')
    if 'quota' in operations and 'quota_argv' not in validated:
        fail('provider.quota_argv', 'required when operations.quota is declared')
    if 'update' in operations and 'update_package' not in validated:
        fail('provider.update_package', 'required when operations.update is declared')
    if 'authenticate_argv' in validated and 'authenticate' not in operations:
        fail('provider.authenticate_argv', 'declared without operations.authenticate')
    if 'quota_argv' in validated and 'quota' not in operations:
        fail('provider.quota_argv', 'declared without operations.quota')
    if 'verify_argv' in validated and 'authenticate' not in operations:
        fail('provider.verify_argv', 'declared without operations.authenticate')
    if 'update_package' in validated and 'update' not in operations:
        fail('provider.update_package', 'declared without operations.update')
    return validated


def read_descriptor(bundle_directory: str, harness: str, expected_sha256: str | None = None) -> tuple[dict, str]:
    if not isinstance(harness, str) or not HARNESS_ID.fullmatch(harness):
        fail('harness', 'must match [a-z][a-z0-9_-]{0,63}')
    descriptor = open_descriptor_directory(bundle_directory)
    try:
        if harness not in {entry[:-5] for entry in os.listdir(descriptor) if entry.endswith('.json')}:
            fail(f'descriptors/{harness}.json', 'descriptor is not present in the bundle')
        try:
            file_fd = os.open(harness + '.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        except OSError as error:
            fail(f'descriptors/{harness}.json', f'cannot open without following links ({error.__class__.__name__})')
        try:
            details = os.fstat(file_fd)
            if not stat.S_ISREG(details.st_mode) or details.st_uid not in (0, os.geteuid()) \
                    or details.st_mode & 0o022 or details.st_nlink != 1 or details.st_size > 16384:
                fail(f'descriptors/{harness}.json', 'descriptor has an unsafe identity (type, owner, mode, links or size)')
            with os.fdopen(file_fd, 'rb', closefd=False) as stream:
                raw = stream.read(16385)
            if len(raw) > 16384 or os.fstat(file_fd).st_mtime_ns != details.st_mtime_ns:
                fail(f'descriptors/{harness}.json', 'descriptor changed during its read')
        finally:
            os.close(file_fd)
    finally:
        os.close(descriptor)
    fingerprint = hashlib.sha256(raw).hexdigest()
    if expected_sha256 is not None and (not isinstance(expected_sha256, str)
            or PIN.fullmatch(expected_sha256) is None or fingerprint != expected_sha256):
        raise HarnessOperationFailure('approved harness descriptor changed')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        fail(f'descriptors/{harness}.json', 'descriptor is not valid JSON')
    if not isinstance(value, dict):
        fail('$', 'descriptor must be an object')
    for field in value:
        if field not in {'schema_version', 'harness', 'operations', 'context', 'provider'}:
            fail(field, 'unknown field')
    if type(value.get('schema_version')) is not int or value.get('schema_version') != 1:
        fail('schema_version', 'must be 1')
    if value.get('harness') != harness:
        fail('harness', 'descriptor identity differs from its file name')
    operations = value.get('operations')
    if not isinstance(operations, dict):
        fail('operations', 'must be an object')
    for name, recipe in operations.items():
        if name not in RECIPES:
            fail(f'operations.{name}', 'unknown lifecycle operation')
        if recipe != RECIPES[name]:
            fail(f'operations.{name}', f'must be the {RECIPES[name]!r} recipe')
    if operations.get('execute') != RECIPES['execute']:
        fail('operations.execute', 'native execution is required')
    context = value.get('context')
    if not isinstance(context, dict) or set(context) != {'native_document', 'max_bytes'}:
        fail('context', 'must declare exactly native_document and max_bytes')
    if not isinstance(context['native_document'], str) or context['native_document'] not in {'AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'none'}:
        fail('context.native_document', 'must be AGENTS.md, CLAUDE.md, SOUL.md or none')
    if type(context['max_bytes']) is not int or not 1024 <= context['max_bytes'] <= 262144:
        fail('context.max_bytes', 'must be an integer between 1024 and 262144')
    if 'provider' in value:
        value['provider'] = validate_provider(operations, value['provider'], harness)
    else:
        validate_provider(operations, {}, harness)
    return value, fingerprint


def resolve_operation(harness: str, operation: str, bundle_directory: str,
                      expected_sha256: str | None = None) -> dict:
    if operation not in RECIPES:
        fail(f'operations.{operation}', 'unknown lifecycle operation')
    descriptor, fingerprint = read_descriptor(bundle_directory, harness, expected_sha256=expected_sha256)
    if operation not in descriptor['operations']:
        fail(f'operations.{operation}', 'operation is not declared by this harness descriptor')
    return {'harness': harness, 'operation': operation, 'recipe': descriptor['operations'][operation],
            'descriptor_sha256': fingerprint}


def lifecycle_plan(harness: str, operation: str, bundle_directory: str,
                   expected_sha256: str | None = None) -> dict:
    request = resolve_operation(harness, operation, bundle_directory, expected_sha256=expected_sha256)
    driver = {'install': ('fleet-runtime', 'artifacts'), 'execute': ('fleet-runtime', 'runtime'),
              'authenticate': ('fleet-provider-hook', 'authenticate'), 'update': ('quota-runtime', 'update_cli'),
              'quota': ('quota-runtime', 'query')}[operation]
    return {**request, 'driver': driver[0], 'action': driver[1]}


def provider_command(harness: str, operation: str, bundle_directory: str,
                     expected_sha256: str | None = None) -> list[str]:
    descriptor, _ = read_descriptor(bundle_directory, harness, expected_sha256=expected_sha256)
    if operation not in RECIPES:
        fail(f'operations.{operation}', 'unknown lifecycle operation')
    if operation not in descriptor['operations']:
        fail(f'operations.{operation}', 'operation is not declared by this harness descriptor')
    provider = descriptor.get('provider') or {}
    if operation == 'authenticate':
        if 'authenticate_argv' not in provider:
            fail('provider.authenticate_argv', 'authentication is fleet-driven for this harness and has no provider login command')
        return list(provider['authenticate_argv'])
    if operation == 'quota':
        return list(provider['quota_argv'])
    if operation == 'update':
        return ['/usr/local/bin/npm', 'install', '--global', '--prefix', '/home/node/.local',
                '--ignore-scripts', '--no-audit', '--no-fund', provider['update_package']]
    fail(f'operations.{operation}', 'operation has no provider command')


def provider_verify_command(harness: str, bundle_directory: str,
                            expected_sha256: str | None = None) -> list[str] | None:
    descriptor, _ = read_descriptor(bundle_directory, harness, expected_sha256=expected_sha256)
    if 'authenticate' not in descriptor['operations']:
        fail('operations.authenticate', 'operation is not declared by this harness descriptor')
    command = (descriptor.get('provider') or {}).get('verify_argv')
    return list(command) if command is not None else None


def fleet_module(harness: str, bundle_directory: str, expected_sha256: str | None = None) -> str | None:
    descriptor, _ = read_descriptor(bundle_directory, harness, expected_sha256=expected_sha256)
    return (descriptor.get('provider') or {}).get('fleet_module')


def operation_capabilities(harness: str, bundle_directory: str,
                           expected_sha256: str | None = None) -> dict:
    """Per-operation availability with the field and reason when unavailable."""
    try:
        descriptor, _ = read_descriptor(bundle_directory, harness, expected_sha256=expected_sha256)
    except HarnessOperationFailure as error:
        return {operation: {'available': False, 'reason': str(error)} for operation in RECIPES}
    provider = descriptor.get('provider') or {}
    capabilities = {}
    for operation in RECIPES:
        if operation not in descriptor['operations']:
            capabilities[operation] = {'available': False,
                                       'reason': f'operations.{operation}: operation is not declared by this harness descriptor'}
        elif operation == 'authenticate' and 'authenticate_argv' not in provider:
            capabilities[operation] = {'available': False,
                                       'reason': 'provider.authenticate_argv: authentication is fleet-driven for this harness and has no provider login command'}
        else:
            capabilities[operation] = {'available': True, 'reason': None}
    return capabilities
