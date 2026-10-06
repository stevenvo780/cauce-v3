from __future__ import annotations

import os
import re

INSTALLATION_ID = re.compile(r'[a-z][a-z0-9-]{0,47}\Z')


def validate_installation_id(value: str | None) -> str | None:
    if value is not None and (not isinstance(value, str) or INSTALLATION_ID.fullmatch(value) is None):
        raise ValueError('invalid installation identifier')
    return value


def unit_prefix(installation: str | None = None) -> str:
    value = validate_installation_id(installation)
    return f'cauce-{value}' if value is not None else 'cauce-v3'


def environment_prefix() -> str:
    return unit_prefix(os.environ.get('CAUCE_INSTALLATION_ID'))


def validate_unit_path(value: str, *, specifier: bool = False) -> str:
    pattern = r"(?:/|%h/|%t/)[A-Za-z0-9._/-]+" if specifier else r"/[A-Za-z0-9._/-]+"
    if not re.fullmatch(pattern, value) or ".." in value.split("/"):
        raise ValueError("unit path must be canonical, absolute and free of systemd metacharacters")
    return value
