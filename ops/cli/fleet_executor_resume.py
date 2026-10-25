from __future__ import annotations

import contextlib
import json
import pathlib
import re
import signal
import subprocess
import tempfile
import uuid

from fleet_executor_policy import SafeFailure, path

ENVIRONMENT = frozenset({'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'CAUCE_HARNESS_COMMAND', 'CAUCE_HARNESS_COMMAND_SHA256', 'CAUCE_HARNESS_COMMAND_FILES',
    'CAUCE_MUSE_CLI_COMMAND', 'CAUCE_MUSE_CLI_SHA256'})
SHA = re.compile(r'[0-9a-f]{64}')


@contextlib.contextmanager
def _probe_signal():
    previous = signal.getsignal(signal.SIGTERM)

    def cancelled(_signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise SafeFailure('resume proof was cancelled')

    signal.signal(signal.SIGTERM, cancelled)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def _remove_probe(runtime, cidfile: pathlib.Path) -> None:
    from fleet_executor_pki import checked_file
    if not cidfile.exists():
        return
    try:
        identity = checked_file(cidfile).decode('ascii').strip()
    except (ValueError, UnicodeError, OSError):
        raise SafeFailure('resume probe has no exact container identity') from None
    if SHA.fullmatch(identity) is None:
        raise SafeFailure('resume probe has no exact container identity')
    try:
        runtime.checked_command([runtime.DOCKER, 'rm', '-f', identity], timeout=3)
    except (SafeFailure, subprocess.TimeoutExpired):
        try:
            remaining = runtime.checked_command([runtime.DOCKER, 'ps', '-aq', '--no-trunc', '--filter', 'id=' + identity], timeout=2)
        except (SafeFailure, subprocess.TimeoutExpired):
            raise SafeFailure('resume probe cleanup is unverified') from None
        if remaining.strip():
            raise SafeFailure('resume probe cleanup is unverified') from None


def _volume_mounts(runtime, policy: dict, agent: dict, observed: dict) -> list[str]:
    placement = agent['_placement']
    labels = runtime.expected_labels(policy, agent)
    mounts = []
    for key, suffix in (('state_root', '-state'), ('profile_root', '-provider-profiles')):
        destination = placement.get(key)
        if destination is None:
            continue
        destination = str(path(destination))
        name = agent['container_name'] + suffix
        rows = [row for row in observed.get('Mounts', []) if row.get('Destination') == destination]
        if len(rows) != 1 or rows[0].get('Type') != 'volume' or rows[0].get('Name') != name or rows[0].get('RW') is not True:
            raise SafeFailure('resume probe persistent volume differs')
        try:
            volumes = json.loads(runtime.docker('volume', 'inspect', name))
        except (ValueError, UnicodeError):
            raise SafeFailure('resume probe persistent volume observation is invalid') from None
        expected = {**labels, **({'cauce.fleet.volume': 'provider-profiles'} if key == 'profile_root' else {})}
        if not isinstance(volumes, list) or len(volumes) != 1 or not isinstance(volumes[0], dict) or volumes[0].get('Name') != name \
                or any((volumes[0].get('Labels') or {}).get(key) != value for key, value in expected.items()):
            raise SafeFailure('resume probe persistent volume ownership differs')
        mounts += ['--mount', f'type=volume,source={name},destination={destination},readonly,volume-nocopy']
    return mounts


def resume_proof(policy: dict, agent: dict, observed: dict, bundle: dict, uid: int | str, gid: int | str) -> dict:
    import fleet_executor_container as runtime
    from fleet_executor_runtime import provider_base_environment
    placement = agent['_placement']
    if agent.get('runtime_mode') != 'container' or placement.get('ownership') == 'shared' \
            or agent.get('harness_id') not in {'codex', 'claude', 'grok', 'muse'} or bundle.get('shared_tui') is not True:
        raise SafeFailure('resume proof requires a dedicated shared runtime')
    if not isinstance(placement.get('image'), str) or re.fullmatch(r'sha256:[0-9a-f]{64}', placement['image']) is None \
            or not str(uid).isdigit() or not str(gid).isdigit() or int(uid) <= 0 or int(gid) <= 0:
        raise SafeFailure('resume proof image or execution owner is unverified')
    entries = [path(value) for value in bundle['argv'] if isinstance(value, str)
               and value.endswith('/bin/' + agent['harness_id'] + '.js')]
    if len(entries) != 1 or not entries[0].is_relative_to(path(bundle['directory'])):
        raise SafeFailure('approved adapter bundle has no exact shared resume helper')
    entry = entries[0].with_name('shared-session.js')
    if not entry.is_file():
        raise SafeFailure('current adapter bundle has no shared resume helper')
    mounts = _volume_mounts(runtime, policy, agent, observed)
    for destination, source in runtime.runtime_mounts(policy, agent).items():
        if not path(source).exists():
            raise SafeFailure('current runtime bind source is unavailable for resume proof')
        mounts += ['--volume', f'{path(source)}:{path(destination)}:ro,z']
    provider = provider_base_environment(policy, agent)
    environment = {key: value for key, value in provider.items() if key in ENVIRONMENT}
    environment.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME=agent['home_directory'],
        CAUCE_RUNTIME_KEY=agent['runtime_key'], CAUCE_SHARED_SESSION='1', CAUCE_SHARED_SESSION_REQUIRE_RESUME='1')
    for field, variable in (('model_id', 'CAUCE_MODEL_ID'), ('reasoning_effort', 'CAUCE_REASONING_EFFORT')):
        if agent.get(field) is not None:
            environment[variable] = agent[field]
    if any(not isinstance(value, str) or '\0' in value for value in environment.values()):
        raise SafeFailure('resume proof environment differs from the approved selection')
    workspace = str(path(agent['state_directory']) / 'space' / 'projects')
    labels = {**runtime.expected_labels(policy, agent), 'cauce.fleet.probe': 'resume-proof'}
    with tempfile.TemporaryDirectory(prefix='resume-proof-', dir=policy['roots']['state']) as directory, _probe_signal():
        cidfile = pathlib.Path(directory) / 'container.id'
        try:
            try:
                arguments = ['run', '--rm', '--pull=never', '--cidfile', str(cidfile),
                    '--name', agent['container_name'] + '-resume-' + uuid.uuid4().hex, '-w', '/',
                    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                    '--pids-limit', '16', '--memory', '256m', '--cpus', '1', '--user', f'{int(uid)}:{int(gid)}',
                    *[value for key, item in labels.items() for value in ('--label', key + '=' + item)], *mounts,
                    '--entrypoint', '/usr/bin/env', placement['image'], '-i',
                    *[key + '=' + value for key, value in environment.items()],
                    bundle['executable'], str(entry), 'resume-proof', '--alias', agent['alias'],
                    '--harness', agent['harness_id'], '--state', agent['state_directory'], '--workspace', workspace]
                raw = runtime.checked_command([runtime.DOCKER, *arguments], timeout=12)
            except (SafeFailure, subprocess.TimeoutExpired):
                raise SafeFailure('current SDK did not accredit an exact shared resume') from None
            if len(raw) > 4096:
                raise SafeFailure('resume proof exceeds its bound')
            try:
                proof = json.loads(raw)
            except (ValueError, UnicodeError):
                raise SafeFailure('resume proof is not a bounded SDK result') from None
            if not isinstance(proof, dict) or set(proof) != {'resumable', 'fingerprint'} \
                    or proof['resumable'] is not True or not isinstance(proof['fingerprint'], str) \
                    or SHA.fullmatch(proof['fingerprint']) is None:
                raise SafeFailure('current SDK did not accredit an exact shared resume')
            return proof
        finally:
            _remove_probe(runtime, cidfile)


def maintenance_resume_preflight(policy: dict, packet: dict) -> dict:
    from fleet_executor_container import identity_for, inspect_container, user_identity
    from fleet_executor_image import validate_previous
    from fleet_executor_maintenance import request_agent
    from fleet_executor_runtime import approved_bundle
    if not isinstance(packet, dict) or set(packet) != {'operation_id', 'agent', 'trusted_accounts', 'claim', 'expected_runtime'}:
        raise SafeFailure('invalid maintenance resume proof request')
    expected = packet['expected_runtime']
    if not isinstance(expected, dict) or set(expected) != {'container_id', 'generation'} \
            or any(not isinstance(value, str) or SHA.fullmatch(value) is None for value in expected.values()):
        raise SafeFailure('maintenance resume proof requires the held runtime identity')
    agent = request_agent(policy, {key: value for key, value in packet.items() if key != 'expected_runtime'})
    if agent['runtime_mode'] != 'container' or agent['_placement'].get('ownership') == 'shared':
        raise SafeFailure('maintenance resume proof requires a dedicated container')
    observed = inspect_container(agent['container_name'])
    if observed is None:
        raise SafeFailure('held runtime is absent during resume proof')
    previous = validate_previous(policy, agent, observed)
    identity = identity_for(previous, observed)
    if any(identity.get(key) != value for key, value in expected.items()):
        raise SafeFailure('held runtime changed before resume proof')
    uid, gid = user_identity(previous, identity)
    return resume_proof(policy, agent, observed, approved_bundle(policy, agent), uid, gid)
