from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import stat
import subprocess
import sys

from fleet_adoption_probe_policy import ProbeFailure, digest_file, open_directory


def directory_identity(filename: str) -> dict:
    fd = open_directory(filename)
    try:
        row = os.fstat(fd)
        return {'device': row.st_dev, 'inode': row.st_ino, 'uid': row.st_uid, 'gid': row.st_gid, 'mode': stat.S_IMODE(row.st_mode)}
    finally:
        os.close(fd)


def code_identity(filename: str, pin: str, runtime_uid: int | None = None) -> dict:
    resolved = os.path.realpath(filename)
    digest = digest_file(resolved)
    row = os.stat(resolved)
    if row.st_uid not in {0, os.geteuid(), runtime_uid} or digest != pin:
        raise ProbeFailure('code_digest_changed')
    return {'path': resolved, 'sha256': digest, 'device': row.st_dev, 'inode': row.st_ino, 'uid': row.st_uid}


def observe_local(row: dict, container: dict | None = None) -> dict:
    observation, placement = row['observation'], row['placement']
    directory = pathlib.Path(observation['lifecycle_directory'])
    required = {'cauce_container_base.py', 'cauce_container_proc.py', 'cauce_container_tree.py', 'cauce_container_adoption.py', 'cauce-container-runtime.py'}
    if set(observation['pins']) != {str(directory / name) for name in required}:
        raise ProbeFailure('lifecycle_pins_incomplete')
    pins = {filename: code_identity(filename, pin) for filename, pin in observation['pins'].items()}
    sys.path.insert(0, str(directory))
    import cauce_container_base as base
    import cauce_container_proc as proc
    control = base.open_control_directory(observation['control_directory'])
    try:
        document, _ = proc.read_metadata(control)
        if document is None or document['phase'] != 'running' or document['alias'] != row['runtime_key'] \
                or document.get('wireAlias') != row['target']['alias'] or document.get('tenantId') != row['target']['tenant_id'] \
                or document['stateDirectory'] != placement['state_directory']:
            raise ProbeFailure('running_control_unavailable')
        proc.verify_controller(document)
        proc.verify_adapter(document, row['runtime_key'], placement['state_directory'])
        if document['controlDirectory'] != observation['control_directory']:
            raise ProbeFailure('control_directory_changed')
        if not proc.lock_is_held(control):
            raise ProbeFailure('lifecycle_lock_unavailable')
        user = pwd.getpwnam(placement['runtime_user'])
        if (document['runtimeUid'], document['runtimeGid']) != (user.pw_uid, user.pw_gid):
            raise ProbeFailure('runtime_user_changed')
        if container is not None:
            generation = hashlib.sha256(('\0'.join([container['id'], container['started_at'],
                str(container['restart_count']), str(proc.proc_stat(1)['starttime'])]) + '\0').encode()).hexdigest()
            if document['containerId'] != container['id'] or document['containerGeneration'] != generation:
                raise ProbeFailure('container_generation_changed')
        bundle = base.bundle_digest(observation['bundle_directory'])
        if bundle != observation['bundle_digest'] or document['bundleDigest'] != bundle:
            raise ProbeFailure('bundle_changed')
        node = code_identity(observation['node_command'], observation['node_sha256'], user.pw_uid)
        provider = code_identity(observation['provider_command'], observation['provider_sha256'], user.pw_uid)
        adapter_path = observation.get('adapter_entry', str(pathlib.Path(observation['bundle_directory']) / 'packages/adapter-sdk/dist/src/bin' / (row['harness_id'] + '.js')))
        adapter = code_identity(adapter_path, observation.get('adapter_sha256', digest_file(adapter_path)), user.pw_uid)
        with proc.matched_fs_credentials(user.pw_uid, user.pw_gid):
            process_node = os.stat(f"/proc/{document['pid']}/exe")
            raw = pathlib.Path(f"/proc/{document['pid']}/environ").read_bytes()
            arguments = pathlib.Path(f"/proc/{document['pid']}/cmdline").read_bytes().split(b'\0')
        if (process_node.st_dev, process_node.st_ino) != (node['device'], node['inode']):
            raise ProbeFailure('node_identity_changed')
        if adapter['path'].encode() not in arguments:
            raise ProbeFailure('adapter_entry_changed')
        environment = {part.split(b'=', 1)[0].decode(): part.split(b'=', 1)[1].decode()
                       for part in raw.split(b'\0') if b'=' in part and part.split(b'=', 1)[0]
                       in {b'HOME', b'CODEX_HOME', b'CLAUDE_CONFIG_DIR', b'GEMINI_CLI_HOME'}}
        if environment.get('HOME') != placement['home_directory']:
            raise ProbeFailure('runtime_home_changed')
        account = row['account']
        profile = None
        if account is not None:
            if environment.get(account['environment_key']) != account['profile_path']:
                raise ProbeFailure('account_profile_changed')
            profile = directory_identity(account['profile_path'])
            if profile['uid'] != user.pw_uid or profile['mode'] & 0o022:
                raise ProbeFailure('account_profile_owner_changed')
        receipt_stat = os.stat('cauce-v3-adapter.json', dir_fd=control, follow_symlinks=False)
        identity = {'control': directory_identity(observation['control_directory']), 'receipt': document,
            'receipt_file': {'device': receipt_stat.st_dev, 'inode': receipt_stat.st_ino, 'uid': receipt_stat.st_uid},
            'state': directory_identity(placement['state_directory']), 'home': directory_identity(placement['home_directory']),
            'bundle': bundle, 'adapter': adapter, 'node': node, 'provider': provider, 'lifecycle': pins, 'account_profile': profile,
            'boot_id': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'container': container}
        proc.verify_adapter(document, row['runtime_key'], placement['state_directory'])
        return {'physical_identity_sha256': hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                'runtime_pid': document['pid'], 'runtime_starttime': document['starttime'], 'container': container,
                'lifecycle_identity': {key: document[key] for key in ('alias', 'containerId', 'containerGeneration', 'controllerPid', 'controllerStarttime')}}
    finally:
        os.close(control)


def docker_observation(row: dict) -> dict:
    observation = row['observation']
    container_id = observation.get('container_id')
    result = subprocess.run(['docker', 'inspect', '--format', '{{json .State}}\n{{.Id}}\n{{.Image}}\n{{.RestartCount}}', container_id],
                            check=True, capture_output=True, text=True, timeout=15)
    parts = result.stdout.splitlines()
    if len(parts) != 4:
        raise ProbeFailure('container_identity_unavailable')
    state = json.loads(parts[0])
    if state.get('Running') is not True or parts[1] != container_id or parts[2] != observation.get('container_image'):
        raise ProbeFailure('container_identity_changed')
    context = {'id': parts[1], 'image': parts[2], 'started_at': state['StartedAt'], 'restart_count': int(parts[3])}
    policy_source = pathlib.Path(__file__).with_name('fleet_adoption_probe_policy.py').read_text()
    source = pathlib.Path(__file__).read_text().replace('from fleet_adoption_probe_policy import ProbeFailure, digest_file, open_directory', '')
    source = source.replace('from __future__ import annotations', '')
    script = policy_source + '\n' + source + '\nvalue=json.load(sys.stdin)\nprint(json.dumps(observe_local(value["row"],value["container"])))\n'
    measured = subprocess.run(['docker', 'exec', '-i', '--user', '0', container_id, '/usr/bin/python3', '-B', '-c', script],
                             input=json.dumps({'row': row, 'container': context}), check=True, capture_output=True, text=True, timeout=30)
    if len(measured.stdout) > 8192:
        raise ProbeFailure('observation_exceeds_limit')
    return json.loads(measured.stdout)


def observe(row: dict) -> dict:
    try:
        if row['observation']['transport'] == 'docker':
            return docker_observation(row)
        return observe_local(row)
    except ProbeFailure:
        raise
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        raise ProbeFailure('physical_observation_unavailable') from error


def public_facts(row: dict, measured: dict) -> dict:
    account = row['account']
    return {'source': 'measured', 'target': row['target'], 'runtime_key': row['runtime_key'], 'harness_id': row['harness_id'],
            'placement': row['placement'], 'primary_account_id': None if account is None else account['id'],
            'account_provider': None if account is None else account['provider'], 'account_binding_approved': account is not None,
            'physical_identity_sha256': measured['physical_identity_sha256'], 'supervisor_fenced': True}
