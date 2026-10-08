"""Select verified applied inventory independently from installed runtime code."""

from __future__ import annotations

import os
import pathlib
from typing import Any


def inventory_root(root: pathlib.Path) -> pathlib.Path:
    configured = os.environ.get("CAUCE_FLEET_RUNTIME_STATE")
    if configured is None:
        return root
    if not configured:
        raise ValueError("CAUCE_FLEET_RUNTIME_STATE must name an absolute external directory")
    from fleet_runtime_materialization import load_applied_fleet

    state = pathlib.Path(configured)
    receipt = load_applied_fleet(state)
    return state.resolve() / "generations" / receipt["generation"]


def resolve_runtime_key(selector: str, aliases: dict[str, dict[str, Any]]) -> str:
    if selector in aliases:
        return selector
    if "/" in selector:
        tenant, logical = selector.split("/", 1)
        matches = [key for key, entry in aliases.items()
                   if entry["tenant"] == tenant and entry.get("alias", key) == logical]
    else:
        matches = [key for key, entry in aliases.items() if entry.get("alias", key) == selector]
    if len(matches) > 1:
        raise ValueError(f"ambiguous wire alias; select TENANT/ALIAS: {selector}")
    if not matches:
        raise ValueError(f"runtime identity is not declared: {selector}")
    return matches[0]
