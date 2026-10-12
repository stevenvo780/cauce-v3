#!/usr/bin/env bash
# Read-only footprint of a Docker host and of the agent aliases it runs, as one JSON receipt
# sealed with sha256. Process command lines are only matched in memory on the measured host:
# the receipt carries process counts and RSS sums, never arguments or environment.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: measure-vps-footprint.sh [--ssh DEST] [--label NAME] [--out FILE] ALIAS=CONTAINER[:REGEX] ...
       measure-vps-footprint.sh --verify FILE
       measure-vps-footprint.sh --compare BEFORE AFTER
EOF
  exit 2
}

PROGRAM=$(cat <<'PY'
import hashlib, json, os, re, socket, subprocess, sys, time

ALIAS_RE = re.compile(r'^[a-z][a-z0-9-]{0,62}$')
CONTAINER_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
UNITS = {'B': 1, 'KIB': 1024, 'MIB': 1024**2, 'GIB': 1024**3, 'TIB': 1024**4,
         'KB': 1000, 'MB': 1000**2, 'GB': 1000**3, 'TB': 1000**4}


def seal(doc):
    body = {k: v for k, v in doc.items() if k != 'sha256'}
    raw = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def run(cmd, timeout=120):
    try:
        done = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, '', type(error).__name__
    return done.returncode, done.stdout, done.stderr.strip()[:200]


def to_bytes(text):
    match = re.fullmatch(r'\s*([0-9.]+)\s*([A-Za-z]*)\s*', text or '')
    if not match:
        return None
    return int(float(match.group(1)) * UNITS.get(match.group(2).upper() or 'B', 1))


def host_state(errors):
    state = {}
    code, out, err = run(['free', '-b'])
    for line in out.splitlines() if code == 0 else []:
        cells = line.split()
        if cells[:1] == ['Mem:']:
            state['memory'] = dict(zip(('total', 'used', 'free', 'shared', 'buffCache', 'available'),
                                       map(int, cells[1:7])))
        elif cells[:1] == ['Swap:']:
            state['swap'] = dict(zip(('total', 'used', 'free'), map(int, cells[1:4])))
    if code:
        errors.append({'step': 'free', 'error': err})
    code, out, err = run(['df', '-B1', '--output=size,used,avail', '/'])
    rows = out.splitlines()[1:] if code == 0 else []
    if rows:
        state['disk'] = dict(zip(('mount', 'size', 'used', 'available'), ['/', *map(int, rows[0].split())]))
    else:
        errors.append({'step': 'df', 'error': err})
    state['load'] = list(os.getloadavg())
    return state


def container_state(name, errors):
    code, out, err = run(['docker', 'container', 'inspect', '--size', name], timeout=900)
    if code:
        errors.append({'step': 'inspect', 'container': name, 'error': err})
        return {'present': False}
    data = json.loads(out)[0]
    image_id = data.get('Image', '')
    code, size, _ = run(['docker', 'image', 'inspect', '--format', '{{.Size}}', image_id])
    host = data.get('HostConfig') or {}
    return {
        'present': True,
        'running': bool((data.get('State') or {}).get('Running')),
        'image': (data.get('Config') or {}).get('Image'),
        'imageId': image_id[:19],
        'imageBytes': int(size) if code == 0 and size.strip().isdigit() else None,
        'writableBytes': data.get('SizeRw'),
        'memoryLimit': host.get('Memory') or 0,
        'nanoCpus': host.get('NanoCpus') or 0,
        'user': (data.get('Config') or {}).get('User') or '',
        'mounts': sorted(f"{m.get('Type')}:{m.get('Source')}->{m.get('Destination')}:{'rw' if m.get('RW') else 'ro'}"
                         for m in data.get('Mounts') or []),
    }


def docker_stats(names, containers, errors):
    live = [name for name in names if containers[name].get('running')]
    if not live:
        return
    code, out, err = run(['docker', 'stats', '--no-stream', '--format', '{{json .}}', *live])
    if code:
        errors.append({'step': 'stats', 'error': err})
        return
    for line in out.splitlines():
        row = json.loads(line)
        usage, _, limit = (row.get('MemUsage') or '').partition('/')
        target = containers.get(row.get('Name')) or {}
        target.update({'memUsageBytes': to_bytes(usage), 'memLimitBytes': to_bytes(limit),
                       'cpuPercent': float((row.get('CPUPerc') or '0%').rstrip('%') or 0),
                       'pids': int(row.get('PIDs') or 0)})


def alias_usage(alias, container, pattern, info, errors):
    result = {'container': container, 'pattern': bool(pattern)}
    code, out, err = run(['docker', 'exec', container, 'ps', '-eo', 'pid=,ppid=,rss=,args='])
    if code:
        errors.append({'step': 'ps', 'alias': alias, 'error': err})
        return result
    table, children = {}, {}
    for line in out.splitlines():
        cells = line.split(None, 3)
        if len(cells) < 3 or not cells[0].isdigit():
            continue
        pid, ppid, rss = int(cells[0]), int(cells[1]), int(cells[2])
        table[pid] = (rss, cells[3] if len(cells) > 3 else '')
        children.setdefault(ppid, []).append(pid)
    matchers = [re.compile(rf'--alias {re.escape(alias)}(\s|$)'),
                re.compile(rf'cauce-pty-bundle-{re.escape(alias)}\.json')]
    if pattern:
        matchers.append(re.compile(pattern))
    roots = {pid for pid, (_, args) in table.items() if any(m.search(args) for m in matchers)}
    user = info.get('user') or ''
    code, out, _ = run(['docker', 'exec', *(['--user', user] if user else []), container, 'tmux', '-L', 'cauce',
                        'list-panes', '-t', f'cauce-{alias}', '-F', '#{pane_pid}'])
    roots.update(int(pid) for pid in out.split() if code == 0 and pid.isdigit() and int(pid) in table)
    seen, pending = set(), list(roots)
    while pending:
        pid = pending.pop()
        if pid not in seen:
            seen.add(pid)
            pending.extend(children.get(pid, []))
    result.update({'roots': len(roots), 'processes': len(seen),
                   'rssBytes': sum(table[pid][0] for pid in seen) * 1024,
                   'containerProcesses': len(table)})
    return result


def measure(label, specs):
    errors, aliases, wanted = [], {}, {}
    for spec in specs:
        alias, _, rest = spec.partition('=')
        container, _, pattern = rest.partition(':')
        if not ALIAS_RE.fullmatch(alias) or not CONTAINER_RE.fullmatch(container):
            raise SystemExit(f'invalid spec: {spec!r}')
        if pattern:
            re.compile(pattern)
        wanted[alias] = (container, pattern)
    doc = {'schema': 'cauce.vps-footprint/1', 'label': label, 'host': socket.gethostname(),
           'measuredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    doc.update(host_state(errors))
    names = sorted({container for container, _ in wanted.values()})
    containers = {name: container_state(name, errors) for name in names}
    docker_stats(names, containers, errors)
    for alias, (container, pattern) in sorted(wanted.items()):
        info = containers[container]
        aliases[alias] = (alias_usage(alias, container, pattern, info, errors) if info.get('running')
                          else {'container': container, 'running': False})
        aliases[alias]['sharedWith'] = sorted(a for a, (c, _) in wanted.items() if c == container and a != alias)
    doc.update({'containers': containers, 'aliases': aliases, 'errors': errors})
    doc['sha256'] = seal(doc)
    return doc


def load(path):
    with open(path, encoding='utf-8') as handle:
        doc = json.load(handle)
    if doc.get('sha256') != seal(doc):
        raise SystemExit(f'{path}: sha256 mismatch')
    return doc


def delta(before, after, *keys):
    values = []
    for doc in (before, after):
        for key in keys:
            doc = doc.get(key) if isinstance(doc, dict) else None
        values.append(doc)
    return None if None in values else values[1] - values[0]


def compare(first, second):
    before, after = load(first), load(second)
    report = {'before': {'label': before['label'], 'measuredAt': before['measuredAt'], 'sha256': before['sha256']},
              'after': {'label': after['label'], 'measuredAt': after['measuredAt'], 'sha256': after['sha256']},
              'memoryAvailable': delta(before, after, 'memory', 'available'),
              'memoryUsed': delta(before, after, 'memory', 'used'),
              'swapUsed': delta(before, after, 'swap', 'used'), 'diskUsed': delta(before, after, 'disk', 'used'),
              'aliases': {}, 'containers': {}}
    for alias in sorted(set(before['aliases']) | set(after['aliases'])):
        report['aliases'][alias] = {'rssBytes': delta(before, after, 'aliases', alias, 'rssBytes')}
    for name in sorted(set(before['containers']) | set(after['containers'])):
        old, new = before['containers'].get(name, {}), after['containers'].get(name, {})
        report['containers'][name] = {'presentBefore': old.get('present', False),
                                      'presentAfter': new.get('present', False),
                                      'memUsageBytes': delta(before, after, 'containers', name, 'memUsageBytes')}
    return report


mode, *rest = sys.argv[1:]
if mode == 'measure':
    print(json.dumps(measure(rest[0], rest[1:]), indent=1, sort_keys=True, ensure_ascii=False))
elif mode == 'verify':
    print(f"{rest[0]}: sha256 {load(rest[0])['sha256']} ok")
else:
    print(json.dumps(compare(rest[0], rest[1]), indent=1, sort_keys=True))
PY
)

dest='' label='medicion' out=''
specs=()
while (($#)); do
  case $1 in
    --verify) (($# == 2)) || usage; exec python3 -c "$PROGRAM" verify "$2" ;;
    --compare) (($# == 3)) || usage; exec python3 -c "$PROGRAM" compare "$2" "$3" ;;
    --ssh) (($# >= 2)) || usage; dest=$2; shift 2 ;;
    --label) (($# >= 2)) || usage; label=$2; shift 2 ;;
    --out) (($# >= 2)) || usage; out=$2; shift 2 ;;
    -h|--help) usage ;;
    *=*) specs+=("$1"); shift ;;
    *) usage ;;
  esac
done
((${#specs[@]})) || usage
[[ $label =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { printf 'invalid label: %s\n' "$label" >&2; exit 2; }

if [[ -n $dest ]]; then
  remote=$(printf '%q ' python3 - measure "$label" "${specs[@]}")
  receipt=$(ssh -o BatchMode=yes "$dest" "$remote" <<<"$PROGRAM")
else
  receipt=$(python3 -c "$PROGRAM" measure "$label" "${specs[@]}")
fi

if [[ -n $out ]]; then
  [[ ! -e $out ]] || { printf 'refusing to overwrite %s\n' "$out" >&2; exit 1; }
  printf '%s\n' "$receipt" >"$out"
  python3 -c "$PROGRAM" verify "$out"
else
  printf '%s\n' "$receipt"
fi
