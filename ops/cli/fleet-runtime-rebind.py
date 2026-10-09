#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import json
import pathlib
import sys

from fleet_executor_container import RELEASE_ROOT
from fleet_executor_policy import SafeFailure, load_policy, path
from fleet_executor_rebind import RELEASE, installed_release, rebind_all
from fleet_executor_steps import executor_lock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from update_alias_lib import SafeArgumentParser


def main() -> int:
    parser = SafeArgumentParser(description='Recreate owned fleet containers bound to another installed release')
    parser.add_argument('--policy', type=pathlib.Path, required=True)
    parser.add_argument('--release-root', default=str(RELEASE_ROOT))
    parser.add_argument('--include-running', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    policy = load_policy(args.policy)
    release = path(args.release_root)
    if RELEASE.fullmatch(RELEASE_ROOT.name) is None or release.parent != RELEASE_ROOT.parent:
        raise SafeFailure('target is not a sibling installed release')
    installed_release(release)
    with contextlib.nullcontext() if args.dry_run else executor_lock(policy):
        receipt = rebind_all(policy, release, include_running=args.include_running, dry_run=args.dry_run)
    print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SafeFailure as error:
        print('fleet container rebind failed: ' + str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        print('fleet container rebind failed: unverified operational effect', file=sys.stderr)
        raise SystemExit(2) from None
