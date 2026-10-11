from __future__ import annotations

import pathlib


class SafeFailure(ValueError):
    pass


def path(value) -> pathlib.Path:
    if not isinstance(value, str) or not value.startswith('/') or str(pathlib.PurePosixPath(value)) != value \
            or '..' in pathlib.PurePosixPath(value).parts or any(ord(character) < 32 for character in value):
        raise SafeFailure('noncanonical policy path')
    return pathlib.Path(value)
