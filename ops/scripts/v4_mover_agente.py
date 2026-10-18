"""One explicit cut: stop, copy, restore, relocate through the fleet and verify, with inverse relocation on failure."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
import uuid
from decimal import Decimal

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

from v4_mover_host import Remote  # noqa: E402


def destination_limits(plan):
    defaults = {'gaia': (1024**3, 1.5), 'hades': (1024**3, 1), 'argos': (3 * 1024**3, 2), 'hegel': (2 * 1024**3, 2)}
    memory, cpus = defaults.get(plan.get('alias'), (1024**3, 1))
    limits = plan['destination'].get('limits', {'memory_bytes': memory, 'cpus': cpus})
    if not isinstance(limits, dict) or set(limits) != {'memory_bytes', 'cpus'} \
            or type(limits['memory_bytes']) is not int or not 6 * 1024**2 <= limits['memory_bytes'] < 2**63 \
            or type(limits['cpus']) not in (int, float) or not math.isfinite(limits['cpus']) \
            or not 0.01 <= limits['cpus'] <= 1024:
        raise ValueError('limits requiere memory_bytes de 6 MiB a int64 y cpus entre 0.01 y 1024')
    nano_cpus = Decimal(str(limits['cpus'])) * 1_000_000_000
    if nano_cpus != nano_cpus.to_integral_value():
        raise ValueError('cpus solo admite precisión de nanocpu')
    return dict(limits)


def write_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as writer:
            os.chmod(temporary, 0o600)
            json.dump(value, writer, ensure_ascii=False, indent=2)
            writer.write('\n')
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_plan(path, alias):
    if path.is_symlink():
        raise ValueError('el plan debe ser un archivo propio, sin enlaces')
    info = path.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('el plan debe ser propio y no escribible por otros usuarios')
    plan = json.loads(path.read_text())
    if not isinstance(plan, dict) or not {'company', 'tenant', 'source', 'destination', 'roots'} <= plan.keys():
        raise ValueError('el plan requiere company, tenant, source, destination y roots')
    if bool(plan.get('session_file')) == bool(plan.get('platform_gateway')):
        raise ValueError('el plan requiere una sesión o la autoridad interna del gateway')
    if not all(isinstance(plan[key], str) and plan[key] for key in ('company', 'tenant')):
        raise ValueError('identidad de empresa, tenant o sesión inválida')
    if plan.get('session_file') and not isinstance(plan['session_file'], str):
        raise ValueError('session_file debe ser una ruta')
    if plan.get('platform_gateway'):
        from v4_mover_plataforma import PlatformClient, PlatformFailure
        try:
            PlatformClient(plan['platform_gateway'], plan['company'], plan['tenant'])
        except PlatformFailure as error:
            raise ValueError(str(error)) from None
    if not isinstance(plan['roots'], list) or any(not isinstance(item, dict) or not all(
            isinstance(item.get(field), str) and item[field] for field in ('name', 'path', 'target')) for item in plan['roots']):
        raise ValueError('cada raíz debe declarar name, path y target')
    timeout = plan.get('timeout', 300)
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 3600:
        raise ValueError('timeout debe estar entre 0 y 3600 segundos')
    if plan.get('alias', alias) != alias:
        raise ValueError('el alias del plan no coincide')
    if not plan.get('company') or not plan.get('tenant'):
        raise ValueError('el plan requiere company y tenant')
    for key in ('source', 'destination'):
        if not isinstance(plan[key], dict) or not isinstance(plan[key].get('route'), str) \
                or not re.fullmatch(r'local|ssh:[A-Za-z0-9_.@-]{1,128}', plan[key]['route']):
            raise ValueError('ruta de host inválida')
        if not alias.startswith('zz-canary-') and not re.fullmatch(r'[a-f0-9]{16}', plan[key].get('machine_id_sha256', '')):
            raise ValueError('el plan requiere la identidad física medida de origen y destino')
        if type(plan[key].get('sudo', False)) is not bool or plan[key].get('sudo') and plan[key]['route'] == 'local':
            raise ValueError('sudo debe ser booleano y solo se admite por SSH')
    if plan['source'].get('systemd_scope', 'user') not in ('user', 'system'):
        raise ValueError('systemd_scope debe ser user o system')
    if not isinstance(plan['destination'].get('host_id'), str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', plan['destination']['host_id']):
        raise ValueError('host_id de destino inválido')
    destination_limits({**plan, 'alias': alias})
    names = set()
    targets = []
    for item in plan['roots']:
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', item['name']) or item['name'] in names:
            raise ValueError('raíces duplicadas o inválidas')
        names.add(item['name'])
        for field in ('path', 'target'):
            candidate = pathlib.PurePosixPath(item[field])
            if '..' in candidate.parts or str(candidate) != item[field]:
                raise ValueError('ruta de copia no canónica')
        if not item['path'].startswith('/') or item['target'].startswith('/'):
            raise ValueError('origen absoluto y destino relativo obligatorios')
        target_parts = pathlib.PurePosixPath(item['target']).parts
        if not target_parts or target_parts[0] not in {'context', 'directives', 'projects', 'config', 'data', 'logs', 'tmp'}:
            raise ValueError('el destino no usa la estructura estándar')
        if any(item['target'] == other or item['target'].startswith(other + '/') or other.startswith(item['target'] + '/') for other in targets):
            raise ValueError('los mapas de destino se solapan')
        targets.append(item['target'])
    if not names:
        raise ValueError('el plan no declara datos para copiar')
    return plan


def migration_parameters(fleet, row, plan):
    if row.get('runtime_mode') is not None:
        return fleet.parameters(row)
    source = plan['source']
    if not plan.get('platform_gateway'):
        raise ValueError('el traslado heredado requiere autoridad de plataforma dentro del gateway')
    if not all(isinstance(source.get(key), str) and source[key]
               for key in ('legacy_unit', 'systemd_user', 'container_id')):
        raise ValueError('el origen heredado requiere unidad, usuario de manager e ID de contenedor medidos')
    if plan['destination'].get('mode', 'container') != 'container':
        raise ValueError('el traslado heredado requiere un contenedor propio en destino')
    values = dict(row)
    overrides = plan.get('agent', {})
    if not isinstance(overrides, dict) or set(overrides) - {'runtime_key', 'harness_id', 'primary_account_id', 'model_id', 'primary_room_id'}:
        raise ValueError('agent solo admite identidad de runtime, harness, cuenta, modelo y sala primaria')
    for key, value in overrides.items():
        if row.get(key) is not None and row[key] != value:
            raise ValueError('el plan no puede sustituir el harness, cuenta, modelo o identidad existentes')
        values[key] = value
    if values.get('primary_room_id') is None:
        rooms = [member['room_id'] for member in row['memberships'] if member.get('enabled', True)]
        if len(rooms) == 1:
            values['primary_room_id'] = rooms[0]
    if not values.get('model_id') or not values.get('primary_room_id'):
        raise ValueError('el traslado heredado requiere modelo y sala primaria explícitos')
    return fleet.parameters(values)


def target_parameters(fleet, original, plan):
    row = fleet.agent(plan['alias'])
    capabilities = fleet.capabilities(plan['tenant'], plan['alias'])
    provider = fleet.account_provider(original['primary_account_id'])
    placements = [item for item in capabilities['placements'] if item['host_id'] == plan['destination']['host_id']]
    runtimes = [item for placement in placements for item in placement.get('runtimes', [])
                if item['harness_id'] == original['harness_id'] and item['provider'] == provider
                and item['mode'] == plan['destination'].get('mode', 'container')
                and (not plan['destination'].get('runtime_user') or item['runtime_user'] == plan['destination']['runtime_user'])]
    if len(runtimes) != 1 or not capabilities['available']:
        raise ValueError('el destino no ofrece un único runtime enrolado para el harness; no se detuvo el origen')
    runtime = runtimes[0]
    if not original.get('primary_account_id'):
        raise ValueError('falta el binding de cuenta original; no se puede conservar la cuenta')
    placement = {'host_id': plan['destination']['host_id'], 'mode': runtime['mode'],
                 'runtime_user': runtime['runtime_user'], 'home_directory': runtime['home_directory'],
                 'state_directory': runtime['state_root'].rstrip('/') + '/' + original['runtime_key']}
    if runtime.get('systemd_user'):
        placement['systemd_user'] = runtime['systemd_user']
    if runtime['mode'] == 'container':
        placement['container_name'] = runtime.get('container_name') or runtime['container_prefix'] + original['runtime_key']
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', plan['destination'].get('image', '')):
            raise ValueError('el plan requiere el digest de la imagen aprobada para restaurar el volumen')
    if row.get('host_id') == placement['host_id']:
        raise ValueError('el agente ya está en el destino; revisar su recibo anterior')
    return {**original, 'placement': placement}


class Cut:
    def __init__(self, fleet, plan, evidence, alias_config):
        self.fleet, self.plan, self.evidence, self.alias_config = fleet, plan, evidence, alias_config
        self.source = Remote(plan['source']['route'], sudo=plan['source'].get('sudo', False))
        self.destination = Remote(plan['destination']['route'], sudo=plan['destination'].get('sudo', False))
        self.receipt = {'schema': 'cauce.v4-mover-agente/1', 'alias': plan['alias'], 'company': plan['company'],
                        'tenant': plan['tenant'], 'state': 'preflight', 'steps': [], 'operations': [],
                        'started_at': time.time(), 'source_retained': True,
                        'tool_sha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                        for path in [HERE / 'v4-mover-agente.sh', *HERE.glob('v4_mover_*.py'),
                                                     HERE / 'v4_copia_integral.py']}}
        self.original = None
        self.stop_attempted = self.relocation_attempted = False
        self.stopped_at = None
        self.recovering = False
        self.legacy = self.legacy_prepared = self.create_attempted = self.data_staged = False
        self.original_row = self.common = None
        self.fleet.on_operation = lambda _row: self.save()

    def save(self):
        self.receipt['operations'] = self.fleet.operations
        try:
            write_json(self.evidence / 'recibo.json', self.receipt)
        except OSError:
            if not self.recovering:
                raise
            self.receipt['journal_error'] = True
            print('No se pudo guardar el diario; continúa la recuperación del origen.', file=sys.stderr)

    def step(self, name, action):
        self.receipt['state'] = name
        self.save()
        start = time.monotonic()
        result = action()
        self.receipt['steps'].append({'step': name, 'seconds': round(time.monotonic() - start, 3), 'verified': True})
        self.save()
        return result

    def measure(self, label):
        if self.plan['source'].get('sudo'):
            from v4_medicion_migracion import load, scope_from_config
            scope = load(str(self.evidence / 'antes.json'))['scope'] if label != 'antes' else scope_from_config(
                json.loads(self.alias_config.read_text()), [self.plan['alias']])
            receipt = self.source.call('measure', {'label': label, 'scope': scope, 'route': self.plan['source']['route']})
            write_json(self.evidence / (label + '.json'), receipt)
            load(str(self.evidence / (label + '.json')))
            return
        arguments = [str(HERE / 'v4-medicion-migracion.sh'), 'medir', '--label', label,
                     '--out', str(self.evidence / (label + '.json'))]
        route = self.plan['source']['route']
        arguments += ['--local'] if route == 'local' else ['--ssh', route.removeprefix('ssh:')]
        arguments += ['--alcance-de', str(self.evidence / 'antes.json')] if label != 'antes' else [
            '--config', str(self.alias_config), self.plan['alias']]
        result = subprocess.run(arguments, capture_output=True, check=False)
        (self.evidence / (label + '.log')).write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('falló la medición ' + label)

    def rollback(self):
        self.recovering = True
        self.receipt['state'] = 'rollback'
        self.save()
        # Cancelling must settle before the inverse update can grant authority to the original host.
        self.fleet.settle_pending(timeout=self.plan.get('timeout', 300))
        if self.legacy:
            return self.rollback_legacy()
        if self.relocation_attempted:
            self.fleet.rollback(self.plan['alias'], self.original, timeout=self.plan.get('timeout', 300))
        else:
            self.fleet.operation('start', self.plan['alias'], {}, timeout=self.plan.get('timeout', 300))
        self.fleet.refresh_context(self.plan['alias'], 'Restablecer el contexto del agente tras revertir su traslado.',
                                   timeout=self.plan.get('timeout', 300))
        proof = self.fleet.verify(self.plan['alias'], self.original, timeout=self.plan.get('timeout', 300))
        write_json(self.evidence / 'rollback-verificacion.json', proof)
        self.receipt['rollback'] = {'verified': True, 'source_host': self.original['placement']['host_id']}
        self.receipt['outage_seconds'] = round(time.monotonic() - self.stopped_at, 3)
        self.save()

    def legacy_control(self, action):
        return self.source.call('legacy-' + action, {'alias': self.plan['alias'], 'source': self.plan['source'],
                               'config': json.loads(self.alias_config.read_text())})

    def rollback_legacy(self):
        alias, timeout = self.plan['alias'], self.plan.get('timeout', 300)
        cleanup_failure = None
        if self.create_attempted:
            current = self.fleet.agent(alias)
            if current.get('runtime_mode') is not None:
                self.fleet.operation('retire', alias, {}, timeout=timeout)
        if self.data_staged:
            self.common['create_operation_id'] = self.receipt.get('create_operation_id')
            try:
                self.receipt['destination_cleanup'] = self.destination.call('cleanup-destination', self.common)
            except BaseException as error:
                if self.create_attempted:
                    raise
                cleanup_failure = error
                self.receipt['destination_cleanup'] = {'verified': False, 'error': type(error).__name__}
        if self.legacy_prepared:
            self.receipt['registry_rollback'] = self.fleet.restore_legacy(alias, self.original_row, self.receipt['target'])
        row = self.fleet.agent(alias)
        fields = ('host_id', 'runtime_mode', 'container_name', 'runtime_user', 'home_directory', 'state_directory',
                  'systemd_user', 'harness_id', 'primary_room_id', 'primary_account_id', 'model_id',
                  'reasoning_effort', 'enabled', 'lifecycle_state')
        if any(row.get(key) != self.original_row.get(key) for key in fields):
            raise ValueError('la reversión no restauró el registro legado')
        unit = self.legacy_control('start')
        proof = {'verified': cleanup_failure is None, 'unit': unit, 'registry_restored': True, 'source_restarted': True,
                 'retained_runtime_key': row.get('runtime_key')}
        write_json(self.evidence / 'rollback-verificacion.json', proof)
        self.receipt['rollback'] = proof
        self.receipt['outage_seconds'] = round(time.monotonic() - self.stopped_at, 3)
        self.save()
        if cleanup_failure is not None:
            raise RuntimeError('el origen se recuperó; queda pendiente limpiar el volumen de destino') from cleanup_failure

    def run(self):
        alias, timeout = self.plan['alias'], self.plan.get('timeout', 300)
        self.original_row = self.fleet.agent(alias)
        self.legacy = self.original_row.get('runtime_mode') is None
        self.original = migration_parameters(self.fleet, self.original_row, self.plan)
        self.receipt['original'] = self.original
        self.receipt['legacy'] = self.legacy
        if self.legacy:
            self.receipt['original_registry'] = self.original_row
        target = target_parameters(self.fleet, self.original, self.plan)
        self.receipt['target'] = target
        self.save()
        common = {**self.plan['destination'], 'alias': alias, 'tenant': self.plan['tenant'], 'runtime_key': target['runtime_key'],
                  'placement': target['placement'], 'roots': self.plan['roots'],
                  'directory': target['placement']['state_directory'] + '/space', 'require_new': self.legacy,
                  'migration_id': self.evidence.name, 'legacy': self.legacy}
        self.common = common
        destination = self.step('preflight-destino', lambda: self.destination.call('preflight', common))
        write_json(self.evidence / 'destination-host.json', destination['host'])
        if self.plan['destination'].get('machine_id_sha256', destination['host']['machineIdSha256']) != destination['host']['machineIdSha256']:
            raise ValueError('la identidad física del destino no coincide con el plan')
        scope = self.step('preflight-origen', lambda: self.source.call('preflight-source', {**common,
            'original': self.original, 'config': json.loads(self.alias_config.read_text())}))
        write_json(self.evidence / 'alcance-integral.json', scope)
        self.step('medir-antes', lambda: self.measure('antes'))
        source = self.source.call('identity', {})
        write_json(self.evidence / 'source-host.json', source)
        if self.plan['source'].get('machine_id_sha256', source['machineIdSha256']) != source['machineIdSha256']:
            raise ValueError('la identidad física del origen no coincide con el plan')
        if not alias.startswith('zz-canary-') and source['machineIdSha256'] == destination['host']['machineIdSha256']:
            raise ValueError('el destino es el mismo ordenador físico que el origen')
        if source['machineIdSha256'] == destination['host']['machineIdSha256']:
            destination_path = pathlib.PurePosixPath(common['directory'])
            if any(destination_path.is_relative_to(item['path']) or pathlib.PurePosixPath(item['path']).is_relative_to(destination_path)
                   for item in self.plan['roots']):
                raise ValueError('el destino se solapa con los datos del origen')
        baseline = self.step('verificar-origen', lambda: self.legacy_control('status') if self.legacy
                             else self.fleet.verify(alias, self.original, timeout=timeout))
        write_json(self.evidence / 'origen-verificacion.json', baseline)
        self.stopped_at = time.monotonic()
        try:
            self.stop_attempted = True
            self.step('detener-origen', lambda: self.legacy_control('stop') if self.legacy
                      else self.fleet.operation('stop', alias, {}, timeout=timeout))
            self.step('comprobar-alcance-final', lambda: self.source.call('preflight-source', {**common,
                'original': self.original, 'config': json.loads(self.alias_config.read_text())}))
            archive = self.evidence / 'copia-integral.tar'
            with archive.open('xb') as writer:
                os.chmod(archive, 0o600)
                self.step('copiar-integral', lambda: self.source.call('pack', {**common,
                    'config': json.loads(self.alias_config.read_text())}, destination=writer))
                writer.flush()
                os.fsync(writer.fileno())
            self.data_staged = True
            restore = self.step('restaurar-espacio', lambda: self.destination.call('restore', common, source=archive))
            if restore.get('verified') is not True:
                raise ValueError('la restauración no acredita igualdad')
            write_json(self.evidence / 'restauracion.json', restore)
            if self.legacy:
                self.legacy_prepared = True
                checkpoint = self.step('registrar-borrador-heredado', lambda: self.fleet.prepare_legacy(alias, self.original_row, target))
                self.receipt['legacy_checkpoint'] = checkpoint
                self.create_attempted = True
                try:
                    created = self.step('preparar-flota-v4', lambda: self.fleet.operation('create', alias, target, timeout=timeout))
                    self.receipt['create_operation_id'] = created['id']
                finally:
                    if self.fleet.last_operation_id:
                        self.receipt['create_operation_id'] = self.fleet.last_operation_id
            else:
                self.relocation_attempted = True
                self.step('reubicar-flota', lambda: self.fleet.operation('update', alias, target, timeout=timeout))
            if target['placement']['mode'] == 'container':
                limits = destination_limits(self.plan)
                self.step('limites-destino', lambda: self.destination.call('limit', {
                    **common, 'memory': limits['memory_bytes'], 'cpus': limits['cpus']}))
            self.step('aplicar-contexto-destino', lambda: self.fleet.refresh_context(alias,
                'Aplicar el contexto del agente en su nuevo ordenador tras el traslado.', timeout=timeout))
            proof = self.step('verificar', lambda: self.fleet.verify(alias, target, timeout=timeout))
            if self.plan.get('platform_gateway'):
                terminal = self.step('verificar-terminal-destino', lambda: self.destination.call('terminal-probe', common))
                proof['terminal'] = {**proof.get('terminal', {}), **terminal}
            write_json(self.evidence / 'verificacion.json', proof)
            self.receipt['outage_seconds'] = round(time.monotonic() - self.stopped_at, 3)
            self.step('medir-despues', lambda: self.measure('despues'))
            comparison = subprocess.run([str(HERE / 'v4-medicion-migracion.sh'), 'comparar',
                str(self.evidence / 'antes.json'), str(self.evidence / 'despues.json')], capture_output=True, check=False)
            (self.evidence / 'comparacion.json').write_bytes(comparison.stdout)
            if comparison.returncode:
                raise ValueError('las mediciones no tienen el mismo alcance')
            self.receipt.update(state='succeeded', verified=True)
            self.save()
        except BaseException as failure:
            self.receipt['failure'] = {'type': type(failure).__name__, 'step': self.receipt['state'],
                                       'message': str(failure)[:240]}
            try:
                self.rollback()
                self.receipt['state'] = 'rolled_back'
            except BaseException as rollback_failure:
                self.receipt.update(state='rollback_failed', rollback={**self.receipt.get('rollback', {}),
                                    'verified': False, 'error': type(rollback_failure).__name__,
                                    'message': str(rollback_failure)[:240]})
            self.save()
            raise


def main():
    parser = argparse.ArgumentParser(description='Traslado V4 en un paso; simula sin red ni escrituras por defecto')
    parser.add_argument('alias')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--simular', action='store_true')
    mode.add_argument('--ejecutar', action='store_true')
    parser.add_argument('--plan', type=pathlib.Path)
    parser.add_argument('--alias-config', type=pathlib.Path, default=HERE.parent / 'container-aliases.json')
    parser.add_argument('--recibos', type=pathlib.Path, default=ROOT / '.delegados/v4/recibos/migraciones')
    parser.add_argument('--inventario', type=pathlib.Path, help='snapshot público reciente de configuración y capacidad para simular')
    parser.add_argument('--copia', type=pathlib.Path, help='copia preliminar local cuyo manifiesto y bytes se comprueban al simular')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', args.alias):
        parser.error('alias inválido; debe identificar un agente del registro de la empresa')
    plan_path = args.plan or ROOT / '.delegados/v4/migracion' / (args.alias + '.json')
    if not args.ejecutar:
        from v4_simular_traslado import simulate
        result = simulate(args, plan_path, load_plan, target_parameters)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if result['blockers'] else 0
    if args.inventario or args.copia:
        parser.error('--inventario y --copia solo se admiten en simulación')
    from v4_mover_flota import Fleet
    plan = {**load_plan(plan_path, args.alias), 'alias': args.alias}
    os.umask(0o077)
    args.recibos.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.open(args.recibos / (args.alias + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        evidence = args.recibos / (args.alias + '-' + uuid.uuid4().hex)
        evidence.mkdir(mode=0o700)
        fleet = Fleet(plan.get('gateway'), plan.get('session_file'), plan['company'], ca_file=plan.get('ca_file'),
                      platform_gateway=plan.get('platform_gateway'))
        fleet.tenant = plan['tenant']
        cut = Cut(fleet, plan, evidence, args.alias_config)
        def interrupted(_number, _frame):
            raise InterruptedError('interrupción del corte')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        try:
            cut.run()
        except BaseException as failure:
            if 'failure' not in cut.receipt:
                cut.receipt['failure'] = {'type': type(failure).__name__, 'step': cut.receipt['state'],
                                          'message': str(failure)[:240]}
                cut.save()
            print(json.dumps({'state': cut.receipt['state'], 'receipt': str(evidence / 'recibo.json')}))
            return 1
        print(json.dumps({'state': 'succeeded', 'receipt': str(evidence / 'recibo.json'),
                          'outage_seconds': cut.receipt['outage_seconds']}))
        return 0
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print('No se completó el traslado: ' + str(error), file=sys.stderr)
        raise SystemExit(2) from None
