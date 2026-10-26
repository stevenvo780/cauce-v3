from __future__ import annotations

import hashlib
import json
import uuid

from fleet_executor_policy import SafeFailure

PRESENT = 'El adaptador corre con una versión anterior. Se detendrá y se relanzará con la versión vigente, que reanuda la conversación acreditada.'
ABSENT = 'El adaptador está detenido. Se relanzará con la versión vigente, que reanuda la conversación acreditada.'
UNRESUMABLE = 'La versión vigente no acredita una conversación exacta que reanudar. Relanzar podría perder el contexto; no se modificó el agente.'
RELAUNCHED = 'Se relanzó con la versión vigente; su TUI compartida reanuda la conversación acreditada al reconectarse.'


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def instance_id(value) -> str:
    try:
        if isinstance(value, str) and str(uuid.UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise SafeFailure('relaunch adapter instance identity is unavailable')


def observe(policy: dict, agent: dict) -> tuple[dict, dict] | None:
    """None when the adapter runs the approved bundle in the approved container: only its TUI is recovered."""
    import fleet_executor_container as runtime
    from fleet_executor_rebind import bound_release
    from fleet_executor_resume import resume_proof
    from fleet_executor_runtime import approved_bundle, sdk_environment
    if agent['runtime_mode'] != 'container' or agent['_placement'].get('ownership') == 'shared':
        return None
    observed = runtime.inspect_container(agent['container_name'])
    if observed is None or observed.get('State', {}).get('Running') is not True:
        return None
    bundle = approved_bundle(policy, agent)
    previous = runtime.teardown_agent(policy, agent, observed)
    recreate = observed.get('Image') != agent['_placement']['image'] or bound_release(observed, runtime.RELEASE_ROOT) is not None
    if not recreate:
        runtime.validate_container(policy, agent, observed)
    state, environment = runtime.observe_adapter_state(previous, observed)
    if state['adapter_running'] and state['adapter_bundle_digest'] == bundle['digest'] and not recreate:
        return None
    identity = runtime.identity_for(previous, observed)
    if state['adapter_running']:
        plan = {'bootstrap': state['adapter_bootstrap'], 'operation_id': state['adapter_operation_id']}
        writer = instance_id(environment.get('CAUCE_INSTANCE_ID'))
    else:
        plan = {'bootstrap': False, 'operation_id': None}
        writer = instance_id(sdk_environment(policy, agent, False, None)['CAUCE_INSTANCE_ID'])
    uid, gid = runtime.user_identity(previous, identity)
    try:
        resume = resume_proof(policy, agent, observed, bundle, uid, gid)['fingerprint']
    except SafeFailure:
        resume = None
    public = {'container_id': identity['container_id'], 'generation': identity['generation'], 'writer_instance_id': writer}
    if resume is None:
        session = {'type': 'session', 'state': 'unsupported', 'resumable': False, 'fingerprint': None, 'reason': UNRESUMABLE}
    else:
        witness = {'identity': public, 'adapter': state, 'bundle': bundle['digest'], 'image': agent['_placement']['image'],
                   'recreates_container': recreate, 'resume': resume}
        session = {'type': 'session', 'state': 'present' if state['adapter_running'] else 'absent', 'resumable': True,
                   'fingerprint': digest(witness), 'reason': PRESENT if state['adapter_running'] else ABSENT}
    preview = {'identity': public, 'session': session, 'strategy': 'relaunch', 'preserves_conversation': True,
               'recreates_container': recreate}
    return preview, {**plan, 'resume': resume}


def relaunched_agent(agent: dict) -> dict:
    return {**agent, '_require_shared_resume': True}


def current_runtime(policy: dict, agent: dict, plan: dict) -> tuple[dict, dict]:
    import fleet_executor_container as runtime
    from fleet_executor_runtime import approved_bundle
    observed = runtime.inspect_container(agent['container_name'])
    if observed is None or observed.get('State', {}).get('Running') is not True:
        raise SafeFailure('relaunched container is not observed running')
    identity = runtime.identity_for(agent, observed)
    runtime.process_proof(policy, agent, identity, approved_bundle(policy, agent),
                          bootstrap=plan['bootstrap'], operation_id=plan['operation_id'])
    return observed, {'container_id': identity['container_id'], 'generation': identity['generation']}


def relaunch(policy: dict, agent: dict, plan: dict) -> dict:
    import fleet_executor_container as runtime
    from fleet_executor_resume import resume_proof
    from fleet_executor_runtime import approved_bundle
    agent = relaunched_agent(agent)
    runtime.start_container(policy, agent, bootstrap=plan['bootstrap'], operation_id=plan['operation_id'])
    observed, identity = current_runtime(policy, agent, plan)
    uid, gid = runtime.user_identity(agent, runtime.identity_for(agent, observed))
    if resume_proof(policy, agent, observed, approved_bundle(policy, agent), uid, gid)['fingerprint'] != plan['resume']:
        raise SafeFailure('relaunched runtime does not resume the confirmed conversation')
    return identity


def perform(policy: dict, agent: dict, parameters: dict, journal: dict, save, step: str) -> dict:
    from fleet_executor_container import start_container, stop_container
    if step == 'compensate':
        if journal.get('relaunch') is not None:
            plan = journal['relaunch']
            start_container(policy, relaunched_agent(agent), bootstrap=plan['bootstrap'], operation_id=plan['operation_id'])
        return {'evidence': {'recovery_compensated': True}}
    if 'receipt' in journal:
        if current_runtime(policy, relaunched_agent(agent), journal['relaunch'])[1] != journal['relaunched']:
            raise SafeFailure('relaunched runtime changed before its receipt was verified')
        return {'evidence': journal['receipt']}
    if step != 'runtime':
        raise SafeFailure('recovery has no verified receipt; a new explicit preview is required')
    if journal.get('relaunch') is None:
        observed = observe(policy, agent)
        if observed is None:
            raise SafeFailure('recovery strategy changed after confirmation')
        preview, plan = observed
        session = preview['session']
        if preview['identity'] != parameters['identity'] or session['state'] not in {'present', 'absent'} \
                or session['resumable'] is not True or session['fingerprint'] != parameters['expected_fingerprint'] \
                or session['state'] == 'present' and not parameters['force']:
            raise SafeFailure('recovery conversation or terminal changed after confirmation')
        journal.update(attempted=True, relaunch=plan, preview=preview)
        save()
    stop_container(policy, agent)
    identity = relaunch(policy, agent, journal['relaunch'])
    preview = journal['preview']
    receipt = {**preview, 'session': {**preview['session'], 'reason': RELAUNCHED,
               'state': 'resumed' if preview['session']['state'] == 'present' else 'recreated'}}
    journal.update(relaunched=identity, receipt={'runtime_digest': digest(receipt), 'recovery': receipt})
    save()
    return {'evidence': journal['receipt']}
