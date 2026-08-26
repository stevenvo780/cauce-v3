#!/usr/bin/env python3
from dlq_cli import guarded, private_replay_inspect_main

if __name__ == "__main__":
    raise SystemExit(guarded(private_replay_inspect_main))
