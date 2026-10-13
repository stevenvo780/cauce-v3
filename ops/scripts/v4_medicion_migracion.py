"""Read-only measurement of a Docker host and of the agent aliases it runs, for the V4 migration.

One sealed JSON receipt per run, with the same format before and after each cut. Sizes come from stat
metadata (du), never from file content. Process command lines are matched in memory on the measured host:
the receipt carries executable names, counts and RSS sums, never arguments or environment.

Stdlib only: v4-medicion-migracion.sh pipes this file through ssh to the measured host.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time

SCHEMA = 'cauce.v4-migracion-medicion/1'
SCOPE_SCHEMA = 'cauce.v4-migracion-alcance/1'
ALIAS_RE = re.compile(r'^[a-z][a-z0-9-]{0,62}$')
CONTAINER_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
USER_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$')
LABEL_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')
ROUTE_RE = re.compile(r'^(?:local|ssh:[A-Za-z0-9_.@-]{1,128})$')
UNITS = {'B': 1, 'KIB': 1024, 'MIB': 1024**2, 'GIB': 1024**3, 'TIB': 1024**4,
         'KB': 1000, 'MB': 1000**2, 'GB': 1000**3, 'TB': 1000**4}
OPENCLAW_GATEWAY = r'index\.js gateway'
DU_TIMEOUT = 1800
TOP_PROCESSES = 8


class Failure(ValueError):
    pass


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def seal(doc: dict) -> str:
    return hashlib.sha256(canonical({k: v for k, v in doc.items() if k != 'sha256'})).hexdigest()


def absolute_path(value) -> str:
    if not isinstance(value, str) or not value.startswith('/') or len(value) > 1024 \
            or any(part in ('.', '..') for part in value.split('/')) \
            or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise Failure(f'invalid absolute path: {value!r}')
    return value.rstrip('/') or '/'


def scope_entry(alias: str, entry: dict) -> dict:
    if not ALIAS_RE.fullmatch(alias) or not isinstance(entry, dict):
        raise Failure(f'invalid alias in scope: {alias!r}')
    if not CONTAINER_RE.fullmatch(str(entry.get('container', ''))) or not USER_RE.fullmatch(str(entry.get('user', ''))):
        raise Failure(f'{alias}: container and user are required')
    paths = entry.get('paths')
    if not isinstance(paths, dict) or not paths or set(paths) - {'estado', 'configuracion', 'espacio'}:
        raise Failure(f'{alias}: paths must name estado, configuracion or espacio')
    together = entry.get('containerAliases')
    if not isinstance(together, list) or alias not in together or any(not ALIAS_RE.fullmatch(str(a)) for a in together):
        raise Failure(f'{alias}: containerAliases must list the aliases sharing the container')
    pattern = entry.get('processes')
    if pattern is not None:
        re.compile(pattern)
    route = entry.get('declaredRoute', 'local')
    if not ROUTE_RE.fullmatch(str(route)):
        raise Failure(f'{alias}: invalid declaredRoute')
    return {'container': entry['container'], 'user': entry['user'], 'home': absolute_path(entry.get('home', '/')),
            'harness': str(entry.get('harness', '')), 'paths': {k: absolute_path(v) for k, v in sorted(paths.items())},
            'containerAliases': sorted(set(together)), 'processes': pattern, 'declaredRoute': route}


def validate_scope(scope) -> dict:
    if not isinstance(scope, dict) or scope.get('schema') != SCOPE_SCHEMA or not isinstance(scope.get('aliases'), dict) \
            or not scope['aliases']:
        raise Failure('scope must be a cauce.v4-migracion-alcance/1 document with aliases')
    return {'schema': SCOPE_SCHEMA, 'aliases': {a: scope_entry(a, e) for a, e in sorted(scope['aliases'].items())}}


def scope_digest(scope: dict) -> str:
    """Placement may change across the cut; what is measured may not, so the route stays out of the digest."""
    body = {a: {k: v for k, v in e.items() if k != 'declaredRoute'} for a, e in scope['aliases'].items()}
    return hashlib.sha256(canonical({'schema': scope['schema'], 'aliases': body})).hexdigest()


def scope_from_config(config: dict, aliases: list[str]) -> dict:
    """Derives the durable scope from the versioned alias config: state, harness config and workspace of each alias."""
    entries = config.get('aliases') if isinstance(config, dict) else None
    if not isinstance(entries, dict):
        raise Failure('container alias config has no aliases')
    result = {}
    for alias in aliases:
        entry = entries.get(alias)
        if not isinstance(entry, dict):
            raise Failure(f'alias not in config: {alias}')
        host = entry.get('dockerHost', 'local')
        paths = {'estado': entry['stateDirectory'],
                 'configuracion': f"{entry['home'].rstrip('/')}/.local/share/cauce-v3/config/{alias}"}
        if entry.get('workspace'):
            paths['espacio'] = entry['workspace']
        result[alias] = {
            'container': entry['container'], 'user': entry['user'], 'home': entry['home'],
            'harness': entry.get('harness', ''), 'paths': paths,
            'containerAliases': sorted(a for a, other in entries.items() if isinstance(other, dict)
                                       and other.get('container') == entry['container']
                                       and other.get('dockerHost', 'local') == host),
            'processes': OPENCLAW_GATEWAY if entry.get('harness') == 'openclaw' else None,
            'declaredRoute': 'local' if host == 'local' else f"ssh:{entry['systemdUser']}@{host}"}
    return validate_scope({'schema': SCOPE_SCHEMA, 'aliases': result})


def run(command: list[str], timeout: int = 120) -> tuple[int, str, str]:
    try:
        done = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, '', type(error).__name__
    return done.returncode, done.stdout, done.stderr.strip()[:200]


def to_bytes(text: str):
    match = re.fullmatch(r'\s*([0-9.]+)\s*([A-Za-z]*)\s*', text or '')
    return int(float(match.group(1)) * UNITS.get(match.group(2).upper() or 'B', 1)) if match else None


def host_identity(errors: list) -> dict:
    identity = {'hostname': socket.gethostname()}
    try:
        with open('/etc/machine-id', 'rb') as handle:
            identity['machineIdSha256'] = hashlib.sha256(handle.read().strip()).hexdigest()[:16]
    except OSError as error:
        errors.append({'step': 'machine-id', 'error': type(error).__name__})
    code, out, err = run(['docker', 'info', '--format', '{{.Name}}'])
    if code == 0 and out.strip():
        identity['dockerName'] = out.strip()
    else:
        errors.append({'step': 'docker-info', 'error': err})
    return identity


def fields(names: tuple[str, ...], values: list) -> dict:
    """Pairs names with the leading values; also runs on hosts whose Python predates zip(strict=)."""
    return {name: values[index] for index, name in enumerate(names) if index < len(values)}


def host_state(errors: list) -> dict:
    state = {}
    code, out, err = run(['free', '-b'])
    for line in out.splitlines() if code == 0 else []:
        cells = line.split()
        if cells[:1] == ['Mem:']:
            state['memory'] = fields(('total', 'used', 'free', 'shared', 'buffCache', 'available'),
                                     [int(cell) for cell in cells[1:7]])
        elif cells[:1] == ['Swap:']:
            state['swap'] = fields(('total', 'used', 'free'), [int(cell) for cell in cells[1:4]])
    if code:
        errors.append({'step': 'free', 'error': err})
    code, out, err = run(['df', '-B1', '--output=size,used,avail', '/'])
    rows = out.splitlines()[1:] if code == 0 else []
    if rows:
        state['disk'] = fields(('mount', 'size', 'used', 'available'), ['/', *[int(cell) for cell in rows[0].split()]])
    else:
        errors.append({'step': 'df', 'error': err})
    state['load'] = list(os.getloadavg())
    return state


def related(first: str, second: str) -> bool:
    return first == second or first.startswith(second.rstrip('/') + '/') or second.startswith(first.rstrip('/') + '/')


def host_mounts(errors: list) -> dict[str, list[str]]:
    code, out, err = run(['docker', 'ps', '-aq'])
    ids = out.split() if code == 0 else []
    if code:
        errors.append({'step': 'ps-all', 'error': err})
    if not ids:
        return {}
    code, out, err = run(['docker', 'container', 'inspect', *ids], timeout=300)
    if code:
        errors.append({'step': 'inspect-all', 'error': err})
        return {}
    return {item['Name'].lstrip('/'): [m.get('Source') or m.get('Name') or '' for m in item.get('Mounts') or []]
            for item in json.loads(out)}


def glob_escape(path: str) -> str:
    return re.sub(r'([*?\[\]\\])', r'\\\1', path)


def du(container: str, path: str, nested: list[str], errors: list) -> dict:
    """Apparent size from stat metadata; nested mount points are excluded so no byte is counted twice."""
    excludes = [f'--exclude={glob_escape(item)}' for item in nested]
    code, out, err = run(['docker', 'exec', '--user', '0', container, 'du', '-s', '-B1', '--apparent-size',
                          *excludes, '--', path], timeout=DU_TIMEOUT)
    method = 'du-apparent-B1'
    if code and 'No such file' not in err:
        code, out, err = run(['docker', 'exec', '--user', '0', container, 'du', '-s', '-k', '--', path], timeout=DU_TIMEOUT)
        method = 'du-k-blocks'
    lines = out.strip().splitlines()
    if code or not lines or not lines[-1].split()[0].isdigit():
        if 'No such file' in err:
            return {'exists': False, 'bytes': 0, 'method': method}
        errors.append({'step': 'du', 'container': container, 'error': err})
        return {'exists': None, 'bytes': None, 'method': method}
    value = int(lines[-1].split()[0])
    return {'exists': True, 'bytes': value * 1024 if method == 'du-k-blocks' else value, 'method': method,
            'nestedExcluded': len(nested) if method == 'du-apparent-B1' else 0}


def container_state(name: str, mounts_by_container: dict, errors: list) -> dict:
    code, out, err = run(['docker', 'container', 'inspect', '--size', name], timeout=900)
    if code:
        errors.append({'step': 'inspect', 'container': name, 'error': err})
        return {'present': False, 'running': False, 'mounts': []}
    data = json.loads(out)[0]
    image_id = data.get('Image', '')
    code, size, _ = run(['docker', 'image', 'inspect', '--format', '{{.Size}}', image_id])
    host = data.get('HostConfig') or {}
    mounts = []
    for mount in data.get('Mounts') or []:
        source = mount.get('Source') or mount.get('Name') or ''
        others = sorted(other for other, sources in mounts_by_container.items() if other != name
                        and any(source and related(source, item) for item in sources if item))
        mounts.append({'type': mount.get('Type'), 'source': source, 'destination': mount.get('Destination'),
                       'rw': bool(mount.get('RW')), 'sharedWithContainers': others})
    return {
        'present': True, 'running': bool((data.get('State') or {}).get('Running')),
        'image': (data.get('Config') or {}).get('Image'), 'imageId': image_id[:19],
        'imageBytes': int(size) if code == 0 and size.strip().isdigit() else None,
        'writableBytes': data.get('SizeRw'), 'memoryLimit': host.get('Memory') or 0,
        'nanoCpus': host.get('NanoCpus') or 0, 'user': (data.get('Config') or {}).get('User') or '',
        'mounts': sorted(mounts, key=lambda item: item['destination'] or ''),
    }


def docker_stats(containers: dict, errors: list) -> None:
    live = sorted(name for name, info in containers.items() if info.get('running'))
    if not live:
        return
    code, out, err = run(['docker', 'stats', '--no-stream', '--format', '{{json .}}', *live])
    if code:
        errors.append({'step': 'stats', 'error': err})
        return
    for line in out.splitlines():
        row = json.loads(line)
        usage, _, limit = (row.get('MemUsage') or '').partition('/')
        (containers.get(row.get('Name')) or {}).update({
            'memUsageBytes': to_bytes(usage), 'memLimitBytes': to_bytes(limit),
            'cpuPercent': float((row.get('CPUPerc') or '0%').rstrip('%') or 0), 'pids': int(row.get('PIDs') or 0)})


def process_table(container: str, errors: list, alias: str):
    code, out, err = run(['docker', 'exec', container, 'ps', '-eo', 'pid=,ppid=,rss=,args='])
    code_names, names, _ = run(['docker', 'exec', container, 'ps', '-eo', 'pid=,comm='])
    if code:
        errors.append({'step': 'ps', 'alias': alias, 'error': err})
        return None, None, None
    table, children, commands = {}, {}, {}
    for line in names.splitlines() if code_names == 0 else []:
        cells = line.strip().split(None, 1)
        if len(cells) == 2 and cells[0].isdigit():
            commands[int(cells[0])] = cells[1][:32]
    for line in out.splitlines():
        cells = line.split(None, 3)
        if len(cells) < 3 or not cells[0].isdigit():
            continue
        pid, ppid, rss = int(cells[0]), int(cells[1]), int(cells[2])
        table[pid] = (rss, cells[3] if len(cells) > 3 else '')
        children.setdefault(ppid, []).append(pid)
    return table, children, commands


def alias_processes(alias: str, entry: dict, errors: list) -> dict:
    container = entry['container']
    table, children, commands = process_table(container, errors, alias)
    if table is None:
        return {'measured': False}
    matchers = [re.compile(rf'--alias {re.escape(alias)}(\s|$)'), re.compile(rf'cauce-pty-bundle-{re.escape(alias)}\.json')]
    adapters = {pid for pid, (_, args) in table.items() if matchers[0].search(args)}
    if entry.get('processes'):
        matchers.append(re.compile(entry['processes']))
    roots = {pid for pid, (_, args) in table.items() if any(m.search(args) for m in matchers)}
    code, out, _ = run(['docker', 'exec', '--user', entry['user'], container, 'tmux', '-L', 'cauce',
                        'list-panes', '-t', f'cauce-{alias}', '-F', '#{pane_pid}'])
    panes = {int(pid) for pid in out.split() if code == 0 and pid.isdigit() and int(pid) in table}
    roots |= panes
    seen, pending = set(), list(roots)
    while pending:
        pid = pending.pop()
        if pid not in seen:
            seen.add(pid)
            pending.extend(children.get(pid, []))
    top: dict[str, int] = {}
    for pid in seen:
        top[commands.get(pid, '?')] = top.get(commands.get(pid, '?'), 0) + table[pid][0] * 1024
    return {'measured': True, 'adapters': len(adapters), 'tmuxPanes': len(panes), 'roots': len(roots),
            'processes': len(seen), 'rssBytes': sum(table[pid][0] for pid in seen) * 1024,
            'containerProcesses': len(table),
            'rssByCommand': [{'command': name, 'rssBytes': value} for name, value
                             in sorted(top.items(), key=lambda item: (-item[1], item[0]))[:TOP_PROCESSES]]}


def mount_of(path: str, mounts: list[dict]) -> dict | None:
    candidates = [m for m in mounts if m['destination'] and (path == m['destination']
                  or path.startswith(m['destination'].rstrip('/') + '/'))]
    return max(candidates, key=lambda m: len(m['destination'])) if candidates else None


def measure_container_mounts(name: str, info: dict, errors: list, cache: dict) -> None:
    """A source mounted by several containers (the shared /workspace) is walked once per run."""
    destinations = [m['destination'] for m in info['mounts'] if m['destination']]
    for mount in info['mounts']:
        nested = [d for d in destinations if d != mount['destination'] and d.startswith(mount['destination'].rstrip('/') + '/')]
        key = (mount['source'], tuple(sorted(d[len(mount['destination']):] for d in nested)))
        if not mount['source'] or key not in cache:
            cache[key] = du(name, mount['destination'], nested, errors)
        mount.update(cache[key])


def alias_paths(alias: str, entry: dict, info: dict, errors: list) -> dict:
    shared_container = len(entry['containerAliases']) > 1
    paths, own, shared = [], 0, 0
    counted_mounts = set()
    for mount in info['mounts']:
        mount_shared = shared_container or bool(mount['sharedWithContainers'])
        if mount.get('bytes') is None:
            continue
        if mount_shared:
            shared += mount['bytes']
        else:
            own += mount['bytes']
            counted_mounts.add(mount['destination'])
    scope_paths = sorted(entry['paths'].values())
    for role, path in sorted(entry['paths'].items()):
        holder = mount_of(path, info['mounts'])
        nested = [m['destination'] for m in info['mounts']
                  if m['destination'] and m['destination'] != path and m['destination'].startswith(path.rstrip('/') + '/')]
        size = du(entry['container'], path, nested, errors)
        within = holder['destination'] if holder else 'writable-layer'
        inside = [other for other in scope_paths if other != path and path.startswith(other.rstrip('/') + '/')]
        paths.append({'role': role, 'path': path, 'within': within, 'insideScopePath': bool(inside), **size})
        if size.get('bytes') and within not in counted_mounts and not inside:
            own += size['bytes']
    return {'paths': paths, 'ownBytes': own, 'sharedBytes': shared,
            'sharedMounts': sorted(m['destination'] for m in info['mounts']
                                   if shared_container or m['sharedWithContainers']),
            'containerAliases': entry['containerAliases']}


def measure(label: str, scope: dict, measured_via: str) -> dict:
    if not LABEL_RE.fullmatch(label) or not ROUTE_RE.fullmatch(measured_via):
        raise Failure('invalid label or route')
    scope = validate_scope(scope)
    errors: list = []
    doc = {'schema': SCHEMA, 'label': label, 'measuredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'measuredVia': measured_via, 'host': host_identity(errors), 'scope': scope, 'scopeSha256': scope_digest(scope)}
    doc.update(host_state(errors))
    mounts_by_container = host_mounts(errors)
    names = sorted({entry['container'] for entry in scope['aliases'].values()})
    containers = {name: container_state(name, mounts_by_container, errors) for name in names}
    docker_stats(containers, errors)
    sizes: dict = {}
    for name, info in containers.items():
        if info.get('running'):
            measure_container_mounts(name, info, errors, sizes)
    aliases, correlation = {}, {}
    for alias, entry in scope['aliases'].items():
        info = containers[entry['container']]
        result = {'container': entry['container'], 'running': bool(info.get('running'))}
        if info.get('running'):
            result.update(alias_processes(alias, entry, errors))
            result.update(alias_paths(alias, entry, info, errors))
        aliases[alias] = result
        correlation[alias] = {'declaredRoute': entry['declaredRoute'], 'measuredVia': measured_via,
                              'routeMatches': entry['declaredRoute'] == measured_via,
                              'containerRunning': result['running'], 'adapters': result.get('adapters', 0),
                              'tmuxPanes': result.get('tmuxPanes', 0),
                              'correlated': entry['declaredRoute'] == measured_via and result['running']
                              and (result.get('adapters', 0) > 0 or result.get('tmuxPanes', 0) > 0)}
    doc.update({'containers': containers, 'aliases': aliases, 'correlation': correlation, 'errors': errors})
    doc['sha256'] = seal(doc)
    return doc


def load(path: str) -> dict:
    with open(path, encoding='utf-8') as handle:
        doc = json.load(handle)
    if not isinstance(doc, dict) or doc.get('schema') != SCHEMA:
        raise Failure(f'{path}: not a {SCHEMA} receipt')
    if doc.get('sha256') != seal(doc):
        raise Failure(f'{path}: sha256 mismatch')
    if doc.get('scopeSha256') != scope_digest(validate_scope(doc.get('scope'))):
        raise Failure(f'{path}: scope digest mismatch')
    return doc


def pick(doc: dict, *keys):
    for key in keys:
        doc = doc.get(key) if isinstance(doc, dict) else None
    return doc


def delta(before: dict, after: dict, *keys):
    old, new = pick(before, *keys), pick(after, *keys)
    return None if old is None or new is None else new - old


def alias_metric(result: dict, key: str):
    """An alias that no longer runs on the measured host holds nothing there: it counts as zero."""
    return result.get(key) if result.get('running') else 0


def compare(first: str, second: str) -> dict:
    before, after = load(first), load(second)
    if before['scopeSha256'] != after['scopeSha256']:
        raise Failure('before and after were measured with different scopes; measure again with --alcance-de')
    report = {'schema': 'cauce.v4-migracion-comparacion/1', 'scopeSha256': before['scopeSha256'],
              'before': {k: before[k] for k in ('label', 'measuredAt', 'sha256')},
              'after': {k: after[k] for k in ('label', 'measuredAt', 'sha256')},
              'sameHost': before['host'].get('machineIdSha256') == after['host'].get('machineIdSha256'),
              'memoryAvailable': delta(before, after, 'memory', 'available'),
              'memoryUsed': delta(before, after, 'memory', 'used'), 'swapUsed': delta(before, after, 'swap', 'used'),
              'diskUsed': delta(before, after, 'disk', 'used'), 'aliases': {}, 'containers': {}}
    for alias in sorted(before['aliases']):
        old, new = before['aliases'][alias], after['aliases'].get(alias, {'running': False})
        report['aliases'][alias] = {key: alias_metric(new, key) - alias_metric(old, key)
                                    if None not in (alias_metric(new, key), alias_metric(old, key)) else None
                                    for key in ('rssBytes', 'ownBytes', 'sharedBytes')}
        report['aliases'][alias].update(runningBefore=old['running'], runningAfter=new['running'])
    for name in sorted(set(before['containers']) | set(after['containers'])):
        report['containers'][name] = {
            'presentBefore': pick(before, 'containers', name, 'present') or False,
            'presentAfter': pick(after, 'containers', name, 'present') or False,
            'memUsageBytes': delta(before, after, 'containers', name, 'memUsageBytes'),
            'writableBytes': delta(before, after, 'containers', name, 'writableBytes')}
    return report


def main(argv: list[str]) -> int:
    try:
        mode, *rest = argv
        if mode == 'medir' and len(rest) == 3:
            scope = json.loads(base64.b64decode(rest[1], validate=True))
            print(json.dumps(measure(rest[0], scope, rest[2]), indent=1, sort_keys=True, ensure_ascii=False))
        elif mode == 'alcance' and len(rest) >= 2:
            with open(rest[0], encoding='utf-8') as handle:
                config = json.load(handle)
            print(json.dumps(scope_from_config(config, rest[1:]), sort_keys=True, ensure_ascii=False))
        elif mode == 'alcance-de' and len(rest) == 1:
            print(json.dumps(load(rest[0])['scope'], sort_keys=True, ensure_ascii=False))
        elif mode == 'validar-alcance' and len(rest) == 1:
            with open(rest[0], encoding='utf-8') as handle:
                print(json.dumps(validate_scope(json.load(handle)), sort_keys=True, ensure_ascii=False))
        elif mode == 'verificar' and len(rest) == 1:
            doc = load(rest[0])
            print(f"{rest[0]}: sha256 {doc['sha256']} ok; alcance {doc['scopeSha256'][:16]}")
        elif mode == 'comparar' and len(rest) == 2:
            print(json.dumps(compare(rest[0], rest[1]), indent=1, sort_keys=True))
        else:
            raise Failure('usage: medir LABEL SCOPE_B64 ROUTE | alcance CONFIG ALIAS... | alcance-de RECEIPT '
                          '| validar-alcance FILE | verificar RECEIPT | comparar BEFORE AFTER')
    except (Failure, OSError, ValueError, KeyError) as error:
        print(f'v4-medicion-migracion: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
