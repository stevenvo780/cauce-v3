#!/usr/bin/env python3
"""Deterministic production config generator for the Telegram bridge (gap G2).

Historically only a test fixture (ops/harness/authentic-fixture-init.mjs) wrote a
Telegram bridge config, and only for a single alias. This tool productionises that
gap: it emits a JSON document that validates EXACTLY against the schema enforced by
`parseTelegramBridgeConfig` in services/telegram-bridge/src/config.ts, built from the
fleet source of truth (ops/container-aliases.json, cross-checked against
ops/manifests/*.yaml).

Mapping (per alias):
  alias                   <- fleet alias key
  tenant_id               <- fleet tenant   (container-aliases.json / manifest spec.tenant)
  room_id                 <- fleet room     (container-aliases.json / manifest spec.room)
  token_file              <- PLACEHOLDER  {runtime-dir}/{alias}.token   (container-internal path)
  v2_shutdown_marker_file <- PLACEHOLDER  {runtime-dir}/{alias}.disabled (container-internal path)
  bot_username            <- --groups-file (omitted when unknown)
  allowed_user_ids        <- --allowlist-file / --allow-user-id, else a sentinel placeholder
  allowed_chat_ids        <- --allowlist-file / --allow-chat-id, else a sentinel placeholder
  chats                   <- --groups-file (KEY OMITTED unless the alias appears there)
  recipients              <- exactly the alias itself
  poll_timeout_seconds    <- --poll-timeout-seconds (default 25)
  poll_lease_ms           <- --poll-lease-ms (default 60000)

GROUP ROUTING (gap G4): a bot only knows whether a group message is meant for it if
the config says who serves that chat. `chats[]` carries that, and `bot_username`
carries the handle each bot answers to. Both are emitted ONLY from --groups-file.

The `chats` key is omitted entirely for any alias absent from that file, and the
omission is load-bearing, not cosmetic: the bridge reads an ABSENT `chats` as "this
alias never opted into group routing" and keeps the pre-routing behaviour for every
chat in allowed_chat_ids. An alias with `"chats": []` has explicitly opted into
default-deny and goes mute in every group. So regenerating without --groups-file is
safe (it restores legacy routing) while emitting an empty list would silence the
fleet — which is exactly the failure this generator must be incapable of producing.

RUNTIME PATHS (gap G1): deploy/compose.yaml bind-mounts CAUCE_TELEGRAM_RUNTIME_DIR
(host) onto /run/cauce-telegram (container, read-only) and reads config.json from
/run/cauce-telegram/config.json. token_file and v2_shutdown_marker_file MUST live
under that same mount or the container cannot read them, so token_file/marker default
to /run/cauce-telegram/<alias>.{token,disabled}. Override with --runtime-dir (or the
finer --token-dir/--marker-dir) only if you also mount those directories.

RECIPIENTS (gap G2): a human DMs the <alias> bot expecting <alias> to answer, so the
only supported policy routes each alias's ingress to its own harness. Delegation and
fan-out happen afterward through durable Cauce V3 `messages`, where completion can be
correlated before one final Telegram response. Legacy room/peers ingress fan-out is
rejected because it cannot provide one deterministic activity/result state.

ALLOWLISTS (gap G3): the schema's `idList` REQUIRES a non-empty array, so a literally
empty allowlist cannot validate. With no operational IDs supplied the allowlists
default to a single, clearly fake sentinel that is IDENTICAL across every alias (a
real fleet never shares user or chat IDs, so the repetition is an unmistakable
"replace me" marker). A bridge configured with the sentinel silently DENIES all real
traffic, so telegram-cutover-preflight.py fails closed on it. Inject the real IDs with
--allowlist-file (per alias/tenant) or --allow-user-id/--allow-chat-id (global).

SAFETY: this generator never emits secrets. token_file/v2_shutdown_marker_file are
container-internal path PLACEHOLDERS (no token material); the bridge reads the actual
token only from token_file at runtime (regular file, 0600, owned by the service user).
Telegram user/chat IDs are operational identifiers, not credentials; --allowlist-file
carries IDs only and rejects any inline token key.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import pathlib
import re
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telegram_config_merge as merge_lib  # noqa: E402
from atomic_file import atomic_write as _atomic_write  # noqa: E402
from fleet_derive import load_fleet_assignments  # noqa: E402  same-directory ops library (stdlib-only)

_LIB_RUTA = pathlib.Path(__file__).resolve().parent / "generate-telegram-config-lib.py"
_LIB_SPEC = importlib.util.spec_from_file_location("generate_telegram_config_lib", _LIB_RUTA)
if _LIB_SPEC is None or _LIB_SPEC.loader is None:
    raise ImportError(f"no se pudo cargar la libreria hermana: {_LIB_RUTA}")
_LIB = importlib.util.module_from_spec(_LIB_SPEC)
_LIB_SPEC.loader.exec_module(_LIB)

ALIAS_RE = _LIB.ALIAS_RE
TENANT_RE = _LIB.TENANT_RE
ROOM_RE = _LIB.ROOM_RE
ID_RE = _LIB.ID_RE
NON_WHITESPACE_RE = _LIB.NON_WHITESPACE_RE
USERNAME_RE = _LIB.USERNAME_RE
GROUP_CHAT_ID_RE = _LIB.GROUP_CHAT_ID_RE
THREAD_ID_RE = _LIB.THREAD_ID_RE
CHAT_MODES = _LIB.CHAT_MODES
SESSION_SCOPES = _LIB.SESSION_SCOPES
MAX_CHATS = _LIB.MAX_CHATS
MAX_THREADS = _LIB.MAX_THREADS
CHAT_FIELD_ORDER = _LIB.CHAT_FIELD_ORDER
THREAD_FIELD_ORDER = _LIB.THREAD_FIELD_ORDER
GeneratorError = _LIB.GeneratorError
_check_text = _LIB._check_text
_check_absolute = _LIB._check_absolute
_check_id_list = _LIB._check_id_list
_check_int = _LIB._check_int
_check_bool = _LIB._check_bool
_check_enum = _LIB._check_enum
_check_default_alias = _LIB._check_default_alias
_check_narrowed_user_ids = _LIB._check_narrowed_user_ids
_validate_thread_policy = _LIB._validate_thread_policy
_validate_chat_policy = _LIB._validate_chat_policy
_effective_chat_policy = _LIB._effective_chat_policy
_declared_scopes = _LIB._declared_scopes
_check_single_ambient_host = _LIB._check_single_ambient_host
_check_fleet_usernames = _LIB._check_fleet_usernames
validate_config = _LIB.validate_config


# Placeholder allowlist sentinels — NOT secrets and NOT real Telegram IDs. They are
# identical across every alias on purpose, so they read as obvious placeholders and so
# telegram-cutover-preflight.py can fail closed before a sentinel-guarded alias is
# enabled (a sentinel allowlist silently denies all real traffic).
PLACEHOLDER_USER_ID = "999999999999999999"
PLACEHOLDER_CHAT_ID = "-999999999999999999"

# Container-internal placeholder path that matches the compose mount + config location
# (deploy/compose.yaml: CAUCE_TELEGRAM_RUNTIME_DIR -> /run/cauce-telegram, read-only).
DEFAULT_RUNTIME_DIR = "/run/cauce-telegram"
DEFAULT_POLL_TIMEOUT_SECONDS = 25
DEFAULT_POLL_LEASE_MS = 60_000
DEFAULT_RECIPIENTS_POLICY = "self"
RECIPIENTS_POLICIES = ("self",)

# Deterministic key order for each emitted alias object. `bot_username` and `chats`
# are OPTIONAL: they appear only when --groups-file supplies them (see GROUP ROUTING).
ALIAS_FIELD_ORDER = (
    "alias",
    "tenant_id",
    "room_id",
    "token_file",
    "v2_shutdown_marker_file",
    "bot_username",
    "allowed_user_ids",
    "allowed_chat_ids",
    "chats",
    "recipients",
    "poll_timeout_seconds",
    "poll_lease_ms",
)
OPTIONAL_ALIAS_FIELDS = ("bot_username", "chats")


# --------------------------------------------------------------------------- sources
def load_fleet(ops_dir: pathlib.Path, cross_check: bool = True) -> dict[str, dict[str, str]]:
    """Return {alias: {'tenant','room','harness'}} for the fleet.

    flota.json is the primary source (stdlib-only, carries tenant/room/
    harness). When cross_check is on, ops/manifests/*.yaml must agree exactly.
    """
    aliases = load_fleet_assignments(ops_dir)  # validates the fleet mapping
    fleet = {
        alias: {"tenant": entry["tenant"], "room": entry["room"], "harness": entry["harness"]}
        for alias, entry in aliases.items()
    }
    if cross_check:
        _cross_check_manifests(ops_dir, fleet)
    return fleet


def _cross_check_manifests(ops_dir: pathlib.Path, fleet: dict[str, dict[str, str]]) -> None:
    try:
        import manifest_lib  # lazy: pulls PyYAML + jsonschema, not needed without cross-check
    except Exception as exc:  # noqa: BLE001 - surface a clear, actionable message
        raise GeneratorError(
            f"manifest cross-check requires ops manifest tooling ({exc}); pass --no-cross-check to skip"
        ) from exc
    manifest_fleet: dict[str, dict[str, str]] = {}
    for document in manifest_lib.load_manifests(ops_dir):  # validates the fleet mapping
        spec = document["spec"]
        manifest_fleet[spec["alias"]] = {
            "tenant": spec["tenant"],
            "room": spec["room"],
            "harness": spec["harness"],
        }
    if manifest_fleet != fleet:
        raise GeneratorError("flota.json and ops/manifests/*.yaml disagree on the fleet")


# -------------------------------------------------------------------------- allowlists
def _check_ids(value: Any, label: str) -> list[str]:
    """Validate a Telegram id list against config.ts idList (non-empty, shaped, unique)."""
    if not isinstance(value, list) or not (1 <= len(value) <= 10_000):
        raise GeneratorError(f"{label} must be a non-empty array of Telegram ids")
    ids: list[str] = []
    for entry in value:
        if not isinstance(entry, str) or not (1 <= len(entry) <= 20) or not ID_RE.fullmatch(entry):
            raise GeneratorError(f"{label} has an invalid Telegram id: {entry!r}")
        ids.append(entry)
    if len(set(ids)) != len(ids):
        raise GeneratorError(f"{label} contains duplicate ids")
    return ids


def _check_allowlist_entry(entry: Any, label: str) -> dict[str, list[str]]:
    if not isinstance(entry, dict):
        raise GeneratorError(f"{label} must be an object with user_ids/chat_ids")
    if "token" in entry or "bot_token" in entry:
        raise GeneratorError(f"{label} must not carry token material (ids only)")
    unknown = set(entry) - {"user_ids", "chat_ids"}
    if unknown:
        raise GeneratorError(f"{label} has unexpected keys: {sorted(unknown)}")
    return {
        "user_ids": _check_ids(entry.get("user_ids"), f"{label}.user_ids"),
        "chat_ids": _check_ids(entry.get("chat_ids"), f"{label}.chat_ids"),
    }


def load_allowlist_file(path: pathlib.Path) -> dict[str, dict[str, dict[str, list[str]]]]:
    """Parse an ids-only allowlist file: {"aliases": {...}, "tenants": {...}}.

    Every entry is {"user_ids": [...], "chat_ids": [...]}. Both sections are optional.
    Never contains tokens; a `token`/`bot_token` key anywhere is rejected.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GeneratorError(f"cannot read allowlist file {path}: {exc}") from exc
    if not isinstance(document, dict):
        raise GeneratorError("allowlist file must be a JSON object")
    unknown = set(document) - {"aliases", "tenants"}
    if unknown:
        raise GeneratorError(f"allowlist file has unexpected top-level keys: {sorted(unknown)}")
    by_alias: dict[str, dict[str, list[str]]] = {}
    for alias, entry in (document.get("aliases") or {}).items():
        if not ALIAS_RE.fullmatch(str(alias)):
            raise GeneratorError(f"allowlist file has an invalid alias key: {alias!r}")
        by_alias[str(alias)] = _check_allowlist_entry(entry, f"allowlist.aliases.{alias}")
    by_tenant: dict[str, dict[str, list[str]]] = {}
    for tenant, entry in (document.get("tenants") or {}).items():
        if not TENANT_RE.fullmatch(str(tenant)):
            raise GeneratorError(f"allowlist file has an invalid tenant key: {tenant!r}")
        by_tenant[str(tenant)] = _check_allowlist_entry(entry, f"allowlist.tenants.{tenant}")
    return {"aliases": by_alias, "tenants": by_tenant}


def _resolve_allowlist(alias: str, tenant: str, options: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Precedence: per-alias file entry > per-tenant file entry > CLI/global > placeholder."""
    allowlist = options.get("allowlist") or {}
    by_alias = allowlist.get("aliases") or {}
    if alias in by_alias:
        entry = by_alias[alias]
        return list(entry["user_ids"]), list(entry["chat_ids"])
    by_tenant = allowlist.get("tenants") or {}
    if tenant in by_tenant:
        entry = by_tenant[tenant]
        return list(entry["user_ids"]), list(entry["chat_ids"])
    return list(options["allowed_user_ids"]), list(options["allowed_chat_ids"])


# ------------------------------------------------------------------------ groups file
def _ordered(row: dict[str, Any], order: tuple[str, ...]) -> dict[str, Any]:
    """Re-key a dict into the deterministic emission order, dropping absent keys."""
    return {key: row[key] for key in order if key in row}


def _check_group_thread(entry: Any, owner: str, label: str) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise GeneratorError(f"{label} must be an object")
    unknown = set(entry) - set(THREAD_FIELD_ORDER)
    if unknown:
        raise GeneratorError(f"{label} has unexpected keys: {sorted(unknown)}")
    thread: dict[str, Any] = {"thread_id": entry.get("thread_id")}
    _check_text(thread["thread_id"], f"{label}.thread_id", THREAD_ID_RE, 16)
    for key in ("mode", "allowed_user_ids", "default_alias", "session_scope", "reply_to_origin"):
        if key in entry:
            thread[key] = entry[key]
    _validate_thread_policy(thread, owner, None, label)
    return _ordered(thread, THREAD_FIELD_ORDER)


def _check_group_chat(entry: Any, owner: str, label: str) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise GeneratorError(f"{label} must be an object")
    unknown = set(entry) - set(CHAT_FIELD_ORDER)
    if unknown:
        raise GeneratorError(f"{label} has unexpected keys: {sorted(unknown)}")
    chat: dict[str, Any] = {"chat_id": entry.get("chat_id")}
    _check_text(chat["chat_id"], f"{label}.chat_id", GROUP_CHAT_ID_RE, 20)
    for key in ("mode", "allowed_user_ids", "default_alias", "session_scope", "reply_to_origin"):
        if key in entry:
            chat[key] = entry[key]
    # Validate eagerly, the same fields `_validate_thread_policy` checks for a thread
    # override. The `allowed_user_ids` subset-of-alias-wide check and the `chat_id in
    # allowed_chat_ids` check are deferred to `validate_config()`, the only place that also
    # has the alias-wide allowlist in scope; everything checkable from the groups file alone
    # is rejected here instead of being silently passed through to that later, less precise
    # error.
    mode = chat.get("mode")
    if mode is not None:
        _check_enum(mode, CHAT_MODES, f"{label}.mode")
    if "allowed_user_ids" in chat:
        _check_id_list(chat["allowed_user_ids"], f"{label}.allowed_user_ids")
    if "default_alias" in chat:
        _check_default_alias(chat["default_alias"], owner, f"{label}.default_alias")
    if "session_scope" in chat:
        _check_enum(chat["session_scope"], SESSION_SCOPES, f"{label}.session_scope")
    if "reply_to_origin" in chat:
        _check_bool(chat["reply_to_origin"], f"{label}.reply_to_origin")
    if mode == "off" and isinstance(chat.get("default_alias"), str):
        raise GeneratorError(f"{label}.default_alias cannot be set while mode is off")
    threads = entry.get("threads", [])
    if not isinstance(threads, list):
        raise GeneratorError(f"{label}.threads must be an array")
    chat["threads"] = [
        _check_group_thread(thread, owner, f"{label}.threads[{index}]")
        for index, thread in enumerate(threads)
    ]
    return _ordered(chat, CHAT_FIELD_ORDER)


def load_groups_file(path: pathlib.Path) -> dict[str, Any]:
    """Parse the group-routing file: {"bot_usernames": {...}, "aliases": {alias: {"chats": [...]}}}.

    Carries no secrets (handles and Telegram ids only). An alias absent from `aliases`
    gets NO `chats` key at all, which is what keeps its groups on legacy routing.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GeneratorError(f"cannot read groups file {path}: {exc}") from exc
    if not isinstance(document, dict):
        raise GeneratorError("groups file must be a JSON object")
    unknown = set(document) - {"bot_usernames", "aliases"}
    if unknown:
        raise GeneratorError(f"groups file has unexpected top-level keys: {sorted(unknown)}")
    usernames: dict[str, str] = {}
    for alias, handle in (document.get("bot_usernames") or {}).items():
        if not ALIAS_RE.fullmatch(str(alias)):
            raise GeneratorError(f"groups file has an invalid alias key: {alias!r}")
        _check_text(handle, f"bot_usernames.{alias}", USERNAME_RE, 32)
        usernames[str(alias)] = handle
    by_alias: dict[str, dict[str, Any]] = {}
    for alias, entry in (document.get("aliases") or {}).items():
        if not ALIAS_RE.fullmatch(str(alias)):
            raise GeneratorError(f"groups file has an invalid alias key: {alias!r}")
        if not isinstance(entry, dict):
            raise GeneratorError(f"groups.aliases.{alias} must be an object")
        if "token" in entry or "bot_token" in entry:
            raise GeneratorError(f"groups.aliases.{alias} must not carry token material")
        unknown = set(entry) - {"chats"}
        if unknown:
            raise GeneratorError(f"groups.aliases.{alias} has unexpected keys: {sorted(unknown)}")
        chats = entry.get("chats", [])
        if not isinstance(chats, list) or not (0 <= len(chats) <= MAX_CHATS):
            raise GeneratorError(f"groups.aliases.{alias}.chats must be an array of at most {MAX_CHATS}")
        by_alias[str(alias)] = {
            "chats": [
                _check_group_chat(chat, str(alias), f"groups.aliases.{alias}.chats[{index}]")
                for index, chat in enumerate(chats)
            ]
        }
    return {"bot_usernames": usernames, "aliases": by_alias}


# ----------------------------------------------------------------------------- build
def default_options() -> dict[str, Any]:
    return {
        "runtime_dir": DEFAULT_RUNTIME_DIR,
        "token_dir": DEFAULT_RUNTIME_DIR,
        "marker_dir": DEFAULT_RUNTIME_DIR,
        "recipients_policy": DEFAULT_RECIPIENTS_POLICY,
        "allowed_user_ids": [PLACEHOLDER_USER_ID],
        "allowed_chat_ids": [PLACEHOLDER_CHAT_ID],
        "allowlist": {"aliases": {}, "tenants": {}},
        "groups": {"bot_usernames": {}, "aliases": {}},
        "poll_timeout_seconds": DEFAULT_POLL_TIMEOUT_SECONDS,
        "poll_lease_ms": DEFAULT_POLL_LEASE_MS,
    }


def _recipients_for(alias: str, fleet: dict[str, dict[str, str]], policy: str) -> list[dict[str, str]]:
    """Return the sole ingress recipient accepted by the runtime bridge."""
    tenant = fleet[alias]["tenant"]
    if policy != "self":
        raise GeneratorError(f"unknown recipients policy: {policy!r}")
    return [{"tenant_id": tenant, "alias": alias}]


def build_alias_config(alias: str, fleet: dict[str, dict[str, str]], options: dict[str, Any]) -> dict[str, Any]:
    meta = fleet[alias]
    token_dir = str(options["token_dir"]).rstrip("/")
    marker_dir = str(options["marker_dir"]).rstrip("/")
    allowed_user_ids, allowed_chat_ids = _resolve_allowlist(alias, meta["tenant"], options)
    groups = options.get("groups") or {}
    row = {
        "alias": alias,
        "tenant_id": meta["tenant"],
        "room_id": meta["room"],
        "token_file": f"{token_dir}/{alias}.token",
        "v2_shutdown_marker_file": f"{marker_dir}/{alias}.disabled",
        "allowed_user_ids": allowed_user_ids,
        "allowed_chat_ids": allowed_chat_ids,
        "recipients": _recipients_for(alias, fleet, options["recipients_policy"]),
        "poll_timeout_seconds": options["poll_timeout_seconds"],
        "poll_lease_ms": options["poll_lease_ms"],
    }
    username = (groups.get("bot_usernames") or {}).get(alias)
    if username is not None:
        row["bot_username"] = username
    entry = (groups.get("aliases") or {}).get(alias)
    if entry is not None:
        # Present (even empty) = this alias opts into default-deny group routing. Absent = legacy.
        row["chats"] = copy.deepcopy(entry["chats"])
    # Enforce the deterministic key order, dropping the optional keys that were not supplied.
    return _ordered(row, ALIAS_FIELD_ORDER)


def resolve_selection(fleet: dict[str, dict[str, str]], selected: list[str] | None) -> list[str]:
    all_aliases = sorted(fleet)
    if selected is None:
        return all_aliases
    seen: set[str] = set()
    for alias in selected:
        if alias not in fleet:
            raise GeneratorError(f"unknown alias {alias!r}; the fleet is {all_aliases}")
        if alias in seen:
            raise GeneratorError(f"duplicate alias in selection: {alias!r}")
        seen.add(alias)
    if not seen:
        raise GeneratorError("no aliases selected")
    # Sort so the output is idempotent regardless of selection order.
    return sorted(seen)


def build_config(
    fleet: dict[str, dict[str, str]],
    selected: list[str] | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    options = options or default_options()
    if options["recipients_policy"] not in RECIPIENTS_POLICIES:
        raise GeneratorError(f"recipients policy must be one of {RECIPIENTS_POLICIES}")
    chosen = resolve_selection(fleet, selected)
    config = {"aliases": [build_alias_config(alias, fleet, options) for alias in chosen]}
    validate_config(config)  # fail closed: never emit a config the bridge would reject
    return config


# ------------------------------------------------------------------------------ emit
def render(config: dict[str, Any], indent: int = 2) -> str:
    return json.dumps(config, indent=indent, ensure_ascii=False, sort_keys=False) + "\n"

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="generate-telegram-config.py",
        description="Deterministically generate the Telegram bridge production config (no secrets).",
    )
    parser.add_argument("--aliases", help="comma-separated subset for canary; default = the whole fleet")
    parser.add_argument("--output", type=pathlib.Path, help="atomic output path; default = stdout")
    parser.add_argument(
        "--ops-dir",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parents[1],
        help="path to the ops/ directory holding container-aliases.json and manifests/",
    )
    parser.add_argument(
        "--runtime-dir",
        default=DEFAULT_RUNTIME_DIR,
        help="container-internal mount holding config.json, tokens and markers "
        f"(default {DEFAULT_RUNTIME_DIR}, matches deploy/compose.yaml)",
    )
    parser.add_argument("--token-dir", help="placeholder dir for <alias>.token (default = --runtime-dir)")
    parser.add_argument("--marker-dir", help="placeholder dir for <alias>.disabled (default = --runtime-dir)")
    parser.add_argument(
        "--recipients",
        choices=RECIPIENTS_POLICIES,
        default=DEFAULT_RECIPIENTS_POLICY,
        help="ingress recipient policy (only self is supported)",
    )
    parser.add_argument("--poll-timeout-seconds", type=int, default=DEFAULT_POLL_TIMEOUT_SECONDS)
    parser.add_argument("--poll-lease-ms", type=int, default=DEFAULT_POLL_LEASE_MS)
    parser.add_argument(
        "--allowlist-file",
        type=pathlib.Path,
        help="ids-only JSON {'aliases':{alias:{user_ids,chat_ids}},'tenants':{...}} (no tokens)",
    )
    parser.add_argument(
        "--allow-user-id",
        action="append",
        dest="allow_user_ids",
        metavar="ID",
        help="global operational Telegram user id (repeatable); overridden per alias by --allowlist-file",
    )
    parser.add_argument(
        "--allow-chat-id",
        action="append",
        dest="allow_chat_ids",
        metavar="ID",
        help="global operational Telegram chat id (repeatable); overridden per alias by --allowlist-file",
    )
    parser.add_argument(
        "--groups-file",
        type=pathlib.Path,
        help="ids-only JSON {'bot_usernames':{alias:handle},'aliases':{alias:{'chats':[...]}}} "
        "(no tokens); an alias absent from 'aliases' keeps legacy group routing",
    )
    parser.add_argument("--no-cross-check", action="store_true", help="skip ops/manifests/*.yaml cross-check")
    parser.add_argument("--allow-placeholders", action="store_true", help="force the sentinel over real ids at --output (default: fails closed)")
    parser.add_argument("--reuse-existing-allowlist", action="store_true", help="default an --aliases alias's allowlist to its own real ids already at --output")
    parser.add_argument("--indent", type=int, default=2)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        fleet = load_fleet(args.ops_dir, cross_check=not args.no_cross_check)
        allowlist = {"aliases": {}, "tenants": {}}
        if args.allowlist_file is not None:
            allowlist = load_allowlist_file(args.allowlist_file)
        groups = {"bot_usernames": {}, "aliases": {}}
        if args.groups_file is not None:
            groups = load_groups_file(args.groups_file)
        options = {
            "runtime_dir": args.runtime_dir,
            "token_dir": args.token_dir or args.runtime_dir,
            "marker_dir": args.marker_dir or args.runtime_dir,
            "recipients_policy": args.recipients,
            "allowed_user_ids": args.allow_user_ids or [PLACEHOLDER_USER_ID],
            "allowed_chat_ids": args.allow_chat_ids or [PLACEHOLDER_CHAT_ID],
            "allowlist": allowlist,
            "groups": groups,
            "poll_timeout_seconds": args.poll_timeout_seconds,
            "poll_lease_ms": args.poll_lease_ms,
        }
        selected: list[str] | None = None
        if args.aliases is not None:
            selected = [alias.strip() for alias in args.aliases.split(",") if alias.strip()]
            if not selected:
                raise GeneratorError("--aliases was empty")
        config = merge_lib.build_and_merge(fleet, selected, options, allowlist, args.output, args.reuse_existing_allowlist, args.allow_placeholders, build_config, validate_config)
        document = render(config, args.indent)
    except (GeneratorError, merge_lib.MergeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.output is None:
        sys.stdout.write(document)
    else:
        _atomic_write(args.output, document)
        print(f"wrote {len(config['aliases'])} alias configs to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
