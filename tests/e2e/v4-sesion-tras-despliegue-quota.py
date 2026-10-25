#!/usr/local/bin/python3
from __future__ import annotations

import json
import pathlib
import sys

if len(sys.argv) != 2 or not pathlib.Path(sys.argv[1]).is_dir():
    raise ValueError('the owned quota reader requires the canonical existing profile directory')
print(json.dumps({'ok': True, 'provider': 'codex', 'extra': {'account_id': 'host-setup@example.test'},
                  'windows': [{'key': '5h', 'remainingPercent': 75, 'windowMinutes': 300}]}))
