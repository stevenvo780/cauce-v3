from __future__ import annotations

from fleet_executor_policy import SafeFailure, approve_agent

UNACCREDITED = 'shared terminal has no accredited conversation to continue'
SHARED_HARNESSES = frozenset({'codex', 'claude', 'grok', 'muse'})


def proof_mode(policy: dict, agent: dict, previous: list[dict]) -> str | None:
    """`resume` when the update keeps the selection, `launch` when it changes model, effort or account of the same harness.

    A harness change starts the conversation tree of another provider: the runtime step is left to report it.
    """
    if agent.get('harness_id') not in SHARED_HARNESSES \
            or policy.get('bundles', {}).get(agent['harness_id'], {}).get('shared_tui') is not True \
            or agent.get('runtime_mode') != 'container' or agent['_placement'].get('ownership') == 'shared':
        return None
    if agent.get('_require_shared_resume') is True:
        return 'resume'
    rows = [row for row in previous if row.get('tenant_id') == agent.get('tenant_id') and row.get('alias') == agent.get('alias')]
    if len(rows) != 1 or any(rows[0].get(field) != agent.get(field) for field in ('harness_id', 'runtime_key', 'container_name')):
        return None
    return 'launch'


def assert_update_resumes(policy: dict, agent: dict, previous: list[dict], operation_id: str) -> bool:
    """Before an update stops anything, the current SDK must accredit the shared terminal its new adapter will start."""
    mode = proof_mode(policy, agent, previous)
    if mode is None:
        return False
    from fleet_executor_container import identity_for, inspect_container, user_identity
    from fleet_executor_image import validate_previous
    from fleet_executor_resume import launch_proof, resume_proof
    from fleet_executor_runtime import approved_bundle
    observed = inspect_container(agent['container_name'])
    if observed is None or not observed['State']['Running']:
        return False
    current = validate_previous(policy, agent, observed)
    uid, gid = user_identity(current, identity_for(current, observed))
    bundle = approved_bundle(policy, agent)
    try:
        if mode == 'resume':
            resume_proof(policy, agent, observed, bundle, uid, gid)
        else:
            launch_proof(policy, agent, observed, bundle, uid, gid, operation_id)
    except SafeFailure:
        raise SafeFailure(UNACCREDITED) from None
    return True


def preflight(executor) -> None:
    journal = executor.journal
    if journal.get('stopped') is True or journal.get('shared_resume_accredited') is True:
        return
    try:
        accredited = assert_update_resumes(executor.policy, executor.agent(), executor.context.get('previous_agents', []),
                                           executor.context['operation_id'])
    except SafeFailure as error:
        if str(error) == UNACCREDITED:
            journal['shared_resume_refused'] = True
            executor.save()
        raise
    journal.pop('shared_resume_refused', None)
    if accredited:
        journal['shared_resume_accredited'] = True
    executor.save()


def _recorded_bundle(policy: dict, approved: dict, observed: dict, recorded: dict) -> dict:
    """The bundle the untouched adapter runs: the approved one, or the same harness bundle of the release its container binds."""
    from fleet_executor_container import RELEASE_ROOT, approved_executable_digest, rebased
    from fleet_executor_image import previous_agent
    from fleet_executor_rebind import bound_release
    from fleet_executor_runtime import approved_bundle
    bundle = approved_bundle(policy, approved)
    if recorded.get('adapter_bundle_digest') == bundle['digest']:
        return bundle
    root = bound_release(observed, RELEASE_ROOT)
    if root is None:
        raise SafeFailure('untouched adapter runs a bundle of no bound release')
    executable = bundle['executable_sha256']
    if executable is not None and approved['_placement']['image'] != observed.get('Image'):
        executable = approved_executable_digest(policy, previous_agent(approved, observed.get('Image')), bundle)
    return {**bundle, 'directory': rebased(bundle['directory'], RELEASE_ROOT, root),
            'digest': recorded['adapter_bundle_digest'], 'executable_sha256': executable}


def untouched_restoration(executor, agent: dict) -> dict | None:
    """The original adapter of an update refused before it stopped anything, still the recorded process: it keeps running.

    Relaunching it would apply the current policy, whose shared TUI is exactly what could not continue its conversation;
    after a release change it would also start the new release. The process is accredited against the bundle it runs.
    """
    journal = executor.journal
    recorded = journal.get('previous_adapter_state', {}).get(agent['runtime_key'])
    if journal.get('shared_resume_refused') is not True or journal.get('stopped') is True \
            or not isinstance(recorded, dict) or recorded.get('adapter_running') is not True:
        return None
    from fleet_executor_container import adapter_restart_state, identity_for, inspect_container, process_proof
    from fleet_executor_image import validate_previous
    approved = approve_agent(executor.policy, agent)
    observed = inspect_container(approved['container_name'])
    if observed is None or not observed['State']['Running']:
        return None
    try:
        if adapter_restart_state(executor.policy, approved, observed) != recorded:
            return None
        previous = validate_previous(executor.policy, approved, observed)
        bundle = _recorded_bundle(executor.policy, approved, observed, recorded)
        return process_proof(executor.policy, previous, identity_for(previous, observed), bundle)
    except SafeFailure:
        return None
