from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import re
import ssl

from fleet_executor_native_manager import systemctl
from fleet_executor_native_retirement import pinned_file
from fleet_executor_pki import checked_file
from fleet_executor_policy import SafeFailure, open_absolute_directory

UNIT_PREFIXES = ('cauce-v3-pty@', 'cauce-v3-pty-host@', 'cauce-v3-profile-expectation@')
CONTAINER_REAPER = '''import hashlib,json,os,ssl,stat,sys
try:
    expected=json.loads(sys.argv[1]); phase=sys.argv[2]
    namespace={'__name__':'cauce_terminal_reaper'}
    exec(compile(sys.stdin.buffer.read(),'<approved-pty-reaper>','exec'),namespace)
    canonical_cmdlines=namespace['expected_cmdlines']
    def scoped_cmdlines(bundle,alias):
        declared=(os.fsencode(expected['python']),b'-m',b'cauce_pty_agent',b'--bundle',os.fsencode(bundle))
        return canonical_cmdlines(bundle,alias)|frozenset((declared,))
    namespace['expected_cmdlines']=scoped_cmdlines
    result={}
    processes={}
    for filename in expected['paths']:
        processes[filename]=namespace['discover'](filename,expected['alias'])
        if any(namespace['read_process_uid'](row[0])!=os.geteuid() for row in processes[filename]): raise ValueError()
        process_pins=[[row[0],row[1],hashlib.sha256(b'\\0'.join(row[2])).hexdigest()] for row in processes[filename]]
        try:
            descriptor=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        except FileNotFoundError:
            if process_pins and not expected['allow_consumed_bundle']: raise ValueError()
            result[filename]={'bundle':None,'processes':process_pins}
            continue
        try:
            details=os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_uid!=os.geteuid() or details.st_mode&0o077 or details.st_nlink!=1:
                raise ValueError()
            raw=os.read(descriptor,1048577)
        finally:
            os.close(descriptor)
        if len(raw)>1048576: raise ValueError()
        document=json.loads(raw)
        if any(document.get(key)!=value for key,value in expected['identity'].items()): raise ValueError()
        fingerprint=hashlib.sha256(ssl.PEM_cert_to_DER_cert(document['client_cert_pem'])).hexdigest()
        if fingerprint not in expected['fingerprints']: raise ValueError()
        result[filename]={'bundle':hashlib.sha256(raw).hexdigest(),'processes':process_pins}
    if phase=='reap':
        for name,pin in result.items():
            prior=expected['pins'][name]
            if pin['bundle'] is not None and pin['bundle']!=prior['bundle']: raise ValueError()
            if any(process not in prior['processes'] for process in pin['processes']): raise ValueError()
        namespace['check_capabilities']()
        for filename in expected['paths']:
            for process in processes[filename]: namespace['reap_candidate'](process)
            if namespace['discover'](filename,expected['alias']): raise ValueError()
            if result[filename]['bundle'] is not None:
                descriptor=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                try:
                    if hashlib.sha256(os.read(descriptor,1048577)).hexdigest()!=result[filename]['bundle']: raise ValueError()
                    before=os.fstat(descriptor); after=os.stat(filename,follow_symlinks=False)
                    if (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino): raise ValueError()
                    os.unlink(filename)
                finally: os.close(descriptor)
    if phase=='verify' and any(pin['bundle'] is not None or pin['processes'] for pin in result.values()): raise ValueError()
    print(json.dumps(result,sort_keys=True))
except Exception:
    sys.stderr.write('terminal container identity or orphan cleanup is unverified\\n')
    sys.exit(2)
'''


def reap_container(policy: dict, agent: dict, entry: dict, save) -> None:
    if agent['runtime_mode'] != 'container':
        return
    from fleet_executor_container import (
        checked_command,
        identity_for,
        inspect_container,
        teardown_agent,
        user_identity,
    )
    observed = inspect_container(agent['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        return
    agent = teardown_agent(policy, agent, observed)
    identity = identity_for(agent, observed)
    uid, gid = user_identity(agent, identity)
    source = pathlib.Path(__file__).resolve().parents[1] / 'pty-agent/reap_orphan_agent.py'
    raw = source.read_bytes()
    pin = hashlib.sha256(raw).hexdigest()
    previous = entry.get('container')
    expected = {'alias': agent['alias'], 'fingerprints': entry['fingerprints'], 'paths': entry['bundle_paths'],
                'python': agent['_placement']['python'],
                'allow_consumed_bundle': bool(entry['files']) and bool(entry['fingerprints']),
                'identity': {'tenant_id': agent['tenant_id'], 'alias': agent['alias'], 'container_id': observed['Id'],
                    'image_id': observed['Image'], 'runtime_user': agent['runtime_user'], 'runtime_uid': int(uid),
                    'runtime_gid': int(gid), 'home': agent['home_directory'], 'harness': agent['harness_id']}}
    command = ['/usr/bin/docker', 'exec', '-i', '-w', '/', '--user', uid + ':' + gid, observed['Id'],
               agent['_placement']['python'], '-I', '-B', '-c', CONTAINER_REAPER]
    if previous is None:
        pins = json.loads(checked_command([*command, json.dumps(expected), 'observe'], input_data=raw))
        previous = {'id': observed['Id'], 'source_sha256': pin, 'pins': pins}
        entry['container'] = previous
        save()
    if previous['id'] != observed['Id'] or previous['source_sha256'] != pin:
        raise SafeFailure('terminal orphan cleanup changed its approved container or reaper')
    checked_command([*command, json.dumps({**expected, 'pins': previous['pins']}),
                     'verify' if entry.get('complete') else 'reap'], input_data=raw)


def properties(unit: str, root: pathlib.Path) -> dict:
    row = dict(line.split('=', 1) for line in systemctl('show', unit,
        '--property=LoadState,FragmentPath,DropInPaths,ActiveState,UnitFileState', allow_absent=True).splitlines())
    fragment = pathlib.Path(row.get('FragmentPath', ''))
    template = root / (unit.split('@', 1)[0] + '@.service')
    if row.get('LoadState') not in {'loaded', 'not-found'} or row.get('ActiveState') not in {'active', 'inactive', 'failed'} \
            or row.get('FragmentPath') and fragment not in (template, root / unit) \
            or any(pathlib.Path(filename).parent not in (root / (unit + '.d'), root / (template.name + '.d'))
                   for filename in row.get('DropInPaths', '').split()):
        raise SafeFailure('terminal systemd manager is outside its alias configuration')
    return row


def file_pin(filename: pathlib.Path, *, private: bool = False) -> str:
    return hashlib.sha256(checked_file(filename, private=private)).hexdigest()


def private_directory(directory: pathlib.Path, *, private: bool = True) -> list[str]:
    descriptor = open_absolute_directory(directory)
    try:
        details = os.fstat(descriptor)
        if details.st_uid != os.geteuid() or details.st_mode & (0o077 if private else 0o022):
            raise SafeFailure('terminal directory is not private and executor-owned')
        return os.listdir(descriptor)
    finally:
        os.close(descriptor)


def relay_absence(agent: dict, journal: dict) -> dict:
    entry = journal.get('central_revocations', {}).get(agent['runtime_key'], {})
    rows = entry.get('absence', {}).get('authorities', [])
    pty = [row for row in rows if row.get('id') == 'pty']
    if entry.get('complete') is not True or len(pty) != 1 or pty[0].get('preserved') \
            or pty[0].get('matching_records') != []:
        raise SafeFailure('terminal purge requires observed relay authority revocation')
    return entry


def observe(agent: dict, home: pathlib.Path, journal: dict, *, require_container: bool = False, selector: str | None = None) -> dict:
    selector = agent['alias'] if selector is None else selector
    if selector not in {agent['alias'], agent['runtime_key']}:
        raise SafeFailure('terminal storage selector is outside its physical and wire identity')
    config = home / '.config/cauce-v3'
    envs = [config / name / (selector + '.env') for name in ('pty', 'pty-host')]
    metadata = config / 'pty' / (selector + '.migration.json')
    pki = config / 'pty-pki' / selector
    root = home / '.config/systemd/user'
    units = [prefix + selector + '.service' for prefix in UNIT_PREFIXES]
    candidates = [*envs, metadata, pki, *(root / (unit + '.d') for unit in units),
                  *(root / 'default.target.wants' / unit for unit in units), *(root / unit for unit in units)]
    observed = {}
    if os.path.exists(pathlib.Path('/run/user') / str(os.geteuid()) / 'bus'):
        observed = {unit: properties(unit, root) for unit in units}
    live = any(row.get('ActiveState') in {'active', 'failed'} or row.get('UnitFileState', '').startswith('enabled')
               for row in observed.values())
    if not live and not any(os.path.lexists(filename) for filename in candidates):
        if require_container:
            authority = relay_absence(agent, journal)
            return {'identity': {key: agent[key] for key in ('tenant_id', 'alias', 'runtime_key')},
                    'files': {}, 'templates': {}, 'units': list(observed), 'observed_units': [], 'dropins': [],
                    'pki': str(pki), 'pki_present': False, 'fingerprints': authority.get('terminal_fingerprints', []),
                    'selector': selector, 'bundle_paths': ['/var/tmp/.cauce-pty-bundle-' + selector + '.json',
                                     '/run/cauce-pty-' + selector + '/bundle.json'], 'removed': []}
        return {}
    authority = relay_absence(agent, journal)
    files, templates, dropins, observed_units = {}, {}, [], []
    bundle_paths = ['/var/tmp/.cauce-pty-bundle-' + selector + '.json']
    for filename in (*envs, metadata):
        if os.path.lexists(filename):
            files[str(filename)] = file_pin(filename, private=True)
            if filename in envs:
                config_values = {}
                for line in checked_file(filename, private=True).decode('utf-8').splitlines():
                    if not line or line.startswith('#'):
                        continue
                    key, separator, value = line.partition('=')
                    if not separator or key in config_values:
                        raise SafeFailure('terminal environment has invalid or duplicate fields')
                    config_values[key] = value
                if config_values.get('PKI_DIR') != str(pki) \
                        or config_values.get('ALIAS_KEY_FILE') != str(pki / 'alias-key.hex') \
                        or 'TENANT_ID' in config_values and config_values['TENANT_ID'] != agent['tenant_id']:
                    raise SafeFailure('terminal environment is outside its fenced identity and PKI')
                if 'CONTAINER_RUNTIME_DIR' in config_values:
                    if config_values['CONTAINER_RUNTIME_DIR'] != '/run':
                        raise SafeFailure('terminal container bundle is outside its approved runtime directory')
                    bundle_paths.append('/run/cauce-pty-' + selector + '/bundle.json')
    certificate = None
    if os.path.lexists(pki):
        names = private_directory(pki)
        if set(names) - {'client.crt', 'client.key', 'ca.crt', 'alias-key.hex'}:
            raise SafeFailure('terminal PKI contains unapproved files')
        for name in names:
            filename = pki / name
            files[str(filename)] = file_pin(filename, private=name in {'client.key', 'alias-key.hex'})
        if 'client.crt' in names:
            certificate = hashlib.sha256(ssl.PEM_cert_to_DER_cert(checked_file(pki / 'client.crt').decode('ascii'))).hexdigest()
    if str(metadata) in files:
        document = json.loads(checked_file(metadata, private=True))
        if not isinstance(document, dict) or document.get('schema_version') != 1 \
                or document.get('tenant') != agent['tenant_id'] or document.get('alias') != agent['alias'] \
                or document.get('runtime_key') != agent['runtime_key'] \
                or certificate is not None and document.get('client_cert_sha256') != certificate:
            raise SafeFailure('terminal migration identity differs from the fenced runtime')
    elif certificate is None or certificate not in authority.get('terminal_fingerprints', []):
        raise SafeFailure('terminal certificate is not bound to the fenced tenant and alias')
    for unit in units:
        row = observed.get(unit) or properties(unit, root)
        if row.get('ActiveState') in {'active', 'failed'} or row.get('UnitFileState', '').startswith('enabled') \
                or os.path.lexists(root / (unit + '.d')) or os.path.lexists(root / unit):
            observed_units.append(unit)
        fragment = row.get('FragmentPath')
        if fragment:
            pin = file_pin(pathlib.Path(fragment))
            pinned_file(pathlib.Path(fragment), pin)
            (files if pathlib.Path(fragment).name == unit else templates)[fragment] = pin
        for filename in row.get('DropInPaths', '').split():
            candidate = pathlib.Path(filename)
            if candidate.parent == root / (unit.split('@', 1)[0] + '@.service.d'):
                pin = file_pin(candidate)
                pinned_file(candidate, pin)
                templates[filename] = pin
        directory = root / (unit + '.d')
        if os.path.lexists(directory):
            names = private_directory(directory, private=False)
            if any(not name.endswith('.conf') for name in names):
                raise SafeFailure('terminal unit drop-in directory contains unapproved files')
            dropins.append(str(directory))
            for name in names:
                filename = directory / name
                files[str(filename)] = file_pin(filename)
                pinned_file(filename, files[str(filename)])
    return {'identity': {key: agent[key] for key in ('tenant_id', 'alias', 'runtime_key')}, 'files': files,
            'templates': templates, 'units': units, 'observed_units': observed_units, 'dropins': dropins, 'pki': str(pki),
            'pki_present': os.path.lexists(pki),
            'fingerprints': [certificate] if certificate else authority.get('terminal_fingerprints', []),
            'selector': selector, 'bundle_paths': list(dict.fromkeys(bundle_paths)), 'removed': []}


def verify_stopped(entry: dict, root: pathlib.Path) -> None:
    for unit in entry['units']:
        row = properties(unit, root)
        if row.get('ActiveState') != 'inactive' or row.get('UnitFileState', '') not in {'disabled', 'static', '', 'not-found'}:
            raise SafeFailure('terminal unit is still running or enabled')


def purge_selector(policy: dict, agent: dict, journal: dict | None, save, selector: str, journal_key: str) -> dict:
    alias = agent.get('alias')
    if not isinstance(alias, str) or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', alias) is None:
        raise SafeFailure('terminal purge alias is invalid')
    if 'authority' in policy:
        relay_absence(agent, journal or {})
    home = pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir)
    entries = (journal or {}).get('terminal_decommission', {})
    entry = entries.get(journal_key)
    if entry is None:
        entry = observe(agent, home, journal or {}, require_container='authority' in policy and agent['runtime_mode'] == 'container', selector=selector)
        if not entry:
            return {'removed': []}
        if journal is None or save is None:
            raise SafeFailure('terminal purge requires a durable operation receipt')
        journal.setdefault('terminal_decommission', {})[journal_key] = entry
        save()
    if entry.get('identity') != {key: agent[key] for key in ('tenant_id', 'alias', 'runtime_key')} \
            or agent.get('systemd_user') != policy['executor_user'] \
            or policy['executor_user'] != pwd.getpwuid(os.geteuid()).pw_name:
        raise SafeFailure('terminal purge replay changed its approved identity')
    relay_absence(agent, journal)
    root = home / '.config/systemd/user'
    if entry.get('complete'):
        verify_stopped(entry, root)
        reap_container(policy, agent, entry, save)
        config = home / '.config/cauce-v3'
        candidates = [config / kind / (selector + '.env') for kind in ('pty', 'pty-host')]
        candidates += [config / 'pty' / (selector + '.migration.json'), pathlib.Path(entry['pki']),
                       *(root / (unit + '.d') for unit in entry['units']), *(root / unit for unit in entry['units'])]
        if any(os.path.lexists(filename) for filename in candidates):
            raise SafeFailure('terminal artifacts reappeared after observed removal')
        return {'removed': entry['removed']}
    for filename, pin in {**entry['templates'], **entry['files']}.items():
        if not pinned_file(pathlib.Path(filename), pin) and filename in entry['templates']:
            raise SafeFailure('terminal shared unit template disappeared')
    for unit in entry['units']:
        row = properties(unit, root)
        if row.get('LoadState') == 'loaded':
            systemctl('stop', unit)
            systemctl('disable', unit)
            if row.get('ActiveState') == 'failed':
                systemctl('reset-failed', unit)
    verify_stopped(entry, root)
    reap_container(policy, agent, entry, save)
    entry['removed'] = [{'type': 'unit', 'name': unit} for unit in entry['observed_units']]
    for filename, pin in entry['files'].items():
        pinned_file(pathlib.Path(filename), pin, remove=True)
        entry['removed'].append({'type': 'file', 'name': filename})
    for name in [*entry['dropins'], entry['pki']]:
        directory = pathlib.Path(name)
        try:
            parent = open_absolute_directory(directory.parent)
        except FileNotFoundError:
            continue
        try:
            try:
                os.rmdir(directory.name, dir_fd=parent)
                os.fsync(parent)
            except FileNotFoundError:
                pass
        finally:
            os.close(parent)
        if name != entry['pki'] or entry['pki_present']:
            entry['removed'].append({'type': 'directory', 'name': name})
    systemctl('daemon-reload')
    verify_stopped(entry, root)
    entry['complete'] = True
    save()
    return {'removed': entry['removed']}


def purge_terminal(policy: dict, agent: dict, journal: dict | None, save) -> dict:
    key, alias = agent['runtime_key'], agent['alias']
    if key == alias:
        return purge_selector(policy, agent, journal, save, alias, key)
    home = pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir)
    config = home / '.config/cauce-v3'
    selectors = [(key, key + ':physical')]
    metadata = config / 'pty' / (alias + '.migration.json')
    certificate = config / 'pty-pki' / alias / 'client.crt'
    legacy = False
    if os.path.lexists(metadata):
        document = json.loads(checked_file(metadata, private=True))
        legacy = isinstance(document, dict) and all(document.get(name) == value for name, value in
            {'schema_version': 1, 'tenant': agent['tenant_id'], 'alias': alias, 'runtime_key': key}.items())
    elif os.path.lexists(certificate):
        authority = relay_absence(agent, journal or {})
        pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(checked_file(certificate).decode('ascii'))).hexdigest()
        legacy = pin in authority.get('terminal_fingerprints', [])
    if legacy or key in (journal or {}).get('terminal_decommission', {}):
        selectors.append((alias, key))
    removed = []
    for selector, journal_key in selectors:
        removed.extend(purge_selector(policy, agent, journal, save, selector, journal_key)['removed'])
    return {'removed': removed}
