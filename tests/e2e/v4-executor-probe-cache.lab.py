from __future__ import annotations

import copy
import datetime
import hashlib
import io
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import tarfile
import time

ROOT, WORK = (pathlib.Path(value) for value in sys.argv[1:3])
IMAGE_A, IMAGE_B, CASE = sys.argv[3:6]
OWNER = 'p1-sondas-1025'
HARNESSES = ('grok', 'muse', 'openclaw')
USER = pwd.getpwuid(os.geteuid()).pw_name
RECEIPT = {'passed': False, 'environment': 'docker-lab', 'case': CASE, 'calls': [], 'checks': {}}


def run(*argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{argv[0:3]}: {result.returncode}: {result.stderr[:4096]}')
    return result.stdout.strip()


def sha(filename):
    return hashlib.sha256(pathlib.Path(filename).read_bytes()).hexdigest()


def timestamp():
    return datetime.datetime.now(datetime.UTC).isoformat(timespec='microseconds')


def sources(directory):
    return {str(filename.relative_to(directory)): sha(filename) for filename in sorted(directory.rglob('*.py'))}


def snapshots():
    candidate = WORK / 'candidate/ops'
    for directory in ('cli', 'scripts', 'container-runtime'):
        for filename in (ROOT / 'ops' / directory).rglob('*.py'):
            destination = candidate / filename.relative_to(ROOT / 'ops')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(filename, destination)
    revision = run('git', '-C', str(ROOT), 'rev-parse', 'HEAD')
    archive = subprocess.run(['git', '-C', str(ROOT), 'archive', revision,
        'ops/cli', 'ops/scripts', 'ops/container-runtime'], capture_output=True, check=True, timeout=20).stdout
    baseline = WORK / 'baseline'
    baseline.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as content:
        content.extractall(baseline, filter='data')
    RECEIPT['baseline_revision'] = revision
    RECEIPT['baseline_source'] = 'git archive HEAD; cache removed before each baseline call'
    RECEIPT['candidate_source_sha256'] = sources(candidate)
    RECEIPT['baseline_source_sha256'] = sources(baseline / 'ops')
    return baseline / 'ops', candidate


def policy(image):
    roots = {key: str(WORK / key) for key in ('state', 'runtime', 'pki', 'tokens', 'identities')}
    for value in roots.values():
        pathlib.Path(value).mkdir(mode=0o700, exist_ok=True)
    certificate, key = WORK / 'ca.crt', WORK / 'ca.key'
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '10', '-keyout', str(key),
        '-out', str(certificate), '-subj', '/CN=zz-canary-probe-cache', '-addext', 'basicConstraints=critical,CA:TRUE')
    key.chmod(0o400)
    bundle = WORK / 'bundle'
    shutil.copytree(ROOT / 'packages/adapter-sdk/descriptors', bundle / 'packages/adapter-sdk/dist/descriptors')
    templates, placements = [], []
    for harness in HARNESSES:
        prefix = f'zz-canary-p1-sondas-1025-{harness}-'
        placements.append({'harness_id': harness, 'prefix': prefix, 'image': image, 'runtime_user': USER,
            'systemd_user': USER, 'home_directory': '/home/node', 'state_root': '/tmp/probe-state',
            'profile_root': '/tmp/probe-profiles', 'python': '/usr/bin/python3'})
        command = '/usr/local/bin/' + ('openclaw-cli' if harness == 'openclaw' else harness)
        row = {'provider': 'codex' if harness == 'openclaw' else harness, 'runtime_user': USER,
            'path_root': '/tmp/probe-profiles', 'command': command, 'command_sha256': sha(command)}
        if harness == 'openclaw':
            row['openclaw'] = {'provider_id': 'openai', 'method_id': 'device-code', 'version': '2026.7.1-2',
                'auth_list_source': '/usr/local/bin/auth-list.js', 'auth_list_sha256': sha('/usr/local/bin/auth-list.js'),
                'node_command': '/usr/local/bin/node-probe', 'node_command_sha256': sha('/usr/local/bin/node-probe'),
                'bridge': str(WORK / 'bridge.mjs'), 'bridge_sha256': sha(WORK / 'bridge.mjs')}
        else:
            arguments = ['login', '--device-auth'] if harness == 'grok' else ['login']
            row['login'] = {'method': 'device', 'command': [command, *arguments], 'sha256': sha(command)}
        if harness == 'muse':
            row['muse'] = {'bridge': '/usr/local/bin/muse-cauce', 'bridge_sha256': sha('/usr/local/bin/muse-cauce')}
        native = copy.deepcopy(row)
        native.update(runtime_mode='native', path_root=str(WORK / 'native-profiles'))
        templates.extend([native, {**row, 'runtime_mode': 'container', 'container_prefix': prefix}])
    return {'schemaVersion': 1, 'host_id': 'zz-canary-probes', 'executor_user': USER, 'roots': roots,
        'native': [{'runtime_user': USER, 'systemd_user': USER, 'home_directory': '/home/node',
            'state_root': str(WORK / 'native-state')}], 'containers': {}, 'profiles': {},
        'hooks': {key: {} for key in ('authenticate', 'profile', 'verify', 'revoke')},
        'bundles': {harness: {'directory': str(bundle)} for harness in HARNESSES},
        'container_templates': placements, 'profile_templates': templates,
        'signer': {'certificate': str(certificate), 'key': str(key)},
        'transport': {'bootstrap_url': 'https://bootstrap.example.invalid', 'gateway_url': 'https://gateway.example.invalid',
            'ca_certificate': str(certificate), 'network': 'none'}}


def events(start, end):
    output = run('docker', 'events', '--since', start, '--until', end, '--filter', 'type=container',
        '--filter', 'label=cauce.e2e.case=' + CASE, '--format', '{{json .}}')
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def native_lines():
    filename = WORK / 'native-invocations.jsonl'
    return len(filename.read_text().splitlines()) if filename.exists() else 0


def summarize(name, start, end, elapsed, before, after, documents):
    observed = events(start, end)
    counts, durations, started = {}, {}, {}
    for event in observed:
        attributes = event.get('Actor', {}).get('Attributes', {})
        container = attributes.get('name', '')
        harness = next((value for value in HARNESSES if container.startswith(f'cauce-{value}-probe-')), None)
        if harness is None:
            continue
        action = event.get('Action', event.get('status'))
        counts.setdefault(harness, {'create': 0, 'start': 0, 'die': 0})
        if action in counts[harness]:
            counts[harness][action] += 1
        if action == 'start':
            started[event['id']] = event['timeNano']
        if action == 'die' and event['id'] in started:
            durations.setdefault(harness, []).append((event['timeNano'] - started[event['id']]) / 1e9)
    entry = {'phase': name, 'elapsed_seconds': elapsed, 'container_events': counts, 'probe_seconds': durations,
        'native_processes': after - before, 'capabilities': documents, 'events': observed}
    RECEIPT['calls'].append(entry)
    print(json.dumps({key: value for key, value in entry.items() if key not in ('capabilities', 'events')}), flush=True)
    return entry


def capabilities(name, source, document, concurrent=False):
    filename = WORK / 'policy.json'
    filename.write_text(json.dumps(document))
    filename.chmod(0o600)
    argv = [sys.executable, '-B', str(source / 'cli/fleet-executor.py'), '--policy', str(filename), '--capabilities']
    start, clock, before = timestamp(), time.monotonic(), native_lines()
    processes = [subprocess.Popen(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                 for _ in range(2 if concurrent else 1)]
    documents = []
    for process in processes:
        output, error = process.communicate(timeout=100)
        if process.returncode:
            diagnostic = subprocess.run([sys.executable, '-B', '-c',
                'import pathlib,runpy,sys; p=pathlib.Path(sys.argv.pop(1));sys.path.insert(0,str(p.parent));'
                'module=runpy.run_path(str(p));module["main"]()', str(source / 'cli/fleet-executor.py'),
                '--policy', str(filename), '--capabilities'], capture_output=True, text=True, timeout=100)
            error += diagnostic.stderr
            raise RuntimeError(f'{name}: executor exit={process.returncode}: {error}')
        documents.append(json.loads(output))
    return summarize(name, start, timestamp(), time.monotonic() - clock, before, native_lines(), documents)


def verify(entry, containers, native):
    expected = {harness: {'create': containers, 'start': containers, 'die': containers} for harness in HARNESSES}
    actual = {harness: entry['container_events'].get(harness, {'create': 0, 'start': 0, 'die': 0}) for harness in HARNESSES}
    assert actual == expected, (entry['phase'], actual, expected)
    assert entry['native_processes'] == native, (entry['phase'], entry['native_processes'], native)


def main():
    digest_a = run('docker', 'image', 'inspect', IMAGE_A, '--format', '{{.Id}}')
    digest_b = run('docker', 'image', 'inspect', IMAGE_B, '--format', '{{.Id}}')
    assert digest_a != digest_b
    document = policy(digest_a)
    RECEIPT['images'] = [digest_a, digest_b]
    source, candidate = snapshots()
    for harness in HARNESSES:
        for mode in ('native', 'container'):
            isolated = copy.deepcopy(document)
            isolated['bundles'] = {harness: document['bundles'][harness]}
            isolated['native'] = document['native'] if mode == 'native' else []
            isolated['container_templates'] = [row for row in document['container_templates']
                if row['harness_id'] == harness] if mode == 'container' else []
            shutil.rmtree(WORK / 'state/provider-probes', ignore_errors=True)
            entry = capabilities(f'baseline-isolated-{harness}-{mode}', source, isolated)
            assert len(entry['capabilities'][0]['placements'][0]['runtimes']) == 1
            assert entry['native_processes'] == (1 if mode == 'native' else 0)
            assert sum(row['create'] for row in entry['container_events'].values()) == (1 if mode == 'container' else 0)
    baseline = []
    for index in range(2):
        shutil.rmtree(WORK / 'state/provider-probes', ignore_errors=True)
        baseline.append(capabilities(f'baseline-{index + 1}', source, document))
        verify(baseline[-1], 1, 3)
    canonical = baseline[0]['capabilities'][0]
    assert canonical == baseline[1]['capabilities'][0]
    assert canonical['available'] is True
    runtimes = canonical['placements'][0]['runtimes']
    assert {(row['harness_id'], row['mode']) for row in runtimes} == {
        (harness, mode) for harness in HARNESSES for mode in ('native', 'container')}
    shutil.rmtree(WORK / 'state/provider-probes', ignore_errors=True)
    first = capabilities('cached-first', candidate, document)
    second = capabilities('cached-second-independent-process', candidate, document)
    verify(first, 1, 3)
    verify(second, 0, 0)
    for entry in (first, second):
        assert entry['capabilities'][0] == canonical, entry['phase']
    for placement in document['container_templates']:
        placement['image'] = digest_b
    changed = capabilities('changed-image-digest', candidate, document)
    verify(changed, 1, 0)
    assert changed['capabilities'][0] == canonical
    shutil.rmtree(WORK / 'state/provider-probes')
    concurrent = capabilities('concurrent-cold-independent-processes', candidate, document, concurrent=True)
    verify(concurrent, 1, 3)
    assert all(value == canonical for value in concurrent['capabilities'])
    directory = WORK / 'state/provider-probes'
    assert directory.stat().st_mode & 0o777 == 0o700
    files = list(directory.iterdir())
    assert files and all(value.stat().st_mode & 0o777 == 0o600 for value in files)
    RECEIPT['checks'] = {'same_capabilities': True, 'six_runtime_modes': True, 'cross_process_reuse': True,
        'image_digest_invalidation': True, 'concurrent_single_probe': True, 'private_modes': True}
    RECEIPT['passed'] = True


try:
    main()
except Exception as error:
    RECEIPT['error'] = str(error)
    raise
finally:
    for identifier in run('docker', 'ps', '-aq', '--filter', 'label=cauce.e2e.case=' + CASE).splitlines():
        container_name = run('docker', 'inspect', '--format', '{{.Name}}', identifier).lstrip('/')
        if container_name != CASE:
            run('docker', 'rm', '-f', identifier)
    RECEIPT['remaining_probe_containers'] = [name for name in run('docker', 'ps', '-a', '--filter',
        'label=cauce.e2e.case=' + CASE, '--format', '{{.Names}}').splitlines() if name != CASE]
    (WORK / 'receipt.json').write_text(json.dumps(RECEIPT, indent=2) + '\n')
