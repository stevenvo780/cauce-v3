#!/usr/bin/env python3
"""Deterministic production config generator for the Telegram bridge (gap G2).

Historically only a test fixture (ops/harness/authentic-fixture-init.mjs) wrote a
Telegram bridge config, and only for a single alias. This tool productionises that
gap: it emits a JSON document that validates EXACTLY against the schema enforced by
`parseTelegramBridgeConfig` in services/telegram-bridge/src/config.ts, built from the
12-alias fleet source of truth (ops/container-aliases.json, cross-checked against
ops/manifests/*.yaml).

Mapping (per alias):
  alias                   <- fleet alias key
  tenant_id               <- fleet tenant   (container-aliases.json / manifest spec.tenant)
  room_id                 <- fleet room     (container-aliases.json / manifest spec.room)
  token_file              <- PLACEHOLDER  {runtime-dir}/{alias}.token   (container-internal path)
  v2_shutdown_marker_file <- PLACEHOLDER  {runtime-dir}/{alias}.disabled (container-internal path)
  allowed_user_ids        <- --allowlist-file / --allow-user-id, else a sentinel placeholder
  allowed_chat_ids        <- --allowlist-file / --allow-chat-id, else a sentinel placeholder
  recipients              <- exactly the alias itself
  poll_timeout_seconds    <- --poll-timeout-seconds (default 25)
  poll_lease_ms           <- --poll-lease-ms (default 60000)

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
import json
import os
import pathlib
import re
import sys
import tempfile
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import container_alias_lib  # noqa: E402  same-directory ops library (stdlib-only)

# --- constraints mirrored verbatim from services/telegram-bridge/src/config.ts ---
ALIAS_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")         # config.ts text(..., 64) for alias / recipient.alias
TENANT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")  # @cauce/protocol TenantSchema
ROOM_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")         # config.ts room_id
ID_RE = re.compile(r"^-?[1-9][0-9]{0,19}$")               # config.ts idList entries
NON_WHITESPACE_RE = re.compile(r"^\S+$")                  # config.ts text() pattern used by absolutePath

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

# Deterministic key order for each emitted alias object.
ALIAS_FIELD_ORDER = (
    "alias",
    "tenant_id",
    "room_id",
    "token_file",
    "v2_shutdown_marker_file",
    "allowed_user_ids",
    "allowed_chat_ids",
    "recipients",
    "poll_timeout_seconds",
    "poll_lease_ms",
)


class GeneratorError(ValueError):
    """Raised for any invalid input, source divergence, or invalid emitted config."""


# --------------------------------------------------------------------------- sources
def load_fleet(ops_dir: pathlib.Path, cross_check: bool = True) -> dict[str, dict[str, str]]:
    """Return {alias: {'tenant','room','harness'}} for the exact 12-alias fleet.

    container-aliases.json is the primary source (stdlib-only, carries tenant/room/
    harness). When cross_check is on, ops/manifests/*.yaml must agree exactly.
    """
    aliases = container_alias_lib.load_container_aliases(ops_dir)  # validates the exact 12
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
    for document in manifest_lib.load_manifests(ops_dir):  # validates the exact 12
        spec = document["spec"]
        manifest_fleet[spec["alias"]] = {
            "tenant": spec["tenant"],
            "room": spec["room"],
            "harness": spec["harness"],
        }
    if manifest_fleet != fleet:
        raise GeneratorError("container-aliases.json and ops/manifests/*.yaml disagree on the fleet")


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
    # Enforce the deterministic key order.
    return {key: row[key] for key in ALIAS_FIELD_ORDER}


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


# -------------------------------------------------------------------------- validate
def _check_text(value: Any, name: str, pattern: re.Pattern[str], max_len: int = 256) -> None:
    # fullmatch (not match) so an anchored pattern behaves exactly like JS `RegExp.test`
    # and does not accept a trailing newline before `$`, matching config.ts semantics.
    if not isinstance(value, str) or not (1 <= len(value) <= max_len) or not pattern.fullmatch(value):
        raise GeneratorError(f"{name} is invalid: {value!r}")


def _check_absolute(value: Any, name: str) -> None:
    _check_text(value, name, NON_WHITESPACE_RE, 1_024)
    if not value.startswith("/"):
        raise GeneratorError(f"{name} must be an absolute path: {value!r}")


def _check_id_list(value: Any, name: str) -> None:
    if not isinstance(value, list) or not (1 <= len(value) <= 10_000):
        raise GeneratorError(f"{name} must be a non-empty array")
    for entry in value:
        _check_text(entry, name, ID_RE, 20)
    if len(set(value)) != len(value):
        raise GeneratorError(f"{name} contains duplicates")


def _check_int(value: Any, minimum: int, maximum: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not (minimum <= value <= maximum):
        raise GeneratorError(f"{name} is invalid: {value!r}")


def validate_config(config: Any) -> dict[str, Any]:
    """Replicate parseTelegramBridgeConfig (services/telegram-bridge/src/config.ts)."""
    if not isinstance(config, dict) or not isinstance(config.get("aliases"), list):
        raise GeneratorError("config must be an object with an 'aliases' array")
    aliases = config["aliases"]
    if not (1 <= len(aliases) <= 100):
        raise GeneratorError("aliases must be a non-empty array of at most 100 entries")
    names: list[str] = []
    pairs: list[str] = []
    for row in aliases:
        if not isinstance(row, dict):
            raise GeneratorError("each alias must be an object")
        if "token" in row or "bot_token" in row:
            raise GeneratorError("inline Telegram tokens are forbidden")
        _check_text(row.get("alias"), "alias", ALIAS_RE, 64)
        _check_text(row.get("tenant_id"), "tenant_id", TENANT_RE, 64)
        _check_text(row.get("room_id"), "room_id", ROOM_RE, 128)
        _check_absolute(row.get("token_file"), "token_file")
        _check_absolute(row.get("v2_shutdown_marker_file"), "v2_shutdown_marker_file")
        _check_id_list(row.get("allowed_user_ids"), "allowed_user_ids")
        _check_id_list(row.get("allowed_chat_ids"), "allowed_chat_ids")
        recipients = row.get("recipients")
        if not isinstance(recipients, list) or not (1 <= len(recipients) <= 100):
            raise GeneratorError("recipients must be a non-empty array of at most 100 entries")
        for recipient in recipients:
            if not isinstance(recipient, dict):
                raise GeneratorError("each recipient must be an object")
            _check_text(recipient.get("tenant_id"), "recipient.tenant_id", TENANT_RE, 64)
            _check_text(recipient.get("alias"), "recipient.alias", ALIAS_RE, 64)
        expected_recipient = [{"tenant_id": row["tenant_id"], "alias": row["alias"]}]
        if recipients != expected_recipient:
            raise GeneratorError("Telegram ingress requires exactly one self recipient")
        poll_timeout = row.get("poll_timeout_seconds")
        poll_lease = row.get("poll_lease_ms")
        _check_int(poll_timeout, 1, 50, "poll_timeout_seconds")
        _check_int(poll_lease, 10_000, 300_000, "poll_lease_ms")
        if poll_lease < poll_timeout * 1_000 + 5_000:
            raise GeneratorError("poll_lease_ms must exceed the long-poll timeout by at least 5 seconds")
        names.append(row["alias"])
        pairs.append(f"{row['tenant_id']}:{row['alias']}")
    if len(set(names)) != len(names):
        raise GeneratorError("alias names must be unique")
    if len(set(pairs)) != len(pairs):
        raise GeneratorError("tenant/alias pairs must be unique")
    return config


# ------------------------------------------------------------------------------ emit
def render(config: dict[str, Any], indent: int = 2) -> str:
    return json.dumps(config, indent=indent, ensure_ascii=False, sort_keys=False) + "\n"


def _atomic_write(destination: pathlib.Path, body: str, mode: int = 0o644) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="generate-telegram-config.py",
        description="Deterministically generate the Telegram bridge production config (no secrets).",
    )
    parser.add_argument("--aliases", help="comma-separated subset for canary; default = all 12")
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
    parser.add_argument("--no-cross-check", action="store_true", help="skip ops/manifests/*.yaml cross-check")
    parser.add_argument("--indent", type=int, default=2)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        fleet = load_fleet(args.ops_dir, cross_check=not args.no_cross_check)
        allowlist = {"aliases": {}, "tenants": {}}
        if args.allowlist_file is not None:
            allowlist = load_allowlist_file(args.allowlist_file)
        options = {
            "runtime_dir": args.runtime_dir,
            "token_dir": args.token_dir or args.runtime_dir,
            "marker_dir": args.marker_dir or args.runtime_dir,
            "recipients_policy": args.recipients,
            "allowed_user_ids": args.allow_user_ids or [PLACEHOLDER_USER_ID],
            "allowed_chat_ids": args.allow_chat_ids or [PLACEHOLDER_CHAT_ID],
            "allowlist": allowlist,
            "poll_timeout_seconds": args.poll_timeout_seconds,
            "poll_lease_ms": args.poll_lease_ms,
        }
        selected: list[str] | None = None
        if args.aliases is not None:
            selected = [alias.strip() for alias in args.aliases.split(",") if alias.strip()]
            if not selected:
                raise GeneratorError("--aliases was empty")
        config = build_config(fleet, selected, options)
        document = render(config, args.indent)
    except GeneratorError as exc:
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
