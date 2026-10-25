from __future__ import annotations

import datetime
import hashlib
import json
import os
import pathlib
import pwd
import re
import ssl
import subprocess
import sys
import uuid

from fleet_executor_authority import call, inventory, scope_for, validate_authority
from fleet_executor_native_manager import systemctl
from fleet_executor_pki import expiry, openssl
from fleet_executor_policy import SafeFailure
from fleet_executor_terminal_files import directory, read_file, remove_file, write_file
from fleet_executor_terminal_inventory import desired_agent
from fleet_executor_terminal_manager import approved_release, pin_unit, presence, selector, unit_state


def fingerprint(pem: bytes) -> str:
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))).hexdigest()


def terminal_inventory(policy: dict, context: dict, agent: dict) -> list[dict]:
    configuration = validate_authority(policy.get('authority'), policy['host_id'])
    observed = inventory(call(configuration, scope_for(policy, context, agent), 'inventory'), agent)
    rows = [row for row in observed['authorities'] if row['id'] == 'pty']
    if len(rows) != 1:
        raise SafeFailure('terminal provisioning requires the configured relay authority')
    return rows[0]['matching_records']


def existing_pair(pki: pathlib.Path, agent: dict, records: list[dict]) -> dict:
    directory(pki)
    certificate = read_file(pki / 'client.crt', 0o600)
    pin = fingerprint(certificate)
    registered = [row for row in records if row.get('fingerprint_sha256', '').lower() == pin
                  and row.get('tenant_id') == agent['tenant_id'] and row.get('alias') == agent['alias']]
    if len(registered) != 1:
        raise SafeFailure('terminal existing certificate is not registered for this exact identity')
    for name in ('client.key', 'ca.crt'):
        read_file(pki / name, 0o600)
    alias_key = read_file(pki / 'alias-key.hex', 0o400).strip()
    if re.fullmatch(rb'[a-fA-F0-9]{64}', alias_key) is None:
        raise SafeFailure('terminal alias key is invalid')
    openssl('verify', '-purpose', 'sslclient', '-CAfile', str(pki / 'ca.crt'), str(pki / 'client.crt'))
    openssl('x509', '-in', str(pki / 'client.crt'), '-noout', '-checkend', '60')
    if openssl('x509', '-in', str(pki / 'client.crt'), '-pubkey', '-noout') \
            != openssl('pkey', '-in', str(pki / 'client.key'), '-pubout'):
        raise SafeFailure('terminal certificate does not match its local private key')
    expires = datetime.datetime.fromisoformat(registered[0]['expires_at'].replace('Z', '+00:00'))
    if expires <= datetime.datetime.now(datetime.UTC) or expires > min(expiry(pki / 'client.crt'), expiry(pki / 'ca.crt')):
        raise SafeFailure('terminal registered certificate expiry differs')
    return {'certificate_sha256': pin, 'expires_at': registered[0]['expires_at']}


def read_environment(filename: pathlib.Path) -> dict:
    values = {}
    for line in read_file(filename, 0o600).decode().splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in values or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or not value:
            raise SafeFailure('terminal environment has an invalid or duplicate field')
        values[key] = value
    if set(values) - {'RELAY_HOST', 'RELAY_PORT', 'RELAY_SERVER_NAME', 'PKI_DIR', 'ALIAS_KEY_FILE', 'CONTAINER_RUNTIME_DIR'}:
        raise SafeFailure('terminal existing environment has unapproved overrides')
    return values


def publication(entry: dict, filename: pathlib.Path, raw: bytes | None, mode: int, work: pathlib.Path, save, *, advance: bool = False) -> None:
    key = str(filename)
    expected = hashlib.sha256(raw).hexdigest() if raw is not None else None
    previous = entry['files'].get(key)
    if previous is None:
        current = read_file(filename, mode) if os.path.lexists(filename) else None
        if current == raw:
            return
        backup = None
        if current is not None:
            backup = work / ('before-' + str(len(entry['files'])))
            write_file(backup, current, 0o600)
        previous = {'sha256': expected, 'owned': [expected], 'mode': mode, 'previous': hashlib.sha256(current).hexdigest() if current is not None else None,
                    'backup': str(backup) if backup else None}
        entry['files'][key] = previous
        save()
    if advance and previous['mode'] == mode and previous['sha256'] != expected:
        if filename.name != 'zz-fleet-terminal.conf':
            raise SafeFailure('terminal replay cannot rotate its credential publication')
        previous['sha256'] = expected
        previous.setdefault('owned', []).append(expected)
        save()
    if previous['sha256'] != expected or previous['mode'] != mode:
        raise SafeFailure('terminal publication replay changed its approved contents')
    current = hashlib.sha256(read_file(filename, mode)).hexdigest() if os.path.lexists(filename) else None
    if current == expected:
        return
    if current not in {*previous.get('owned', [expected]), previous['previous']}:
        raise SafeFailure('terminal publication changed outside its own replay')
    if raw is None:
        remove_file(filename, current, mode)
    else:
        write_file(filename, raw, mode, previous=current)


def prepare_request(work: pathlib.Path, key: str, entry: dict, save) -> bytes:
    private, csr = work / 'client.key', work / 'request.csr'
    files = entry.setdefault('work_files', {})
    if not os.path.lexists(private):
        if entry.get('issuance_requested'):
            raise SafeFailure('terminal issuance lost its original private key')
        raw = openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072')
        files['client.key'] = hashlib.sha256(raw).hexdigest()
        save()
        write_file(private, raw, 0o600)
    if hashlib.sha256(read_file(private, 0o600)).hexdigest() != files.get('client.key'):
        raise SafeFailure('terminal request private key changed')
    if not os.path.lexists(csr):
        if entry.get('issuance_requested'):
            raise SafeFailure('terminal issuance lost its original CSR')
        raw = openssl('req', '-new', '-sha256', '-key', str(private), '-subj', '/CN=pty-' + key)
        files['request.csr'] = hashlib.sha256(raw).hexdigest()
        save()
        write_file(csr, raw, 0o600)
    raw = read_file(csr, 0o600)
    if hashlib.sha256(raw).hexdigest() != files.get('request.csr') \
            or openssl('req', '-in', str(csr), '-pubkey', '-noout') != openssl('pkey', '-in', str(private), '-pubout'):
        raise SafeFailure('terminal CSR no longer matches its local private key')
    return raw


def _ensure(policy: dict, context: dict, agent: dict, generation: pathlib.Path, journal: dict, save) -> dict:
    if policy.get('terminal', {}).get('required') is not True:
        return {}
    account = pwd.getpwuid(os.geteuid())
    if os.geteuid() == 0 or agent['runtime_mode'] != 'container' or agent['systemd_user'] != account.pw_name \
            or policy['executor_user'] != account.pw_name or str(uuid.UUID(context['operation_id'])) != context['operation_id']:
        raise SafeFailure('terminal provisioning requires its approved local container manager')
    from fleet_executor_container import inspect_container, validate_container
    observed = inspect_container(agent['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('terminal provisioning requires its live approved container')
    validate_container(policy, agent, observed)
    _, identity = desired_agent(policy, generation, agent)
    ops, version, template = approved_release(policy, agent)
    home = pathlib.Path(account.pw_dir)
    config = directory(home, '.config/cauce-v3', private=False)
    env_root = directory(config, 'pty')
    pki_root = directory(config, 'pty-pki')
    unit_root = directory(home, '.config/systemd/user', private=False)
    work = directory(pathlib.Path(policy['roots']['state']), 'terminal-provision/' + agent['runtime_key'] + '/' + context['operation_id'])
    entries = journal.setdefault('terminal_provision', {})
    expected_identity = {key: agent[key] for key in ('tenant_id', 'alias', 'runtime_key')}
    entry = entries.get(agent['runtime_key'])
    if entry is None:
        entry = {'identity': expected_identity, 'operation_id': context['operation_id'], 'selector': agent['runtime_key'],
                 'files': {}, 'grant': None, 'new_credentials': True, 'stage': 'prepared', 'work': str(work)}
        records = terminal_inventory(policy, context, agent)
        candidates = [agent['runtime_key']] + ([agent['alias']] if agent['alias'] != agent['runtime_key'] else [])
        for candidate in candidates:
            pki = pki_root / candidate
            if not os.path.lexists(pki):
                continue
            try:
                proof = existing_pair(pki, agent, records)
            except (SafeFailure, ValueError, OSError):
                if candidate == agent['runtime_key']:
                    raise
                continue
            metadata = env_root / (candidate + '.migration.json')
            if os.path.lexists(metadata):
                document = json.loads(read_file(metadata, 0o600))
                if any(document.get(name) != value for name, value in
                       {'schema_version': 1, 'tenant': agent['tenant_id'], 'alias': agent['alias'],
                        'runtime_key': agent['runtime_key'], 'client_cert_sha256': proof['certificate_sha256']}.items()):
                    raise SafeFailure('terminal existing migration identity differs')
            entry.update(selector=candidate, new_credentials=False, proof=proof)
            break
        entries[agent['runtime_key']] = entry
        save()
    if entry['identity'] != expected_identity or entry['operation_id'] != context['operation_id'] or entry['work'] != str(work):
        raise SafeFailure('terminal provisioning journal changed its fenced identity')
    if entry.get('rolled_back'):
        raise SafeFailure('terminal provisioning was already rolled back')
    selected = entry['selector']
    was_verified = entry.get('stage') == 'verified'
    pki = directory(pki_root, selected)
    unit = 'cauce-v3-pty@' + selected + '.service'
    dropins = directory(unit_root, unit + '.d', private=False)
    if 'unit_before' not in entry:
        pinned = pin_unit(unit, unit_root, template, agent=agent)
        entry['unit_before'] = unit_state(unit, unit_root)
        entry['legacy_dropins'] = pinned.get('legacy_dropins', [])
        save()
    if entry['new_credentials'] and not (entry.get('credentials_published') or was_verified):
        from fleet_executor_authority import issue_terminal
        csr = prepare_request(work, agent['runtime_key'], entry, save)
        idempotency = hashlib.sha256((context['operation_id'] + '\0' + agent['runtime_key']).encode()).hexdigest()
        entry.update(issuance_requested=True, idempotency_key=idempotency,
                     work_files={name: hashlib.sha256(read_file(work / name, 0o600)).hexdigest()
                                 for name in ('client.key', 'request.csr')})
        save()
        issued = issue_terminal(policy, context, agent, csr.decode('ascii'), idempotency)
        grant = {name: issued[name] for name in ('grant_id', 'certificate_sha256', 'expires_at', 'relay_host', 'relay_port')}
        if entry['grant'] is not None and entry['grant'] != grant:
            raise SafeFailure('terminal issuance replay changed its approved grant')
        entry['grant'] = grant
        entry['stage'] = 'issued'
        save()
        if openssl('x509', '-pubkey', '-noout', input_data=issued['certificate_pem'].encode()) \
                != openssl('pkey', '-in', str(work / 'client.key'), '-pubout'):
            raise SafeFailure('terminal issued certificate does not match its private key')
        for name, raw, mode in [('client.key', read_file(work / 'client.key', 0o600), 0o600),
                                ('client.crt', issued['certificate_pem'].encode(), 0o600),
                                ('ca.crt', issued['ca_pem'].encode(), 0o600),
                                ('alias-key.hex', (issued['alias_key_hex'] + '\n').encode(), 0o400)]:
            publication(entry, pki / name, raw, mode, work, save)
        relay = {'RELAY_HOST': issued['relay_host'], 'RELAY_PORT': str(issued['relay_port'])}
        if issued.get('relay_server_name'):
            relay['RELAY_SERVER_NAME'] = issued['relay_server_name']
        proof = {'certificate_sha256': grant['certificate_sha256'], 'expires_at': grant['expires_at']}
    else:
        proof = existing_pair(pki, agent, terminal_inventory(policy, context, agent))
        relay = read_environment(env_root / (selected + '.env'))
        if relay.get('PKI_DIR') != str(pki) or relay.get('ALIAS_KEY_FILE') != str(pki / 'alias-key.hex'):
            raise SafeFailure('terminal existing launcher environment has another PKI identity')
        relay = {name: value for name, value in relay.items() if name.startswith('RELAY_')}
    values = {**relay, 'PKI_DIR': str(pki), 'ALIAS_KEY_FILE': str(pki / 'alias-key.hex'), 'CONTAINER_RUNTIME_DIR': '/run'}
    metadata = {'schema_version': 1, 'tenant': agent['tenant_id'], 'alias': agent['alias'],
                'runtime_key': agent['runtime_key'], 'client_cert_sha256': proof['certificate_sha256']}
    publication(entry, env_root / (selected + '.env'), ''.join(name + '=' + value + '\n' for name, value in values.items()).encode(), 0o600, work, save)
    publication(entry, env_root / (selected + '.migration.json'), (json.dumps(metadata, sort_keys=True) + '\n').encode(), 0o600, work, save)
    publication(entry, unit_root / unit, template, 0o644, work, save)
    approved_selector = selector(ops, version, policy['roots']['state'], generation.name,
                                 agent['runtime_key'], identity, policy['host_id'],
                                 shared_tui=policy['bundles'][agent['harness_id']].get('shared_tui', False))
    publication(entry, dropins / 'zz-fleet-terminal.conf', approved_selector, 0o600, work, save, advance=True)
    for previous in entry.get('legacy_dropins', []):
        filename = pathlib.Path(previous['path'])
        if filename.parent != dropins or filename.name >= 'zz-fleet-terminal.conf':
            raise SafeFailure('terminal legacy publication escapes its approved instance')
        if str(filename) not in entry['files'] \
                and hashlib.sha256(read_file(filename, previous['mode'])).hexdigest() != previous['sha256']:
            raise SafeFailure('terminal legacy drop-in changed before adoption')
        publication(entry, filename, None, previous['mode'], work, save)
    entry.update(stage='published', unit=unit, source_sha256=version, credentials_published=True)
    save()
    systemctl('daemon-reload')
    pin_unit(unit, unit_root, template, approved_selector, agent=agent)
    try:
        if not was_verified and (entry['new_credentials'] or entry['files']):
            raise SafeFailure('terminal current publication requires a fresh relay acknowledgement')
        ready = presence(unit, agent['alias'], version, attempts=1)
    except SafeFailure:
        entry['activation_changed'] = True
        save()
        systemctl('enable', unit)
        systemctl('restart', unit)
        ready = presence(unit, agent['alias'], version)
    entry.update(stage='verified', proof=proof, presence=ready)
    save()
    for name, pin in entry.get('work_files', {}).items():
        remove_file(work / name, pin, 0o600)
    return {'terminal_verified': True, 'terminal_certificate_sha256': proof['certificate_sha256'],
            'unit': unit, 'generation': generation.name, 'reused': not entry['new_credentials'], 'presence': ready}


def ensure_terminal(policy: dict, context: dict, agent: dict, generation: pathlib.Path, journal: dict, save) -> dict:
    try:
        return _ensure(policy, context, agent, generation, journal, save)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, SafeFailure) as error:
        from fleet_executor_image import failure_details
        details = failure_details(error) if isinstance(error, SafeFailure) else type(error).__name__
        details = re.sub(r'(?:~?/)[^\s\x00-\x1f\x7f\"\'<>;,]+', '[path]', details)
        print('terminal provisioning failed: ' + details, file=sys.stderr)
        raise SafeFailure('terminal provisioning failed') from None


def rollback_terminal(policy: dict, context: dict, agent: dict, journal: dict, save) -> dict:
    entry = journal.get('terminal_provision', {}).get(agent['runtime_key'])
    if entry is None or entry.get('rolled_back'):
        return {'terminal_rollback_verified': True}
    if entry.get('identity') != {key: agent[key] for key in ('tenant_id', 'alias', 'runtime_key')} \
            or entry.get('operation_id') != context['operation_id']:
        raise SafeFailure('terminal provisioning failed')
    home = pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir)
    unit_root = home / '.config/systemd/user'
    selected = entry.get('selector')
    if selected not in {agent['runtime_key'], agent['alias']}:
        raise SafeFailure('terminal provisioning failed')
    unit = 'cauce-v3-pty@' + selected + '.service'
    config = home / '.config/cauce-v3'
    permitted = {str(config / 'pty' / (selected + suffix)) for suffix in ('.env', '.migration.json')}
    permitted.update(str(config / 'pty-pki' / selected / name) for name in ('client.crt', 'client.key', 'ca.crt', 'alias-key.hex'))
    permitted.update((str(unit_root / unit), str(unit_root / (unit + '.d') / 'zz-fleet-terminal.conf')))
    for previous in entry.get('legacy_dropins', []):
        filename = pathlib.Path(previous['path'])
        if filename.parent != unit_root / (unit + '.d') or filename.name >= 'zz-fleet-terminal.conf':
            raise SafeFailure('terminal provisioning failed')
        permitted.add(str(filename))
    work = pathlib.Path(policy['roots']['state']) / 'terminal-provision' / agent['runtime_key'] / context['operation_id']
    if entry.get('work') != str(work) or set(entry['files']) - permitted:
        raise SafeFailure('terminal provisioning failed')
    for name, pin in entry['files'].items():
        current = hashlib.sha256(read_file(pathlib.Path(name), pin['mode'])).hexdigest() if os.path.lexists(name) else None
        if current not in {*pin.get('owned', [pin['sha256']]), pin['previous']}:
            raise SafeFailure('terminal provisioning failed')
    if entry.get('activation_changed'):
        _, _, template = approved_release(policy, agent)
        if pin_unit(unit, unit_root, template, agent=agent).get('LoadState') != 'not-found':
            systemctl('stop', unit)
            systemctl('disable', unit)
    if entry.get('issuance_requested') and entry.get('grant') is None:
        from fleet_executor_authority import terminal_receipt
        csr = read_file(pathlib.Path(entry['work']) / 'request.csr', 0o600).decode('ascii')
        observed = terminal_receipt(policy, context, agent, csr, entry['idempotency_key'])
        if observed['grant'] is not None:
            entry['grant'] = {name: observed['grant'][name] for name in
                              ('grant_id', 'certificate_sha256', 'expires_at', 'relay_host', 'relay_port')}
            save()
    if entry.get('grant'):
        from fleet_executor_authority import revoke_terminal
        grant = entry['grant']
        revoke_terminal(policy, context, agent, grant['grant_id'], grant['certificate_sha256'])
    for name, pin in reversed(list(entry['files'].items())):
        filename = pathlib.Path(name)
        if pin['backup']:
            if os.path.lexists(filename) and hashlib.sha256(read_file(filename, pin['mode'])).hexdigest() == pin['previous']:
                continue
            raw = read_file(pathlib.Path(pin['backup']), 0o600)
            if hashlib.sha256(raw).hexdigest() != pin['previous']:
                raise SafeFailure('terminal provisioning failed')
            current = hashlib.sha256(read_file(filename, pin['mode'])).hexdigest() if os.path.lexists(filename) else None
            if current not in {*pin.get('owned', [pin['sha256']]), pin['previous']}:
                raise SafeFailure('terminal rollback file changed during authority revocation')
            write_file(filename, raw, pin['mode'], previous=current)
        else:
            if os.path.lexists(filename):
                current = hashlib.sha256(read_file(filename, pin['mode'])).hexdigest()
                if current not in pin.get('owned', [pin['sha256']]):
                    raise SafeFailure('terminal rollback file changed during authority revocation')
                remove_file(filename, current, pin['mode'])
    systemctl('daemon-reload')
    if entry.get('activation_changed') and entry.get('unit_before', {}).get('enabled'):
        systemctl('enable', unit)
    if entry.get('activation_changed') and entry.get('unit_before', {}).get('active'):
        systemctl('start', unit)
    for name, pin in entry.get('work_files', {}).items():
        if name not in {'client.key', 'request.csr'}:
            raise SafeFailure('terminal provisioning failed')
        remove_file(work / name, pin, 0o600)
    for pin in entry['files'].values():
        if pin['backup']:
            filename = pathlib.Path(pin['backup'])
            if filename.parent != work or not re.fullmatch(r'before-[0-9]+', filename.name):
                raise SafeFailure('terminal provisioning failed')
            remove_file(filename, pin['previous'], 0o600)
    empty = [work, unit_root / (unit + '.d')]
    if entry['new_credentials']:
        empty.append(config / 'pty-pki' / selected)
    for filename in empty:
        try:
            filename.rmdir()
        except FileNotFoundError:
            pass
        except OSError:
            if filename == work or entry['new_credentials'] and filename == config / 'pty-pki' / selected:
                raise SafeFailure('terminal provisioning failed') from None
    entry.update(stage='rolled_back', rolled_back=True)
    save()
    return {'terminal_rollback_verified': True}
