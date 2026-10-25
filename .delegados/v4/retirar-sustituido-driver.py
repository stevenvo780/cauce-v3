#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import re
import stat
import sys
import uuid

APPLY_STARTED = False

class Blocked(RuntimeError):
    pass


def emit(**fields):
    print(json.dumps(fields, ensure_ascii=False, sort_keys=True), flush=True)


def digest(document):
    return hashlib.sha256(json.dumps(document, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def code_root(filename, owners):
    if not filename.is_absolute() or str(filename) != os.path.normpath(filename):
        raise Blocked('--ops-root debe ser una ruta absoluta canónica')
    for parent in (filename, *filename.parents):
        if parent.is_symlink():
            raise Blocked('--ops-root no admite componentes simbólicos')
    for directory in (filename, filename / 'cli', filename / 'scripts', filename / 'container-runtime'):
        details = directory.lstat()
        if not stat.S_ISDIR(details.st_mode) or details.st_uid not in owners or details.st_mode & 0o022:
            raise Blocked('El código canónico no tiene dueño o modos autorizados')
        for candidate in directory.glob('*.py'):
            info = candidate.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid not in owners or info.st_mode & 0o022:
                raise Blocked('Un módulo canónico tiene un propietario, tipo o modo inseguro')


def read_private(filename, owners):
    from secure_path import open_absolute_directory, open_regular_at
    parent = open_absolute_directory(filename.parent)
    try:
        directory = os.fstat(parent)
        if directory.st_uid not in owners or directory.st_mode & 0o022:
            raise Blocked('El directorio del documento no tiene dueño o modo seguro')
        descriptor = open_regular_at(parent, filename.name, os.O_RDONLY | os.O_NONBLOCK)
        try:
            details = os.fstat(descriptor)
            if details.st_uid not in owners or details.st_nlink != 1 or details.st_mode & 0o077 or details.st_size > 8_388_608:
                raise Blocked('El documento debe ser privado, regular y de un dueño autorizado')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                return json.loads(stream.read(8_388_609))
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def scope(args, policy, context):
    from fleet_executor_container import docker
    from fleet_executor_policy import approve_agent, target_agent
    desired = target_agent(context)
    previous = [row for row in context['previous_agents']
                if (row.get('tenant_id'), row.get('alias')) == (desired.get('tenant_id'), desired.get('alias'))]
    if len(previous) != 1:
        raise Blocked('El contexto no contiene un único runtime anterior para el agente')
    previous = previous[0]
    if context['request']['kind'] != 'update' or any(previous.get(key) != desired.get(key)
            for key in ('tenant_id', 'alias', 'runtime_key', 'host_id')):
        raise Blocked('El contexto no representa la sustitución de la misma identidad física')
    if args.lab_prefix:
        if os.environ.get('CAUCE_REQUIRE_TESTCONTAINERS') != '1' \
                or re.fullmatch(r'zz-canary-h9-contenedor-sustituido-1025-[a-z0-9-]+', args.lab_prefix) is None \
                or docker('info', '--format', '{{.Name}}').decode().strip() not in {'docker-lab', 'docker-lab-2', 'docker-lab-3'}:
            raise Blocked('El prefijo de canario exige el runner y un daemon VM de laboratorio verificado')
        if any(not row.get('container_name', '').startswith(args.lab_prefix + '-') for row in (previous, desired)):
            raise Blocked('Un contenedor está fuera del prefijo del canario autorizado')
    else:
        expected = {'tenant_id': 'Hospital', 'alias': 'teseo', 'runtime_key': 'teseo', 'host_id': 'server2-praxis'}
        if any(row.get(key) != value for row in (previous, desired) for key, value in expected.items()) \
                or policy['executor_user'] != 'server' \
                or previous.get('container_name') != 'cauce-muse-teseo' or previous.get('harness_id') != 'muse' \
                or desired.get('container_name') != 'cauce-grok-teseo' or desired.get('harness_id') != 'grok':
            raise Blocked('El guion de producción sólo admite Praxis/Hospital/teseo en server2-praxis, Muse → Grok')
    if previous['container_name'] == desired['container_name']:
        raise Blocked('Los contenedores anterior y vivo deben ser distintos')
    return approve_agent(policy, previous), approve_agent(policy, desired)


def applied_target(policy, desired):
    from fleet_runtime_materialization import _destination, load_applied_fleet
    state = pathlib.Path(policy['roots']['state'])
    receipt = load_applied_fleet(state)
    fleet = json.loads(_destination(state, 'generations/' + receipt['generation'] + '/flota.json').read_bytes())
    row = fleet.get('fleet', {}).get(desired['runtime_key'])
    if not isinstance(row, dict) or row.get('enabled') is not True or row.get('alias', desired['runtime_key']) != desired['alias']:
        raise Blocked('El applied-fleet canónico no admite al runtime nuevo como agente vivo')
    fields = {'tenant': 'tenant_id', 'harness': 'harness_id', 'container': 'container_name', 'user': 'runtime_user',
              'home': 'home_directory', 'runtimeStateDirectory': 'state_directory', 'hostId': 'host_id',
              'runtimeMode': 'runtime_mode', 'systemdUser': 'systemd_user', 'primaryAccountId': 'primary_account_id',
              'modelId': 'model_id', 'reasoningEffort': 'reasoning_effort'}
    if any(row.get(source) != desired.get(target) for source, target in fields.items()):
        raise Blocked('El runtime nuevo difiere del applied-fleet vigente')
    return receipt['generation']


def current_runtime(policy, desired):
    from fleet_executor_container import (
        adapter_restart_state,
        identity_for,
        inspect_container,
        process_proof,
        validate_container,
    )
    from fleet_executor_runtime import approved_bundle
    observed = inspect_container(desired['container_name'])
    if observed is None or not observed['State']['Running']:
        raise Blocked('El contenedor nuevo no está vivo')
    validate_container(policy, desired, observed)
    adapter = adapter_restart_state(policy, desired, observed)
    if adapter.get('adapter_running') is not True or adapter.get('adapter_bootstrap') is not False:
        raise Blocked('El runtime nuevo no tiene un adaptador normal vivo verificado')
    proof = process_proof(policy, desired, identity_for(desired, observed), approved_bundle(policy, desired),
                          bootstrap=False, operation_id=adapter.get('adapter_operation_id'))
    return proof['runtime_digest'], observed


def confirmed_receipt(policy, context, previous, desired):
    from fleet_executor_replacement import REQUIRED_PROOF
    operation = context.get('operation')
    if not isinstance(operation, dict) or operation.get('status') != 'succeeded' or operation.get('kind') != 'update' \
            or operation.get('target') != context['request']['target']:
        raise Blocked('Falta el contexto exportado del backend con la operación update succeeded')
    identity = operation.get('id')
    try:
        if str(uuid.UUID(identity)) != identity or uuid.UUID(identity).version != 4:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise Blocked('La operación no tiene una identidad canónica UUIDv4') from None
    if context.get('operation_id', identity) != identity:
        raise Blocked('El contexto y la confirmación durable identifican operaciones distintas')
    state = pathlib.Path(policy['roots']['state'])
    journal = read_private(state / 'operations' / identity / 'effects.json', (os.geteuid(),))
    if journal.get('request_sha256') != digest(context['request']):
        raise Blocked('El journal canónico no corresponde al request de la operación exportada')
    admission = journal.get('admission_normal_proof')
    receipt = journal.get('replacement_retirement')
    if not isinstance(admission, dict) or admission.get('operation_id') != identity \
            or any(admission.get(field) is not True for field in REQUIRED_PROOF) \
            or not isinstance(receipt, dict) or receipt.get('name') != previous['container_name']:
        raise Blocked('Falta el recibo normal durable y los pins anteriores del núcleo; el legado necesita evidencia canónica')
    runtime_digest, observed = current_runtime(policy, desired)
    replacement = receipt.get('replacement')
    if not isinstance(replacement, dict) or replacement.get('normal_verified') is not True \
            or replacement.get('operation_id') != identity or replacement.get('runtime_digest') != runtime_digest \
            or admission.get('runtime_digest') != runtime_digest:
        raise Blocked('La prueba normal durable no pertenece al adaptador actual observado')
    from fleet_executor_replacement import container_pin
    if replacement.get('pin') != container_pin(observed):
        raise Blocked('El contenedor vivo cambió después de su turno normal verificado')
    if digest({key: value for key, value in replacement.get('agent', {}).items() if not key.startswith('_')}) != \
            digest({key: value for key, value in desired.items() if not key.startswith('_')}):
        raise Blocked('El agente del recibo normal difiere del contexto exportado')
    result = copy.deepcopy(receipt)
    result['confirmed_operation'] = {'operation_id': identity, 'status': 'succeeded', 'runtime_digest': runtime_digest,
                                   'container_id': observed['Id'], 'started_at': observed['State']['StartedAt']}
    return result


def persist(filename, document):
    from atomic_file import atomic_write
    from secure_path import open_absolute_directory
    parent = open_absolute_directory(filename.parent)
    try:
        details = os.fstat(parent)
        if details.st_uid != os.geteuid() or details.st_mode & 0o077:
            raise Blocked('El directorio del recibo debe ser privado y del usuario ejecutor')
    finally:
        os.close(parent)
    if os.path.lexists(filename):
        read_private(filename, (os.geteuid(),))
    atomic_write(filename, json.dumps(document, sort_keys=True).encode(), mode=0o600)


def run(args, context):
    global APPLY_STARTED
    from fleet_executor_container import retire_replaced_container
    from fleet_executor_policy import load_policy
    policy = load_policy(args.policy)
    previous, desired = scope(args, policy, context)

    def prepare():
        generation = applied_target(policy, desired)
        receipt = confirmed_receipt(policy, context, previous, desired)
        return generation, retire_replaced_container(policy, previous, receipt, apply=False)

    generation, receipt = prepare()
    if not args.apply:
        emit(status='ready', simulation=True, writes=False, generation=generation, previous=receipt['previous'],
             replacement=receipt['replacement']['pin'], retained_volumes=receipt['volumes'],
             retention=receipt['retention'], retention_reason=receipt['retention_reason'])
        return
    from fleet_executor_steps import executor_lock
    APPLY_STARTED = True
    with executor_lock(policy):
        generation, receipt = prepare()
        filename = args.receipt or pathlib.Path(policy['roots']['state']) / 'retirar-sustituido-teseo.receipt.json'
        binding = {'context_sha256': digest(context), 'policy_sha256': hashlib.sha256(args.policy.read_bytes()).hexdigest(),
                   'generation': generation, 'ops_root': str(args.ops_root)}
        if os.path.lexists(filename):
            saved = read_private(filename, (os.geteuid(),))
            if saved.get('binding') != binding or saved.get('receipt', {}).get('previous') != receipt['previous'] \
                    or saved.get('receipt', {}).get('replacement') != receipt['replacement']:
                raise Blocked('El recibo de retirada existente pertenece a otros pins o contexto')
        document = {'version': 1, 'status': 'prepared', 'binding': binding, 'receipt': receipt,
                    'recorded_at': datetime.datetime.now(datetime.UTC).isoformat()}
        persist(filename, document)
        document['receipt'] = retire_replaced_container(policy, previous, receipt, apply=True)
        document['status'] = 'complete'
        persist(filename, document)
        emit(status='complete', receipt=str(filename), retained_volumes=document['receipt']['volumes'],
             retention=document['receipt']['retention'], volumes_deleted=False)


def main():
    parser = argparse.ArgumentParser(description='Retira exclusivamente el contenedor sustituido de Teseo; simula por defecto y conserva volúmenes')
    parser.add_argument('--ops-root', required=True, type=pathlib.Path)
    parser.add_argument('--policy', required=True, type=pathlib.Path)
    parser.add_argument('--context', required=True, type=pathlib.Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--simular', action='store_true')
    modes.add_argument('--aplicar', dest='apply', action='store_true')
    parser.add_argument('--recibo', dest='receipt', type=pathlib.Path)
    parser.add_argument('--lab-prefix')
    args = parser.parse_args()
    if args.apply and os.geteuid() != 0:
        raise Blocked('--aplicar debe invocarlo el orquestador como root')
    owner = args.policy.lstat()
    if not stat.S_ISREG(owner.st_mode) or owner.st_nlink != 1 or owner.st_mode & 0o022:
        raise Blocked('La política debe ser un fichero regular y protegido')
    code_root(args.ops_root, (0, owner.st_uid))
    sys.path[:0] = [str(args.ops_root / 'cli'), str(args.ops_root / 'scripts')]
    context = read_private(args.context, tuple({0, owner.st_uid, os.geteuid()}))
    if owner.st_uid != os.geteuid():
        if os.geteuid() != 0:
            raise Blocked('El usuario actual no es el dueño de la política')
        user = pwd.getpwuid(owner.st_uid)
        os.initgroups(user.pw_name, user.pw_gid)
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    os.umask(0o077)
    run(args, context)


if __name__ == '__main__':
    try:
        main()
    except Blocked as error:
        emit(status='blocked', writes='possible' if APPLY_STARTED else False, effects_possible=APPLY_STARTED, reason=str(error))
        raise SystemExit(1) from None
    except Exception as error:
        emit(status='blocked', writes='possible' if APPLY_STARTED else False, effects_possible=APPLY_STARTED, error_type=type(error).__name__,
             reason='El preflight o efecto canónico falló; no se imprime su contexto privado')
        raise SystemExit(1) from None
