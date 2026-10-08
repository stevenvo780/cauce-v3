#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import select
import sys
import time

from provider_login_native import cleanup_native, run_native
from provider_login_state import LoginFailure, operation, private_state, read_metadata, validate_plan


def first_plan() -> dict:
    body = bytearray()
    deadline = time.monotonic() + 15
    while len(body) <= 65536 and time.monotonic() < deadline:
        if not select.select([0], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        value = os.read(0, 1)
        if value == b'\n':
            return json.loads(body)
        if not value:
            break
        body.extend(value)
    raise LoginFailure('missing bounded trusted login plan')


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == '--cleanup':
        identity, state = operation(sys.argv[2]), sys.argv[3]
        root = private_state(state)
        try:
            saved = read_metadata(root, identity)
        finally:
            os.close(root)
        if saved is not None and saved.get('backend') == 'container':
            from provider_login_container import cleanup_container
            proof = cleanup_container(identity, state)
        else:
            proof = cleanup_native(identity, state)
        print(json.dumps(proof, separators=(',', ':')))
        return 0
    if sys.argv[1:] not in ([], ['--container-child']):
        raise LoginFailure('unsupported login helper action')
    child = sys.argv[1:] == ['--container-child']
    plan = validate_plan(first_plan(), child=child)
    if plan['backend'] == 'container':
        from provider_login_container import run_container
        return run_container(plan)
    return run_native(plan, child=child)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('provider login failed: bounded session was not verified', file=sys.stderr)
        raise SystemExit(2) from None
