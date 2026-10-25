from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import re
import ssl
import stat
import subprocess
import sys
import tempfile
import traceback
import uuid


class FixtureFailure(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FixtureFailure(message)


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def command(*arguments: str) -> str:
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=30, check=False)
    require(result.returncode == 0, 'owned legacy fixture command failed')
    return result.stdout.strip()


def write(filename: pathlib.Path, raw: bytes, mode: int = 0o600) -> None:
    require(not filename.is_symlink(), 'owned fixture file became a symlink')
    filename.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    filename.write_bytes(raw)
    filename.chmod(mode)


def file_state(filename: pathlib.Path) -> dict:
    details = filename.lstat()
    require(stat.S_ISREG(details.st_mode) and details.st_uid == os.geteuid() and details.st_nlink == 1,
            'owned fixture file identity differs')
    return {'sha256': digest(filename.read_bytes()), 'inode': details.st_ino, 'mode': stat.S_IMODE(details.st_mode)}


def main() -> dict:
    action = sys.argv[1]
    require(action in {'prepare', 'managed', 'rollback', 'foreign', 'restore'}, 'unknown owned fixture action')
    request = json.load(sys.stdin)
    alias, key, tenant, container = (request[name] for name in ('alias', 'key', 'tenant', 'container'))
    require(re.fullmatch(r'pty-([a-f0-9]{8})', key) is not None, 'owned legacy runtime is invalid')
    run = key.removeprefix('pty-')
    company = request['company']
    require(alias == 'pty' + run and company == 'zz-pty-' + run and re.fullmatch(r'hub-[a-f0-9]{32}', tenant) is not None
            and container == 'zz-canary-h12-pty-flota-dinamica-1025-' + run + '-' + key,
            'owned legacy wire identity is invalid')
    account = pwd.getpwuid(os.geteuid())
    home = pathlib.Path(account.pw_dir)
    require(os.geteuid() != 0 and account.pw_name == 'cauce' and home == pathlib.Path('/home/cauce'),
            'legacy fixture requires its isolated computer user')
    policy_file = pathlib.Path(request['policy'])
    require(policy_file.name == 'executor-policy.json' and policy_file.parent.name == company + '-pc'
            and policy_file.parent.parent.name == company and policy_file.is_relative_to('/datos')
            and policy_file.parts[2].startswith('zz-canary-h12-pty-flota-dinamica-1025-' + run + '-'),
            'legacy fixture policy is outside its owned computer')
    policy = json.loads(policy_file.read_bytes())
    require(policy.get('terminal') == {'required': True} and policy['executor_user'] == account.pw_name,
            'legacy fixture terminal policy is not required')
    state = pathlib.Path(policy['roots']['state'])
    require(state == pathlib.Path(request['state']) and state.is_relative_to(policy_file.parent),
            'legacy fixture state differs from its owned computer')
    bundle = pathlib.Path(policy['bundles']['codex']['directory'])
    releases = [path for path in bundle.parents if path.parent == policy_file.parent / 'release'
                and re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', path.name)]
    require(len(releases) == 1, 'legacy fixture adapter release is ambiguous')
    ops = releases[0] / 'ops'
    sys.path[:0] = [str(ops / 'cli'), str(ops / 'scripts'), str(ops / 'pty-agent')]
    from fleet_executor_container import DOCKER, identity_for, inspect_container, user_identity, validate_container
    from fleet_executor_policy import approve_agent, load_policy
    from fleet_executor_terminal_manager import approved_release, presence, unit_state
    from fleet_executor_terminal_provision import read_environment, rollback_terminal
    from fleet_runtime_materialization import load_desired_fleet
    from rollout_pty_lib import ManagerWorker, ReleaseBundle

    policy = load_policy(policy_file)
    work = home / ('zz-canary-h14-legacy-' + key)
    work.mkdir(mode=0o700, exist_ok=True)
    require(not work.is_symlink() and work.stat().st_uid == os.geteuid(), 'legacy fixture work identity differs')
    snapshot_file = work / 'snapshot.json'
    snapshot = json.loads(snapshot_file.read_bytes()) if snapshot_file.exists() else None
    desired = load_desired_fleet(state)
    mapping = json.loads((state / 'generations' / desired['generation'] / 'container-aliases.json').read_bytes())
    row = mapping['aliases'].get(key)
    if row is None:
        require(snapshot is not None and snapshot['identity'] == {'tenant_id': tenant, 'alias': alias, 'runtime_key': key},
                'stopped legacy fixture has no previously verified identity')
        row = snapshot['row']
    require(row['tenant'] == tenant and row.get('alias', key) == alias and row['container'] == container,
            'legacy fixture desired identity differs')
    agent = approve_agent(policy, {'tenant_id': tenant, 'alias': alias, 'runtime_key': key,
        'runtime_mode': 'container', 'host_id': policy['host_id'], 'container_name': container,
        'runtime_user': row['user'], 'home_directory': row['home'], 'state_directory': row['stateDirectory'],
        'harness_id': row['harness'], 'systemd_user': account.pw_name})
    observed = inspect_container(container)
    require(observed is not None and observed['State']['Running'], 'owned legacy container is not running')
    validate_container(policy, agent, observed)
    config = home / '.config/cauce-v3'
    units = home / '.config/systemd/user'
    unit = 'cauce-v3-pty@' + alias + '.service'
    physical_unit = 'cauce-v3-pty@' + key + '.service'
    pki = config / 'pty-pki' / alias
    env = config / 'pty' / (alias + '.env')
    metadata = config / 'pty' / (alias + '.migration.json')
    dropins = units / (unit + '.d')
    legacy_dropin = dropins / '20-cauce-release.conf'

    def credentials() -> dict:
        certificate = (pki / 'client.crt').read_text(encoding='ascii')
        return {'fingerprint': digest(ssl.PEM_cert_to_DER_cert(certificate)),
                'files': {name: file_state(pki / name) for name in ('client.crt', 'client.key', 'ca.crt', 'alias-key.hex')}}

    def legacy_matches() -> dict:
        require(snapshot is not None, 'owned legacy snapshot is absent')
        values = {'generic_template_exact': digest((units / 'cauce-v3-pty@.service').read_bytes()) == snapshot['template_sha256'],
                  'legacy_dropin_exact': legacy_dropin.exists() and digest(legacy_dropin.read_bytes()) == snapshot['dropin_sha256'],
                  'environment_exact': digest(env.read_bytes()) == snapshot['environment_sha256'],
                  'instance_absent': not os.path.lexists(units / unit),
                  'managed_selector_absent': not os.path.lexists(dropins / 'zz-fleet-terminal.conf'),
                  'migration_absent': not os.path.lexists(metadata),
                  'credentials_unchanged': credentials() == snapshot['credentials']}
        require(all(values.values()), 'owned legacy state differs from its snapshot')
        return values

    def operation_journal() -> tuple[dict, pathlib.Path]:
        operation_id = request.get('operation_id', '')
        require(str(uuid.UUID(operation_id)) == operation_id, 'owned legacy operation is invalid')
        location = state / 'operations' / operation_id / 'effects.json'
        journal = json.loads(location.read_bytes())
        entry = journal.get('terminal_provision', {}).get(key)
        require(entry is not None and entry.get('identity') == {'tenant_id': tenant, 'alias': alias, 'runtime_key': key}
                and entry.get('operation_id') == operation_id and entry.get('selector') == alias,
                'owned legacy journal has another fenced identity')
        require(entry.get('new_credentials') is False and not entry.get('issuance_requested') and not entry.get('grant'),
                'legacy adoption unexpectedly issued another grant')
        return journal, location

    if action == 'prepare':
        for selected in (physical_unit, unit):
            if (units / selected).exists() or (units / (selected + '.d')).exists():
                command('systemctl', '--user', 'stop', selected)
                subprocess.run(['systemctl', '--user', 'disable', selected], capture_output=True, check=False, timeout=30)
        # Stopping a launcher unit leaves its in-container agent alive (the final docker exec does not
        # forward signals) and the agent already unlinked its bundle. A legacy V3 host never ran a
        # physical-key channel, so reap that orphan exactly as the launcher does before reconstructing.
        uid, gid = user_identity(agent, identity_for(agent, observed))
        reaper = (ops / 'pty-agent/reap_orphan_agent.py').read_bytes()
        for bundle_path in ('/var/tmp/.cauce-pty-bundle-' + key + '.json', '/run/cauce-pty-' + key + '/bundle.json'):
            reaped = subprocess.run([DOCKER, 'exec', '-i', '--user', uid + ':' + gid, observed['Id'], '/usr/bin/python3', '-',
                                     bundle_path, key], input=reaper, capture_output=True, timeout=30, check=False)
            require(reaped.returncode == 0, 'owned physical PTY orphan could not be reaped')
        physical_pki = config / 'pty-pki' / key
        if physical_pki.exists():
            require(not pki.exists(), 'legacy fixture has duplicate channel material')
            physical_pki.rename(pki)
            (config / 'pty' / (key + '.env')).rename(env)
        require(pki.is_dir() and not pki.is_symlink(), 'owned legacy PKI is absent')
        before = credentials()
        if snapshot is not None:
            require(before == snapshot['credentials'], 'owned legacy credentials changed before reconstruction')
        values = read_environment(env)
        values.pop('RELAY_SERVER_NAME', None)
        values.update(PKI_DIR=str(pki), ALIAS_KEY_FILE=str(pki / 'alias-key.hex'), CONTAINER_RUNTIME_DIR='/run')
        require(set(values) == {'RELAY_HOST', 'RELAY_PORT', 'PKI_DIR', 'ALIAS_KEY_FILE', 'CONTAINER_RUNTIME_DIR'},
                'owned legacy environment has an unexpected field')
        write(env, ''.join(name + '=' + value + '\n' for name, value in values.items()).encode())
        template = request['template'].encode()
        require(b'ExecStart=%h/.local/share/cauce-v3/ops/pty-agent/cauce-pty-launcher.sh %i\n' in template
                and template != approved_release(policy, agent)[2], 'legacy fixture template is not the historical template')
        with tempfile.TemporaryDirectory(prefix='source-', dir=work) as temporary:
            source = pathlib.Path(temporary)
            from rollout_pty_lib import RELEASE_FILES
            legacy_mapping = {**mapping, 'aliases': {alias: {**row, 'alias': alias}}, 'historicalAliases': {}, 'systemPrincipals': {}}
            for relative in RELEASE_FILES:
                raw = json.dumps(legacy_mapping, sort_keys=True).encode() if relative == 'container-aliases.json' else (ops / relative).read_bytes()
                if relative == 'pty-agent/systemd/cauce-v3-pty@.service':
                    raw = template
                write(source / relative, raw)
            release = ReleaseBundle.from_ops_root(source)
            worker = ManagerWorker('server', home=home)
            worker.publish(release)
            published, _fleet = worker.validate_release(release.release_sha)
        dropin = ('[Service]\nEnvironment=CAUCE_PTY_OPS_ROOT=' + str(published)
                  + '\nEnvironment=CAUCE_PTY_AGENT_VERSION=' + release.release_sha
                  + '\nExecStart=\nExecStart=' + str(published / 'pty-agent/cauce-pty-launcher.sh') + ' %i\n').encode()
        for selected, selector in ((physical_unit, key), (unit, alias)):
            for filename in (units / selected, units / (selected + '.d') / 'zz-fleet-terminal.conf',
                             config / 'pty' / (selector + '.migration.json')):
                if os.path.lexists(filename):
                    require(not filename.is_symlink(), 'owned legacy fixture artifact became a symlink')
                    filename.unlink()
        physical_dropins = units / (physical_unit + '.d')
        if physical_dropins.exists():
            require(not list(physical_dropins.iterdir()), 'physical fixture drop-in directory is not empty')
            physical_dropins.rmdir()
        write(units / 'cauce-v3-pty@.service', template, 0o644)
        write(legacy_dropin, dropin)
        command('systemctl', '--user', 'daemon-reload')
        command('systemctl', '--user', 'enable', unit)
        command('systemctl', '--user', 'restart', unit)
        ready = presence(unit, alias, release.release_sha, attempts=60)
        snapshot = {'identity': {'tenant_id': tenant, 'alias': alias, 'runtime_key': key}, 'credentials': before, 'row': row,
                    'template_sha256': digest(template), 'dropin_sha256': digest(dropin),
                    'environment_sha256': digest(env.read_bytes()), 'release_sha256': release.release_sha,
                    'unit_before': unit_state(unit, units)}
        require(snapshot['unit_before'] == {'active': True, 'enabled': True}
                and command('systemctl', '--user', 'show', unit, '--property=FragmentPath', '--value')
                == str(units / 'cauce-v3-pty@.service'), 'owned legacy generic unit was not observed active and enabled')
        write(snapshot_file, (json.dumps(snapshot, sort_keys=True) + '\n').encode())
        for shared in (home / '.config', home / '.config/systemd'):
            require(not shared.is_symlink() and shared.stat().st_uid == os.geteuid(), 'owned fixture shared directory differs')
            shared.chmod(stat.S_IMODE(shared.stat().st_mode) | 0o020)
        return {'legacy': legacy_matches(), 'credentials': before, 'presence': ready,
                'required': policy['terminal']['required'], 'shared_directories_group_writable': True,
                'release_sha256': release.release_sha, 'generic_fragment_observed': True, 'active_enabled': True}

    require(snapshot is not None and snapshot['identity'] == {'tenant_id': tenant, 'alias': alias, 'runtime_key': key},
            'owned legacy snapshot has another identity')
    if action == 'managed':
        journal, _location = operation_journal()
        entry = journal['terminal_provision'][key]
        document = json.loads(metadata.read_bytes())
        require(document['tenant'] == tenant and document['alias'] == alias and document['runtime_key'] == key,
                'managed legacy migration identity differs')
        require(entry['stage'] == 'verified' and credentials() == snapshot['credentials']
                and not legacy_dropin.exists() and (dropins / 'zz-fleet-terminal.conf').is_file()
                and (units / unit).read_bytes() == approved_release(policy, agent)[2],
                'owned legacy adoption was not fully published')
        require(all(not shared.stat().st_mode & 0o022 for shared in (home / '.config', home / '.config/systemd')),
                'owned legacy shared directory modes were not repaired')
        ready = presence(unit, alias, entry['source_sha256'])
        return {'required': True, 'reused': True, 'credentials_unchanged': True,
                'legacy_dropin_removed': True, 'instance_canonical': True, 'migration_created': True,
                'credentials': credentials(), 'presence': ready}
    if action == 'rollback':
        journal, location = operation_journal()

        def save():
            write(location, (json.dumps(journal, sort_keys=True) + '\n').encode())

        result = rollback_terminal(policy, {'operation_id': request['operation_id']}, agent, journal, save)
        restored = legacy_matches()
        require(unit_state(unit, units) == snapshot['unit_before'], 'legacy unit state was not restored exactly')
        return {'rollback': result, 'restored': restored, 'credentials': credentials(),
                'presence': presence(unit, alias, snapshot['release_sha256'])}
    if action == 'foreign':
        legacy_matches()
        raw = legacy_dropin.read_bytes()
        write(work / 'before-foreign.conf', raw)
        replacement = re.sub(rb'(?m)^ExecStart=.+$', b'ExecStart=/usr/bin/false %i', raw)
        require(replacement != raw, 'foreign fixture launcher was not changed')
        write(legacy_dropin, replacement)
        command('systemctl', '--user', 'daemon-reload')
        return {'foreign_execstart': True, 'credentials': credentials(), 'dropin_sha256': digest(replacement)}
    require(credentials() == snapshot['credentials'], 'rejected foreign launcher changed owned channel material')
    executor = 'cauce-v3-host-executor-' + company + '-' + policy['host_id'] + '.service'
    records = command('journalctl', '--user', '--user-unit=' + executor, '--no-pager', '-o', 'json', '-n', '200')
    cause = 'terminal provisioning failed: SafeFailure: terminal legacy execution differs from its immutable published launcher'
    require(any(cause in json.loads(line).get('MESSAGE', '') for line in records.splitlines() if line),
            'rejected legacy launcher cause was not recorded in the executor journal')
    write(legacy_dropin, (work / 'before-foreign.conf').read_bytes())
    command('systemctl', '--user', 'daemon-reload')
    return {'credentials_unchanged': True, 'safe_failure_journaled': True, 'legacy': legacy_matches(), 'credentials': credentials()}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as error:
        print(json.dumps({'fixture_error': {'type': type(error).__name__, 'errno': getattr(error, 'errno', None),
              'reason': str(error) if isinstance(error, FixtureFailure) else None,
              'frames': [{'function': frame.name, 'line': frame.lineno} for frame in traceback.extract_tb(error.__traceback__)]}}), file=sys.stderr)
        raise SystemExit(1) from None
