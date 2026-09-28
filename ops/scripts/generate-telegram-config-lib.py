"""Schema-validation mirror for generate-telegram-config.py.

Constraints and validators copied verbatim from services/telegram-bridge/src/config.ts.
Loaded by the entrypoint with importlib (hyphenated filename) and re-exported there,
so the entrypoint keeps its full module surface and CLI contract.
"""

from __future__ import annotations

import re
from typing import Any


# --- constraints mirrored verbatim from services/telegram-bridge/src/config.ts ---
ALIAS_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")         # config.ts text(..., 64) for alias / recipient.alias
TENANT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")  # @cauce/protocol TenantSchema
ROOM_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")         # config.ts room_id
ID_RE = re.compile(r"^-?[1-9][0-9]{0,19}$")               # config.ts idList entries
NON_WHITESPACE_RE = re.compile(r"^\S+$")                  # config.ts text() pattern used by absolutePath
USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{4,31}$")  # config.ts bot_username
GROUP_CHAT_ID_RE = re.compile(r"^-[1-9][0-9]{0,19}$")     # config.ts chats[].chat_id (groups are negative)
THREAD_ID_RE = re.compile(r"^[1-9][0-9]{0,15}$")          # config.ts threads[].thread_id

CHAT_MODES = ("mention", "always", "off")                 # config.ts CHAT_MODES
SESSION_SCOPES = ("user", "chat", "thread")               # config.ts SESSION_SCOPES
MAX_CHATS = 200
MAX_THREADS = 200

CHAT_FIELD_ORDER = (
    "chat_id",
    "mode",
    "allowed_user_ids",
    "default_alias",
    "session_scope",
    "reply_to_origin",
    "threads",
)
THREAD_FIELD_ORDER = (
    "thread_id",
    "mode",
    "allowed_user_ids",
    "default_alias",
    "session_scope",
    "reply_to_origin",
)


class GeneratorError(ValueError):
    """Raised for any invalid input, source divergence, or invalid emitted config."""


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


def _check_bool(value: Any, name: str) -> None:
    if not isinstance(value, bool):
        raise GeneratorError(f"{name} must be a boolean: {value!r}")


def _check_enum(value: Any, allowed: tuple[str, ...], name: str) -> None:
    if value not in allowed:
        raise GeneratorError(f"{name} is invalid: {value!r}")


def _check_default_alias(value: Any, owner: str, name: str) -> None:
    """config.ts defaultAlias(): null clears the host, a string MUST name the owning alias.

    A `default_alias` pointing at somebody else is silently inert in the resolver (P9 compares it
    against `self.alias`), so the group would go mute with no error anywhere. Reject it here.
    """
    if value is None:
        return
    _check_text(value, name, ALIAS_RE, 64)
    if value != owner:
        raise GeneratorError(f"{name} must name the alias that declares it ({owner!r}): {value!r}")


def _check_narrowed_user_ids(value: Any, parent: list[str], name: str) -> None:
    """config.ts narrowedUserIds(): a per-chat/per-thread list must be a SUBSET of its parent."""
    _check_id_list(value, name)
    for entry in value:
        if entry not in parent:
            raise GeneratorError(f"{name} must be a subset of the parent allowed_user_ids: {entry!r}")


def _validate_thread_policy(
    thread: dict[str, Any],
    owner: str,
    parent_user_ids: list[str] | None,
    label: str,
) -> None:
    """config.ts threadPolicy(). `parent_user_ids` is None when only the shape can be checked."""
    _check_text(thread.get("thread_id"), f"{label}.thread_id", THREAD_ID_RE, 16)
    mode = thread.get("mode")
    if mode is not None:
        _check_enum(mode, CHAT_MODES, f"{label}.mode")
    if "allowed_user_ids" in thread:
        if parent_user_ids is None:
            _check_id_list(thread["allowed_user_ids"], f"{label}.allowed_user_ids")
        else:
            _check_narrowed_user_ids(thread["allowed_user_ids"], parent_user_ids, f"{label}.allowed_user_ids")
    if "default_alias" in thread:
        _check_default_alias(thread["default_alias"], owner, f"{label}.default_alias")
    if "session_scope" in thread:
        _check_enum(thread["session_scope"], SESSION_SCOPES, f"{label}.session_scope")
    if "reply_to_origin" in thread:
        _check_bool(thread["reply_to_origin"], f"{label}.reply_to_origin")
    if mode == "off" and isinstance(thread.get("default_alias"), str):
        raise GeneratorError(f"{label}.default_alias cannot be set while mode is off")


def _validate_chat_policy(
    chat: Any,
    owner: str,
    alias_user_ids: list[str],
    allowed_chat_ids: list[str],
    label: str,
) -> None:
    """config.ts chatPolicy()."""
    if not isinstance(chat, dict):
        raise GeneratorError(f"{label} must be an object")
    unknown = set(chat) - set(CHAT_FIELD_ORDER)
    if unknown:
        raise GeneratorError(f"{label} has unexpected keys: {sorted(unknown)}")
    chat_id = chat.get("chat_id")
    # Groups and supergroups always have a negative id. A positive one would name a private chat,
    # which ingress answers before consulting any policy while egress still honours it.
    _check_text(chat_id, f"{label}.chat_id", GROUP_CHAT_ID_RE, 20)
    if chat_id not in allowed_chat_ids:
        raise GeneratorError(f"{label}.chat_id must be listed in allowed_chat_ids: {chat_id!r}")
    mode = chat.get("mode", "mention")
    _check_enum(mode, CHAT_MODES, f"{label}.mode")
    chat_user_ids = alias_user_ids
    if "allowed_user_ids" in chat:
        _check_narrowed_user_ids(chat["allowed_user_ids"], alias_user_ids, f"{label}.allowed_user_ids")
        chat_user_ids = list(chat["allowed_user_ids"])
    if "default_alias" in chat:
        _check_default_alias(chat["default_alias"], owner, f"{label}.default_alias")
    if "session_scope" in chat:
        _check_enum(chat["session_scope"], SESSION_SCOPES, f"{label}.session_scope")
    if "reply_to_origin" in chat:
        _check_bool(chat["reply_to_origin"], f"{label}.reply_to_origin")
    if mode == "off" and isinstance(chat.get("default_alias"), str):
        raise GeneratorError(f"{label}.default_alias cannot be set while mode is off")
    threads = chat.get("threads", [])
    if not isinstance(threads, list) or len(threads) > MAX_THREADS:
        raise GeneratorError(f"{label}.threads must be an array of at most {MAX_THREADS}")
    for index, thread in enumerate(threads):
        if not isinstance(thread, dict):
            raise GeneratorError(f"{label}.threads[{index}] must be an object")
        unknown = set(thread) - set(THREAD_FIELD_ORDER)
        if unknown:
            raise GeneratorError(f"{label}.threads[{index}] has unexpected keys: {sorted(unknown)}")
        _validate_thread_policy(thread, owner, chat_user_ids, f"{label}.threads[{index}]")
    thread_ids = [thread["thread_id"] for thread in threads]
    if len(set(thread_ids)) != len(thread_ids):
        raise GeneratorError(f"{label}.threads contains duplicate thread_id")


def _effective_chat_policy(row: dict[str, Any], chat_id: str, thread_id: str) -> dict[str, Any] | None:
    """config.ts effectiveChatPolicy(): merge the chat entry with its thread override."""
    chat = next((entry for entry in row.get("chats") or [] if entry["chat_id"] == chat_id), None)
    if chat is None:
        return None
    thread = None
    if thread_id != "0":
        thread = next((entry for entry in chat.get("threads") or [] if entry["thread_id"] == thread_id), None)
    host = thread["default_alias"] if thread is not None and "default_alias" in thread else chat.get("default_alias")
    mode = chat.get("mode", "mention")
    if thread is not None and "mode" in thread:
        mode = thread["mode"]
    return {"mode": mode, "default_alias": host}


def _declared_scopes(aliases: list[dict[str, Any]]) -> dict[str, set[str]]:
    scopes: dict[str, set[str]] = {}
    for row in aliases:
        for chat in row.get("chats") or []:
            threads = scopes.setdefault(chat["chat_id"], {"0"})
            for thread in chat.get("threads") or []:
                threads.add(thread["thread_id"])
    return scopes


def _check_single_ambient_host(aliases: list[dict[str, Any]]) -> None:
    """config.ts assertSingleAmbientHost(): at most one alias may answer unaddressed messages.

    Two ambient-eligible aliases in the same (chat, thread) means every message that names nobody
    wakes both of them, which is the "every bot answers everything" bug this whole feature removes.
    Evaluated across the WHOLE file, so a `mode:"always"` in one alias colliding with another
    alias's `default_alias` — including on a thread only the other alias declares — is caught.
    """
    for chat_id, threads in _declared_scopes(aliases).items():
        for thread_id in sorted(threads):
            hosts = []
            for row in aliases:
                policy = _effective_chat_policy(row, chat_id, thread_id)
                if policy is None or policy["mode"] == "off":
                    continue
                if policy["mode"] == "always" or policy["default_alias"] == row["alias"]:
                    hosts.append(row["alias"])
            if len(hosts) > 1:
                raise GeneratorError(
                    f"at most one alias may answer unaddressed messages in chat {chat_id} "
                    f"thread {thread_id}: {sorted(hosts)}"
                )


def _check_fleet_usernames(aliases: list[dict[str, Any]]) -> None:
    """config.ts assertFleetUsernames(): every alias that declares chats needs a unique handle."""
    seen: set[str] = set()
    for row in aliases:
        username = row.get("bot_username")
        if username is None:
            if len(row.get("chats") or []) > 0:
                raise GeneratorError(f"{row['alias']} must declare bot_username because it declares chats")
            continue
        _check_text(username, "bot_username", USERNAME_RE, 32)
        lowered = username.lower()
        if lowered in seen:
            raise GeneratorError(f"bot_username values must be unique: {username!r}")
        seen.add(lowered)


def validate_config(config: Any) -> dict[str, Any]:
    """Replicate parseTelegramBridgeConfig (services/telegram-bridge/src/config.ts).

    Kept an exact mirror on purpose: this is the only gate between an operator's edit and a fleet
    of the whole bot fleet reading the file at boot. Anything the bridge rejects must be rejected here, and
    the cross-alias rules (`assertFleetUsernames`, `assertSingleAmbientHost`) matter most, because
    those are the ones a per-alias review cannot catch.
    """
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
        if "bot_username" in row:
            _check_text(row["bot_username"], "bot_username", USERNAME_RE, 32)
        _check_id_list(row.get("allowed_user_ids"), "allowed_user_ids")
        _check_id_list(row.get("allowed_chat_ids"), "allowed_chat_ids")
        if "chats" in row:
            chats = row["chats"]
            if not isinstance(chats, list) or len(chats) > MAX_CHATS:
                raise GeneratorError(f"chats must be an array of at most {MAX_CHATS} entries")
            for index, chat in enumerate(chats):
                _validate_chat_policy(
                    chat,
                    row["alias"],
                    list(row["allowed_user_ids"]),
                    list(row["allowed_chat_ids"]),
                    f"{row['alias']}.chats[{index}]",
                )
            chat_ids = [chat["chat_id"] for chat in chats]
            if len(set(chat_ids)) != len(chat_ids):
                raise GeneratorError(f"{row['alias']}.chats contains duplicate chat_id")
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
    # Cross-alias invariants (config.ts assertFleetUsernames / assertSingleAmbientHost). These
    # cannot be checked per-alias above: a shared chat where two aliases are each individually
    # valid can still be invalid together (two ambient hosts, or a participant with no handle).
    _check_fleet_usernames(aliases)
    _check_single_ambient_host(aliases)
    return config
