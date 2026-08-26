#!/usr/bin/env python3
from dlq_cli import guarded, reconcile_main

if __name__ == "__main__":
    raise SystemExit(guarded(reconcile_main))
