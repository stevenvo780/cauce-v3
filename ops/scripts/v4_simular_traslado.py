"""Offline migration checks over public inventory evidence, without provider sessions or host effects."""
from __future__ import annotations

import collections
import datetime
import json
import os
import pathlib
import stat
import time

from v4_copia_migracion import digest_of, load
from v4_mover_flota import Fleet, FleetFailure


class InventoryFleet(Fleet):
    def __init__(self, evidence, tenant):
        self.evidence, self.tenant, self.targets = evidence, tenant, {}

    def request(self, method, path, payload=None):
        if method != 'GET' or payload is not None:
            raise ValueError('la simulación solo admite lecturas')
        if path == '/v3/console/config':
            return self.evidence['snapshot']
        if path == '/v3/console/fleet/capability':
            return self.evidence['capability']
        raise ValueError('lectura fuera del inventario público')


def copy_summary(path, alias, tenant):
    manifest = load(str(path))
    if manifest['alias'] != alias or manifest['tenant'] != tenant:
        raise ValueError('la copia pertenece a otro agente o tenant')
    for entry in manifest['entries']:
        if entry['kind'] == 'file' and entry.get('source', 'data') == 'data':
            digest = entry['sha256']
            if digest_of(str(path / 'data' / digest[:2] / digest)) != digest:
                raise ValueError('un blob de la copia difiere de su manifiesto')
    for repo in manifest['repositories']:
        if digest_of(str(path / repo['bundle'])) != repo['bundleSha256']:
            raise ValueError('un bundle de la copia difiere de su manifiesto')
    return {'path': str(path), 'manifest': manifest['sha256'], 'created_at': manifest.get('createdAt'),
            'hashes_verified': True, 'restore_verified': False, 'consistent_stopped_snapshot': False,
            'omissions': dict(collections.Counter(item['reason'] for item in manifest['omissions'])),
            'data_files': manifest['totals']['dataFiles'], 'repositories': len(manifest['repositories'])}


def simulate(args, plan_path, load_plan, target_parameters):
    result = {'alias': args.alias, 'simular': True, 'changes': False, 'network': False,
              'plan': str(plan_path), 'state': 'preflight_required', 'blockers': [], 'checks': {},
              'steps': ['medir-antes', 'verificar-origen', 'detener-origen', 'comprobar-alcance-final',
                        'copiar-integral', 'restaurar-espacio', 'reubicar-flota', 'limites-destino',
                        'aplicar-contexto-destino', 'verificar-nonce-terminal-contexto-host-cuenta', 'medir-despues'],
              'outage': {'simulated_seconds': 0, 'real_seconds': None,
                         'interval': 'desde solicitar stop hasta verificar nonce, contexto y terminal',
                         'estimate': 'no medible sin copia consistente, red y autenticación reales'},
              'rollback': 'cancelar y asentar operación; update inverso, contexto y nonce desde origen',
              'pending': ['empresa activa y autoridad Cauce vigente (sesión o administrador de plataforma en gateway)',
                          'identidad física, imagen, capacidad y espacio destino vacíos',
                          'control exclusivo del origen; unidad legada fijada o colocación V4 verificada',
                          'autenticación de la misma cuenta en destino por el canal privado del dueño',
                          'contexto inicial versionado y adopción efectiva',
                          'copia consistente nueva tras stop; copia cifrada externa antes de retirar origen']}
    blockers, checks = result['blockers'], result['checks']
    plan = None
    try:
        plan = {**load_plan(plan_path, args.alias), 'alias': args.alias}
        checks['plan_valid'] = True
        from v4_mover_agente import destination_limits
        checks['destination_limits'] = destination_limits(plan)
        if plan.get('platform_gateway'):
            checks['authority'] = 'platform_gateway'
        else:
            info = pathlib.Path(plan['session_file']).lstat()
            checks['session_file_private'] = stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077
            if not checks['session_file_private']:
                blockers.append('session_file_not_private')
    except (OSError, ValueError, KeyError, TypeError):
        blockers.append('plan_or_session_missing_or_invalid')
    try:
        config = json.loads(args.alias_config.read_text())
        entry = config['aliases'][args.alias]
        if not isinstance(entry, dict):
            raise ValueError('entrada de alias inválida')
        checks['alias'] = {key: entry.get(key) for key in ('tenant', 'container', 'harness', 'user', 'workspace', 'stateDirectory')}
        tenant = plan['tenant'] if plan else entry['tenant']
        if entry['tenant'] != tenant:
            raise ValueError('el plan y el catálogo discrepan sobre el tenant')
        if plan and plan['source'].get('legacy_unit'):
            from v4_mover_legado import legacy_manager
            scope, user = legacy_manager(plan['source'], args.alias, entry)
            checks['legacy_manager'] = {'scope': scope, 'user': user, 'sudo': plan['source'].get('sudo', False)}
    except (OSError, ValueError, KeyError, TypeError):
        blockers.append('alias_config_missing_or_invalid')
        tenant = plan['tenant'] if plan else None
    if args.inventario and tenant:
        try:
            evidence = json.loads(args.inventario.read_text())
            observed = datetime.datetime.fromisoformat(evidence['observed_at'])
            if not observed.tzinfo:
                raise ValueError('el inventario requiere hora con zona horaria')
            age = time.time() - observed.timestamp()
            checks['inventory'] = {'path': str(args.inventario), 'age_seconds': round(age, 3), 'company': evidence['company']}
            if not 0 <= age <= 120:
                blockers.append('inventory_not_fresh')
            if plan and evidence['company'] != plan['company']:
                raise ValueError('el inventario no es de la empresa del plan')
            fleet = InventoryFleet(evidence, tenant)
            row = fleet.agent(args.alias)
            checks['agent'] = {key: row.get(key) for key in ('tenant_id', 'alias', 'harness_id', 'host_id', 'container_name',
                                                           'runtime_mode', 'lifecycle_state', 'enabled', 'primary_account_id', 'model_id')}
            legacy = row.get('runtime_mode') is None
            legacy_draft = legacy and row.get('lifecycle_state') == 'draft' and row.get('enabled') is False
            if row.get('enabled') is not True and not legacy_draft:
                blockers.append('source_agent_not_enabled')
            if row.get('lifecycle_state') != 'ready' and not (legacy and row.get('lifecycle_state') in {'verifying', 'draft'}):
                blockers.append('source_agent_not_ready')
            if row.get('runtime_mode') not in (None, 'native', 'container'):
                blockers.append('source_runtime_mode_invalid')
            selected = {**(plan.get('agent', {}) if plan else {}), **{key: value for key, value in row.items() if value is not None}}
            if not selected.get('primary_account_id'):
                blockers.append('original_account_not_bound')
            if selected.get('harness_id') == 'openclaw' and not selected.get('model_id'):
                blockers.append('openclaw_model_not_selected')
            if legacy:
                checks['legacy_create'] = True
                result['steps'][6:7] = ['registrar-borrador-heredado', 'preparar-flota-v4']
                result['rollback'] = 'asentar operación, retirar y purgar solo runtime destino, restaurar registro y arrancar unidad legada'
            host = plan['destination']['host_id'] if plan else 'server2'
            placements = [item for item in evidence['capability']['placements'] if item['host_id'] == host]
            runtimes = [item for placement in placements for item in placement.get('runtimes', [])]
            checks['destination'] = {'host_id': host, 'found': bool(placements),
                                     'runtimes': [{key: item.get(key) for key in ('harness_id', 'provider', 'mode', 'runtime_user')}
                                                  for item in runtimes]}
            if evidence['capability'].get('available') is not True:
                blockers.append('executor_capability_unavailable')
            if not any(item['harness_id'] == selected.get('harness_id') for item in runtimes):
                blockers.append('destination_harness_template_missing')
            if selected.get('primary_account_id'):
                provider = fleet.account_provider(selected['primary_account_id'])
                checks['account_provider'] = provider
                if not any(item['harness_id'] == selected.get('harness_id') and item['provider'] == provider for item in runtimes):
                    blockers.append('destination_provider_template_missing')
            if plan:
                try:
                    from v4_mover_agente import migration_parameters
                    target_parameters(fleet, migration_parameters(fleet, row, plan), plan)
                    checks['target_parameters_valid'] = True
                except (ValueError, FleetFailure):
                    blockers.append('target_parameters_invalid')
        except (OSError, ValueError, KeyError, TypeError, OverflowError, FleetFailure):
            blockers.append('inventory_or_runtime_invalid')
    else:
        blockers.append('public_inventory_required')
    if args.copia and tenant:
        try:
            checks['copy'] = copy_summary(args.copia, args.alias, tenant)
        except (OSError, ValueError, KeyError, TypeError):
            blockers.append('copy_missing_or_invalid')
    else:
        result['pending'].append('comprobar copia preliminar con --copia')
    if blockers:
        result['state'] = 'blocked'
    return result
