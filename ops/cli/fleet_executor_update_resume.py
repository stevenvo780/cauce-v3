from __future__ import annotations

from fleet_executor_policy import SafeFailure, approve_agent

UNACCREDITED = 'shared terminal has no exact Codex conversation to resume'


def requires_exact_resume(policy: dict, agent: dict) -> bool:
    return agent.get('_require_shared_resume') is True and agent.get('harness_id') == 'codex' \
        and agent.get('runtime_mode') == 'container' and agent['_placement'].get('ownership') != 'shared' \
        and policy['bundles']['codex'].get('shared_tui') is True


def assert_update_resumes(policy: dict, agent: dict) -> bool:
    """Before an update stops anything, the current SDK must accredit the exact conversation its shared TUI will resume."""
    if not requires_exact_resume(policy, agent):
        return False
    from fleet_executor_container import identity_for, inspect_container, user_identity
    from fleet_executor_image import validate_previous
    from fleet_executor_resume import resume_proof
    from fleet_executor_runtime import approved_bundle
    observed = inspect_container(agent['container_name'])
    if observed is None or not observed['State']['Running']:
        return False
    previous = validate_previous(policy, agent, observed)
    uid, gid = user_identity(previous, identity_for(previous, observed))
    try:
        resume_proof(policy, agent, observed, approved_bundle(policy, agent), uid, gid)
    except SafeFailure:
        raise SafeFailure(UNACCREDITED) from None
    return True


def preflight(executor) -> None:
    journal = executor.journal
    if journal.get('stopped') is True or journal.get('shared_resume_accredited') is True:
        return
    try:
        accredited = assert_update_resumes(executor.policy, executor.agent())
    except SafeFailure as error:
        if str(error) == UNACCREDITED:
            journal['shared_resume_refused'] = True
            executor.save()
        raise
    journal.pop('shared_resume_refused', None)
    if accredited:
        journal['shared_resume_accredited'] = True
    executor.save()


def untouched_restoration(executor, agent: dict) -> dict | None:
    """The original adapter of an update refused before it stopped anything, still the recorded process: it keeps running.

    Relaunching it would apply the current policy, whose shared TUI is exactly what could not resume its conversation.
    """
    journal = executor.journal
    recorded = journal.get('previous_adapter_state', {}).get(agent['runtime_key'])
    if journal.get('shared_resume_refused') is not True or journal.get('stopped') is True \
            or not isinstance(recorded, dict) or recorded.get('adapter_running') is not True:
        return None
    from fleet_executor_container import adapter_restart_state, identity_for, inspect_container, process_proof
    from fleet_executor_image import validate_previous
    from fleet_executor_runtime import approved_bundle
    approved = approve_agent(executor.policy, agent)
    observed = inspect_container(approved['container_name'])
    if observed is None or not observed['State']['Running']:
        return None
    try:
        if adapter_restart_state(executor.policy, approved, observed) != recorded:
            return None
        previous = validate_previous(executor.policy, approved, observed)
        return process_proof(executor.policy, previous, identity_for(previous, observed), approved_bundle(executor.policy, approved))
    except SafeFailure:
        return None
