#!/usr/local/bin/python3
from __future__ import annotations

import hashlib
import codecs
import json
import os
import pathlib
import re
import select
import sys
import time
import tty
import uuid

IDENTITY = 'host-setup@example.test'
PLACEHOLDER = 'Ask owned provider...'


def answer_for(text: str) -> str:
    nonce = re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}', text)
    if nonce:
        return nonce.group()
    marker = re.search(r'FLEET-DEPLOY-DELIVERY-[a-f0-9-]+', text)
    correlation = re.search(r'"cauce_correlation_id"\s*:\s*"([a-f0-9]{64})"', text)
    if marker is None or correlation is None:
        raise ValueError('the owned delivery lacks its durable marker or correlation')
    return json.dumps({'reply': 'DELIVERED:' + marker.group(), 'messages': [], 'status': 'done',
                      'retryable': False, 'artifacts': [], 'cauce_correlation_id': correlation.group(1)})


if '--version' in sys.argv:
    print('codex-cli 0.144.6 controlled-lab')
    sys.exit(0)
if 'app-server' in sys.argv:
    for line in sys.stdin:
        packet = json.loads(line)
        if 'id' in packet:
            result = {'account': {'type': 'chatgpt', 'email': IDENTITY}} if packet['method'] == 'account/read' else {}
            print(json.dumps({'id': packet['id'], 'result': result}), flush=True)
    sys.exit(0)
if not sys.stdin.isatty():
    prompt = sys.stdin.read() if sys.argv[-1] == '-' else ' '.join(sys.argv[1:])
    native = str(uuid.uuid4())
    if 'resume' in sys.argv and '--json' in sys.argv:
        native = sys.argv[sys.argv.index('resume') + 2]
    print(json.dumps({'type': 'thread.started', 'thread_id': native}), flush=True)
    print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': answer_for(prompt)}}), flush=True)
    sys.exit(0)

native = sys.argv[sys.argv.index('resume') + 1] if 'resume' in sys.argv else str(uuid.uuid4())
uuid.UUID(native)
profile = pathlib.Path(os.environ['CODEX_HOME'])
sessions = profile / 'sessions'
sessions.mkdir(parents=True, exist_ok=True, mode=0o700)
transcript = sessions / ('rollout-owned-' + native + '.jsonl')
workspace = pathlib.Path.cwd()
control = workspace / '.h13-provider'
control.mkdir(exist_ok=True, mode=0o700)
state_file = control / 'state.json'
model = next((sys.argv[index + 1] for index, value in enumerate(sys.argv[:-1]) if value in ('--model', '-m')), None)
starttime = pathlib.Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
pending = ''
decoder = codecs.getincrementaldecoder('utf-8')('strict')
draft = ''
input_bytes = 0
submits = 0
turn_id = None


def append(kind: str, payload: dict) -> None:
    with transcript.open('a') as stream:
        stream.write(json.dumps({'type': kind, 'payload': payload}) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def record() -> None:
    context = workspace / 'h13-continuity.txt'
    value = {'pid': os.getpid(), 'starttime': starttime, 'nativeSessionId': native, 'turnId': turn_id,
             'inputBytes': input_bytes, 'submits': submits, 'draftLength': len(draft),
             'draftSha256': hashlib.sha256(draft.encode()).hexdigest(), 'model': model,
             'identitySha256': hashlib.sha256(IDENTITY.encode()).hexdigest(),
             'contextSha256': hashlib.sha256(context.read_bytes()).hexdigest() if context.is_file() else None}
    temporary = state_file.with_suffix('.tmp-' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(state_file)


def render() -> None:
    visible = draft.replace('\n', '\r\n  ')
    content = '\x1b[38;2;225;225;225m' + visible + '\x1b[0m' if draft else '\x1b[2m' + PLACEHOLDER + '\x1b[22m'
    sys.stdout.write('\x1b[2J\x1b[HOwned completed task.\r\n\r\n› ' + content)
    if not draft:
        sys.stdout.write('\x1b[3;3H')
    sys.stdout.flush()
    record()


def submit() -> None:
    global draft, submits, turn_id
    if not draft:
        return
    text = draft
    draft = ''
    submits += 1
    turn_id = str(uuid.uuid4())
    append('event_msg', {'type': 'task_started', 'turn_id': turn_id})
    append('response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}],
           'internal_chat_message_metadata_passthrough': {'turn_id': turn_id}})
    record()
    arm = control / 'hold-next-turn'
    if arm.exists() and 'CAUCE_BOOTSTRAP_' not in text:
        arm.unlink()
        sys.stdout.write('\x1b[2J\x1b[HWorking on owned task.\r\nesc to interrupt\r\n')
        sys.stdout.flush()
        release = control / ('release-' + turn_id)
        deadline = time.monotonic() + 420
        while not release.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError('the owned native turn was not released')
            if select.select([sys.stdin], [], [], 0.1)[0]:
                raise RuntimeError('the held native turn received unexpected terminal input')
        release.unlink()
    answer = answer_for(text)
    append('event_msg', {'type': 'task_complete', 'turn_id': turn_id, 'last_agent_message': answer})
    turn_id = None
    render()


if not transcript.exists():
    append('session_meta', {'id': native, 'source': 'cli', 'model': model})
tty.setraw(sys.stdin.fileno())
sys.stdout.write('\x1b[?2004h')
render()
while True:
    data = os.read(sys.stdin.fileno(), 65536)
    if not data:
        break
    input_bytes += len(data)
    pending += decoder.decode(data)
    if len(pending.encode()) + len(draft.encode()) > 1048576:
        raise ValueError('the owned compositor exceeded its input bound')
    while pending:
        if pending.startswith('\x1b[200~'):
            end = pending.find('\x1b[201~', 6)
            if end < 0:
                break
            draft += pending[6:end].replace('\r\n', '\n').replace('\r', '\n')
            pending = pending[end + 6:]
            render()
            continue
        if pending.startswith('\x1b') and len(pending) < 6:
            break
        character, pending = pending[0], pending[1:]
        if character in '\r\n':
            submit()
        elif character == '\x15':
            draft = ''
        elif character == '\x7f':
            draft = draft[:-1]
        elif character >= ' ':
            draft += character
        else:
            raise ValueError('the owned compositor received an unsupported control byte')
        render()
