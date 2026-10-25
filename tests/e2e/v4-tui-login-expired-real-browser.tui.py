#!/usr/bin/python3
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import select
import sys
import tty
import uuid

profile = pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])
directory = profile / 'projects' / os.getcwd().rstrip('/').replace('/', '-')
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
native = str(uuid.uuid4())
transcript = directory / (native + '.jsonl')
(profile / 'double-process.json').write_text(json.dumps({'pid': os.getpid(), 'native_id': native, 'double': True}))
tty.setraw(sys.stdin.fileno())
sys.stdout.write('\x1b[?2004h')
sys.stdout.flush()
mode = ''
pending = ''
pasting = False


def append(path: pathlib.Path, value: dict) -> None:
    with path.open('a') as stream:
        stream.write(json.dumps(value) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


while True:
    current = (profile / 'double-mode').read_text().strip()
    if current != mode:
        mode = current
        frame = ('Login expired · Please run /login\r\nPaste code here if prompted >\r\n'
                 if mode == 'expired' else 'CLAUDE_CANARY_READY\r\n❯ ')
        sys.stdout.write('\x1b[2J\x1b[H' + frame)
        sys.stdout.flush()
    if not select.select([sys.stdin], [], [], 0.1)[0]:
        continue
    chunk = os.read(sys.stdin.fileno(), 65536).decode(errors='replace')
    if not chunk:
        break
    append(profile / 'double-input.jsonl', {'mode': mode, 'bytes': len(chunk.encode()), 'sha256': hashlib.sha256(chunk.encode()).hexdigest()})
    pending += chunk
    if '\x1b[200~' in pending:
        pasting = True
    if '\x1b[201~' in pending:
        pasting = False
    if pasting or not pending.endswith(('\r', '\n')):
        continue
    raw = pending[:-1].replace('\x1b[200~', '').replace('\x1b[201~', '')
    text = raw.replace('\r\n', '\n').replace('\r', '\n')
    append(profile / 'double-normalization.jsonl', {
        'raw_sha256': hashlib.sha256(raw.encode()).hexdigest(),
        'normalized_sha256': hashlib.sha256(text.encode()).hexdigest(),
        'raw_cr': raw.count('\r'), 'normalized_cr': text.count('\r'), 'normalized_lf': text.count('\n'),
    })
    pending = ''
    if mode == 'expired':
        continue
    user = str(uuid.uuid4())
    append(transcript, {'type': 'user', 'uuid': user, 'sessionId': native,
                        'message': {'role': 'user', 'content': text}})
    hold = re.search(r'H8C_WAIT_[a-f0-9-]+', text)
    held = profile / 'double-hold-ready'
    if hold and (not held.exists() or held.read_text() != hold.group(0)):
        held.write_text(hold.group(0))
        held.chmod(0o600)
        sys.stdout.write('\x1b[2J\x1b[HCLAUDE_CANARY_BUSY\r\nEsc to interrupt\r\n')
        sys.stdout.flush()
        continue
    marker = re.search(r'H8C_OK_[a-f0-9-]+', text) or hold
    correlation = re.search(r'"cauce_correlation_id"\s*:\s*"([a-f0-9]{64})"', text)
    answer = {'reply': 'H8C_HEALTHY_REPLY:' + (marker.group(0) if marker else 'RECOVERED_FIRST_MESSAGE'),
              'messages': [], 'status': 'done', 'retryable': False, 'artifacts': []}
    if correlation:
        answer['cauce_correlation_id'] = correlation.group(1)
    reply = json.dumps(answer)
    append(transcript, {'type': 'assistant', 'uuid': str(uuid.uuid4()), 'parentUuid': user, 'sessionId': native,
                        'message': {'role': 'assistant', 'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': reply}]}})
    sys.stdout.write('\r\n' + reply + '\r\n❯ ')
    sys.stdout.flush()
