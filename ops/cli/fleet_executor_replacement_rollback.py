from __future__ import annotations

import copy
import hashlib
import json
import os
import ssl
import traceback
from pathlib import Path

from fleet_executor_policy import SafeFailure, approve_agent

RESTORED_LABEL = 'cauce.fleet.restored_by'


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def restoration(context: dict) -> bool:
    request = context['request']
    previous = context['previous_agents']
    placement = request.get('parameters', {}).get('placement', {})
    return request['kind'] == 'update' and len(previous) == 1 \
        and context.get('fleet_scope', {}).get('placement_role') is None \
        and previous[0].get('runtime_mode') == placement.get('mode') == 'container' \
        and previous[0].get('host_id') == placement.get('host_id') \
        and previous[0].get('runtime_key') == request['parameters']['runtime_key'] \
        and (previous[0].get('container_name') != placement.get('container_name') \
             or previous[0].get('enabled') is True and previous[0].get('lifecycle_state') == 'ready')


def snapshot(context: dict) -> dict:
    value = context.get('snapshot', {}).get('compensation_snapshot')
    try:
        if not isinstance(value, dict):
            raise ValueError
        body = {key: child for key, child in value.items() if key not in {'snapshot_canonical', 'snapshot_sha256'}}
        encoded = value['snapshot_canonical']
        if not isinstance(encoded, str) or hashlib.sha256(encoded.encode()).hexdigest() != value['snapshot_sha256'] \
                or canonical(json.loads(encoded)) != canonical(body) or type(body.get('version')) is not int or body['version'] != 1 \
                or body.get('operation_id') != context['operation_id'] or body.get('target') != context['request']['target'] \
                or not isinstance(body.get('previous_agents'), list) or len(body['previous_agents']) != 1 \
                or not isinstance(body.get('previous_memberships'), list):
            raise ValueError
        before = body['previous_agents'][0]
        previous = context['previous_agents'][0]
        if any(before.get(key) != child for key, child in previous.items() if key != 'fleet_baseline'):
            raise ValueError
        if before.get('enabled') is not True or before.get('lifecycle_state') != 'ready':
            raise ValueError
        if any(member.get('tenant_id') != before['tenant_id'] or member.get('alias') != before['alias']
               for member in body['previous_memberships']):
            raise ValueError
        return value
    except (KeyError, TypeError, ValueError, IndexError):
        raise SafeFailure('replacement snapshot missing') from None


def normal_pins(executor, agent: dict) -> dict:
    from fleet_executor_authority import proof_for, sha256
    from fleet_executor_pki import checked_file
    proof = proof_for(executor.policy, agent, bootstrap=False)
    token = checked_file(Path(executor.policy['roots']['tokens']) / 'normal' / (agent['runtime_key'] + '.token'), True).strip()
    return {'normal_certificate_sha256': proof['certificate_fingerprint'], 'normal_token_sha256': sha256(token)}


def original(executor, entry: dict, *, restarting: bool = False) -> tuple[dict, dict]:
    from fleet_executor_replacement import approved_observation, container_pin, volume_pins
    try:
        agent, observed = approved_observation(executor.policy, executor.context['previous_agents'][0])
        if observed is None:
            raise ValueError
        pin = container_pin(observed)
        # An in-place update removed the captured container; its rebuild was pinned when it was created.
        expected = entry.get('recreated_original') or entry['original']['previous']
        fields = set(expected) - ({'started_at'} if restarting else set())
        if any(pin.get(key) != expected[key] for key in fields) \
                or volume_pins(executor.policy, agent) != entry['original']['volumes']:
            raise ValueError
        return agent, observed
    except (KeyError, TypeError, ValueError, SafeFailure):
        raise SafeFailure('replacement original unverified') from None


def refreshed_destination(executor, agent: dict, pin: dict, current: dict) -> bool:
    """An image refresh recreates the container in place and keeps the creator's operation label, so its destination is
    proven by the refresh receipt this operation journaled: it replaced the captured original with this very container."""
    from fleet_executor_pki import checked_file
    state = executor.policy.get('roots', {}).get('state')
    filename = state and Path(state) / 'operations' / executor.context['operation_id'] / ('image-refresh-' + agent['runtime_key'] + '.json')
    if not filename or not filename.exists():
        return False
    receipt = json.loads(checked_file(filename, True))
    return receipt.get('status') == 'succeeded' and receipt.get('container_id') == current['Id'] \
        and receipt.get('previous_id') == pin['container_id'] and receipt.get('previous_image') == pin['image_id'] \
        and receipt.get('container_name') == agent['container_name'] and receipt.get('runtime_key') == agent['runtime_key'] \
        and receipt.get('tenant_id') == agent['tenant_id'] and receipt.get('host_id') == executor.policy['host_id']


def recreate_original(executor, entry: dict) -> None:
    """An update that changes extensions or resources recreates the container under its own name, so the captured
    original no longer exists when admission fails. Restoring it rebuilds the captured placement: the approved previous
    shape, the captured image and the very volumes pinned at capture. The rebuild carries this operation as its
    provenance, is started idle (no adapter) and pinned in the journal; from then on it is verified as the original,
    field by field, and the restoration continues exactly as for a preserved original."""
    if 'recreated_original' in entry:
        return
    from fleet_executor_container import (
        OPERATION_LABEL,
        assert_idle_command,
        create_container,
        discard_operation,
        docker,
        expected_labels,
        inspect_container,
        validate_container,
    )
    from fleet_executor_image import previous_agent
    from fleet_executor_replacement import container_pin, volume_pins
    context, journal = executor.context, executor.journal
    operation = context['operation_id']
    previous = context['previous_agents'][0]
    desired = executor.agent()
    if desired['container_name'] != previous['container_name'] or not isinstance(entry.get('original'), dict):
        return
    try:
        pin = entry['original']['previous']
        if docker('ps', '-a', '-q', '--no-trunc', '--filter', 'id=' + pin['container_id']).strip():
            return
        # Only this operation's runtime step removes the original in place; anything else stays unverified.
        if 'runtime' not in journal.get('attempted', []) or journal.get('runtime_launch_attempted') is not True:
            raise ValueError
        agent = approve_agent(executor.policy, previous)
        if agent['runtime_mode'] != 'container' or agent['_placement'].get('ownership') == 'shared' \
                or any(agent.get(key) != desired.get(key) for key in ('tenant_id', 'alias', 'runtime_key', 'host_id')):
            raise ValueError
        # The rebuild needs the captured image and the captured volumes; without them the destination is kept.
        restored = previous_agent(agent, pin['image_id'])
        image = json.loads(docker('image', 'inspect', pin['image_id']))
        if len(image) != 1 or image[0].get('Id') != pin['image_id'] \
                or volume_pins(executor.policy, agent) != entry['original']['volumes']:
            raise ValueError
        current = inspect_container(agent['container_name'])
        if current is not None:
            labels = current['Config'].get('Labels') or {}
            if any(labels.get(key) != value for key, value in expected_labels(executor.policy, agent).items()):
                raise ValueError
            if labels.get(RESTORED_LABEL) != operation:
                refreshed = labels.get(OPERATION_LABEL) != operation
                if refreshed and not refreshed_destination(executor, agent, pin, current):
                    raise ValueError
                entry['phase'] = 'removing_destination'
                executor.save()
                if refreshed:
                    docker('rm', '-f', current['Id'])
                discard_operation(executor.policy, desired, operation)
                if inspect_container(agent['container_name']) is not None:
                    raise ValueError
                current = None
        if current is None:
            entry['phase'] = 'recreating_original'
            executor.save()
            current = create_container(executor.policy, restored, extra_labels={RESTORED_LABEL: operation})
        # Pinned once running, as the original was: Docker rewrites HostConfig (OomKillDisable) on the first start.
        if not current['State']['Running']:
            assert_idle_command(current)
            docker('start', current['Id'])
            started = inspect_container(agent['container_name'])
            if started is None or started['Id'] != current['Id'] or not started['State']['Running']:
                raise ValueError
            current = started
        validate_container(executor.policy, restored, current)
        labels = current['Config'].get('Labels') or {}
        if current['Image'] != pin['image_id'] or labels.get(RESTORED_LABEL) != operation or OPERATION_LABEL in labels \
                or volume_pins(executor.policy, agent) != entry['original']['volumes']:
            raise ValueError
        entry.update(recreated_original=container_pin(current), phase='recreated_original')
        executor.save()
    except (OSError, KeyError, TypeError, ValueError, IndexError, SafeFailure) as error:
        frames = traceback.extract_tb(error.__traceback__)
        entry['diagnostic'] = {'phase': entry.get('phase'), 'exception_type': type(error).__name__,
                               'last_function': frames[-1].name if frames else None,
                               'last_lineno': frames[-1].lineno if frames else None}
        try:
            executor.save()
        except OSError:
            pass
        raise SafeFailure('replacement original unverified') from None


def capture(executor) -> None:
    if not restoration(executor.context):
        return
    value = snapshot(executor.context)
    entry = executor.journal.get('replacement_compensation')
    if entry is not None:
        if entry.get('snapshot_sha256') != value['snapshot_sha256']:
            raise SafeFailure('replacement snapshot missing')
        return
    if executor.journal.get('attempted') or executor.journal.get('runtime_launch_attempted'):
        raise SafeFailure('replacement authority unverified')
    from fleet_executor_authority import checkpoint_credentials
    from fleet_executor_container import adapter_restart_state
    from fleet_executor_replacement import capture_previous
    try:
        previous = executor.context['previous_agents'][0]
        receipt = capture_previous(executor.policy, previous)
        entry = {'snapshot_sha256': value['snapshot_sha256'], 'original': receipt,
                 'original_container_id': receipt['previous']['container_id'], 'phase': 'capturing'}
        agent, observed = original(executor, entry)
        state = adapter_restart_state(executor.policy, agent, observed)
        if state.get('adapter_bootstrap') is not False:
            raise SafeFailure('replacement original unverified')
        entry['adapter_state'] = state
        entry.update(normal_pins(executor, agent))
        checkpoint = checkpoint_credentials(executor.policy, executor.context, agent, entry)
        entry.update(checkpoint_sha256=checkpoint['checkpoint_sha256'], phase='captured')
        executor.journal['replacement_compensation'] = entry
        if previous['container_name'] != executor.context['request']['parameters']['placement']['container_name']:
            executor.journal.setdefault('replacement_retirement', receipt)
        executor.save()
    except (OSError, KeyError, TypeError, ValueError, SafeFailure) as error:
        if str(error) == 'replacement original unverified':
            raise
        raise SafeFailure('replacement authority unverified') from None


# Artifacts whose top-level maps are keyed by runtime key; every other key of these documents is compared verbatim.
RUNTIME_KEYED = {'flota.json': ('fleet', 'placement', 'retired', 'bootstrap'),
                 'container-aliases.json': ('aliases', 'historicalAliases'),
                 'bootstrap/container-aliases.json': ('aliases', 'historicalAliases'),
                 'generated/fleet.json': ('aliases',)}


def _artifact(state: Path, generation: str, name: str, digest: str):
    body = (Path(state) / 'generations' / generation / name).read_bytes()
    if hashlib.sha256(body).hexdigest() != digest:
        raise ValueError
    return json.loads(body)


def _without_runtime(document, maps: tuple[str, ...], runtime_key: str):
    if not isinstance(document, dict):
        raise ValueError
    trimmed = dict(document)
    for name in maps:
        if name not in trimmed:
            continue
        if not isinstance(trimmed[name], dict):
            raise ValueError
        rows = {key: row for key, row in trimmed[name].items() if key != runtime_key}
        # An empty runtime-keyed map and an absent one describe the same fleet (the exporter omits an empty bootstrap).
        if rows:
            trimmed[name] = rows
        else:
            trimmed.pop(name)
    return trimmed


def differs_only_in_runtime(state: Path, applied: dict, receipt: dict, runtime_key: str) -> bool:
    """Whether publishing `receipt` over the applied generation changes nothing on this host but `runtime_key`.

    Another operation of the same host (a retire, a start) may publish its own applied generation while this one waits
    to be compensated. The restoration is rendered from the current, revision-locked fleet snapshot, so it already carries
    that operation's effect: when both generations agree artifact by artifact on every other runtime, the restoration
    rebases onto the applied generation without undoing anyone else's work. Any other difference keeps it refused."""
    own = {f'manifests/{runtime_key}.yaml', f'bootstrap/manifests/{runtime_key}.yaml'}
    left, right = applied['files'], receipt['files']
    for name in sorted((set(left) | set(right)) - own):
        if left.get(name) == right.get(name):
            continue
        maps = RUNTIME_KEYED.get(name)
        if maps is None or name not in left or name not in right:
            return False
        if _without_runtime(_artifact(state, applied['generation'], name, left[name]), maps, runtime_key) \
                != _without_runtime(_artifact(state, receipt['generation'], name, right[name]), maps, runtime_key):
            return False
    return True


def restore_source(executor, value: dict) -> dict:
    from fleet_runtime_apply import publish_applied
    from fleet_runtime_materialization import load_applied_fleet
    source = copy.deepcopy(executor.context['snapshot'])
    source.pop('compensation_snapshot', None)
    before = value['previous_agents'][0]
    rows = [row for row in source['agents'] if row.get('tenant_id') == before['tenant_id'] and row.get('alias') == before['alias']]
    if len(rows) != 1:
        raise SafeFailure('replacement snapshot missing')
    for key in rows[0]:
        if key in before:
            rows[0][key] = before[key]
    source['memberships'] = [member for member in source['memberships']
        if (member['tenant_id'], member['alias']) != (before['tenant_id'], before['alias'])]
    fields = ('tenant_id', 'alias', 'room_id', 'role', 'enabled')
    source['memberships'].extend({key: member[key] for key in fields} for member in value['previous_memberships'])
    receipt = executor.materialize_snapshot(source)
    applied = load_applied_fleet(executor.state)
    current = applied['generation']
    permitted = {executor.journal['expected_applied'], executor.journal.get('admission_pending_generation'),
                 executor.journal.get('admission', {}).get('generation'), receipt['generation']}
    if current not in permitted:
        runtime_key = executor.context['request']['parameters']['runtime_key']
        try:
            rebased = differs_only_in_runtime(executor.state, applied, receipt, runtime_key)
        except (OSError, KeyError, TypeError, ValueError):
            rebased = False
        if not rebased:
            raise SafeFailure('replacement original unverified')
        rebase = {'from': current, 'to': receipt['generation']}
        history = executor.journal['replacement_compensation'].setdefault('rebased_applied', [])
        if rebase not in history:
            history.append(rebase)
            executor.save()
    publish_applied(executor.state, receipt['generation'], current)
    return receipt


def cleanup_credentials(executor, entry: dict, revoked: list[dict]) -> None:
    if not revoked:
        return
    from fleet_executor_authority import scope_for, stable_scope
    from fleet_executor_pki import checked_file
    from fleet_executor_terminal_files import remove_file
    key = executor.context['request']['parameters']['runtime_key']
    scope = stable_scope(scope_for(executor.policy, executor.context, executor.agent()))
    for credential in revoked:
        phase = credential['phase']
        pair = Path(executor.policy['roots']['pki']) / phase / key
        token = Path(executor.policy['roots']['tokens']) / phase / (key + '.token')
        files = {'certificate': (pair / ('agent-' + key + '.crt'), 0o444),
                 'private': (pair / ('agent-' + key + '.key'), 0o400),
                 'csr': (pair / ('agent-' + key + '.csr'), 0o400),
                 'receipt': (pair / '.authority-receipt.json', 0o400),
                 'token': (token, 0o400), 'request': (pair / '.authority-request.json', 0o400)}
        cleanups = entry.setdefault('credential_cleanup', {})
        plan = cleanups.get(phase)
        if plan is None:
            present = {name: (filename, mode) for name, (filename, mode) in files.items() if os.path.lexists(filename)}
            if present:
                request = json.loads(checked_file(files['request'][0], True))
                if request.get('scope') != scope or request.get('phase') != phase:
                    raise SafeFailure('replacement authority unverified')
                if 'certificate' in present:
                    pem = checked_file(files['certificate'][0]).decode()
                    if hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest() != credential['certificate_sha256']:
                        raise SafeFailure('replacement authority unverified')
                if 'token' in present and hashlib.sha256(checked_file(token, True).strip()).hexdigest() != credential['token_sha256']:
                    raise SafeFailure('replacement authority unverified')
            plan = {**credential, 'files': {name: hashlib.sha256(checked_file(filename, mode == 0o400)).hexdigest()
                                           for name, (filename, mode) in present.items()}}
            cleanups[phase] = plan
            executor.save()
        if any(plan.get(name) != credential[name] for name in credential):
            raise SafeFailure('replacement authority unverified')
        for name, (filename, mode) in files.items():
            if name not in plan['files']:
                if os.path.lexists(filename):
                    raise SafeFailure('replacement authority unverified')
                continue
            remove_file(filename, plan['files'][name], mode)
        try:
            pair.rmdir()
        except FileNotFoundError:
            pass
        plan['complete'] = True
        executor.save()


def preserve_container(executor, agent: dict, observed: dict, entry: dict) -> None:
    from fleet_executor_container import adapter_restart_state, stop_running_adapter
    try:
        state = adapter_restart_state(executor.policy, agent, observed)
        current = agent
    except SafeFailure:
        current = executor.agent()
        state = adapter_restart_state(executor.policy, current, observed)
    if state.get('adapter_running') is False:
        return
    if state.get('adapter_running') is not True:
        raise SafeFailure('replacement original unverified')
    if state.get('adapter_bootstrap') is False \
            and state.get('adapter_operation_id') == entry['adapter_state'].get('adapter_operation_id'):
        return
    if state.get('adapter_operation_id') != executor.context['operation_id']:
        raise SafeFailure('replacement original unverified')
    entry['phase'] = 'stopping_operation_adapter'
    executor.save()
    stop_running_adapter(current, observed)


def compensate(executor) -> dict | None:
    if not restoration(executor.context):
        return None
    journal = executor.journal
    same_container = executor.context['previous_agents'][0]['container_name'] \
        == executor.context['request']['parameters']['placement']['container_name']
    if same_container and executor.context.get('restore_previous_runtime') is True \
            and 'compensation_snapshot' not in executor.context.get('snapshot', {}) \
            and 'replacement_compensation' not in journal \
            and all(step in {'prepare', 'stop'} for step in journal.get('attempted', [])) \
            and not any(name in journal for name in ('bootstrap_credentials', 'normal_credentials', 'runtime',
                'runtime_launch_attempted', 'compensation_credential_effects', 'revocation_complete', 'terminal_provision')) \
            and not any(journal.get(name) for name in ('central_revocations', 'compensated', 'revoked', 'legacy_authority_absence')):
        return None
    value = snapshot(executor.context)
    entry = executor.journal.get('replacement_compensation')
    if not isinstance(entry, dict) or entry.get('snapshot_sha256') != value['snapshot_sha256']:
        raise SafeFailure('replacement authority unverified')
    restarting = entry.get('original_restart_attempted') is True
    recreate_original(executor, entry)
    agent, observed = original(executor, entry, restarting=restarting)
    try:
        if normal_pins(executor, agent) != {key: entry[key] for key in ('normal_certificate_sha256', 'normal_token_sha256')}:
            raise ValueError
        if executor.journal.get('terminal_provision'):
            from fleet_executor_terminal_provision import rollback_terminal
            rollback_terminal(executor.policy, executor.context, executor.agent(), executor.journal, executor.save)
        from fleet_executor_container import discard_operation, inspect_container, restore_existing_adapter
        desired = executor.agent()
        if desired['container_name'] == agent['container_name']:
            preserve_container(executor, agent, observed, entry)
        else:
            entry['phase'] = 'removing_destination'
            executor.save()
            discard_operation(executor.policy, desired, executor.context['operation_id'])
            if inspect_container(desired['container_name']) is not None:
                raise SafeFailure('replacement original unverified')
        from fleet_executor_authority import rollback_credentials
        entry['phase'] = 'rolling_back_authority'
        executor.save()
        authority = rollback_credentials(executor.policy, executor.context, agent, entry)
        cleanup_credentials(executor, entry, authority['revoked_credentials'])
        entry['authority_sha256'] = authority['authority_sha256']
        entry['phase'] = 'restoring_snapshot'
        entry['original_restart_attempted'] = True
        executor.save()
        receipt = restore_source(executor, value)
        state = entry['adapter_state']
        entry['phase'] = 'restoring_adapter'
        executor.save()
        restored_agent = {**agent, '_trusted_accounts': executor.context.get('trusted_accounts', []),
                          '_trusted_accounts_present': 'trusted_accounts' in executor.context}
        from fleet_executor_update_resume import untouched_restoration
        proof = untouched_restoration(executor, restored_agent) or restore_existing_adapter(
            executor.policy, restored_agent, was_running=True, bootstrap=False,
            operation_id=state.get('adapter_operation_id'), allow_refresh=False)
        if not isinstance(proof.get('runtime_digest'), str):
            raise SafeFailure('replacement original unverified')
        entry['phase'] = 'verifying_original'
        executor.save()
        original(executor, entry, restarting=True)
        entry['phase'] = 'verifying_authority'
        executor.save()
        authority = rollback_credentials(executor.policy, executor.context, agent, entry)
        binding = ['fleet-replacement-restored:v1', value['snapshot_sha256'], entry['original_container_id'],
                   entry['checkpoint_sha256'], authority['authority_sha256']]
        runtime = hashlib.sha256('\n'.join(binding).encode()).hexdigest()
        restored = {'snapshot_sha256': value['snapshot_sha256'], 'original_container_id': entry['original_container_id'],
                    'checkpoint_sha256': entry['checkpoint_sha256'], 'authority_sha256': authority['authority_sha256'],
                    'runtime_digest': runtime, 'shared_authority_preserved': True, 'created_authority_revoked': True}
        entry.update(phase='restored', runtime_proof_sha256=proof['runtime_digest'], evidence=restored)
        executor.save()
        return {'replacement_restored': restored, 'runtime_digest': runtime, 'artifact_sha256': receipt['generation'],
                'stopped_verified': True, 'revocation_verified': True}
    except (OSError, KeyError, TypeError, ValueError, SafeFailure) as error:
        frames = traceback.extract_tb(error.__traceback__)
        entry['diagnostic'] = {'phase': entry['phase'], 'exception_type': type(error).__name__,
                               'last_function': frames[-1].name, 'last_lineno': frames[-1].lineno}
        try:
            executor.save()
        except OSError:
            pass
        if isinstance(error, SafeFailure) and str(error) in {'replacement original unverified', 'replacement snapshot missing'}:
            raise
        raise SafeFailure('replacement authority unverified') from None
