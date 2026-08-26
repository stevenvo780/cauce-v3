#!/usr/bin/env python3
from dlq_cli import guarded, private_request_main

if __name__ == "__main__":
    raise SystemExit(guarded(lambda: private_request_main("telegram-manual-replay")))
