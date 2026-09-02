#!/usr/bin/env python3
"""Bounded rendering of jsonschema failures, shared by every schema consumer."""
from __future__ import annotations

import re
from typing import Any

SCHEMA_PATH_SEGMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
SCHEMA_KEYWORD_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$")
SCHEMA_SENSITIVE_PATH_RE = re.compile(
    r"^(?:sha(?:1|256|512):)?[0-9a-f]{32,128}$"
    r"|^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def safe_schema_diagnostic(error: Any) -> str:
    """Describe a jsonschema failure without rendering its instance or rule value.

    Default jsonschema rendering includes the rejected instance and, for rules such as
    ``const`` or ``enum``, the schema value. Both may contain identifiers or digests from
    operational evidence. Keep diagnostics to a bounded instance path and the validator
    keyword; unexpected or value-shaped mapping keys are intentionally collapsed.
    """
    parts: list[str] = []
    for part in error.absolute_path:
        if isinstance(part, int) and part >= 0:
            parts.append(str(part))
        elif (isinstance(part, str) and SCHEMA_PATH_SEGMENT_RE.fullmatch(part)
              and not SCHEMA_SENSITIVE_PATH_RE.fullmatch(part)):
            parts.append(part)
        else:
            parts.append("<key>")
    location = ".".join(parts) or "<root>"
    validator = getattr(error, "validator", None)
    keyword = validator if isinstance(validator, str) and SCHEMA_KEYWORD_RE.fullmatch(validator) \
        else "unknown"
    return f"{location}: schema rule {keyword}"


def schema_error_sort_key(error: Any) -> tuple[str, ...]:
    """Give jsonschema failures a stable order without inspecting instance values."""
    return tuple(str(part) for part in error.absolute_path)
