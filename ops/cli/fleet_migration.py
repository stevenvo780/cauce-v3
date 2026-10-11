from __future__ import annotations

from fleet_executor_policy import SafeFailure


def placement_role(context: dict) -> str | None:
    scope = context.get('fleet_scope', {})
    role = scope.get('placement_role')
    if role is None:
        return None
    request = context['request']
    target = request['target']
    if role not in {'source', 'destination'} or request['kind'] != 'update' or target['resource'] != 'agent':
        raise SafeFailure('migration requires an exact coordinated agent update')
    parameters = request['parameters']
    host = scope['host_id']
    previous = context['previous_agents']
    fenced = context['fenced_targets']
    expected = {'resource': 'agent', 'tenant_id': target['tenant_id'], 'alias': target['alias']}
    if fenced != [expected]:
        raise SafeFailure('migration requires its exact durable identity fence')
    if role == 'source':
        if len(previous) != 1 or host == parameters['placement']['host_id']:
            raise SafeFailure('migration source placement is unavailable')
        agent = previous[0]
        if any(agent.get(field) != value for field, value in (
                ('host_id', host), ('tenant_id', target['tenant_id']), ('alias', target['alias']),
                ('runtime_key', parameters['runtime_key']))):
            raise SafeFailure('migration source identity differs from its durable placement')
    elif host != parameters['placement']['host_id'] or previous:
        raise SafeFailure('migration destination placement is unavailable')
    return role


def approve_step(context: dict, step: str) -> None:
    role = placement_role(context)
    if role is None:
        return
    allowed = {'source': {'stop', 'revoke', 'artifacts', 'compensate'},
               'destination': {'credentials', 'runtime', 'authenticate', 'profile', 'verify',
                               'admission', 'artifacts', 'compensate', 'login-stop'}}
    if step not in allowed[role]:
        raise SafeFailure('fleet step is outside the sealed migration placement role')
