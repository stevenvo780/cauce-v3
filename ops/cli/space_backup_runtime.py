from __future__ import annotations

import argparse
import json
import os
import pathlib
import pwd
import re
import resource
import subprocess
import sys
import uuid

from fleet_executor_policy import SafeFailure, approve_agent, digest, load_policy, path
from space_backup_local import exception_record, failure_record

AGENT_FIELDS = {'company_id', 'tenant_id', 'alias', 'runtime_key', 'host_id', 'harness_id', 'runtime_mode',
                'container_name', 'runtime_user', 'home_directory', 'state_directory', 'systemd_user'}
CLAIM_FIELDS = {'id', 'claim_token', 'claim_epoch', 'company_id', 'tenant_id', 'alias', 'host_id',
                'policy_sha256', 'agent_snapshot'}


class BackupEffectFailure(SafeFailure):
    def __init__(self, record: dict):
        super().__init__(record['cause_message'])
        self.record = record


def local_failure(stderr: bytes) -> dict | None:
    if len(stderr) > 1024:
        return None
    try:
        value = json.loads(stderr)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(value, dict) or set(value) != {'event', 'stage', 'cause_type', 'cause_message'} \
            or value['event'] != 'space_backup_failure' or value['stage'] != 'local' \
            or not isinstance(value['cause_type'], str) or not re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,63}', value['cause_type']) \
            or not isinstance(value['cause_message'], str) or not 1 <= len(value['cause_message']) <= 384:
        return None
    return failure_record(value['cause_type'], value['cause_message'], 'local')


def read_container_binding(policy: dict, agent: dict) -> tuple[dict, dict]:
    from fleet_executor_container import identity_for, inspect_container, user_identity
    from fleet_executor_hooks import container_binding
    from fleet_executor_image import validate_previous
    agent = approve_agent(policy, agent)
    observed = inspect_container(agent['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('approved backup container is not observed running')
    if agent['_placement'].get('ownership') == 'shared':
        return container_binding(policy, agent)
    image = observed.get('Image')
    if not isinstance(image, str) or re.fullmatch(r'sha256:[0-9a-f]{64}', image) is None \
            or observed.get('Config', {}).get('Image') != image:
        raise SafeFailure('backup container creation image is not an immutable matching digest')
    validate_previous(policy, agent, observed)
    identity = identity_for(agent, observed)
    user_identity(agent, identity)
    return agent, identity


def validate_request(request: dict) -> dict:
    if not isinstance(request, dict) or request.get('action') not in {'export', 'read', 'remove'} \
            or set(request) != {'action', 'claim'} | ({'offset'} if request.get('action') == 'read' else set()):
        raise SafeFailure('invalid closed backup request')
    claim = request['claim']
    if not isinstance(claim, dict) or set(claim) != CLAIM_FIELDS \
            or any(str(uuid.UUID(claim[field])) != claim[field] for field in ('id', 'claim_token')) \
            or type(claim['claim_epoch']) is not int or not 1 <= claim['claim_epoch'] <= 2147483647 \
            or not isinstance(claim['policy_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', claim['policy_sha256']):
        raise SafeFailure('invalid space backup claim')
    agent = claim['agent_snapshot']
    if not isinstance(agent, dict) or set(agent) != AGENT_FIELDS \
            or any(agent[field] != claim[field] for field in ('company_id', 'tenant_id', 'alias', 'host_id')):
        raise SafeFailure('space backup target differs')
    from space_archive import identity
    identity({field: agent[field] for field in ('company_id', 'tenant_id', 'alias', 'runtime_key')})
    return claim


def approve_legacy_container(policy: dict, snapshot: dict) -> tuple[dict, dict]:
    shared = policy.get('shared_containers', {}).get(snapshot.get('container_name'))
    if not isinstance(shared, dict):
        raise SafeFailure('legacy backup container is not approved')
    converted = {**snapshot, 'runtime_mode': 'container',
                 'home_directory': snapshot.get('home_directory') or shared.get('home_directory'),
                 'systemd_user': snapshot.get('systemd_user') or shared.get('systemd_user')}
    return read_container_binding(policy, converted)


def execute(policy_file: pathlib.Path, request: dict) -> dict:
    claim = validate_request(request)
    if digest(policy_file) != claim['policy_sha256']:
        raise SafeFailure('space backup policy changed')
    policy = load_policy(policy_file)
    if digest(policy_file) != claim['policy_sha256']:
        raise SafeFailure('space backup policy changed during read')
    legacy = claim['agent_snapshot'].get('runtime_mode') == 'legacy-container'
    agent = claim['agent_snapshot'] if legacy else approve_agent(policy, claim['agent_snapshot'])
    local = {'action': request['action'], 'id': claim['id'], 'claim_epoch': claim['claim_epoch'],
             'state_directory': agent['state_directory'],
             'identity': {field: agent[field] for field in ('company_id', 'tenant_id', 'alias', 'runtime_key')}}
    if request['action'] == 'read':
        local['offset'] = request['offset']
    binding = None
    if legacy:
        from fleet_executor_container import isolated_python
        agent, binding = approve_legacy_container(policy, agent)
        command = ['/usr/bin/docker', 'exec', '-i', '-w', '/', '--user', agent['runtime_user'], binding['container_id'],
                   *isolated_python(str(path(agent['_placement']['python'])), '/cauce/executor/space_backup_local.py')]
    elif agent['runtime_mode'] == 'container':
        from fleet_executor_container import isolated_python
        agent, binding = read_container_binding(policy, agent)
        command = ['/usr/bin/docker', 'exec', '-i', '-w', '/', '--user', agent['runtime_user'], binding['container_id'],
                   *isolated_python(str(path(agent['_placement']['python'])), '/cauce/executor/space_backup_local.py')]
    else:
        user = pwd.getpwnam(agent['runtime_user'])
        if user.pw_dir != agent['home_directory']:
            raise SafeFailure('space backup runtime home differs')
        command = [str(pathlib.Path(sys.executable).resolve()), str(pathlib.Path(__file__).with_name('space_backup_local.py'))]
        if user.pw_uid != os.geteuid():
            if os.geteuid() != 0:
                raise SafeFailure('space backup executor is not the exact runtime owner')
            command = ['/usr/sbin/runuser', '-u', agent['runtime_user'], '--', *command]
    result = subprocess.run(command, input=json.dumps(local).encode(), capture_output=True,
                            timeout=1750 if request['action'] == 'export' else 120,
                            env={'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory'], 'PYTHONDONTWRITEBYTECODE': '1',
                                 **{key: os.environ[key] for key in ('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_CONFIG') if key in os.environ}}, check=False)
    if binding is not None:
        _, after = read_container_binding(policy, agent)
        if after['container_id'] != binding['container_id'] or after['generation'] != binding['generation']:
            raise SafeFailure('space backup container was replaced')
    if digest(policy_file) != claim['policy_sha256']:
        raise SafeFailure('space backup policy changed before the receipt')
    if result.returncode:
        record = local_failure(result.stderr)
        if record is not None:
            raise BackupEffectFailure(record)
        raise SafeFailure(f'space backup helper exited with status {result.returncode}')
    if len(result.stdout) > 8 * 1024 * 1024:
        raise SafeFailure('space backup export receipt exceeds its limit')
    output = json.loads(result.stdout)
    if not isinstance(output, dict):
        raise SafeFailure('space backup export receipt is unavailable')
    if request['action'] == 'export' and 'error' not in output:
        measured = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss + resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
        metrics = output.get('metrics', {})
        if not isinstance(metrics, dict) or set(metrics) - {'peak_rss_kib'} \
                or type(metrics.get('peak_rss_kib', 0)) is not int or metrics.get('peak_rss_kib', 0) < 0:
            raise SafeFailure('space backup memory receipt is invalid')
        output['metrics'] = {'peak_rss_kib': max(measured, metrics.get('peak_rss_kib', 0))}
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise SafeFailure('space backup request exceeds its limit')
        print(json.dumps(execute(path(args.policy), json.loads(raw)), separators=(',', ':')))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        from fleet_executor_image import failure_details
        record = error.record if isinstance(error, BackupEffectFailure) else exception_record(error, 'runtime')
        details = failure_details(SafeFailure(record['cause_message'])).partition(': ')[2]
        print(json.dumps(failure_record(record['cause_type'], details, record['stage']), separators=(',', ':')), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
