from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import sys
import time


class ProviderProofError(ValueError):
    pass


# Grok spends ~10 s starting (memory_init) before it reasons. The in-container hook's docker exec waits 110 s
# and grok adds up to 10 s of userinfo after the round trip.
ROUNDTRIP_TIMEOUT = 90


NON_HARNESS_MODULES = frozenset({'identity', 'probe', 'revoke'})


def resolve_fleet_module(policy: dict, harness: str) -> str | None:
    """Fleet module named by provider.fleet_module in the harness descriptor of
    its approved bundle. Policies without a bundle entry (unit contexts) fall
    back to a same-named module shipped beside the executor."""
    bundle = (policy.get('bundles') or {}).get(harness)
    directory = bundle.get('directory') if isinstance(bundle, dict) else None
    if isinstance(directory, str):
        from harness_operations import HarnessOperationFailure, fleet_module
        if 'digest' in bundle:
            from fleet_executor_runtime import bundle_digest
            try:
                actual = bundle_digest(directory)
            except (OSError, RuntimeError) as error:
                raise HarnessOperationFailure('bundle digest: approved bundle is unavailable') from error
            if actual != bundle['digest']:
                raise HarnessOperationFailure('bundle digest: approved bundle changed')
        module = fleet_module(harness, directory, expected_sha256=bundle.get('descriptor_sha256'))
        if module is not None and not (pathlib.Path(__file__).resolve().parent / f'{module}.py').is_file():
            raise HarnessOperationFailure(
                f'provider.fleet_module: module {module} is not present beside the executor')
        return module
    if re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', harness or '') is None or harness in NON_HARNESS_MODULES:
        return None
    candidate = f'fleet_provider_{harness}'
    return candidate if (pathlib.Path(__file__).resolve().parent / f'{candidate}.py').is_file() else None


def packet_fleet_module(packet: dict) -> str | None:
    if 'fleet_module' in packet:
        module = packet['fleet_module']
        expected = f"fleet_provider_{packet['agent']['harness_id']}"
        if module is not None and module != expected:
            raise ProviderProofError('packet fleet module differs from its harness')
        return module
    return resolve_fleet_module({}, packet['agent']['harness_id'])


def jwt_claims(token: str) -> dict:
    segment = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4)))


def read_profile_json(filename: str):
    """Bounded read of a profile credential document; never logged or returned whole."""
    try:
        with open(filename, 'rb') as stream:
            raw = stream.read(262145)
        if len(raw) > 262144:
            return None
        return json.loads(raw)
    except (OSError, ValueError):
        return None


def profile_jwt_candidates(filename: str) -> list:
    """JWT-shaped strings in a credential file. These are only hints: a token
    proves identity only after its signature verifies against the provider JWKS."""
    document = read_profile_json(filename)
    if document is None:
        return []
    candidates = []
    pending = [document]
    seen = 0
    while pending and seen < 256:
        value = pending.pop()
        seen += 1
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str) and value.count('.') == 2:
            candidates.append(value)
    return candidates


def nonce_roundtrip(packet: dict, arguments, extract) -> bool:
    """Functional proof: the pinned provider CLI must echo the packet nonce.
    The prompt file is private, bounded to the state directory and removed."""
    from fleet_policy_paths import path
    agent = packet['agent']
    expected = 'CAUCE_BOOTSTRAP_' + packet['nonce']
    prompt = path(agent['state_directory']) / f".cauce-auth-prompt-{packet['nonce'][:16]}"
    descriptor = os.open(prompt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(f'Responde únicamente {expected}.')
        output = command_output([provider_command(packet), *arguments(str(prompt))], packet, ROUNDTRIP_TIMEOUT)
        return extract(output) == expected
    finally:
        try:
            prompt.unlink()
        except OSError:
            pass


def validate_provider_binding(binding: dict, agent: dict, provider: str) -> pathlib.Path:
    from fleet_policy_paths import path
    if not isinstance(binding, dict) or binding.get('provider') != provider or agent.get('harness_id') != provider \
            or binding.get('runtime_user') != agent.get('runtime_user') or 'openclaw' in binding \
            or ('muse' in binding) != (provider == 'muse'):
        raise ProviderProofError('provider profile differs from its exact runtime identity')
    root = path(binding.get('path'))
    home = path(agent['home_directory'])
    state = path(agent['state_directory'])
    if root in {pathlib.Path('/'), home, home / '.grok', home / '.config/muse'} \
            or root.is_relative_to(state) or state.is_relative_to(root):
        raise ProviderProofError('provider profile must be dedicated to the approved account')
    path(binding.get('command'))
    if not isinstance(binding.get('command_sha256'), str) or re.fullmatch(r'[a-f0-9]{64}', binding['command_sha256']) is None:
        raise ProviderProofError('provider command has no exact pin')
    return root


def validate_provider_selection(agent: dict, provider: str, efforts: frozenset[str]) -> None:
    model = agent.get('model_id')
    effort = agent.get('reasoning_effort')
    if agent.get('harness_id') != provider or (model is not None and (not isinstance(model, str)
            or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}', model) is None)) \
            or (effort is not None and (not isinstance(effort, str) or effort not in efforts)):
        raise ProviderProofError('provider model or reasoning effort is not supported')


def pinned_descriptor(filename: str) -> int:
    parts = pathlib.PurePosixPath(filename).parts
    if not filename.startswith("/") or ".." in parts or str(pathlib.PurePosixPath(filename)) != filename:
        raise ProviderProofError("provider pin path is not canonical")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            metadata = os.fstat(directory)
            if metadata.st_uid not in {0, os.geteuid()} or (metadata.st_mode & 0o022 and not metadata.st_mode & stat.S_ISVTX):
                raise ProviderProofError("provider pin ancestor is writable")
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)


def stop_process_group(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def provider_command(packet: dict) -> str:
    binding = packet["profile_binding"]
    command = binding.get("command")
    fingerprint = binding.get("command_sha256")
    if not isinstance(command, str) or not command.startswith("/") or ".." in pathlib.PurePosixPath(command).parts:
        raise ProviderProofError("approved provider executable is unavailable")
    files = binding.get('command_files', {})
    if not isinstance(files, dict) or len(files) > 32:
        raise ProviderProofError('provider command files exceed their approved bound')
    files = dict(files)
    if command in files and files[command] != fingerprint:
        raise ProviderProofError('provider command has conflicting pins')
    files[command] = fingerprint
    if 'muse' in binding:
        from fleet_provider_muse import validate_definition
        validate_definition(binding.get('muse'), binding.get('provider'))
        bridge = binding['muse']
        if bridge['bridge'] in files and files[bridge['bridge']] != bridge['bridge_sha256']:
            raise ProviderProofError('Muse bridge has conflicting pins')
        files[bridge['bridge']] = bridge['bridge_sha256']
    for filename, expected in files.items():
        descriptor = pinned_descriptor(filename)
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid not in {0, os.geteuid()}
                or metadata.st_mode & 0o022
            ):
                raise ProviderProofError("provider executable ownership or mode changed")
            value = hashlib.sha256()
            while chunk := os.read(descriptor, 65536):
                value.update(chunk)
            if value.hexdigest() != expected:
                raise ProviderProofError("provider executable pin changed")
        finally:
            os.close(descriptor)
    return command


def command_output(command: list[str], packet: dict, timeout: int = 30) -> bytes:
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": packet["agent"]["home_directory"],
    }
    binding = packet["profile_binding"]
    module_name = packet_fleet_module(packet)
    variable = None
    if module_name:
        from importlib import import_module
        try:
            module = import_module(module_name)
        except ImportError:
            raise ProviderProofError("fleet provider module is unavailable") from None
        environment.update(module.environment(binding, packet['agent']))
        environment.update(getattr(module, 'INSPECTION_ENV', {}))
        environment['PATH'] = '/usr/bin:/bin'
    else:
        variable = {"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR"}.get(binding["provider"])
        if variable is None:
            raise ProviderProofError("provider identity inspection is unavailable")
    if variable is not None:
        environment[variable] = binding["path"]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
        cwd=packet["agent"]["state_directory"], start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, True)
    selector.register(process.stderr, selectors.EVENT_READ, False)
    deadline = time.monotonic() + timeout
    output = bytearray()
    total = 0
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderProofError("provider command timed out")
            for key, _ in selector.select(remaining):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                total += len(chunk)
                if total > 262144:
                    raise ProviderProofError("provider command output exceeded limit")
                if key.data:
                    output.extend(chunk)
        if process.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
            raise ProviderProofError("provider command failed")
        return bytes(output)
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
        stop_process_group(process)


def codex_identity(packet: dict) -> str:
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": packet["agent"]["home_directory"],
        "CODEX_HOME": packet["profile_binding"]["path"],
    }
    process = subprocess.Popen(
        [provider_command(packet), "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=environment,
        cwd=packet["agent"]["state_directory"],
        start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    pending = b""
    deadline = time.monotonic() + 15

    def send(value):
        process.stdin.write(json.dumps(value).encode() + b"\n")
        process.stdin.flush()

    def receive(identifier):
        nonlocal pending
        while time.monotonic() < deadline:
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                decoded = json.loads(line)
                if decoded.get("id") == identifier:
                    if "error" in decoded:
                        raise ProviderProofError("provider identity query failed")
                    return decoded.get("result")
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            body = os.read(process.stdout.fileno(), 65536)
            if not body or len(pending) + len(body) > 262144:
                break
            pending += body
        raise ProviderProofError("provider identity query timed out")

    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "cauce-fleet", "version": "3.5"}}})
        receive(1)
        send({"method": "initialized"})
        send({"id": 2, "method": "account/read", "params": {"refreshToken": False}})
        result = receive(2)
        account = result.get("account") if isinstance(result, dict) else None
        if (
            not isinstance(account, dict)
            or account.get("type") != "chatgpt"
            or not isinstance(account.get("email"), str)
        ):
            raise ProviderProofError("provider account identity is unavailable")
        return account["email"]
    finally:
        selector.close()
        process.stdin.close()
        process.stdout.close()
        stop_process_group(process)


def valid_account_identity(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r'[^\x00-\x1f\x7f-\x9f]{1,256}', value) is not None \
        and not value.startswith('unverified:')


def select_account_identity(expected: str, identities) -> str | None:
    verified = [value for value in identities if valid_account_identity(value)]
    if expected in verified:
        return expected
    if isinstance(expected, str) and expected.startswith('unverified:'):
        return next(iter(verified), None)
    return None


def authenticated_identity(packet: dict) -> str | None:
    module_name = packet_fleet_module(packet)
    if module_name:
        try:
            from importlib import import_module
            identity = import_module(module_name).authenticated_identity(packet)
            return select_account_identity(packet['identity'], [identity])
        except (ImportError, OSError, ValueError, KeyError, subprocess.SubprocessError, AttributeError):
            return None
    provider = packet["profile_binding"]["provider"]
    try:
        command = provider_command(packet)
        if provider == "codex":
            identity = codex_identity(packet)
        elif provider == "claude":
            result = json.loads(command_output([command, "auth", "status", "--json"], packet))
            if result.get("loggedIn") is not True or not isinstance(result.get("email"), str):
                return None
            identity = result["email"]
        else:
            raise ProviderProofError("provider has no approved account inspection")
        identity = select_account_identity(packet['identity'], [identity])
        if identity is None:
            return None
        expected = "CAUCE_BOOTSTRAP_" + packet["nonce"]
        prompt = "Responde únicamente " + expected + ". No uses herramientas ni envíes mensajes."
        if provider == "codex":
            args = [command, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", prompt]
            output = command_output(args, packet)
            replies = [
                event["item"]["text"]
                for line in output.splitlines()
                if (event := json.loads(line)).get("type") == "item.completed"
                and event.get("item", {}).get("type") == "agent_message"
            ]
            return identity if replies == [expected] else None
        output = json.loads(
            command_output(
                [command, "-p", prompt, "--output-format", "json", "--tools", "", "--max-turns", "1"], packet
            )
        )
        return identity if output.get("is_error") is False and output.get("result") == expected else None
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


def authenticated_provider(packet: dict) -> bool:
    return authenticated_identity(packet) is not None


EXTENSION_LIMIT = 262144
MCP_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
ENV_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,127}')
COMMAND_TOKEN = re.compile(r'[^\s\x00-\x1f\x7f-\x9f]{1,512}')
NPM_PACKAGE = re.compile(r'^npm:((?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*)@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$')
PIP_PACKAGE = re.compile(r'^pip:([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.!+_-]*)$')
TOML_TABLE = re.compile(r'^\[{1,2}[^\[\]\n]+\]{1,2}\s*(#.*)?$')
INSTALL_ENV_KEYS = ('HOME', 'PATH', 'LANG', 'npm_config_prefix', 'npm_config_cache', 'npm_config_update_notifier',
                    'PYTHONUSERBASE', 'PIP_DISABLE_PIP_VERSION_CHECK')


def extension_directory(value) -> pathlib.Path:
    directory = value if isinstance(value, pathlib.Path) else pathlib.Path(value)
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise ProviderProofError('extension directory is not a real directory')
    return directory


def extension_rows(agent: dict) -> list:
    rows = agent.get('extensions')
    if rows is None:
        return []
    if not isinstance(rows, list) or len(rows) > 100 or any(not isinstance(row, dict) for row in rows):
        raise ProviderProofError('extensions must be a bounded list')
    return rows


def one_extension(rows: list, kind: str) -> dict | None:
    found = [row for row in rows if row.get('type') == kind]
    if len(found) > 1:
        raise ProviderProofError(f'extension {kind} is ambiguous')
    return found[0] if found else None


def write_private(path: pathlib.Path, body: bytes) -> None:
    if len(body) > EXTENSION_LIMIT:
        raise ProviderProofError('extension write exceeds its bound')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        if os.write(descriptor, body) != len(body):
            raise ProviderProofError('extension write was incomplete')
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        os.unlink(temporary)
        raise
    os.close(descriptor)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def read_bounded(path: pathlib.Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        return b''
    with path.open('rb') as stream:
        body = stream.read(EXTENSION_LIMIT + 1)
    if len(body) > EXTENSION_LIMIT:
        raise ProviderProofError('extension file exceeds its bound')
    return body


def command_token(value) -> str:
    if not isinstance(value, str) or COMMAND_TOKEN.fullmatch(value) is None:
        raise ProviderProofError('mcp command is outside the contract')
    return value


def argument_list(value) -> list:
    if not isinstance(value, list) or len(value) > 100 or any(
            not isinstance(item, str) or len(item) > 4096 or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in item)
            for item in value):
        raise ProviderProofError('mcp args are outside the contract')
    return list(value)


def environment_map(value) -> dict:
    """Env carries names or ${NAME} references. A literal value is rejected."""
    if value is None or value == [] or value == {}:
        return {}
    if isinstance(value, list):
        if any(not isinstance(item, str) or ENV_NAME.fullmatch(item) is None for item in value):
            raise ProviderProofError('mcp env must name profile variables')
        return {item: '${' + item + '}' for item in value}
    if isinstance(value, dict) and all(isinstance(key, str) and ENV_NAME.fullmatch(key) is not None and item == '${' + key + '}'
                                        for key, item in value.items()):
        return dict(value)
    raise ProviderProofError('mcp env must reference profile variables')


def mcp_entry(row: dict) -> dict:
    if set(row) != {'type', 'name', 'command', 'args', 'env'} or MCP_NAME.fullmatch(str(row.get('name'))) is None:
        raise ProviderProofError('mcp extension is outside the contract')
    return {'name': row['name'], 'command': command_token(row['command']), 'args': argument_list(row['args']),
            'env': environment_map(row['env'])}


def public_mcp(entry: dict) -> dict:
    published = {'command': entry['command'], 'args': entry['args']}
    if entry['env']:
        published['env'] = entry['env']
    return published


def stdio_mcp(entry: dict) -> dict:
    return {'type': 'stdio', **public_mcp(entry)}


MANAGED_MCP = '.cauce-managed-mcp.json'
EXTENSION_RECEIPT = 'cauce-extension-receipt.json'
PREPARE_HARNESSES = ('claude', 'codex', 'openclaw', 'grok', 'muse')
RECEIPT_KEYS = {'extensions_sha256', 'ssh', 'mcp', 'tools', 'browser'}


def mcp_target(profile: pathlib.Path, harness: str) -> tuple[str, pathlib.Path]:
    relative = {'claude': '.claude.json', 'codex': 'config.toml', 'openclaw': 'openclaw.json', 'grok': 'config.toml',
                'muse': 'config/muse/settings.json'}.get(harness)
    if relative is None:
        raise ProviderProofError('mcp harness is outside the contract')
    return relative, profile.joinpath(*relative.split('/'))


def managed_mcp_names(profile: pathlib.Path) -> list[str]:
    path = profile / MANAGED_MCP
    if not path.exists():
        return []
    document = json.loads(read_bounded(path) or b'{}')
    names = document.get('names') if isinstance(document, dict) else None
    if not isinstance(names, list) or any(not isinstance(item, str) or MCP_NAME.fullmatch(item) is None for item in names) \
            or len(set(names)) != len(names):
        raise ProviderProofError('managed mcp registry is outside the contract')
    return list(names)


def write_managed_mcp(profile: pathlib.Path, names: list[str]) -> None:
    path = profile / MANAGED_MCP
    if not names:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ProviderProofError('managed mcp registry is not a regular file')
        if path.exists():
            path.unlink()
        return
    write_private(path, (json.dumps({'names': names}, indent=2) + '\n').encode())


def server_map(document: dict, harness: str) -> dict:
    if harness == 'openclaw':
        parent = document.setdefault('mcp', {})
        if not isinstance(parent, dict):
            raise ProviderProofError('mcp configuration is not an object')
        servers = parent.setdefault('servers', {})
    else:
        servers = document.setdefault('mcpServers', {})
    if not isinstance(servers, dict):
        raise ProviderProofError('mcp configuration is not an object')
    return servers


def write_json_mcp(path: pathlib.Path, harness: str, entries: list, remove: set[str]) -> None:
    if not entries and not remove:
        return
    if not path.exists() and not entries:
        return
    existing = path.exists()
    document = json.loads(read_bounded(path) or b'{}')
    if not isinstance(document, dict):
        raise ProviderProofError('mcp configuration is not an object')
    servers = server_map(document, harness)
    stored = public_mcp if harness == 'openclaw' else stdio_mcp
    for name in remove:
        servers.pop(name, None)
    for entry in entries:
        servers[entry['name']] = stored(entry)
    if harness == 'muse' and not existing:
        document['schema_version'] = 1
    write_private(path, (json.dumps(document, indent=2, ensure_ascii=False) + '\n').encode())


def toml_header(line: str) -> str | None:
    if TOML_TABLE.match(line.rstrip('\n')) is None:
        return None
    return line.split('#', 1)[0].strip().strip('[]')


def toml_mcp(path: pathlib.Path, harness: str, entries: list, remove: set[str]) -> None:
    import tomllib
    if any('.' in entry['name'] for entry in entries):
        raise ProviderProofError('mcp name is not a single toml key')
    if not entries and not remove:
        return
    if not path.exists() and not entries:
        return
    original = read_bounded(path).decode() if path.exists() else ''
    lines = original.splitlines(keepends=True)
    names = {entry['name'] for entry in entries} | remove
    kept, skipping = [], False
    for line in lines:
        header = toml_header(line)
        if header is not None:
            skipping = any(header == f'mcp_servers.{name}' or header.startswith(f'mcp_servers.{name}.') for name in names)
        if not skipping:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    if kept and not kept[-1].endswith('\n'):
        kept[-1] += '\n'
    blocks = []
    for entry in entries:
        body = [f'[mcp_servers.{entry["name"]}]', f'command = {json.dumps(entry["command"])}',
                'args = [', *(f'  {json.dumps(item)},' for item in entry['args']), ']']
        if harness == 'grok':
            body.append('enabled = true')
        if entry['env']:
            body.extend(['', f'[mcp_servers.{entry["name"]}.env]',
                         *(f'{key} = {json.dumps(value)}' for key, value in entry['env'].items())])
        blocks.append('\n'.join(body) + '\n')
    text = ''.join(kept)
    if text and blocks:
        text += '\n'
    text += '\n'.join(blocks)
    before = tomllib.loads(original) if original.strip() else {}
    after = tomllib.loads(text) if text.strip() else {}
    for name in names:
        (before.get('mcp_servers') or {}).pop(name, None)
        observed = (after.get('mcp_servers') or {}).get(name)
        expected = next((entry for entry in entries if entry['name'] == name), None)
        if expected is None:
            if observed is not None:
                raise ProviderProofError('retired mcp entry is still present')
            continue
        if not isinstance(observed, dict) or observed.get('command') != expected['command'] \
                or observed.get('args') != expected['args'] or (expected['env'] and observed.get('env') != expected['env']):
            raise ProviderProofError('mcp configuration does not contain the requested entry')
    if before.get('mcp_servers') == {}:
        before.pop('mcp_servers')
    after_rest = dict(after)
    remaining = dict(after_rest.get('mcp_servers') or {})
    for name in names:
        remaining.pop(name, None)
    if remaining:
        after_rest['mcp_servers'] = remaining
    else:
        after_rest.pop('mcp_servers', None)
    if before != after_rest:
        raise ProviderProofError('mcp configuration would change more than the requested entries')
    write_private(path, text.encode())


def apply_mcp(profile: pathlib.Path, harness: str, entries: list) -> dict:
    """Reconcile Cauce-managed MCP names, including an empty desired list. Foreign names stay."""
    relative, path = mcp_target(profile, harness)
    previous = managed_mcp_names(profile)
    desired = [entry['name'] for entry in entries]
    remove = [name for name in previous if name not in set(desired)]
    if harness in {'claude', 'openclaw', 'muse'}:
        write_json_mcp(path, harness, entries, set(remove))
    else:
        toml_mcp(path, harness, entries, set(remove))
    write_managed_mcp(profile, desired)
    return {'harness': harness, 'path': relative, 'names': desired, 'removed': remove}


def host_token(value) -> bool:
    if not isinstance(value, str) or not 1 <= len(value) <= 253:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*', value) is not None


def parse_ssh_host(value) -> tuple[str, int | None]:
    match = re.fullmatch(r'([a-z_][a-z0-9_-]{0,31})@(\[[0-9A-Fa-f:]+\]|[^:\s]+)(?::([0-9]{1,5}))?', value) \
        if isinstance(value, str) and len(value) <= 512 else None
    if match is None:
        raise ProviderProofError('ssh host is outside the contract')
    raw_host, raw_port = match.group(2), match.group(3)
    host = raw_host[1:-1] if raw_host.startswith('[') else raw_host
    port = int(raw_port) if raw_port is not None else None
    if not host_token(host) or port is not None and not 1 <= port <= 65535:
        raise ProviderProofError('ssh host is outside the contract')
    return f'{match.group(1)}@{raw_host}', port


def endpoint_host(destination: str) -> str:
    raw = destination.split('@', 1)[1]
    return raw[1:-1] if raw.startswith('[') and raw.endswith(']') else raw


def ssh_text(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, timeout=15, check=False, env={'PATH': '/usr/bin:/bin'})
    if result.returncode:
        raise ProviderProofError('ssh key material is not usable')
    return result.stdout.decode()


def prepare_ssh(profile: pathlib.Path, hosts: list[str]) -> dict:
    directory = profile / 'ssh'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    private, public = directory / 'id_ed25519', directory / 'id_ed25519.pub'
    if private.exists():
        info = private.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
            raise ProviderProofError('ssh private key is not a private file')
    else:
        result = subprocess.run(['ssh-keygen', '-t', 'ed25519', '-N', '', '-q', '-f', str(private), '-C', 'cauce-agent'],
                                capture_output=True, timeout=15, check=False, env={'PATH': '/usr/bin:/bin'})
        if result.returncode:
            raise ProviderProofError('ssh key generation failed')
        os.chmod(private, 0o600)
    if not public.exists():
        public.write_text(ssh_text(['ssh-keygen', '-y', '-f', str(private)]))
        os.chmod(public, 0o644)
    listing = ssh_text(['ssh-keygen', '-lf', str(public)]).split()
    public_key = public.read_text().strip()
    if len(listing) < 4 or not listing[1].startswith('SHA256:') or listing[-1] != '(ED25519)' \
            or not public_key.startswith('ssh-ed25519 '):
        raise ProviderProofError('ssh public key is not ed25519')
    return {'fingerprint': listing[1], 'public_key': public_key, 'hosts': hosts}


def run_install(command: list[str], environment: dict, directory: pathlib.Path) -> None:
    result = subprocess.run(command, cwd=directory, env=environment, timeout=180, check=False, capture_output=True)
    if result.returncode:
        detail = re.sub(r'[\x00-\x1f]+', ' ', result.stderr.decode('utf-8', 'replace')).strip()[-240:]
        raise ProviderProofError('tool install failed: ' + (detail or 'no stderr'))


def install_tools(state: pathlib.Path, packages: list[str]) -> list[str]:
    if os.geteuid() == 0:
        raise ProviderProofError('tool install refuses root')
    local = state / '.local'
    local.mkdir(mode=0o700, parents=True, exist_ok=True)
    environment = {'HOME': str(state), 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'npm_config_prefix': str(local),
                   'npm_config_cache': str(state / '.npm'), 'npm_config_update_notifier': 'false',
                   'PYTHONUSERBASE': str(local), 'PIP_DISABLE_PIP_VERSION_CHECK': '1'}
    if set(environment) != set(INSTALL_ENV_KEYS):
        raise ProviderProofError('tool install environment is outside its allowlist')
    for package in packages:
        npm, pip = NPM_PACKAGE.fullmatch(package), PIP_PACKAGE.fullmatch(package)
        if npm is not None:
            name, version = npm.group(1), npm.group(2)
            run_install(['npm', 'install', '--global', '--prefix', str(local), f'{name}@{version}'], environment, state)
            metadata = json.loads((local / 'lib' / 'node_modules' / name / 'package.json').read_text())
            if metadata.get('version') != version:
                raise ProviderProofError('installed npm package version differs')
        elif pip is not None:
            name, version = pip.group(1), pip.group(2)
            run_install([sys.executable, '-m', 'pip', 'install', '--prefix', str(local), '--no-cache-dir',
                         f'{name}=={version}'], environment, state)
            normalized = re.sub(r'[-_.]+', '_', name)
            versions = {version, version.replace('+', '_')}
            found = {path for item in versions for path in (local / 'lib').glob(f'python*/site-packages/{normalized}-{item}.dist-info')}
            if len(found) != 1:
                raise ProviderProofError('installed pip package version differs')
        else:
            raise ProviderProofError('tool package must be an exact npm or pip version')
    return packages


def prepare_browser_tunnel(profile: pathlib.Path, row: dict, endpoints: list[tuple[str, int | None]]) -> dict:
    if set(row) != {'type', 'mode', 'host', 'port'} or row.get('mode') != 'ssh_tunnel' or not host_token(row.get('host')):
        raise ProviderProofError('browser extension is outside the contract')
    if type(row.get('port')) is not int or not 1 <= row['port'] <= 65535:
        raise ProviderProofError('browser tunnel port is outside the contract')
    if not (profile / 'ssh' / 'id_ed25519').is_file():
        raise ProviderProofError('browser tunnel requires the ssh extension key')
    matched = [endpoint for endpoint in endpoints if endpoint_host(endpoint[0]) == row['host']]
    if len(matched) != 1:
        raise ProviderProofError('browser tunnel host must match one ssh endpoint')
    target, ssh_port = matched[0]
    command = ['ssh', '-N', '-i', str(profile / 'ssh' / 'id_ed25519'), '-o', 'IdentitiesOnly=yes',
               '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'UserKnownHostsFile=' + str(profile / 'ssh' / 'known_hosts'),
               '-L', f'127.0.0.1:9222:127.0.0.1:{row["port"]}']
    if ssh_port is not None:
        command.extend(['-p', str(ssh_port)])
    command.append(target)
    host = row['host']
    descriptor = {'mode': 'ssh_tunnel', 'host': host, 'port': row['port'], 'ssh_port': ssh_port,
                  'cdp_url': 'http://127.0.0.1:9222', 'identity': 'ssh/id_ed25519', 'command': command}
    write_private(profile / 'browser' / 'tunnel.json', (json.dumps(descriptor, indent=2) + '\n').encode())
    return {'mode': 'ssh_tunnel', 'host': host, 'port': row['port'], 'cdp_url': descriptor['cdp_url']}


def assert_public_result(profile: pathlib.Path, result: dict) -> None:
    text = json.dumps(result)
    if 'PRIVATE KEY' in text or 'BEGIN ' in text:
        raise ProviderProofError('extension result contains private key material')
    private = profile / 'ssh' / 'id_ed25519'
    if not private.is_file():
        return
    for line in private.read_text().splitlines():
        if len(line) >= 40 and line in text:
            raise ProviderProofError('extension result contains private key material')


def extensions_sha256(rows: list) -> str:
    from host_channel_client import HostFailure, stable_json
    try:
        return hashlib.sha256(stable_json(rows)).hexdigest()
    except HostFailure:
        raise ProviderProofError('extension hash canonicalization is unavailable') from None


def public_receipt(rows: list, result: dict) -> dict:
    """Public prepare receipt. It carries the extensions hash and no proof identity or nonce."""
    receipt: dict = {'extensions_sha256': extensions_sha256(rows)}
    if 'ssh' in result:
        ssh = result['ssh']
        receipt['ssh'] = {'fingerprint': ssh['fingerprint'], 'public_key': ssh['public_key'], 'hosts': ssh['hosts']}
    if 'mcp' in result and (result['mcp'].get('names') or result['mcp'].get('removed')):
        receipt['mcp'] = {key: result['mcp'][key] for key in ('harness', 'path', 'names', 'removed')}
    if 'tools' in result:
        receipt['tools'] = {'packages': result['tools']['packages']}
    if 'browser' in result:
        receipt['browser'] = {key: result['browser'][key] for key in ('mode', 'host', 'port', 'cdp_url')}
    if set(receipt) - RECEIPT_KEYS or any(key in receipt for key in ('nonce', 'identity', 'account_id')):
        raise ProviderProofError('extension receipt is outside its public shape')
    return receipt


def prepare_extensions(agent: dict, profile, state=None) -> dict:
    """Write ssh, mcp, tools and browser tunnel material. The private key is not returned."""
    root = extension_directory(profile)
    rows = extension_rows(agent)
    result: dict = {}
    endpoints: list[tuple[str, int | None]] = []
    ssh_row = one_extension(rows, 'ssh')
    if ssh_row is not None:
        if set(ssh_row) != {'type', 'hosts'} or not isinstance(ssh_row.get('hosts'), list) or not 1 <= len(ssh_row['hosts']) <= 100:
            raise ProviderProofError('ssh extension is outside the contract')
        endpoints = [parse_ssh_host(item) for item in ssh_row['hosts']]
        declared = [host if port is None else f'{host}:{port}' for host, port in endpoints]
        result['ssh'] = prepare_ssh(root, declared)
    mcp_rows = [row for row in rows if row.get('type') == 'mcp']
    harness = agent.get('harness_id')
    if mcp_rows or harness in PREPARE_HARNESSES:
        entries = [mcp_entry(row) for row in mcp_rows]
        if len({entry['name'] for entry in entries}) != len(entries):
            raise ProviderProofError('mcp extension name is ambiguous')
        if harness not in PREPARE_HARNESSES:
            raise ProviderProofError('mcp harness is outside the contract')
        result['mcp'] = apply_mcp(root, harness, entries)
    tools_row = one_extension(rows, 'tools')
    if tools_row is not None:
        if set(tools_row) != {'type', 'packages'} or not isinstance(tools_row.get('packages'), list) \
                or not 1 <= len(tools_row['packages']) <= 100:
            raise ProviderProofError('tools extension is outside the contract')
        if state is None:
            raise ProviderProofError('tool install requires the state volume')
        result['tools'] = {'packages': install_tools(extension_directory(state), list(tools_row['packages']))}
    tunnel = [row for row in rows if row.get('type') == 'browser' and row.get('mode') == 'ssh_tunnel']
    if len(tunnel) > 1:
        raise ProviderProofError('extension browser is ambiguous')
    if tunnel:
        if ssh_row is None:
            raise ProviderProofError('browser tunnel requires the ssh extension')
        result['browser'] = prepare_browser_tunnel(root, tunnel[0], endpoints)
    receipt = public_receipt(rows, result)
    assert_public_result(root, receipt)
    write_private(root / EXTENSION_RECEIPT, (json.dumps(receipt, indent=2, sort_keys=True) + '\n').encode())
    return receipt


def prepare_extension_packet(packet: dict) -> dict:
    agent = packet.get('agent') if isinstance(packet, dict) else None
    if not isinstance(agent, dict) or not isinstance(packet.get('profile'), str):
        raise ProviderProofError('extension prepare packet is outside the contract')
    if any(key in packet for key in ('nonce', 'identity', 'account_id')):
        raise ProviderProofError('extension prepare packet must not carry proof identity')
    harness = agent.get('harness_id')
    state = packet.get('state')
    if harness in {'grok', 'muse', 'openclaw'}:
        import importlib
        module = importlib.import_module('fleet_provider_' + harness)
        return module.prepare_extensions(agent, packet['profile'], state)
    if harness in {'claude', 'codex'}:
        return prepare_extensions(agent, packet['profile'], state)
    raise ProviderProofError('extension harness is outside the contract')


if __name__ == '__main__':
    import argparse
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--prepare-extensions', action='store_true', required=True)
        parser.parse_args()
        raw = sys.stdin.buffer.read(EXTENSION_LIMIT + 1)
        if len(raw) > EXTENSION_LIMIT:
            raise ValueError('extension prepare packet exceeds its bound')
        receipt = prepare_extension_packet(json.loads(raw))
        body = json.dumps(receipt, sort_keys=True).encode()
        if len(body) > EXTENSION_LIMIT or set(receipt) - RECEIPT_KEYS:
            raise ValueError('extension receipt exceeds its public bound')
        sys.stdout.buffer.write(body)
    except Exception:
        raise SystemExit('extension prepare was not verified') from None
