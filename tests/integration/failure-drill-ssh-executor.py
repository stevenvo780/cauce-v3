from __future__ import annotations

import hashlib
import json
import os
import pathlib
import signal
import sys
import time


def running(pid: int, ticks: str) -> bool:
    try:
        fields = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return fields[0] != 'Z' and fields[19] == ticks
    except FileNotFoundError:
        return False


def pause(root: pathlib.Path, operation: str, stage: str) -> None:
    if (root / 'release').exists():
        return
    (root / 'pending.json').write_text(json.dumps({'pid': os.getpid(), 'operation': operation, 'stage': stage}))
    deadline = time.monotonic() + 15
    while not (root / 'release').exists():
        if time.monotonic() > deadline:
            raise RuntimeError('canary release barrier timed out')
        time.sleep(0.01)


policy = json.loads(pathlib.Path(sys.argv[2]).read_text())
packet = json.load(sys.stdin)
root = pathlib.Path(policy['root'])
assert root.name.startswith('zz-canary-')
assert packet['request']['target']['tenant_id'] == 'Steven'
assert packet['request']['target']['alias'] == 'zz_canary_ssh'
operation = packet['operation_id']
step = sys.argv[-1]
effect = root / f'{operation}.stop.json'

if step == 'stop':
    if policy['stage'] == 'before-effect':
        pause(root, operation, 'before-effect')
    if not effect.exists():
        assert running(policy['pid'], policy['ticks'])
        os.kill(policy['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 5
        while running(policy['pid'], policy['ticks']):
            assert time.monotonic() < deadline, 'canary process did not stop'
            time.sleep(0.01)
        with effect.open('x') as output:
            json.dump({'operation': operation, 'pid': policy['pid'], 'stopped': True}, output)
        with (root / 'effects.jsonl').open('a') as output:
            output.write(json.dumps({'operation': operation, 'pid': policy['pid']}) + '\n')
    assert not running(policy['pid'], policy['ticks'])
    if policy['stage'] == 'after-effect':
        pause(root, operation, 'after-effect')
    evidence = {'stopped_verified': True}
elif step == 'artifacts':
    assert effect.exists() and not running(policy['pid'], policy['ticks'])
    body = json.dumps(packet['snapshot'], sort_keys=True).encode()
    (root / 'snapshot.json').write_bytes(body)
    evidence = {'artifact_sha256': hashlib.sha256(body).hexdigest()}
else:
    raise RuntimeError(f'unsupported canary step {step}')

print(json.dumps({'evidence': evidence}))
