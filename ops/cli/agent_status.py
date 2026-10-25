from __future__ import annotations

import datetime
import re

IDENTITY = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}\Z')
MODES = {'shell': 'Consola de comandos', 'harness': 'TUI solo lectura', 'harness_rw': 'TUI con control'}
STATES = {'queued': 'Pendiente', 'running': 'En ejecución', 'awaiting_auth': 'Espera de login',
          'cancelling': 'Cancelando', 'cancelled': 'Cancelada', 'failed': 'Fallida', 'succeeded': 'Completada'}
KINDS = {'create': 'Crear', 'update': 'Editar', 'start': 'Iniciar', 'stop': 'Detener', 'retire': 'Retirar',
         'restore': 'Restaurar', 'purge': 'Purgar', 'recover': 'Recuperar', 'migrate': 'Trasladar'}
LIFECYCLE = {'draft': 'Borrador', 'provisioning': 'Preparando', 'auth_pending': 'Login pendiente',
             'verifying': 'Verificando', 'ready': 'Listo', 'retiring': 'Retirando', 'retired': 'Retirado',
             'purged': 'Purgado', 'disabled': 'Deshabilitado', 'active': 'Activo'}


def rows(snapshot: object, key: str) -> list[dict]:
    value = snapshot.get(key) if isinstance(snapshot, dict) else None
    if not isinstance(value, list):
        raise ValueError('invalid agent snapshot')
    return [row for row in value if isinstance(row, dict)]


def same_agent(row: dict, target: dict) -> bool:
    return all(row.get(key) == target[key] for key in ('tenant_id', 'alias'))


def timestamp(value: object) -> str:
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else None
        if parsed is not None and parsed.tzinfo is not None:
            return parsed.astimezone(datetime.UTC).strftime('%Y-%m-%d %H:%M:%S UTC')
    except ValueError:
        pass
    return 'Sin fecha confirmada'


def agent_status(target: dict, configuration: object, activity: object, operations: object) -> str:
    registered = [] if configuration is None else rows(configuration, 'agents')
    retired = configuration.get('retired') if isinstance(configuration, dict) else None
    if isinstance(retired, dict):
        registered += rows(retired, 'agents')
    agent = next((row for row in registered if same_agent(row, target)), {})
    observed = [] if activity is None else rows(activity, 'agents')
    live = next((row for row in observed if same_agent(row, target)), {})
    placement = agent.get('placement') if isinstance(agent.get('placement'), dict) else {}
    host = agent.get('host_id') or placement.get('host_id') or live.get('host_id')
    host = host if isinstance(host, str) and IDENTITY.fullmatch(host) else 'Sin ordenador confirmado'
    mode = {'container': 'Contenedor', 'native': 'Nativo'}.get(agent.get('runtime_mode') or placement.get('mode'), 'Sin modo confirmado')
    presence = live.get('presence') if isinstance(live.get('presence'), dict) else {}
    online = presence.get('online')
    lease = 'Vigente' if online is True else 'Caducado' if online is False else 'Sin lease observado'
    if activity is None:
        lease = 'No disponible para esta sesión'
    available = target.get('authorized') is True and target.get('pty_state') == 'online' and bool(target.get('modes'))
    lines = ['Ordenador: ' + host, 'Modo: ' + mode,
             'Ciclo de vida: ' + LIFECYCLE.get(agent.get('lifecycle_state'), 'Sin estado confirmado'),
             'Lease: ' + lease, 'Terminal disponible: ' + ('Sí' if available else 'No')]
    if presence.get('lease_until') is not None:
        lines.append('Vencimiento del lease: ' + timestamp(presence['lease_until']))
    if operations is None:
        lines.append('Operación en curso: No disponible para esta sesión')
    else:
        scoped = [row for row in rows(operations, 'operations') if isinstance(row.get('target'), dict)
                  and row['target'].get('resource') == 'agent' and same_agent(row['target'], target)]
        active = [row for row in scoped if row.get('status') in ('queued', 'running', 'awaiting_auth', 'cancelling')]
        lines.append('Operación en curso: ' + ('; '.join(KINDS.get(row.get('kind'), 'Operación') + ' · '
                     + STATES[row['status']] for row in active) or 'Ninguna'))
    return '\n'.join(lines)


def terminal_sessions(target: dict, snapshot: object) -> str:
    lines = ['Sesiones terminales de tu sesión nominal (inventario limitado a 100 resultados):']
    scoped = [row for row in rows(snapshot, 'items') if same_agent(row, target)]
    if not scoped:
        return '\n'.join([*lines, 'No hay sesiones terminales visibles para este agente.'])
    states = {'issued': 'Emitida', 'active': 'Activa', 'closed': 'Cerrada'}
    for index, row in enumerate(scoped, 1):
        lines.append(f"{index}. " + MODES.get(row.get('mode'), 'Modo desconocido') + ' · '
                     + states.get(row.get('state'), 'Estado desconocido') + ' · Abierta: '
                     + timestamp(row.get('opened_at')) + ' · Vence: ' + timestamp(row.get('expires_at')))
    return '\n'.join(lines)
