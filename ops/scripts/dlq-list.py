#!/usr/bin/env python3
from dlq_cli import guarded, list_main

if __name__ == "__main__":
    raise SystemExit(guarded(list_main))
