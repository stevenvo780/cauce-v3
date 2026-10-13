from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import time


class ProviderProofError(ValueError):
    pass


ROUNDTRIP_TIMEOUT = 30


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


def authenticated_provider(packet: dict) -> bool:
    module_name = packet_fleet_module(packet)
    if module_name:
        try:
            from importlib import import_module
            return bool(import_module(module_name).authenticated(packet))
        except (ImportError, OSError, ValueError, KeyError, subprocess.SubprocessError, AttributeError):
            return False
    provider = packet["profile_binding"]["provider"]
    try:
        command = provider_command(packet)
        if provider == "codex":
            identity = codex_identity(packet)
        elif provider == "claude":
            result = json.loads(command_output([command, "auth", "status", "--json"], packet))
            if result.get("loggedIn") is not True or not isinstance(result.get("email"), str):
                return False
            identity = result["email"]
        else:
            raise ProviderProofError("provider has no approved account inspection")
        if identity != packet["identity"]:
            return False
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
            return replies == [expected]
        output = json.loads(
            command_output(
                [command, "-p", prompt, "--output-format", "json", "--tools", "", "--max-turns", "1"], packet
            )
        )
        return output.get("is_error") is False and output.get("result") == expected
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return False
