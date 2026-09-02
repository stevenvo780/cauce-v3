#!/usr/bin/env python3
"""Existing-`--output` merge / fail-closed helpers for generate-telegram-config.py.

Split into its own module to keep both files under the repo's per-file size gate. Not a
standalone entry point; not meant to be imported anywhere but from that generator.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

# Must match PLACEHOLDER_USER_ID/PLACEHOLDER_CHAT_ID in generate-telegram-config.py (duplicated,
# not imported: that module's hyphenated filename cannot be `import`ed from here).
PLACEHOLDER_USER_ID = "999999999999999999"
PLACEHOLDER_CHAT_ID = "-999999999999999999"


class MergeError(ValueError):
    """Raised for any existing-`--output` content this module refuses to merge over."""


def read_existing_destination(path: pathlib.Path) -> Any | None:
    # A file that exists but fails to parse is NOT treated as absent: a write must not proceed
    # over content this tool cannot reason about.
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MergeError(f"cannot read existing {path} to merge/validate safely: {exc}") from exc


def existing_rows_by_alias(document: Any, destination: pathlib.Path) -> dict[str, dict[str, Any]]:
    if not isinstance(document, dict) or not isinstance(document.get("aliases"), list):
        raise MergeError(f"{destination} is not a valid telegram bridge config (no 'aliases' array)")
    indexed: dict[str, dict[str, Any]] = {}
    for row in document["aliases"]:
        if not isinstance(row, dict) or not isinstance(row.get("alias"), str) or row["alias"] in indexed:
            raise MergeError(f"{destination} has a malformed or duplicate alias entry")
        indexed[row["alias"]] = row
    return indexed


def existing_rows_for(path: pathlib.Path | None) -> dict[str, dict[str, Any]]:
    """{} when --output is unset or doesn't exist yet; its indexed rows otherwise."""
    document = read_existing_destination(path) if path is not None else None
    return existing_rows_by_alias(document, path) if document is not None else {}


def check_no_sentinel_regression(
    existing_by_alias: dict[str, dict[str, Any]],
    new_rows: list[dict[str, Any]],
    destination: pathlib.Path,
    allow_placeholders: bool,
) -> None:
    # Dataloss gap G2/G3: fail closed instead of burying a real allowlist under the sentinel.
    # --allow-placeholders is the one named override; everything else fails before a byte is
    # written, whether or not --aliases narrowed this run to fewer than the whole fleet.
    if allow_placeholders:
        return
    fields = (("allowed_user_ids", PLACEHOLDER_USER_ID), ("allowed_chat_ids", PLACEHOLDER_CHAT_ID))
    for row in new_rows:
        existing = existing_by_alias.get(row["alias"]) or {}
        for field, sentinel in fields:
            was_real = isinstance(existing.get(field), list) and existing[field] not in ([], [sentinel])
            if was_real and row.get(field) == [sentinel]:
                raise MergeError(
                    f"refusing to overwrite real {field} for alias {row['alias']!r} at {destination} "
                    "with the sentinel; supply real ids or pass --allow-placeholders"
                )


def merge_into_existing(
    existing_by_alias: dict[str, dict[str, Any]], new_rows: list[dict[str, Any]], selected: set[str]
) -> dict[str, Any]:
    # Fuse new_rows (built for `selected`) into what's already there: an alias NOT in `selected`
    # is copied verbatim (its chats/bot_username survive); one IN `selected` comes only from
    # new_rows, kept in the existing position — a newly-added alias is appended, sorted.
    new_by_alias = {row["alias"]: row for row in new_rows}
    merged = [new_by_alias[alias] if alias in selected else row for alias, row in existing_by_alias.items()]
    merged += [new_by_alias[alias] for alias in sorted(selected - set(existing_by_alias))]
    return {"aliases": merged}


def build_and_merge(
    fleet: dict[str, dict[str, str]],
    selected: list[str] | None,
    options: dict[str, Any],
    allowlist: dict[str, Any],
    output: pathlib.Path | None,
    reuse: bool,
    allow_placeholders: bool,
    build_config: Any,
    validate_config: Any,
) -> dict[str, Any]:
    """The whole existing-`--output` story for main(): resolve, build, check, merge, validate."""
    existing_by_alias = existing_rows_for(output)
    if selected is not None and reuse:
        seed_from_existing(allowlist, existing_by_alias, selected)
    config = build_config(fleet, selected, options)
    if existing_by_alias:
        check_no_sentinel_regression(existing_by_alias, config["aliases"], output, allow_placeholders)
        if selected is not None:
            config = merge_into_existing(existing_by_alias, config["aliases"], set(selected))
    return validate_config(config)


def seed_from_existing(
    allowlist: dict[str, Any], existing_by_alias: dict[str, dict[str, Any]], selected: list[str]
) -> None:
    # --reuse-existing-allowlist: default a selected alias's allowlist to its own already-real
    # ids at --output, instead of the sentinel, when nothing else supplied one explicitly.
    for alias in selected:
        row = existing_by_alias.get(alias)
        if alias in allowlist["aliases"] or row is None:
            continue
        user_ids, chat_ids = row.get("allowed_user_ids"), row.get("allowed_chat_ids")
        if user_ids in (None, [PLACEHOLDER_USER_ID]) or chat_ids in (None, [PLACEHOLDER_CHAT_ID]):
            continue
        allowlist["aliases"][alias] = {"user_ids": user_ids, "chat_ids": chat_ids}
