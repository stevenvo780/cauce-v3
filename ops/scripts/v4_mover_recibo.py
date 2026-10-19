"""Finish a copied runtime awaiting login and recover it only by explicit command."""
from __future__ import annotations

import datetime
import fcntl
import json
import os
import pathlib
import time


def marker_path(alias):
    return pathlib.Path(__file__).resolve().parents[2] / '.delegados/v4/hechas' / ('corte-' + alias + '.listo')


def verify_target(fleet, row, target, *, compensated=False):
    observed = fleet.parameters(row)
    expected = dict(target)
    inactive_states = {'provisioning', 'auth_pending'} | ({'failed', 'retiring', 'retired'} if compensated else set())
    pending = row.get('lifecycle_state') in inactive_states and row.get('enabled') is False
    expected_members = sorted((member['room_id'], member['role'], False if pending else member.get('enabled', True))
                              for member in expected.pop('memberships'))
    observed_members = sorted((member['room_id'], member['role'], member.get('enabled', True))
                              for member in observed.pop('memberships'))
    differences = [key for key in expected.keys() | observed.keys() if expected.get(key) != observed.get(key)]
    if observed_members != expected_members:
        differences.append('memberships')
    if differences:
        raise ValueError('el destino difiere del corte en: ' + ', '.join(sorted(differences)))


def finish_pending_auth(cut):
    from v4_mover_agente import HERE, write_json
    operation = cut.fleet._read_operation(cut.fleet.last_operation)
    if operation['status'] == 'succeeded':
        return False
    if operation['status'] != 'awaiting_auth' or any(not any(
            step.get('name') == name and step.get('status') == 'succeeded' for step in operation.get('steps', []))
            for name in ('prepare', 'artifacts', 'credentials', 'runtime')):
        raise ValueError('el destino no acredita la creación del runtime pendiente de login')
    row = cut.fleet.agent(cut.plan['alias'])
    write_json(cut.evidence / 'registro-pendiente.json', row)
    verify_target(cut.fleet, row, cut.receipt['target'])
    if cut.legacy:
        stopped = cut.step('verificar-origen-retenido', lambda: cut.legacy_control('stopped'))
        write_json(cut.evidence / 'origen-retenido.json', stopped)
    runtime = next(step for step in operation['steps'] if step['name'] == 'runtime')
    write_json(cut.evidence / 'runtime-pendiente.json', {
        'operation_id': operation['id'], 'verification': 'canonical_runtime_step',
        'runtime': runtime, 'physical_terminal_verified': False})
    elapsed = time.monotonic() - cut.stopped_at
    cut.receipt.update(
        state='moved_pending_login', verified=True, admission_verified=False,
        verification_scope='copy_restore_runtime', destination_status='awaiting_auth',
        pending=['provider_login', 'context_adoption', 'nonce', 'quota', 'terminal_physical', 'terminal_gateway'],
        source_retention={'days': 7, 'stopped': True, 'automatic_deletion': False,
                          'retain_until': datetime.datetime.fromtimestamp(
                              time.time() - elapsed + 7 * 86400, datetime.UTC).isoformat()},
        automatic_rollback=False, outage_seconds=round(elapsed, 3), finished_at=time.time(),
        rollback_command=[str(HERE / 'v4-mover-agente.sh'), cut.plan['alias'], '--revertir',
                          str((cut.evidence / 'recibo.json').resolve())],
        rollback_instructions='Reversión manual explícita: ejecutar rollback_command; cancela la operación, '
                              'retira el destino propio y recupera el origen retenido.')
    cut.save()
    marker = marker_path(cut.plan['alias'])
    marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    write_json(marker, {'state': cut.receipt['state'], 'operation_id': operation['id'],
                        'receipt': str((cut.evidence / 'recibo.json').resolve())})
    return True


def own_json(path):
    details = path.lstat()
    if path.is_symlink() or not path.is_file() or details.st_uid != os.geteuid() or details.st_mode & 0o022:
        raise ValueError('la recuperación requiere recibos propios no escribibles por otros usuarios')
    return json.loads(path.read_text())


def rollback_receipt(args):
    from v4_mover_agente import Cut, failure_details, load_plan
    from v4_mover_flota import Fleet
    receipt_path = args.revertir.absolute()
    evidence = receipt_path.parent
    lock = os.open(evidence.parent / (args.alias + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt = own_json(receipt_path)
        plan = load_plan(evidence / 'plan-corte.json', args.alias, allow_legacy_limits=True)
        own_json(evidence / 'alias-config-corte.json')
        if receipt_path.name != 'recibo.json' or receipt.get('schema') != 'cauce.v4-mover-agente/1' \
                or receipt.get('state') not in ({'moved_pending_login', 'succeeded'}
                    | ({'rollback', 'rollback_failed'} if receipt.get('manual_rollback') else set())) \
                or any(receipt.get(key) != plan.get(key) for key in ('alias', 'company', 'tenant')):
            raise ValueError('el recibo no identifica un corte terminado de este agente')
        fleet = Fleet(plan.get('gateway'), plan.get('session_file'), plan['company'], ca_file=plan.get('ca_file'),
                      platform_gateway=plan.get('platform_gateway'))
        fleet.tenant = plan['tenant']
        cut = Cut(fleet, plan, evidence, evidence / 'alias-config-corte.json')
        cut.receipt = receipt
        cut.original = receipt['original']
        cut.original_row = receipt.get('original_registry')
        cut.legacy = cut.legacy_prepared = cut.create_attempted = receipt['legacy']
        cut.stop_attempted = cut.data_staged = True
        cut.relocation_attempted = not cut.legacy
        cut.common = receipt['recovery_common']
        cut.stopped_at = time.monotonic() - receipt.get('outage_seconds', 0)
        for remote, settings in ((cut.source, plan['source']), (cut.destination, plan['destination'])):
            if remote.call('identity', {})['machineIdSha256'] != settings.get('machine_id_sha256'):
                raise ValueError('la identidad física cambió desde el corte')
        fleet.operations = receipt['operations']
        if not fleet.operations:
            raise ValueError('el recibo no contiene la operación de traslado')
        history = fleet.request('GET', '/v3/console/fleet/operations?resource=agent&tenant_id='
                                + plan['tenant'] + '&alias=' + args.alias)
        if not history.get('operations') or history['operations'][0]['id'] != fleet.operations[-1]['id']:
            raise ValueError('hay operaciones posteriores ajenas a este recibo; revisar antes de recuperar')
        operation = fleet._read_operation(fleet.operations[-1])
        row = fleet.agent(args.alias, include_retired=True)
        if not cut.legacy or not cut.legacy_registry_matches(row):
            expected = receipt['target']
            if not cut.legacy and receipt.get('manual_rollback') and operation['kind'] == 'update' \
                    and operation['status'] == 'succeeded' and fleet.parameters(row) == receipt['original']:
                expected = receipt['original']
            verify_target(fleet, row, expected, compensated=operation['status'] in {'failed', 'cancelled'}
                          or operation['kind'] == 'retire')
        cut.receipt['manual_rollback'] = True
        try:
            cut.rollback()
            cut.receipt['state'] = 'rolled_back'
            cut.receipt['manual_rollback'] = True
        except BaseException as error:
            cut.receipt.update(state='rollback_failed', manual_rollback=True,
                               rollback={'verified': False, 'failure': failure_details(error, 'rollback')})
            cut.save()
            raise
        cut.save()
        marker = marker_path(args.alias)
        if marker.exists() and own_json(marker).get('receipt') == str(receipt_path):
            marker.unlink()
        print(json.dumps({'state': 'rolled_back', 'receipt': str(receipt_path)}))
        return 0
    finally:
        os.close(lock)
