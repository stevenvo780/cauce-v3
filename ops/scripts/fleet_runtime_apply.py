"""Publish a verified applied generation under an external state lock."""
from __future__ import annotations

import fcntl
import os
import pathlib
import stat
from typing import Any

from atomic_file import atomic_write
from fleet_runtime_materialization import (
    DIGEST_PATTERN, EXPORTER, _destination, external_directory, load_applied_fleet, load_desired_fleet,
)


def publish_applied(state_directory: pathlib.Path, generation: str, expected_generation: str | None) -> dict[str, Any]:
    if not isinstance(generation, str) or DIGEST_PATTERN.fullmatch(generation) is None \
            or (expected_generation is not None and DIGEST_PATTERN.fullmatch(expected_generation) is None):
        raise ValueError("invalid fleet generation identity")
    state = external_directory(state_directory)
    state.mkdir(parents=True, exist_ok=True)
    destination = _destination(state, "applied-fleet.json")
    lock_path = _destination(state, ".fleet-apply.lock")
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.geteuid():
            raise ValueError("invalid fleet apply lock ownership")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        receipt = load_desired_fleet(state)
        if receipt["generation"] != generation:
            raise ValueError("desired fleet changed before application")
        current = load_applied_fleet(state)["generation"] if destination.exists() else None
        if current != expected_generation:
            if current == generation:
                return receipt
            raise ValueError("applied fleet generation changed")
        _destination(state, "applied-fleet.json")
        atomic_write(destination, EXPORTER.canonical_bytes(receipt))
        return receipt
    finally:
        os.close(descriptor)
