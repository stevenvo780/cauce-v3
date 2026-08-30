#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import hashlib
import hmac
import json
import os
import pty
import re
import select
import signal
import socket
import ssl
import stat
import struct
import sys
import tempfile
import termios
import time
from typing import Any

# Fail-closed exit reserved for identity violations. The container adapter supervisor already
# refuses a root runtime identity with 78; the PTY agent inherits the same contract so the
# systemd template can treat it as a permanent (non-restartable) failure.
PERMANENT_EXIT = 78
ARGUMENT_EXIT = 2

AGENT_PROTOCOL_VERSION = 1

# Wire tags. The relay implements the mirror image of this table; every value is a single byte
# and the length prefix is 4 bytes big-endian, so a frame header is always exactly 5 bytes.
TAG_AGENT_HELLO = 0x01
TAG_HELLO_ACK = 0x02
TAG_OPEN = 0x10
TAG_OPEN_OK = 0x11
TAG_OPEN_ERR = 0x12
TAG_STDIN = 0x20
TAG_STDOUT = 0x21
TAG_RESIZE = 0x22
# DA/DSR response emitted by the emulator. A dedicated tag prevents confusing it with keyboard/paste.
TAG_TERMINAL_RESPONSE = 0x23
# Backpressure per SESSION. The relay never pauses the multiplexed TLS: that would block PONG
# and the other terminals of the same agent.
TAG_PAUSE_OUTPUT = 0x24
TAG_RESUME_OUTPUT = 0x25
TAG_CLOSE = 0x30
TAG_CLOSED = 0x31
TAG_PING = 0x40
TAG_PONG = 0x41
# Reading governance files (CLAUDE.md / AGENTS.md and the memory index). A loose transaction,
# not a session: that is why it does not reuse TAG_OPEN, which opens a PTY with state.
TAG_READ = 0x50
TAG_READ_OK = 0x51
TAG_READ_ERR = 0x52
TAG_READ_DATA = 0x53
# Governed write v1. Tags kept separate from READ preserve compatibility: a relay only sends them
# when the hello advertises `write_governance_v1`; an older agent keeps terminal and read working.
TAG_WRITE = 0x54
TAG_WRITE_DATA = 0x55
TAG_WRITE_OK = 0x56
TAG_WRITE_ERR = 0x57
TAG_WRITE_CANCEL = 0x58
TAG_WRITE_BATCH = 0x59
TAG_WRITE_BATCH_DATA = 0x5A
TAG_WRITE_BATCH_OK = 0x5B
TAG_WRITE_BATCH_ERR = 0x5C
TAG_WRITE_BATCH_CANCEL = 0x5D
# Unambiguous close of a successful read. READ_ERR is already terminal on its own; READ_DONE
# only appears after READ_OK and all its READ_DATA, even when the index/directive is empty.
TAG_READ_DONE = 0x5E

MAX_FRAME = 65536
# DATA frames carry the 36 ASCII bytes of the session UUID before the raw bytes.
SESSION_ID_BYTES = 36
MAX_DATA = MAX_FRAME - SESSION_ID_BYTES
DATA_TAGS = frozenset({TAG_STDIN, TAG_STDOUT, TAG_TERMINAL_RESPONSE})
# Tags whose payload starts with a 36-byte ASCII identifier. READ_DATA carries the request's
# `request_id`, not a session, but the prefix format is intentionally the same: so the relay
# reuses its data-frame decoder without a second code path.
PREFIXED_TAGS = DATA_TAGS | frozenset({TAG_READ_DATA, TAG_WRITE_DATA, TAG_WRITE_BATCH_DATA})

MAX_SESSIONS = 2
# A TUI over the network is unusable if every keystroke echo becomes its own packet, so output is
# coalesced: flush at 16 ms or 8 KiB, whichever comes first.
FLUSH_INTERVAL = 0.016
FLUSH_BYTES = 8192
# Per-session backpressure: while this much output is still queued the master fd is not read, so
# the pressure lands on the writer inside the container instead of on our heap (a `ls -R /` must
# not balloon the agent nor stall the relay for the other session).
SESSION_HIGH_WATER = 262144
# The PTY descriptor can also block writes. This cap keeps a browser burst from growing without
# bound while `select` waits for that descriptor to become writable again.
SESSION_INPUT_HIGH_WATER = 262144
# Same idea one level up: while this much is already queued for the relay nothing new is coalesced
# into it, so a slow relay pushes the pressure back to SESSION_HIGH_WATER and from there to the pty.
OUTBOUND_HIGH_WATER = 1 << 20
PING_TIMEOUT = 45.0
DYNAMIC_CAPABILITY_CHECK_INTERVAL = 5.0
TOMBSTONE_SECONDS = 30.0
KILL_GRACE = 2.0
HELLO_TIMEOUT = 15.0
BACKOFF_MIN = 1.0
BACKOFF_MAX = 30.0
CLOCK_SKEW = 5.0
SELECT_CEILING = 1.0

SESSION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TICKET_RE = re.compile(r"^v1\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$")
IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MODES = ("shell", "harness")

# Same contractual geometry as the browser leg and SessionManager. OPEN and RESIZE go through
# one function so an extreme initial window cannot bypass the clamp applied afterwards.
MIN_COLS = 20
MAX_COLS = 500
MIN_ROWS = 5
MAX_ROWS = 200

# Closed set emitted by xterm 5.5 for Device Attributes / Device Status Report.
MAX_TERMINAL_RESPONSE_BYTES = 256
TERMINAL_FIXED_RESPONSES = (b"\x1b[?1;2c", b"\x1b[>0;276;0c", b"\x1b[0n")
TERMINAL_CURSOR_RESPONSE_RE = re.compile(rb"^\x1b\[(?:\?)?([1-9][0-9]{0,2});([1-9][0-9]{0,2})R")
OPENCLAW_NATIVE_SESSION_RE = re.compile(r"^[A-Za-z0-9._:-]{1,512}$")
TMUX_SOCKET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TMUX_IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MAX_SESSION_STORE_BYTES = 1 << 20

# VIEWER modes: looked at, not typed into. The agent never accepts human STDIN; it may only
# write DA/DSR technical replies that arrive through their own tag and pass back through a
# closed list.
#
# The lock used to live in argv (`tmux attach -r`) and that is not enough for two measured reasons:
#   1. `HARNESS_COMMAND` can be written by hand in the alias `.env`; one without `-r` turns the
#      console into a keyboard on the session the human is working in, without warning.
#   2. The native OpenClaw TUI (the only one openclaw aliases can emit, because their images
#      have no `tmux`) has NO `-r` equivalent.
# With shared session enabled there is a single input box per alias, so a second writer does not
# open a conversation: it stomps the current turn (four `input_busy` in a row, measured).
# The tmux `-r` is kept as defence in depth.
READ_ONLY_MODES = frozenset({"harness"})

# --- Reading governance files ----------------------------------------------------------------
#
# The bundle carries harness, HOME, and the measured overrides the agent publishes in AGENT_HELLO.
# Directory reads accept ONLY the memory root derived from those same facts; the sensitive names
# below are defence in depth, never the source of authorisation. Profile documents use their own
# closed set per harness. Neither path follows symlinks nor leaves the alias HOME.
FEATURES = (
    "read_governance", "write_governance_v1", "write_governance_batch_v1",
    "session_output_flow_control", "read_governance_done_v1",
)

# Never served or listed, wherever they live. Mirror of NEVER_SERVE_BASENAMES in the gateway
# (`services/gateway/src/console/agent-documents.ts`): the two lists defend separately on purpose,
# because a failure in only one must not be enough to leak a credential.
NEVER_SERVE_BASENAMES = frozenset({
    ".credentials.json", "auth.json", ".claude.json", "openclaw.json", ".env", ".netrc",
    "id_ed25519", "id_rsa", "known_hosts", "authorized_keys",
})
NEVER_SERVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx")

READ_KINDS = ("file", "dir")
MAX_READ_PATH = 4096
# 256 KB: the largest CLAUDE.md measured in the fleet is zeus's (10733 B) and hermes's AGENTS.md
# reaches 75 KB. Margin remains without turning the channel into a dump pipe.
MAX_DOCUMENT_BYTES = 256 * 1024
MAX_WRITE_TRANSACTIONS = 4
MAX_WRITE_BATCH_FILES = 7
MAX_WRITE_BATCH_BYTES = MAX_DOCUMENT_BYTES
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Memory index: metadata only, never content.
MAX_DIR_ENTRIES = 200
MAX_DIR_DEPTH = 3
DIR_SCAN_CAP = 5000
# Byte budget for index entries inside their SINGLE frame (MAX_FRAME = 64 KiB).
READ_INDEX_BUDGET = 48 * 1024

BUNDLE_KEYS = (
    "tenant_id", "alias", "container_id", "generation", "image_id", "runtime_user", "runtime_uid",
    "runtime_gid", "home", "shell_candidates", "harness", "relay_host", "relay_port",
    "alias_key_hex", "client_cert_pem", "client_key_pem", "ca_pem", "agent_version",
)
RUNTIME_FACT_KEYS = frozenset((
    "codex_home", "claude_config_dir", "openclaw_workspace", "cwd", "workspace_root",
    "project_root", "project_doc_max_bytes", "project_doc_fallback_filenames",
))
RUNTIME_PATH_FACT_KEYS = frozenset((
    "codex_home", "claude_config_dir", "openclaw_workspace", "cwd", "workspace_root",
    "project_root",
))
PROJECT_DOC_MAX_BYTES_LIMIT = 16 * 1024 * 1024
PROJECT_DOC_FALLBACK_LIMIT = 16


class PermanentError(RuntimeError):
    """The bundle or the runtime identity is wrong; retrying cannot help."""


class ProtocolError(RuntimeError):
    """The peer sent something the framing layer refuses; the connection is dropped."""


class TicketError(RuntimeError):
    """The OPEN ticket did not verify. `reason` travels back in OPEN_ERR, nothing else does."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(reason if not detail else f"{reason}:{detail}")
        self.reason = reason
        self.detail = detail


class ReadSymlinkError(OSError):
    """A requested READ path became, or already was, a symbolic link."""


class ReadPathTypeError(OSError):
    """A requested READ component exists but is not the required filesystem type."""


def fail(message: str, code: int = ARGUMENT_EXIT) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def log(message: str) -> None:
    # stderr only, and never a secret: the launcher's journal is readable by anyone who can read
    # the unit, so only names, paths, sizes and identities are printed.
    print(f"cauce-pty-agent: {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------------------------


def encode_frame(tag: int, payload: bytes) -> bytes:
    if not 0 <= tag <= 0xFF:
        raise ProtocolError("frame tag is out of range")
    if len(payload) > MAX_FRAME:
        raise ProtocolError("frame payload exceeds the negotiated maximum")
    return struct.pack("!BI", tag, len(payload)) + payload


def encode_json(tag: int, document: dict[str, Any]) -> bytes:
    return encode_frame(tag, json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def encode_data(tag: int, session_id: str, data: bytes) -> bytes:
    if tag not in PREFIXED_TAGS:
        raise ProtocolError("only data/response frames carry a 36 byte prefix")
    identifier = session_id.encode("ascii")
    if len(identifier) != SESSION_ID_BYTES:
        raise ProtocolError("session id must be a 36 byte UUID")
    if len(data) > MAX_DATA:
        raise ProtocolError("data chunk exceeds the per-frame maximum")
    return encode_frame(tag, identifier + data)


def decode_data(payload: bytes) -> tuple[str, bytes]:
    if len(payload) < SESSION_ID_BYTES:
        raise ProtocolError("data frame is shorter than its session prefix")
    identifier = payload[:SESSION_ID_BYTES].decode("ascii", "replace")
    if not SESSION_ID_RE.fullmatch(identifier):
        raise ProtocolError("data frame carries an invalid session id")
    return identifier, payload[SESSION_ID_BYTES:]


class FrameDecoder:
    """Incremental decoder. Survives arbitrary fragmentation, including one byte at a time."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, chunk: bytes) -> list[tuple[int, bytes]]:
        self._buffer.extend(chunk)
        frames: list[tuple[int, bytes]] = []
        while True:
            if len(self._buffer) < 5:
                return frames
            tag = self._buffer[0]
            length = struct.unpack_from("!I", self._buffer, 1)[0]
            if length > MAX_FRAME:
                raise ProtocolError("peer announced a frame above the negotiated maximum")
            if len(self._buffer) < 5 + length:
                return frames
            frames.append((tag, bytes(self._buffer[5:5 + length])))
            del self._buffer[:5 + length]


# ---------------------------------------------------------------------------------------------
# Ticket verification
# ---------------------------------------------------------------------------------------------


def b64url_decode(text: str) -> bytes:
    # Unpadded base64url exactly as the gateway emits it: '-' and '_' are the URL-safe aliases of
    # '+' and '/', and the padding is restored here because base64 refuses a short final quantum.
    normalized = text.replace("-", "+").replace("_", "/")
    decoded = base64.b64decode(normalized + "=" * (-len(normalized) % 4))
    canonical = base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
    if canonical != text:
        raise ValueError("base64url segment is not canonical")
    return decoded


def verify_ticket(alias_key: bytes, ticket: str, now: float) -> dict[str, Any]:
    """Second, independent check: a compromised relay still cannot open a shell here.

    The relay already verified this ticket; the agent verifies it again with the per-alias key that
    only exists inside this container, so the relay is not trusted to name a target.
    """
    if not isinstance(ticket, str):
        raise TicketError("ticket_malformed")
    match = TICKET_RE.fullmatch(ticket)
    if not match:
        raise TicketError("ticket_malformed")
    encoded_payload, encoded_mac = match.group(1), match.group(2)
    try:
        signature = b64url_decode(encoded_mac)
    except ValueError:  # binascii.Error is a ValueError subclass
        # Do not expose whether a signature had bad alphabet, length or unused trailing bits.
        raise TicketError("ticket_bad_signature") from None
    expected = hmac.new(alias_key, ("v1." + encoded_payload).encode("ascii"), hashlib.sha256).digest()
    if len(signature) != len(expected) or not hmac.compare_digest(expected, signature):
        raise TicketError("ticket_bad_signature")
    try:
        payload = json.loads(b64url_decode(encoded_payload).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise TicketError("ticket_malformed") from None
    if not isinstance(payload, dict) or payload.get("v") != 1:
        raise TicketError("ticket_malformed")
    expires = payload.get("exp")
    if not isinstance(expires, (int, float)) or isinstance(expires, bool):
        raise TicketError("ticket_malformed")
    if now > float(expires) + CLOCK_SKEW:
        raise TicketError("ticket_expired")
    return payload


def authorize_ticket(payload: dict[str, Any], identity: dict[str, Any], session_id: str) -> str:
    """Every target field must name THIS container generation; anything else is refused."""
    if payload.get("sid") != session_id:
        raise TicketError("session_mismatch")
    target = payload.get("tgt")
    if not isinstance(target, dict):
        raise TicketError("ticket_malformed")
    for field, expected in (
        ("tenant", identity["tenant_id"]),
        ("alias", identity["alias"]),
        ("container", identity["container_id"]),
        ("generation", identity["generation"]),
        ("uid", identity["runtime_uid"]),
    ):
        if target.get(field) != expected:
            raise TicketError("target_mismatch", f"tgt.{field}")
    mode = payload.get("mode")
    if mode not in MODES:
        raise TicketError("mode_unknown")
    return mode


# ---------------------------------------------------------------------------------------------
# Bundle
# ---------------------------------------------------------------------------------------------


def load_bundle(path: str) -> dict[str, Any]:
    """Reads the launcher's drop file and unlinks it immediately: the alias key and the channel
    key must not survive one read, so a later exec inside the container finds nothing."""
    if not path.startswith("/"):
        raise PermanentError("bundle path must be absolute")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode):
            raise PermanentError("bundle must be a regular file")
        if status.st_uid != os.geteuid():
            raise PermanentError("bundle must be owned by the runtime user")
        if status.st_mode & 0o077:
            raise PermanentError("bundle must not be group or world readable")
        raw = os.read(descriptor, 1 << 20)
    finally:
        os.close(descriptor)
    try:
        os.unlink(path)
    except OSError as error:
        raise PermanentError(f"bundle could not be unlinked: {error.strerror}") from None
    try:
        document = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise PermanentError("bundle is not valid JSON") from None
    if not isinstance(document, dict):
        raise PermanentError("bundle must be an object")
    missing = [key for key in BUNDLE_KEYS if key not in document]
    if missing:
        raise PermanentError(f"bundle is missing keys: {' '.join(sorted(missing))}")
    return validate_bundle(document)


def validate_bundle(document: dict[str, Any]) -> dict[str, Any]:
    for key in ("tenant_id", "alias", "container_id", "generation", "runtime_user", "harness", "agent_version"):
        value = document.get(key)
        if not isinstance(value, str) or not IDENTITY_RE.fullmatch(value):
            raise PermanentError(f"bundle field is invalid: {key}")
    for key in ("runtime_uid", "runtime_gid", "relay_port"):
        value = document.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise PermanentError(f"bundle field is invalid: {key}")
    if document["runtime_uid"] == 0 or document["runtime_gid"] == 0:
        raise PermanentError("bundle declares a root runtime identity")
    if not 1 <= document["relay_port"] <= 65535:
        raise PermanentError("bundle field is invalid: relay_port")
    if not isinstance(document.get("home"), str) or not document["home"].startswith("/"):
        raise PermanentError("bundle field is invalid: home")
    if not isinstance(document.get("relay_host"), str) or not document["relay_host"]:
        raise PermanentError("bundle field is invalid: relay_host")
    try:
        key_material = bytes.fromhex(document.get("alias_key_hex", ""))
    except (TypeError, ValueError):
        raise PermanentError("bundle field is invalid: alias_key_hex") from None
    if len(key_material) != 32:
        raise PermanentError("bundle field is invalid: alias_key_hex")
    document["shell_candidates"] = _command_list(document.get("shell_candidates"), "shell_candidates")
    if document.get("harness_command") not in (None, "", []):
        document["harness_command"] = _command(document["harness_command"], "harness_command")
    else:
        document["harness_command"] = None
    document["openclaw_tui"] = _openclaw_tui_config(
        document.get("openclaw_tui"), document["harness"], document["home"]
    )
    document["tmux_tui"] = _tmux_tui_config(
        document.get("tmux_tui"), document["harness"], document["alias"]
    )
    document["runtime_facts"] = _runtime_facts_config(
        document.get("runtime_facts", {}), document["harness"], document["home"]
    )
    harness_resolvers = (
        document["harness_command"], document["openclaw_tui"], document["tmux_tui"],
    )
    if sum(value is not None for value in harness_resolvers) > 1:
        raise PermanentError("bundle defines multiple harness resolvers")
    for key in ("client_cert_pem", "client_key_pem", "ca_pem"):
        if not isinstance(document.get(key), str) or "-----BEGIN" not in document[key]:
            raise PermanentError(f"bundle field is invalid: {key}")
    return document


def _runtime_facts_config(value: Any, harness: str, home: str) -> dict[str, Any]:
    """Validate only non-secret paths measured from the live adapter environment.

    The object is optional during rolling upgrades. Profile roots must name a real alias-owned
    directory below HOME. Project context is different: a measured cwd/workspace can legitimately
    live at `/workspace`, outside HOME, but it must be canonical, non-symlinked, and an advertised
    workspace root must contain the measured cwd. The root `/` is never accepted.
    """
    # These facts enrich terminal presence; they are not the transport identity. A launcher from a
    # newer rolling release may publish an unknown optional fact and a measured directory can
    # disappear between bundle assembly and agent startup. Neither event may permanently stop the
    # shell. Ignore an unrecognised document and let the gateway render context as unmeasured.
    if not isinstance(value, dict) or not set(value).issubset(RUNTIME_FACT_KEYS):
        return {}
    expected = {
        "codex": "codex_home",
        "claude": "claude_config_dir",
        "openclaw": "openclaw_workspace",
    }.get(harness)
    profile_keys = {"codex_home", "claude_config_dir", "openclaw_workspace"}
    if any(key in profile_keys and key != expected for key in value):
        return {}
    validated: dict[str, Any] = {}
    normalized_home = os.path.normpath(home)
    for key in RUNTIME_PATH_FACT_KEYS.intersection(value):
        path = value[key]
        if (not isinstance(path, str) or not path.startswith("/") or path == "/"
                or len(path) > MAX_READ_PATH or "\0" in path or os.path.normpath(path) != path):
            return {}
        try:
            details = os.lstat(path)
        except (OSError, ValueError):
            return {}
        if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode) \
                or os.path.realpath(path) != path:
            return {}
        if key in profile_keys:
            try:
                contained = os.path.commonpath((normalized_home, path)) == normalized_home
            except ValueError:
                contained = False
            if not contained or details.st_uid != os.geteuid():
                return {}
        validated[key] = path
    workspace_root = validated.get("workspace_root")
    cwd = validated.get("cwd")
    if workspace_root is not None and cwd is None:
        for key in ("cwd", "workspace_root", "project_root"):
            validated.pop(key, None)
    elif workspace_root is not None and cwd is not None:
        try:
            contains_cwd = os.path.commonpath((workspace_root, cwd)) == workspace_root
        except ValueError:
            contains_cwd = False
        if not contains_cwd:
            for key in ("cwd", "workspace_root", "project_root"):
                validated.pop(key, None)
    project_root = validated.get("project_root")
    if project_root is not None and cwd is None:
        for key in ("cwd", "workspace_root", "project_root"):
            validated.pop(key, None)
    elif project_root is not None and cwd is not None:
        try:
            contains_cwd = os.path.commonpath((project_root, cwd)) == project_root
            inside_workspace = workspace_root is None \
                or os.path.commonpath((workspace_root, project_root)) == workspace_root
        except ValueError:
            contains_cwd = False
            inside_workspace = False
        if not contains_cwd or not inside_workspace:
            for key in ("cwd", "workspace_root", "project_root"):
                validated.pop(key, None)

    # Codex exposes exactly this pair from config.toml. It is optional and all-or-nothing: an old
    # agent, a partial rollout, a malformed type or one secret-looking fallback simply omits the
    # pair while preserving independently valid path facts and terminal identity.
    maximum_present = "project_doc_max_bytes" in value
    fallbacks_present = "project_doc_fallback_filenames" in value
    maximum = value.get("project_doc_max_bytes")
    fallbacks = value.get("project_doc_fallback_filenames")
    if harness == "codex" and maximum_present and fallbacks_present \
            and isinstance(maximum, int) and not isinstance(maximum, bool) \
            and 1 <= maximum <= PROJECT_DOC_MAX_BYTES_LIMIT \
            and isinstance(fallbacks, list) and len(fallbacks) <= PROJECT_DOC_FALLBACK_LIMIT:
        safe_fallbacks: list[str] = []
        seen = {"agents.override.md", "agents.md"}
        for name in fallbacks:
            if not _valid_project_doc_fallback(name, seen):
                break
            seen.add(name.casefold())
            safe_fallbacks.append(name)
        else:
            validated["project_doc_max_bytes"] = maximum
            validated["project_doc_fallback_filenames"] = safe_fallbacks
    return validated


def _valid_project_doc_fallback(value: Any, seen: set[str] | None = None) -> bool:
    """A Codex fallback is one bounded basename, never a path or credential-shaped file."""
    if not isinstance(value, str) or not value:
        return False
    try:
        # JavaScript's String.length counts UTF-16 code units. Match the gateway exactly so a
        # fallback cannot be accepted by one leg and silently dropped by the next.
        js_length = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return False
    if js_length > 128:
        return False
    if value in (".", "..") or ".." in value or "/" in value or "\\" in value or "\0" in value:
        return False
    if any(ord(character) <= 0x1f or ord(character) == 0x7f for character in value):
        return False
    normalized = value.casefold()
    if normalized in NEVER_SERVE_BASENAMES or normalized.endswith(NEVER_SERVE_SUFFIXES):
        return False
    if seen is not None and normalized in seen:
        return False
    return True


def _command(value: Any, label: str) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value:
        raise PermanentError(f"bundle field is invalid: {label}")
    argv = []
    for item in value:
        if not isinstance(item, str) or not item or "\x00" in item:
            raise PermanentError(f"bundle field is invalid: {label}")
        argv.append(item)
    if not argv[0].startswith("/"):
        raise PermanentError(f"bundle field must name an absolute executable: {label}")
    return argv


def _command_list(value: Any, label: str) -> list[list[str]]:
    if not isinstance(value, list) or not value:
        raise PermanentError(f"bundle field is invalid: {label}")
    return [_command(item, label) for item in value]


def _openclaw_tui_config(value: Any, harness: str, home: str) -> dict[str, Any] | None:
    if value in (None, "", {}):
        return None
    if harness != "openclaw" or not isinstance(value, dict):
        raise PermanentError("bundle field is invalid: openclaw_tui")
    if set(value) != {"node", "entry", "state_directory", "history_limit"}:
        raise PermanentError("bundle field is invalid: openclaw_tui")
    node = value.get("node")
    entry = value.get("entry")
    state_directory = value.get("state_directory")
    history_limit = value.get("history_limit")
    for path in (node, entry, state_directory):
        if not isinstance(path, str) or not os.path.isabs(path) or "\x00" in path:
            raise PermanentError("bundle field is invalid: openclaw_tui")
        if os.path.normpath(path) != path:
            raise PermanentError("bundle field is invalid: openclaw_tui")
    try:
        contained = os.path.commonpath((home, state_directory)) == os.path.normpath(home)
    except ValueError:
        contained = False
    if not contained:
        raise PermanentError("bundle field is invalid: openclaw_tui")
    if not isinstance(history_limit, int) or isinstance(history_limit, bool) or not 1 <= history_limit <= 10000:
        raise PermanentError("bundle field is invalid: openclaw_tui")
    return {
        "node": node,
        "entry": entry,
        "state_directory": state_directory,
        "history_limit": history_limit,
    }


def _tmux_tui_config(value: Any, harness: str, alias: str) -> dict[str, str] | None:
    """Validate the tiny descriptor used to resolve a shared tmux TUI on every OPEN.

    No session id is persisted here: tmux ids are only stable for one server lifetime and are
    reused after a server restart.  The eventual argv performs identity checks and attach as one
    command in the current tmux server, so a stale bundle can never retarget another alias.
    """
    if value in (None, "", {}):
        return None
    if harness not in ("claude", "codex") or not isinstance(value, dict):
        raise PermanentError("bundle field is invalid: tmux_tui")
    if set(value) != {"path", "socket"} or not TMUX_IDENTITY_RE.fullmatch(alias):
        raise PermanentError("bundle field is invalid: tmux_tui")
    path = value.get("path")
    socket_name = value.get("socket")
    if (not isinstance(path, str) or not os.path.isabs(path) or "\x00" in path
            or os.path.normpath(path) != path
            or not isinstance(socket_name, str) or not TMUX_SOCKET_RE.fullmatch(socket_name)):
        raise PermanentError("bundle field is invalid: tmux_tui")
    try:
        details = os.stat(path, follow_symlinks=False)
    except OSError:
        raise PermanentError("bundle tmux executable is unavailable") from None
    if (not stat.S_ISREG(details.st_mode) or details.st_uid != 0
            or details.st_mode & 0o022 or not os.access(path, os.X_OK)):
        raise PermanentError("bundle tmux executable is unsafe")
    return {"path": path, "socket": socket_name}


def resolve_tmux_tui_command(bundle: dict[str, Any]) -> list[str] | None:
    """Build one fail-closed tmux command that validates and attaches on the same server.

    `if-shell -F` evaluates the target formats and executes `attach-session` inside one tmux
    command. If the server was restarted, the mutable name was reused, a marker changed, or the
    pane died, the false branch exits 77. There is no preflight/attach TOCTOU and no frozen `$N`.
    """
    config = bundle.get("tmux_tui")
    if not isinstance(config, dict):
        return None
    alias = bundle["alias"]
    harness = bundle["harness"]
    if not TMUX_IDENTITY_RE.fullmatch(alias) or harness not in ("claude", "codex"):
        return None
    target = f"cauce-{alias}:tui"
    conditions = (
        f"#{{&&:#{{==:#{{session_name}},cauce-{alias}}},"
        f"#{{&&:#{{==:#{{window_name}},tui}},"
        f"#{{&&:#{{==:#{{window_panes}},1}},"
        f"#{{&&:#{{==:#{{@cauce_alias}},{alias}}},"
        f"#{{&&:#{{==:#{{@cauce_harness}},{harness}}},"
        "#{==:#{pane_dead},0}}}}}}}}}}"
    )
    attach = f"attach-session -r -f ignore-size -t {target}"
    return [
        config["path"], "-L", config["socket"],
        "if-shell", "-F", "-t", target, conditions, attach, 'run-shell "exit 77"',
    ]


def resolve_openclaw_tui_command(bundle: dict[str, Any]) -> list[str] | None:
    """Resuelve en cada OPEN el pointer durable de la sesión compartida; nunca usa mtime.

    `sessions.json` lo escribe el adapter con rename atómico y modo 0600. Se abre sin seguir el
    enlace final y se valida antes de mirar la única entrada canónica. El native id sólo vuelve como
    elemento de argv: no se registra ni se incorpora a presencia.
    """
    config = bundle.get("openclaw_tui")
    if not isinstance(config, dict):
        return None
    state_directory = config["state_directory"]
    try:
        directory_status = os.lstat(state_directory)
    except OSError:
        return None
    if (not stat.S_ISDIR(directory_status.st_mode)
            or directory_status.st_uid != os.geteuid()
            or directory_status.st_mode & 0o022
            or os.path.realpath(state_directory) != state_directory):
        return None
    path = os.path.join(state_directory, "sessions.json")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or info.st_mode & 0o777 != 0o600
                or info.st_nlink != 1
                or info.st_size > MAX_SESSION_STORE_BYTES):
            return None
        chunks = bytearray()
        while len(chunks) <= MAX_SESSION_STORE_BYTES:
            chunk = os.read(descriptor, min(65536, MAX_SESSION_STORE_BYTES + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        if len(chunks) > MAX_SESSION_STORE_BYTES:
            return None
    finally:
        os.close(descriptor)
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        document: dict[str, Any] = {}
        for key, value in pairs:
            if key in document:
                raise ValueError("duplicate key")
            document[key] = value
        return document

    try:
        document = json.loads(
            bytes(chunks).decode("utf-8"), object_pairs_hook=reject_duplicates
        )
    except (ValueError, UnicodeDecodeError):
        return None
    if (not isinstance(document, dict) or set(document) != {"version", "sessions"}
            or document.get("version") != 1 or not isinstance(document.get("sessions"), dict)
            or len(document["sessions"]) > 4096):
        return None
    alias = bundle["alias"]
    # The key is deterministic and derived locally; it does not arrive via OPEN nor is it printed.
    pointer = document["sessions"].get(f"openclaw:{alias}:shared:{alias}")
    if not isinstance(pointer, dict):
        return None
    if set(pointer) not in ({"native_id", "initialized"}, {"native_id", "initialized", "origin"}):
        return None
    native_id = pointer.get("native_id")
    if (not isinstance(native_id, str) or not OPENCLAW_NATIVE_SESSION_RE.fullmatch(native_id)
            or pointer.get("initialized") is not True):
        return None
    return [
        config["node"], config["entry"], "tui", "--session", native_id,
        "--history-limit", str(config["history_limit"]),
    ]


# ---------------------------------------------------------------------------------------------
# PTY sessions
# ---------------------------------------------------------------------------------------------


class PtySession:
    def __init__(self, session_id: str, pid: int, fd: int, mode: str, argv: list[str]) -> None:
        self.session_id = session_id
        self.pid = pid
        self.fd = fd
        self.mode = mode
        self.argv = argv
        self.out = bytearray()
        self.pending_input = bytearray()
        self.output_paused = False
        # Logged once per session: a viewer receives keystrokes in bursts and the journal must not
        # become the echo of the operator's keyboard.
        self.refused_input = False
        self.last_flush = time.monotonic()
        self.eof = False
        self.reaped = False
        self.exit_code: int | None = None
        self.exit_signal: int | None = None
        self.kill_deadline: float | None = None
        self.close_reason: str | None = None


class GovernanceWrite:
    """Una escritura correlacionada y acotada que todavía no llegó completa."""

    def __init__(
        self,
        request_id: str,
        path: str,
        operation: str,
        expected_sha: str | None,
        content_sha: str,
        content_bytes: int,
        chunks: int,
    ) -> None:
        self.request_id = request_id
        self.path = path
        self.operation = operation
        self.expected_sha = expected_sha
        self.content_sha = content_sha
        self.content_bytes = content_bytes
        self.chunks = chunks
        self.received_chunks = 0
        self.content = bytearray()


class GovernanceBatchEntry:
    def __init__(
        self,
        path: str,
        mode: str,
        operation: str,
        expected_sha: str | None,
        content_sha: str | None,
        content_bytes: int,
        chunks: int,
    ) -> None:
        self.path = path
        self.mode = mode
        self.operation = operation
        self.expected_sha = expected_sha
        self.content_sha = content_sha
        self.content_bytes = content_bytes
        self.chunks = chunks
        self.received_chunks = 0
        self.content = bytearray()


class GovernanceWriteBatch:
    def __init__(self, request_id: str, entries: list[GovernanceBatchEntry]) -> None:
        self.request_id = request_id
        self.entries = entries

    def receiving_entry(self) -> GovernanceBatchEntry | None:
        return next((entry for entry in self.entries if entry.received_chunks < entry.chunks), None)

    def complete(self) -> bool:
        return all(entry.received_chunks == entry.chunks for entry in self.entries)


def set_window_size(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _window(request: dict[str, Any]) -> tuple[int, int]:
    rows = request.get("rows", 24)
    cols = request.get("cols", 80)
    if not isinstance(rows, int) or isinstance(rows, bool):
        raise ProtocolError("window rows must be an integer")
    if not isinstance(cols, int) or isinstance(cols, bool):
        raise ProtocolError("window cols must be an integer")
    return min(MAX_ROWS, max(MIN_ROWS, rows)), min(MAX_COLS, max(MIN_COLS, cols))


def is_terminal_emulator_response(data: bytes) -> bool:
    """DA/DSR solamente. Acepta concatenacion, rechaza ANSI generico, texto y bytes no ASCII."""
    if not data or len(data) > MAX_TERMINAL_RESPONSE_BYTES or not data.isascii():
        return False
    pending = data
    while pending:
        fixed = next((item for item in TERMINAL_FIXED_RESPONSES if pending.startswith(item)), None)
        if fixed is not None:
            pending = pending[len(fixed):]
            continue
        cursor = TERMINAL_CURSOR_RESPONSE_RE.match(pending)
        if cursor is None:
            return False
        if int(cursor.group(1)) > MAX_ROWS or int(cursor.group(2)) > MAX_COLS:
            return False
        pending = pending[cursor.end():]
    return True


def _cloexec(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFD)
    fcntl.fcntl(fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)


class PtyAgent:
    def __init__(self, bundle: dict[str, Any]) -> None:
        self.bundle = bundle
        self.alias_key = bytes.fromhex(bundle["alias_key_hex"])
        self.identity = {
            "tenant_id": bundle["tenant_id"],
            "alias": bundle["alias"],
            "container_id": bundle["container_id"],
            "generation": bundle["generation"],
            "runtime_uid": bundle["runtime_uid"],
        }
        self.modes = self._advertised_modes()
        self.sessions: dict[str, PtySession] = {}
        self.pending_writes: dict[str, GovernanceWrite] = {}
        self.pending_write_batches: dict[str, GovernanceWriteBatch] = {}
        self.tombstones: dict[str, float] = {}
        self.connection: ssl.SSLSocket | None = None
        self.outbound = bytearray()
        self.decoder = FrameDecoder()
        self.acknowledged = False
        self.connected_at = 0.0
        self.last_ping = 0.0
        self.next_dynamic_capability_check = 0.0
        self.stopping = False

    def _advertised_modes(self) -> list[str]:
        static_or_tmux = any((self.bundle.get("harness_command"), self.bundle.get("tmux_tui")))
        openclaw_ready = (
            self.bundle.get("openclaw_tui") is not None
            and resolve_openclaw_tui_command(self.bundle) is not None
        )
        return ["shell"] + (["harness"] if static_or_tmux or openclaw_ready else [])

    # -- connection lifecycle ------------------------------------------------------------------

    def run(self) -> int:
        context = self._tls_context()
        backoff = BACKOFF_MIN
        while not self.stopping:
            try:
                connection = self._connect(context)
            except (OSError, ssl.SSLError) as error:
                log(f"relay connect failed: {type(error).__name__}")
            else:
                try:
                    self._serve(connection)
                    backoff = BACKOFF_MIN
                except (OSError, ssl.SSLError, ProtocolError) as error:
                    log(f"relay session ended: {type(error).__name__}: {error}")
                    if self.acknowledged:
                        backoff = BACKOFF_MIN
                finally:
                    self._teardown(connection)
            if self.stopping:
                break
            time.sleep(backoff + self._jitter(backoff))
            backoff = min(BACKOFF_MAX, backoff * 2)
        self._terminate_sessions()
        self.pending_writes.clear()
        self.pending_write_batches.clear()
        return 0

    @staticmethod
    def _jitter(backoff: float) -> float:
        # os.urandom keeps the dependency surface at the modules the container is guaranteed to
        # have; a quarter of the current backoff is enough to de-synchronise 14 agents.
        return (struct.unpack("!H", os.urandom(2))[0] / 65535.0) * min(1.0, backoff * 0.25)

    def _tls_context(self) -> ssl.SSLContext:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.verify_mode = ssl.CERT_REQUIRED
        context.check_hostname = True
        context.load_verify_locations(cadata=self.bundle["ca_pem"])
        # load_cert_chain only takes paths, so the PEMs land in a 0700 private directory for the
        # duration of one load and are unlinked before anything else can run.
        directory = tempfile.mkdtemp(prefix=".cauce-pty-tls-")
        certificate = os.path.join(directory, "client.crt")
        key = os.path.join(directory, "client.key")
        try:
            for path, body in ((certificate, self.bundle["client_cert_pem"]), (key, self.bundle["client_key_pem"])):
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    stream.write(body)
            context.load_cert_chain(certificate, key)
        finally:
            for path in (certificate, key):
                try:
                    os.unlink(path)
                except OSError:
                    pass
            os.rmdir(directory)
        return context

    def _connect(self, context: ssl.SSLContext) -> ssl.SSLSocket:
        host = self.bundle["relay_host"]
        port = self.bundle["relay_port"]
        server_hostname = self.bundle.get("relay_server_name") or host
        raw = socket.create_connection((host, port), timeout=20)
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        connection = context.wrap_socket(raw, server_hostname=server_hostname)
        _cloexec(connection.fileno())
        connection.setblocking(False)
        log(f"relay connected: {host}:{port} alias={self.bundle['alias']}")
        return connection

    def _teardown(self, connection: ssl.SSLSocket) -> None:
        try:
            connection.close()
        except OSError:
            pass
        self.connection = None
        self.outbound = bytearray()
        self.decoder = FrameDecoder()
        self.acknowledged = False
        self.pending_writes.clear()
        self.pending_write_batches.clear()
        # The relay is the only path to the operator: if it disappears (container stopped, network
        # cut) the shells it fronted are unreachable, so they are terminated instead of orphaned.
        self._terminate_sessions()

    # -- main loop -----------------------------------------------------------------------------

    def _serve(self, connection: ssl.SSLSocket) -> None:
        self.connection = connection
        self.connected_at = time.monotonic()
        self.last_ping = self.connected_at
        # The pointer may have changed between the launcher's bundle and the relay connection.
        # Presence is born from the current observation, not from an OpenClaw binary existing.
        self.modes = self._advertised_modes()
        self.next_dynamic_capability_check = self.connected_at + DYNAMIC_CAPABILITY_CHECK_INTERVAL
        self._queue(encode_json(TAG_AGENT_HELLO, {
            "v": AGENT_PROTOCOL_VERSION,
            "tenant_id": self.bundle["tenant_id"],
            "alias": self.bundle["alias"],
            "container_id": self.bundle["container_id"],
            "generation": self.bundle["generation"],
            "image_id": self.bundle["image_id"],
            "runtime_user": self.bundle["runtime_user"],
            "runtime_uid": self.bundle["runtime_uid"],
            "harness": self.bundle["harness"],
            # The alias HOME, known to the agent from launch and previously NOT published.
            # Without it, the gateway's `MeasuredFactsSource` has no source and the entire document
            # channel (read/edit an agent's CLAUDE.md from the console) answers "unmeasured"
            # forever: there is no way to know WHICH file is "the directive" for this alias without
            # knowing where its harness lives. Deducing it from the registry is not enough:
            # the registry once picked the wrong harness for 5 of 14 aliases, so it would
            # serve another harness's file.
            # The agent is the only piece that truly knows it: it reads it from the bundle it was
            # launched with, inside the container. It goes here, not in the gateway `.env`, for
            # the same reason as `harness`: the one with the data in front is the one who says it.
            "home": self.bundle["home"],
            # `harness` and `home` identify the configured container, but they do not prove that
            # the adapter process was alive and measured.  Keep that distinction explicit so an
            # empty recovery bundle cannot be promoted to measured context by downstream defaults.
            "runtime_facts_observed": bool(self.bundle["runtime_facts"]),
            **self.bundle["runtime_facts"],
            "agent_version": self.bundle["agent_version"],
            "modes": self.modes,
            # The relay does NOT send TAG_READ to an agent that does not advertise it. An older
            # agent treats an unknown tag as a protocol violation and drops the connection (see
            # `_dispatch`), so without this declaration deploying the relay before the agent would
            # leave terminals down across the whole fleet.
            "features": list(FEATURES),
        }))
        while not self.stopping:
            self._pump_writes()
            readable: list[Any] = [connection]
            writable: list[Any] = [connection] if self.outbound else []
            for session in self.sessions.values():
                if not session.eof and not session.output_paused and len(session.out) < SESSION_HIGH_WATER:
                    readable.append(session.fd)
                if session.pending_input:
                    writable.append(session.fd)
            ready_read, ready_write, _ = select.select(readable, writable, [], self._timeout())
            if connection in ready_read or connection.pending():
                self._read_relay(connection)
            for session in list(self.sessions.values()):
                if session.fd in ready_write:
                    self._write_session(session)
                if session.fd in ready_read and not session.output_paused:
                    self._read_session(session)
            self._maintain()

    def _timeout(self) -> float:
        now = time.monotonic()
        deadlines = [self.last_ping + PING_TIMEOUT]
        if not self.acknowledged:
            deadlines.append(self.connected_at + HELLO_TIMEOUT)
        for session in self.sessions.values():
            if session.out and not session.output_paused:
                deadlines.append(session.last_flush + FLUSH_INTERVAL)
            if session.kill_deadline is not None:
                deadlines.append(session.kill_deadline)
            if session.eof and not session.reaped:
                deadlines.append(now + 0.05)  # poll waitpid until the child is actually gone
        deadlines.extend(self.tombstones.values())
        return max(0.0, min(SELECT_CEILING, min(deadlines) - now))

    def _queue(self, frame: bytes) -> None:
        self.outbound.extend(frame)

    def _pump_writes(self) -> None:
        connection = self.connection
        while self.outbound and connection is not None:
            try:
                sent = connection.send(bytes(self.outbound[:MAX_FRAME]))
            except (ssl.SSLWantReadError, ssl.SSLWantWriteError):
                return
            except BlockingIOError:
                return
            if sent <= 0:
                return
            del self.outbound[:sent]

    def _read_relay(self, connection: ssl.SSLSocket) -> None:
        while True:
            try:
                chunk = connection.recv(MAX_FRAME)
            except (ssl.SSLWantReadError, ssl.SSLWantWriteError, BlockingIOError):
                return
            if not chunk:
                raise ConnectionResetError("relay closed the connection")
            for tag, payload in self.decoder.feed(chunk):
                self._dispatch(tag, payload)
            if not connection.pending():
                return

    def _dispatch(self, tag: int, payload: bytes) -> None:
        if tag in PREFIXED_TAGS:
            if tag not in (TAG_STDIN, TAG_TERMINAL_RESPONSE, TAG_WRITE_DATA, TAG_WRITE_BATCH_DATA):
                raise ProtocolError("relay sent a response-only data frame")
            session_id, data = decode_data(payload)
            if tag == TAG_STDIN:
                self._on_stdin(session_id, data)
            elif tag == TAG_TERMINAL_RESPONSE:
                self._on_terminal_response(session_id, data)
            elif tag == TAG_WRITE_DATA:
                self._on_write_data(session_id, data)
            else:
                self._on_write_batch_data(session_id, data)
            return
        if tag == TAG_PING:
            # Answered even before the ack: the relay's keepalive timer is global and must not be
            # able to make a perfectly healthy agent look silent.
            #
            # PING and PONG are EMPTY control frames. The relay writes `encodeFrame(FRAME_TAGS.PING)`
            # with no payload and ignores whatever a PONG carries, so decoding the payload as JSON
            # here killed every healthy connection ten seconds after the hello was accepted.
            self.last_ping = time.monotonic()
            self._queue(encode_frame(TAG_PONG, b""))
            return
        document = self._json(payload)
        if tag == TAG_HELLO_ACK:
            if not document.get("ok", False):
                raise ProtocolError(f"relay refused the hello: {document.get('reason', 'unknown')}")
            self.acknowledged = True
            log(f"relay accepted alias={self.bundle['alias']} modes={','.join(self.modes)}")
            return
        if not self.acknowledged:
            raise ProtocolError("relay sent traffic before the hello was acknowledged")
        if tag == TAG_OPEN:
            self._on_open(document)
        elif tag == TAG_READ:
            self._on_read(document)
        elif tag == TAG_WRITE:
            self._on_write(document)
        elif tag == TAG_WRITE_CANCEL:
            self._on_write_cancel(document)
        elif tag == TAG_WRITE_BATCH:
            self._on_write_batch(document)
        elif tag == TAG_WRITE_BATCH_CANCEL:
            self._on_write_batch_cancel(document)
        elif tag == TAG_RESIZE:
            self._on_resize(document)
        elif tag == TAG_CLOSE:
            self._on_close(document)
        elif tag == TAG_PAUSE_OUTPUT:
            self._on_output_flow(document, True)
        elif tag == TAG_RESUME_OUTPUT:
            self._on_output_flow(document, False)
        else:
            raise ProtocolError(f"relay sent an unsupported tag: 0x{tag:02x}")

    @staticmethod
    def _json(payload: bytes) -> dict[str, Any]:
        try:
            document = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ProtocolError("control frame is not valid JSON") from None
        if not isinstance(document, dict):
            raise ProtocolError("control frame must be an object")
        return document

    # -- request handlers ----------------------------------------------------------------------

    def _on_open(self, request: dict[str, Any]) -> None:
        session_id = request.get("session_id")
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            raise ProtocolError("OPEN carries an invalid session id")
        if session_id in self.sessions or session_id in self.tombstones:
            self._open_error(session_id, "duplicate_session")
            return
        try:
            payload = verify_ticket(self.alias_key, request.get("ticket"), time.time())
            mode = authorize_ticket(payload, self.identity, session_id)
        except TicketError as error:
            log(f"OPEN refused session={session_id} reason={error.reason} {error.detail}".rstrip())
            self._open_error(session_id, error.reason, error.detail)
            return
        # The browser never names a container, a user or a command: the mode comes from the signed
        # ticket and the argv comes from the bundle the launcher wrote inside the container.
        if request.get("mode") not in (None, mode):
            self._open_error(session_id, "mode_mismatch")
            return
        if len(self.sessions) >= MAX_SESSIONS:
            self._open_error(session_id, "too_many_sessions")
            return
        argv = self._resolve_command(mode)
        if argv is None:
            self._open_error(session_id, "mode_unavailable")
            return
        rows, cols = _window(request)
        try:
            session = self._spawn(session_id, mode, argv, rows, cols)
        except OSError as error:
            log(f"OPEN spawn failed session={session_id} errno={errno.errorcode.get(error.errno, error.errno)}")
            self._open_error(session_id, "spawn_failed")
            return
        self.sessions[session_id] = session
        self._queue(encode_json(TAG_OPEN_OK, {
            "session_id": session_id,
            "mode": mode,
            "pid": session.pid,
            "container_id": self.bundle["container_id"],
            "generation": self.bundle["generation"],
            "image_id": self.bundle["image_id"],
            "runtime_user": self.bundle["runtime_user"],
            "runtime_uid": self.bundle["runtime_uid"],
            "exp": payload.get("exp"),
            "rows": rows,
            "cols": cols,
        }))
        log(f"OPEN accepted session={session_id} mode={mode} pid={session.pid} argv0={argv[0]}")

    def _open_error(self, session_id: str, reason: str, detail: str = "") -> None:
        document: dict[str, Any] = {"session_id": session_id, "reason": reason}
        if detail:
            document["detail"] = detail
        self._queue(encode_json(TAG_OPEN_ERR, document))

    # -- lectura de ficheros de gobierno -------------------------------------------------------

    def _on_read(self, request: dict[str, Any]) -> None:
        """TAG_READ: entrega un manual del sitio, o el indice de memoria. Falla CERRADO.

        Nada de lo que llega por aqui abre un proceso ni pasa por un shell: se valida una ruta y se
        lee. Un rechazo se contesta con TAG_READ_ERR y la conexion sigue viva; solo un
        `request_id` mal formado es violacion de protocolo, porque sin el no hay a quien contestar.
        """
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("READ carries an invalid request id")
        kind = request.get("kind")
        if kind not in READ_KINDS:
            self._read_error(request_id, "invalid_path", "kind must be file or dir")
            return
        # The reply can weigh 256 KB. If the outbound queue is already loaded, reject instead of
        # inverting the pressure onto the terminals, which are what truly cannot wait.
        if len(self.outbound) > OUTBOUND_HIGH_WATER:
            self._read_error(request_id, "unavailable", "outbound queue is congested")
            return
        path = request.get("path")
        verdict = self._validate_read_path(path, kind)
        if verdict is not None:
            self._read_error(request_id, verdict[0], verdict[1])
            return
        try:
            if kind == "file":
                self._send_document(request_id, path)
            else:
                self._send_memory_index(request_id, path)
            self._queue(encode_json(TAG_READ_DONE, {"request_id": request_id}))
        except ReadSymlinkError:
            self._read_error(request_id, "symlink_detected", "path contains a symbolic link")
        except ReadPathTypeError:
            self._read_error(request_id, "invalid_path", "path component has the wrong type")
        except PermissionError:
            self._read_error(request_id, "permission_denied", "permission denied")
        except FileNotFoundError:
            # Legitimate race: existed at validation and no longer does. Counted as what it is.
            self._read_error(request_id, "not_found", "vanished while being read")
        except OSError as error:
            self._read_error(request_id, "unknown", f"read failed: {type(error).__name__}")

    def _validate_read_path(self, path: Any, kind: str) -> tuple[str, str] | None:
        """`None` = se puede leer. Si no, `(codigo, motivo)`.

        El orden importa: primero lo sintactico (barato y sin tocar el disco), despues la lista
        blanca, despues la contencion, y solo al final se pregunta al sistema de ficheros. Asi una
        ruta prohibida se rechaza sin que su existencia se pueda deducir del tiempo de respuesta.
        """
        if not isinstance(path, str) or not path:
            return ("invalid_path", "path is required")
        if len(path) > MAX_READ_PATH:
            return ("invalid_path", "path is too long")
        if "\0" in path:
            return ("invalid_path", "path carries a null byte")
        if not path.startswith("/"):
            return ("invalid_path", "path is not absolute")
        segments = path.split("/")
        # Canonical form required: no `..`, `.`, double slashes, or trailing slash. Any other
        # form is rejected rather than normalised, because normalisation is exactly where the
        # differences between what the gateway validates and what the agent opens show up.
        if ".." in segments or "." in segments or "" in segments[1:]:
            return ("invalid_path", "path is not canonical")
        if kind == "dir":
            memory_root = self._memory_root_for_harness()
            if memory_root is None or path != memory_root:
                return ("permission_denied", "path is not the measured memory root")
            home = str(self.bundle["home"]).rstrip("/") or "/"
            if home == "/" or not memory_root.startswith(home + "/"):
                return ("permission_denied", "measured memory root is outside the agent home")
            return None

        base = segments[-1]
        normalized_base = base.casefold()
        if normalized_base in NEVER_SERVE_BASENAMES:
            return ("permission_denied", f"{base} is never served")
        if normalized_base.endswith(NEVER_SERVE_SUFFIXES):
            return ("permission_denied", "looks like credential material")
        if not self._is_readable_governance_file_path(path):
            return ("permission_denied", f"{base} is not a governance document")
        # Project manuals may live in `/workspace`, outside HOME. They are not authorised by a
        # broad containment rule: the exact list above comes from the measured cwd/root. Profile
        # documents remain confined to HOME, also when a test builds the bundle by hand.
        if not self._is_project_manual_path(path):
            home = str(self.bundle["home"]).rstrip("/")
            if not home.startswith("/") or (path != home and not path.startswith(home + "/")):
                return ("permission_denied", "path is outside the agent home")
        # `realpath` resolves ALL components, so this also catches a symlinked parent directory —
        # which is exactly the vector a name blacklist misses.
        try:
            resolved = os.path.realpath(path)
        except OSError:
            return ("unknown", "path could not be resolved")
        if resolved != path:
            return ("symlink_detected", "path resolves somewhere else")
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return ("not_found", "no such file")
        except PermissionError:
            return ("permission_denied", "permission denied")
        except OSError:
            return ("unknown", "stat failed")
        if not stat.S_ISREG(info.st_mode):
            return ("invalid_path", "not a regular file")
        return None

    def _send_document(self, request_id: str, path: str) -> None:
        directory, basename = self._open_governance_parent(path)
        descriptor = os.open(basename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                raise PermissionError("governance target is not a regular file")
            digest = hashlib.sha256()
            raw = bytearray()
            while True:
                chunk = os.read(descriptor, 64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                if len(raw) < MAX_DOCUMENT_BYTES:
                    raw.extend(chunk[:MAX_DOCUMENT_BYTES - len(raw)])
            info = os.fstat(descriptor)
            identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            identity_after = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if identity_before != identity_after:
                raise OSError("governance file changed while being read")
        finally:
            os.close(descriptor)
            os.close(directory)
        truncated = info.st_size > MAX_DOCUMENT_BYTES
        # Always send valid UTF-8: a byte-wise cut can split a character in half and the relay and
        # gateway decode with no network. A non-text file is sent with replacements, it does not
        # crash the read.
        payload = bytes(raw).decode("utf-8", "replace").encode("utf-8")
        if len(payload) > MAX_DOCUMENT_BYTES:
            payload = payload[:MAX_DOCUMENT_BYTES].decode("utf-8", "ignore").encode("utf-8")
            truncated = True
        chunks = [payload[offset:offset + MAX_DATA] for offset in range(0, len(payload), MAX_DATA)]
        self._queue(encode_json(TAG_READ_OK, {
            "request_id": request_id,
            "kind": "file",
            "path": path,
            # TRUE size of the file, even when the text is truncated: the viewer must be able to
            # see that what they read is not everything.
            "bytes": info.st_size,
            "truncated": truncated,
            "modified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(info.st_mtime)),
            # Hash of the REAL bytes. For a truncated file it is not the hash of the prefix that
            # travels: the UI never edits it, but it can still identify which version was observed.
            "sha": digest.hexdigest(),
            "chunks": len(chunks),
        }))
        for chunk in chunks:
            self._queue(encode_data(TAG_READ_DATA, request_id, chunk))

    def _send_memory_index(self, request_id: str, root: str) -> None:
        """Indice de memoria: sale METADATO, nunca contenido.

        La raiz se abre una sola vez desde HOME, componente por componente con openat(2). Desde
        ahi el barrido usa exclusivamente descriptores: un rename+symlink entre el descubrimiento
        y la recursion no puede redirigirnos fuera de la memoria medida.
        """
        found: list[tuple[str, int, float]] = []
        capped = False
        scanned = 0
        root_fd = self._open_memory_root(root)

        def walk(directory: int, current: str, depth: int) -> None:
            nonlocal capped, scanned
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        # The cap counts inspected entries, not just publishable files.
                        # Otherwise thousands of directories, sockets, or secret names would make
                        # the scan unbounded even when `found` never grew.
                        if scanned >= DIR_SCAN_CAP:
                            capped = True
                            return
                        scanned += 1
                        name = entry.name
                        normalized_name = name.casefold()
                        if not self._safe_memory_entry_name(name):
                            continue
                        if (normalized_name in NEVER_SERVE_BASENAMES
                                or normalized_name.endswith(NEVER_SERVE_SUFFIXES)):
                            continue
                        logical_path = f"{current}/{name}"
                        if len(logical_path.encode("utf-8")) > MAX_READ_PATH:
                            continue
                        try:
                            discovered = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        except OSError:
                            continue
                        # Symlinks are neither followed nor named: the name of a symlink already
                        # tells that something exists on the other side.
                        if stat.S_ISLNK(discovered.st_mode):
                            continue
                        if stat.S_ISDIR(discovered.st_mode):
                            if depth + 1 < MAX_DIR_DEPTH:
                                try:
                                    child = self._open_memory_directory_at(directory, name)
                                except OSError:
                                    # An unreadable, replaced, or linked subdirectory is skipped.
                                    # O_NOFOLLOW ensures the skip never becomes a leak.
                                    continue
                                try:
                                    walk(child, logical_path, depth + 1)
                                finally:
                                    os.close(child)
                                if capped:
                                    return
                            continue
                        if not stat.S_ISREG(discovered.st_mode):
                            continue
                        info = self._memory_regular_stat_at(directory, name)
                        if info is not None:
                            found.append((logical_path, info.st_size, info.st_mtime))
            except OSError:
                if depth == 0:
                    raise
                # An unreadable subdirectory does not invalidate the index: skipped and continued.

        try:
            walk(root_fd, root, 0)
        finally:
            os.close(root_fd)
        found.sort(key=lambda item: item[2], reverse=True)
        # The index travels in ONE frame and a frame has a hard cap (MAX_FRAME). 200 paths of 4 KB
        # do not fit, and overshooting would not be a truncated index but a ProtocolError that
        # drops the connection and with it the open terminals. Cut by BUDGET, not just by count.
        rows: list[dict[str, Any]] = []
        budget = READ_INDEX_BUDGET
        for item in found[:MAX_DIR_ENTRIES]:
            cost = len(item[0].encode("utf-8")) + 80
            if cost > budget:
                break
            budget -= cost
            rows.append({
                "path": item[0],
                "bytes": item[1],
                "modified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(item[2])),
            })
        self._queue(encode_json(TAG_READ_OK, {
            "request_id": request_id,
            "kind": "dir",
            "path": root,
            # If the scan cap cut the tree there is no exact total: `null` prevents a downstream
            # layer from turning the observed prefix into a full-disk count. A pure row/byte
            # truncation preserves `total`, because the scan did finish.
            "total": None if capped else len(found),
            "observed_at_least": len(found),
            "truncated": capped or len(rows) < len(found),
            "entries": rows,
        }))

    def _read_error(self, request_id: str, code: str, reason: str) -> None:
        self._queue(encode_json(TAG_READ_ERR, {
            "request_id": request_id, "error": code, "reason": reason,
        }))

    # -- escritura de ficheros de gobierno ----------------------------------------------------

    def _on_write(self, request: dict[str, Any]) -> None:
        """Empieza una escritura sin abrir procesos ni interpretar el contenido.

        La capacidad se negocia en el hello. Aun así, todo el pedido vuelve a validarse aquí: un
        relay comprometido no puede nombrar otra ruta, omitir la precondición ni mandar un cuerpo
        por encima del tope. El contenido llega en WRITE_DATA y sólo se toca el disco cuando llegó
        completo y su SHA coincide.
        """
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE carries an invalid request id")
        if request_id in self.pending_writes:
            self.pending_writes.pop(request_id, None)
            self._write_error(request_id, "conflict", "duplicate write request id")
            return
        if len(self.pending_writes) >= MAX_WRITE_TRANSACTIONS:
            self._write_error(request_id, "unavailable", "too many governance writes in flight")
            return

        path = request.get("path")
        operation = request.get("operation")
        expected_sha = request.get("expected_sha")
        content_sha = request.get("content_sha")
        content_bytes = request.get("bytes")
        chunks = request.get("chunks")
        verdict = self._validate_write_shape(path)
        if verdict is not None:
            self._write_error(request_id, verdict[0], verdict[1])
            return
        if operation not in ("replace", "create"):
            self._write_error(request_id, "invalid_path", "operation must be replace or create")
            return
        if operation == "replace":
            if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
                self._write_error(request_id, "invalid_path", "replace requires a lowercase SHA-256 precondition")
                return
        elif expected_sha is not None:
            self._write_error(request_id, "invalid_path", "create must use the absent precondition")
            return
        if not isinstance(content_sha, str) or not SHA256_RE.fullmatch(content_sha):
            self._write_error(request_id, "invalid_path", "content_sha must be a lowercase SHA-256")
            return
        if (not isinstance(content_bytes, int) or isinstance(content_bytes, bool)
                or content_bytes < 0 or content_bytes > MAX_DOCUMENT_BYTES):
            self._write_error(request_id, "too_large", "content size is outside the governance limit")
            return
        max_chunks = (MAX_DOCUMENT_BYTES + MAX_DATA - 1) // MAX_DATA
        if (not isinstance(chunks, int) or isinstance(chunks, bool)
                or chunks < 0 or chunks > max_chunks
                or (content_bytes == 0) != (chunks == 0)):
            self._write_error(request_id, "invalid_path", "chunk count does not match the content size")
            return

        pending = GovernanceWrite(
            request_id, path, operation, expected_sha, content_sha, content_bytes, chunks,
        )
        self.pending_writes[request_id] = pending
        if chunks == 0:
            self._finish_write(pending)

    def _on_write_data(self, request_id: str, data: bytes) -> None:
        pending = self.pending_writes.get(request_id)
        # May arrive late after WRITE_CANCEL/timeout. Stale, not a violation that could drop the
        # connection and with it the PTYs that share the socket.
        if pending is None:
            return
        pending.received_chunks += 1
        if pending.received_chunks > pending.chunks or len(pending.content) + len(data) > pending.content_bytes:
            self.pending_writes.pop(request_id, None)
            self._write_error(request_id, "too_large", "write data exceeds the announced content")
            return
        pending.content.extend(data)
        if pending.received_chunks == pending.chunks:
            self._finish_write(pending)

    def _on_write_cancel(self, request: dict[str, Any]) -> None:
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE_CANCEL carries an invalid request id")
        self.pending_writes.pop(request_id, None)

    def _on_write_batch(self, request: dict[str, Any]) -> None:
        """Recibe el manifiesto completo antes de aceptar un solo byte o tocar el disco."""
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE_BATCH carries an invalid request id")
        if request_id in self.pending_write_batches or request_id in self.pending_writes:
            self.pending_write_batches.pop(request_id, None)
            self._write_batch_error(request_id, "conflict", "duplicate write batch request id")
            return
        if len(self.pending_writes) + len(self.pending_write_batches) >= MAX_WRITE_TRANSACTIONS:
            self._write_batch_error(request_id, "unavailable", "too many governance writes in flight")
            return
        raw_entries = request.get("entries")
        if (not isinstance(raw_entries, list) or not raw_entries
                or len(raw_entries) > MAX_WRITE_BATCH_FILES):
            self._write_batch_error(request_id, "too_large", "batch must contain one to seven files")
            return

        entries: list[GovernanceBatchEntry] = []
        seen: set[str] = set()
        total_bytes = 0
        total_chunks = 0
        max_chunks = (MAX_WRITE_BATCH_BYTES + MAX_DATA - 1) // MAX_DATA
        for raw in raw_entries:
            if not isinstance(raw, dict):
                self._write_batch_error(request_id, "invalid_path", "batch entry must be an object")
                return
            path = raw.get("path")
            mode = raw.get("mode")
            operation = raw.get("operation")
            expected_sha = raw.get("expected_sha")
            content_sha = raw.get("content_sha")
            content_bytes = raw.get("bytes")
            chunks = raw.get("chunks")
            verdict = self._validate_write_shape(path)
            if verdict is not None:
                self._write_batch_error(request_id, verdict[0], verdict[1])
                return
            if path in seen:
                self._write_batch_error(request_id, "conflict", "batch contains duplicate paths")
                return
            seen.add(path)
            if (not isinstance(content_bytes, int) or isinstance(content_bytes, bool)
                    or not isinstance(chunks, int) or isinstance(chunks, bool)
                    or content_bytes < 0 or chunks < 0):
                self._write_batch_error(request_id, "invalid_path", "batch sizes must be non-negative integers")
                return

            if mode == "write":
                if operation not in ("replace", "create"):
                    self._write_batch_error(request_id, "invalid_path", "write operation must be replace or create")
                    return
                if operation == "replace":
                    if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
                        self._write_batch_error(request_id, "invalid_path", "replace requires a SHA-256 precondition")
                        return
                elif expected_sha is not None:
                    self._write_batch_error(request_id, "invalid_path", "create must use the absent precondition")
                    return
                if not isinstance(content_sha, str) or not SHA256_RE.fullmatch(content_sha):
                    self._write_batch_error(request_id, "invalid_path", "write content_sha must be a SHA-256")
                    return
                if (content_bytes > MAX_DOCUMENT_BYTES or chunks > max_chunks
                        or (content_bytes == 0) != (chunks == 0)):
                    self._write_batch_error(request_id, "too_large", "batch entry exceeds the governance limit")
                    return
            elif mode == "verify":
                if operation == "present":
                    if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
                        self._write_batch_error(request_id, "invalid_path", "verify present requires a SHA-256")
                        return
                elif operation == "absent":
                    if expected_sha is not None:
                        self._write_batch_error(request_id, "invalid_path", "verify absent cannot carry a SHA-256")
                        return
                else:
                    self._write_batch_error(request_id, "invalid_path", "verify operation must be present or absent")
                    return
                if content_sha is not None or content_bytes != 0 or chunks != 0:
                    self._write_batch_error(request_id, "invalid_path", "verify entries cannot carry content")
                    return
            else:
                self._write_batch_error(request_id, "invalid_path", "batch mode must be write or verify")
                return

            total_bytes += content_bytes
            total_chunks += chunks
            if total_bytes > MAX_WRITE_BATCH_BYTES or total_chunks > max_chunks:
                self._write_batch_error(request_id, "too_large", "batch exceeds the total governance limit")
                return
            entries.append(GovernanceBatchEntry(
                path, mode, operation, expected_sha, content_sha, content_bytes, chunks,
            ))

        pending = GovernanceWriteBatch(request_id, entries)
        self.pending_write_batches[request_id] = pending
        if pending.complete():
            self._finish_write_batch(pending)

    def _on_write_batch_data(self, request_id: str, data: bytes) -> None:
        pending = self.pending_write_batches.get(request_id)
        if pending is None:
            return
        entry = pending.receiving_entry()
        if entry is None:
            self.pending_write_batches.pop(request_id, None)
            self._write_batch_error(request_id, "conflict", "batch received unannounced data")
            return
        entry.received_chunks += 1
        if entry.received_chunks > entry.chunks or len(entry.content) + len(data) > entry.content_bytes:
            self.pending_write_batches.pop(request_id, None)
            self._write_batch_error(request_id, "too_large", "batch data exceeds its announced entry")
            return
        entry.content.extend(data)
        if pending.complete():
            self._finish_write_batch(pending)

    def _on_write_batch_cancel(self, request: dict[str, Any]) -> None:
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not SESSION_ID_RE.fullmatch(request_id):
            raise ProtocolError("WRITE_BATCH_CANCEL carries an invalid request id")
        self.pending_write_batches.pop(request_id, None)

    def _finish_write_batch(self, pending: GovernanceWriteBatch) -> None:
        self.pending_write_batches.pop(pending.request_id, None)
        for entry in pending.entries:
            if entry.mode != "write":
                continue
            content = bytes(entry.content)
            if (len(content) != entry.content_bytes
                    or hashlib.sha256(content).hexdigest() != entry.content_sha):
                self._write_batch_error(
                    pending.request_id, "conflict", "batch content does not match its announced digest",
                )
                return
            try:
                content.decode("utf-8", "strict")
            except UnicodeDecodeError:
                self._write_batch_error(
                    pending.request_id, "invalid_path", "governance content must be UTF-8 text",
                )
                return
        try:
            acknowledgements = self._apply_governance_batch(pending)
        except FileExistsError:
            self._write_batch_error(pending.request_id, "conflict", "an absent precondition failed")
        except FileNotFoundError:
            self._write_batch_error(pending.request_id, "not_found", "a required file is absent")
        except PermissionError:
            self._write_batch_error(pending.request_id, "permission_denied", "permission denied")
        except ValueError as error:
            self._write_batch_error(pending.request_id, "conflict", str(error))
        except OSError as error:
            self._write_batch_error(
                pending.request_id, "unknown", f"batch write failed: {type(error).__name__}",
            )
        else:
            self._queue(encode_json(TAG_WRITE_BATCH_OK, {
                "request_id": pending.request_id, "files": acknowledgements,
            }))

    @staticmethod
    def _stat_identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def _apply_governance_batch(self, pending: GovernanceWriteBatch) -> list[dict[str, Any]]:
        """Preflight, stage, revalidate and commit; any failed commit rolls the prefix back."""
        plans: list[dict[str, Any]] = []
        try:
            # COMPLETE PRE-FLIGHT. Nothing is created, truncated, renamed, or touched before this loop ends.
            for index, entry in enumerate(pending.entries):
                directory, basename = self._open_governance_parent(entry.path)
                plan: dict[str, Any] = {
                    "entry": entry, "directory": directory, "basename": basename,
                    "index": index, "temporary": None, "backup": None, "committed": False,
                }
                plans.append(plan)
                try:
                    current_sha, current_info = self._hash_regular_at(directory, basename)
                    exists = True
                except FileNotFoundError:
                    current_sha, current_info, exists = None, None, False
                plan.update({"current_sha": current_sha, "current_info": current_info, "exists": exists})

                if entry.mode == "verify":
                    if entry.operation == "present":
                        if not exists:
                            raise FileNotFoundError(basename)
                        if current_sha != entry.expected_sha:
                            raise ValueError(f"{basename} changed; SHA-256 precondition failed")
                        plan["ack_operation"] = "unchanged"
                    else:
                        if exists:
                            raise FileExistsError(basename)
                        plan["ack_operation"] = "absent"
                    continue

                if exists and current_sha == entry.content_sha:
                    plan["ack_operation"] = "unchanged"
                    continue
                if entry.operation == "create":
                    if exists:
                        raise FileExistsError(basename)
                else:
                    if not exists:
                        raise FileNotFoundError(basename)
                    if current_sha != entry.expected_sha:
                        raise ValueError(f"{basename} changed; SHA-256 precondition failed")
                plan["ack_operation"] = entry.operation

            # COMPLETE STAGING. Temporaries are not served names and do not change destinations.
            for plan in plans:
                entry = plan["entry"]
                if entry.mode != "write" or plan["ack_operation"] == "unchanged":
                    continue
                directory = plan["directory"]
                temporary = f".cauce-profile-{pending.request_id}-{plan['index']}.tmp"
                temp_fd = os.open(
                    temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600, dir_fd=directory,
                )
                plan["temporary"] = temporary
                try:
                    content = memoryview(bytes(entry.content))
                    written = 0
                    while written < len(content):
                        amount = os.write(temp_fd, content[written:])
                        if amount <= 0:
                            raise OSError("short governance batch write")
                        written += amount
                    current_info = plan["current_info"]
                    if current_info is not None:
                        os.fchmod(temp_fd, stat.S_IMODE(current_info.st_mode))
                        if current_info.st_uid != os.geteuid() or current_info.st_gid != os.getegid():
                            os.fchown(temp_fd, current_info.st_uid, current_info.st_gid)
                    os.fsync(temp_fd)
                    staged = os.fstat(temp_fd)
                    plan["staged_inode"] = (staged.st_dev, staged.st_ino)
                finally:
                    os.close(temp_fd)

            # GLOBAL REVALIDATION. Verifies and no-ops are also re-measured right before.
            for plan in plans:
                entry = plan["entry"]
                directory = plan["directory"]
                basename = plan["basename"]
                try:
                    latest_sha, latest_info = self._hash_regular_at(directory, basename)
                    latest_exists = True
                except FileNotFoundError:
                    latest_sha, latest_info, latest_exists = None, None, False
                if plan["exists"] != latest_exists:
                    raise ValueError(f"{basename} changed after preflight")
                if latest_exists and self._stat_identity(latest_info) != self._stat_identity(plan["current_info"]):
                    raise ValueError(f"{basename} changed after preflight")
                if latest_sha != plan["current_sha"]:
                    raise ValueError(f"{basename} changed after preflight")
                if entry.mode == "write" and plan["ack_operation"] == "replace":
                    backup = f".cauce-profile-{pending.request_id}-{plan['index']}.bak"
                    os.link(basename, backup, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                    plan["backup"] = backup
                    # Creating the rollback hardlink changes the inode's ctime/nlink even though
                    # nobody edited its bytes. That post-link identity is the one that must reach commit.
                    plan["commit_identity"] = self._stat_identity(
                        os.stat(basename, dir_fd=directory, follow_symlinks=False),
                    )
                elif latest_info is not None:
                    plan["commit_identity"] = self._stat_identity(latest_info)

            # COMMIT. Each step is atomic; if one fails, the prefix is reverted in reverse order.
            try:
                for plan in plans:
                    entry = plan["entry"]
                    operation = plan["ack_operation"]
                    if entry.mode != "write" or operation == "unchanged":
                        continue
                    directory = plan["directory"]
                    basename = plan["basename"]
                    temporary = plan["temporary"]
                    if operation == "create":
                        os.link(
                            temporary, basename,
                            src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False,
                        )
                        os.unlink(temporary, dir_fd=directory)
                        plan["temporary"] = None
                    else:
                        latest = os.stat(basename, dir_fd=directory, follow_symlinks=False)
                        if self._stat_identity(latest) != plan["commit_identity"]:
                            raise ValueError(f"{basename} changed before commit")
                        os.replace(temporary, basename, src_dir_fd=directory, dst_dir_fd=directory)
                        plan["temporary"] = None
                    plan["committed"] = True
                    os.fsync(directory)
            except BaseException:
                rollback_failed = False
                for plan in reversed(plans):
                    if not plan["committed"]:
                        continue
                    directory = plan["directory"]
                    basename = plan["basename"]
                    try:
                        current_sha, current = self._hash_regular_at(directory, basename)
                        entry = plan["entry"]
                        if ((current.st_dev, current.st_ino) != plan["staged_inode"]
                                or current_sha != entry.content_sha):
                            rollback_failed = True
                            continue
                        if plan["ack_operation"] == "create":
                            os.unlink(basename, dir_fd=directory)
                        else:
                            os.replace(
                                plan["backup"], basename,
                                src_dir_fd=directory, dst_dir_fd=directory,
                            )
                            plan["backup"] = None
                        os.fsync(directory)
                    except OSError:
                        rollback_failed = True
                if rollback_failed:
                    raise OSError("governance batch rollback could not restore every file") from None
                raise

            acknowledgements: list[dict[str, Any]] = []
            for plan in plans:
                entry = plan["entry"]
                if plan["ack_operation"] == "absent":
                    digest, size = None, 0
                elif entry.mode == "write":
                    digest, size = entry.content_sha, entry.content_bytes
                else:
                    digest, size = entry.expected_sha, plan["current_info"].st_size
                acknowledgements.append({
                    "path": entry.path,
                    "operation": plan["ack_operation"],
                    "sha": digest,
                    "bytes": size,
                })
            return acknowledgements
        finally:
            for plan in plans:
                directory = plan["directory"]
                for key in ("temporary", "backup"):
                    name = plan.get(key)
                    if name is not None:
                        try:
                            os.unlink(name, dir_fd=directory)
                        except OSError:
                            pass
                os.close(directory)

    def _write_batch_error(self, request_id: str, code: str, reason: str) -> None:
        self._queue(encode_json(TAG_WRITE_BATCH_ERR, {
            "request_id": request_id, "error": code, "reason": reason,
        }))

    def _finish_write(self, pending: GovernanceWrite) -> None:
        self.pending_writes.pop(pending.request_id, None)
        content = bytes(pending.content)
        if len(content) != pending.content_bytes or hashlib.sha256(content).hexdigest() != pending.content_sha:
            self._write_error(pending.request_id, "conflict", "content does not match its announced digest")
            return
        try:
            content.decode("utf-8", "strict")
        except UnicodeDecodeError:
            self._write_error(pending.request_id, "invalid_path", "governance content must be UTF-8 text")
            return
        try:
            self._apply_governance_write(pending, content)
        except FileExistsError:
            self._write_error(pending.request_id, "conflict", "the file exists; create precondition failed")
        except FileNotFoundError:
            self._write_error(pending.request_id, "not_found", "the file vanished before replacement")
        except PermissionError:
            self._write_error(pending.request_id, "permission_denied", "permission denied")
        except ValueError as error:
            self._write_error(pending.request_id, "conflict", str(error))
        except OSError as error:
            self._write_error(pending.request_id, "unknown", f"write failed: {type(error).__name__}")

    def _validate_write_shape(self, path: Any) -> tuple[str, str] | None:
        if not isinstance(path, str) or not path:
            return ("invalid_path", "path is required")
        if len(path) > MAX_READ_PATH or "\0" in path or not path.startswith("/"):
            return ("invalid_path", "path is not a bounded absolute path")
        segments = path.split("/")
        if ".." in segments or "." in segments or "" in segments[1:]:
            return ("invalid_path", "path is not canonical")
        base = segments[-1]
        normalized_base = base.casefold()
        if normalized_base in NEVER_SERVE_BASENAMES:
            return ("permission_denied", f"{base} is never served")
        if normalized_base.endswith(NEVER_SERVE_SUFFIXES):
            return ("permission_denied", "looks like credential material")
        if not self._is_writable_governance_file_path(path):
            return ("permission_denied", f"{base} is not a governance document")
        home = str(self.bundle["home"]).rstrip("/")
        if not home.startswith("/") or not path.startswith(home + "/"):
            return ("permission_denied", "path is outside the agent home")
        return None

    def _profile_governance_file_paths(self) -> frozenset[str]:
        """Exact profile roots. These remain the only writable governance destinations."""
        harness = self.bundle.get("harness")
        facts = self.bundle.get("runtime_facts", {})
        home = str(self.bundle["home"]).rstrip("/")
        # HOME and the configured harness are container identity, not proof that the adapter was
        # alive.  Recovery shells intentionally start with `{}` facts; in that state no profile,
        # memory or manual path may be inferred from conventional defaults.
        if not isinstance(facts, dict) or not facts:
            return frozenset()
        if harness == "openclaw":
            root = facts.get("openclaw_workspace")
            allowed = {"SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"}
        elif harness == "claude":
            root = facts.get("claude_config_dir")
            allowed = {"CLAUDE.md"}
        elif harness == "codex":
            root = facts.get("codex_home")
            allowed = {"AGENTS.md"}
        elif harness == "hermes":
            root = home
            allowed = {"AGENTS.md"}
        else:
            return frozenset()
        if not isinstance(root, str):
            return frozenset()
        return frozenset(f"{root.rstrip('/')}/{name}" for name in allowed)

    def _readable_global_governance_file_paths(self) -> frozenset[str]:
        paths = set(self._profile_governance_file_paths())
        if self.bundle.get("harness") == "codex":
            facts = self.bundle.get("runtime_facts", {})
            root = facts.get("codex_home") if isinstance(facts, dict) else None
            if isinstance(root, str):
                paths.add(f"{root.rstrip('/')}/AGENTS.override.md")
        return frozenset(paths)

    def _project_manual_paths(self) -> tuple[str, ...]:
        """Project manuals in effective precedence order, derived only from measured facts.

        With an accredited workspace root, every directory from root to cwd participates. Without
        one, cwd itself is still a real `/proc` measurement and authorizes exactly one level; the
        agent never walks towards `/` looking for a plausible repository root.
        """
        harness = self.bundle.get("harness")
        if harness not in ("claude", "codex"):
            return ()
        facts = self.bundle.get("runtime_facts", {})
        if not isinstance(facts, dict):
            return ()
        codex_fallbacks: tuple[str, ...] = ()
        if harness == "codex":
            raw_fallbacks = facts.get("project_doc_fallback_filenames")
            if isinstance(raw_fallbacks, list) and len(raw_fallbacks) <= PROJECT_DOC_FALLBACK_LIMIT:
                accepted: list[str] = []
                seen = {"AGENTS.override.md", "AGENTS.md"}
                for name in raw_fallbacks:
                    if not _valid_project_doc_fallback(name, seen):
                        accepted = []
                        break
                    seen.add(name)
                    accepted.append(name)
                codex_fallbacks = tuple(accepted)
        cwd = facts.get("cwd")
        # Both runtimes start at the measured project marker. A workspace mount can contain
        # several repositories and its top-level manual need not govern the current process.
        root = facts.get("project_root")
        if not isinstance(cwd, str) or not self._canonical_context_directory(cwd):
            return ()
        directories: list[str]
        if root is None:
            directories = [cwd]
        else:
            if not isinstance(root, str) or not self._canonical_context_directory(root):
                return ()
            try:
                if os.path.commonpath((root, cwd)) != root:
                    return ()
                relative = os.path.relpath(cwd, root)
            except ValueError:
                return ()
            parts = [] if relative == "." else relative.split(os.sep)
            # A measured context this deep is not operationally useful and would amplify one READ
            # into an unbounded sequence. Fail closed instead of silently dropping ancestors.
            if len(parts) > 64 or any(part in ("", ".", "..") for part in parts):
                return ()
            directories = [root]
            current = root
            for part in parts:
                current = f"{current.rstrip('/')}/{part}"
                directories.append(current)
        paths: list[str] = []
        for directory in directories:
            root = directory.rstrip("/")
            if harness == "claude":
                paths.extend((
                    f"{root}/CLAUDE.md", f"{root}/.claude/CLAUDE.md",
                    f"{root}/CLAUDE.local.md",
                ))
            else:
                paths.extend((
                    f"{root}/AGENTS.override.md", f"{root}/AGENTS.md",
                    *(f"{root}/{fallback}" for fallback in codex_fallbacks),
                ))
        return tuple(paths)

    @staticmethod
    def _canonical_context_directory(path: str) -> bool:
        if not path.startswith("/") or path == "/" or len(path) > MAX_READ_PATH or "\0" in path:
            return False
        segments = path.split("/")
        return os.path.normpath(path) == path \
            and not any(segment in ("", ".", "..") for segment in segments[1:])

    def _is_project_manual_path(self, path: str) -> bool:
        return path in self._project_manual_paths()

    def _is_readable_governance_file_path(self, path: str) -> bool:
        return path in self._readable_global_governance_file_paths() or self._is_project_manual_path(path)

    def _is_writable_governance_file_path(self, path: str) -> bool:
        return path in self._profile_governance_file_paths()

    def _memory_root_for_harness(self) -> str | None:
        """Exact root mirrored by the gateway from the facts published in AGENT_HELLO."""
        harness = self.bundle.get("harness")
        facts = self.bundle.get("runtime_facts", {})
        home = str(self.bundle.get("home", "")).rstrip("/")
        if not home.startswith("/") or not isinstance(facts, dict) or not facts:
            return None
        if harness == "claude":
            base = facts.get("claude_config_dir")
            leaf = "projects"
        elif harness == "codex":
            base = facts.get("codex_home")
            leaf = "memories"
        elif harness == "openclaw":
            base = facts.get("openclaw_workspace")
            leaf = "memory"
        else:
            return None
        if not isinstance(base, str) or not base.startswith("/"):
            return None
        return f"{base.rstrip('/')}/{leaf}"

    @staticmethod
    def _safe_memory_entry_name(name: str) -> bool:
        if not name or name in (".", "..") or "/" in name or "\0" in name:
            return False
        if any(ord(character) <= 0x1F or ord(character) == 0x7F for character in name):
            return False
        try:
            name.encode("utf-8")
        except UnicodeEncodeError:
            return False
        return True

    @staticmethod
    def _classify_directory_open_error(directory: int, segment: str, error: OSError) -> None:
        """Translate a no-follow open failure without trusting a preflight stat."""
        try:
            details = os.stat(segment, dir_fd=directory, follow_symlinks=False)
        except OSError:
            raise error
        if stat.S_ISLNK(details.st_mode):
            raise ReadSymlinkError(segment) from None
        if not stat.S_ISDIR(details.st_mode):
            raise ReadPathTypeError(segment) from None
        raise error

    @staticmethod
    def _open_memory_directory_at(directory: int, segment: str) -> int:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            child = os.open(segment, flags, dir_fd=directory)
        except OSError as error:
            PtyAgent._classify_directory_open_error(directory, segment, error)
            raise AssertionError("directory open classifier returned")
        if not stat.S_ISDIR(os.fstat(child).st_mode):
            os.close(child)
            raise ReadPathTypeError(segment)
        return child

    @staticmethod
    def _memory_regular_stat_at(directory: int, basename: str) -> os.stat_result | None:
        # O_PATH obtains metadata without opening content (or activating devices/FIFOs if the
        # name was swapped after lstat). With O_NOFOLLOW, a swap to symlink produces an fd on
        # the link itself and fstat rejects it below.
        flags = getattr(os, "O_PATH", os.O_RDONLY | os.O_NONBLOCK)
        flags |= os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            descriptor = os.open(basename, flags, dir_fd=directory)
        except OSError:
            return None
        try:
            details = os.fstat(descriptor)
            return details if stat.S_ISREG(details.st_mode) else None
        finally:
            os.close(descriptor)

    def _open_memory_root(self, root: str) -> int:
        """Open the authorized memory root using only fd-relative no-follow traversal."""
        home = str(self.bundle["home"]).rstrip("/") or "/"
        if home == "/" or not root.startswith(home + "/"):
            raise PermissionError("memory root is outside HOME")
        relative = root[len(home) + 1:].split("/")
        # HOME is also walked from `/` with openat: O_NOFOLLOW on an absolute path only protects
        # its last component and could follow a symlink at any parent.
        directory = self._open_absolute_memory_directory(home)
        try:
            for segment in relative:
                child = self._open_memory_directory_at(directory, segment)
                os.close(directory)
                directory = child
            return directory
        except BaseException:
            os.close(directory)
            raise

    @classmethod
    def _open_absolute_memory_directory(cls, path: str) -> int:
        """Use `/` as trust anchor and reject symlinks in every absolute-path component."""
        if path == "/" or not path.startswith("/") or os.path.normpath(path) != path:
            raise ReadPathTypeError(path)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        directory = os.open("/", flags)
        try:
            for segment in path.split("/")[1:]:
                child = cls._open_memory_directory_at(directory, segment)
                os.close(directory)
                directory = child
            return directory
        except BaseException:
            os.close(directory)
            raise

    def _open_governance_parent(self, path: str) -> tuple[int, str]:
        """Abre cada padre con O_NOFOLLOW y devuelve `(dirfd, basename)`.

        Resolver con `realpath` y luego abrir por nombre deja una carrera entre ambos pasos. Esta
        caminata queda anclada en descriptores: cambiar un padre por un enlace no redirige la E/S.
        """
        parent, basename = os.path.split(path)
        if not parent or not basename or os.path.normpath(path) != path:
            raise ReadPathTypeError(path)
        # Anchor at `/` and reject symlinks component-by-component. Project manuals legitimately
        # live outside HOME; exact-path authorization happened before this routine is reached.
        directory = self._open_absolute_memory_directory(parent)
        return directory, basename

    @staticmethod
    def _hash_regular_at(directory: int, basename: str) -> tuple[str, os.stat_result]:
        fd = os.open(basename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise PermissionError("governance target is not a regular file")
            digest = hashlib.sha256()
            while True:
                chunk = os.read(fd, 64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            after = os.fstat(fd)
            identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            if identity_before != identity_after:
                raise ValueError("the file changed while its precondition was checked")
            return digest.hexdigest(), after
        finally:
            os.close(fd)

    def _apply_governance_write(self, pending: GovernanceWrite, content: bytes) -> None:
        directory, basename = self._open_governance_parent(pending.path)
        temporary = f".cauce-governance-{pending.request_id}.tmp"
        temp_fd: int | None = None
        temp_exists = False
        try:
            try:
                current_sha, current_info = self._hash_regular_at(directory, basename)
                exists = True
            except FileNotFoundError:
                current_sha, current_info, exists = None, None, False

            # Lost ACK: repeating the same operation must not turn a real success into a conflict.
            if exists and current_sha == pending.content_sha:
                self._write_ok(pending)
                return
            if pending.operation == "create" and exists:
                raise FileExistsError(basename)
            if pending.operation == "replace":
                if not exists:
                    raise FileNotFoundError(basename)
                if current_sha != pending.expected_sha:
                    raise ValueError("the file changed; SHA-256 precondition failed")

            temp_fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=directory,
            )
            temp_exists = True
            view = memoryview(content)
            written = 0
            while written < len(view):
                amount = os.write(temp_fd, view[written:])
                if amount <= 0:
                    raise OSError("short governance write")
                written += amount
            if current_info is not None:
                os.fchmod(temp_fd, stat.S_IMODE(current_info.st_mode))
                if current_info.st_uid != os.geteuid() or current_info.st_gid != os.getegid():
                    os.fchown(temp_fd, current_info.st_uid, current_info.st_gid)
            os.fsync(temp_fd)
            os.close(temp_fd)
            temp_fd = None

            if pending.operation == "create":
                # linkat fails with EEXIST: unlike replace(), it never overwrites a creation that
                # won the race between the check and the commit.
                os.link(
                    temporary, basename,
                    src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False,
                )
                os.unlink(temporary, dir_fd=directory)
                temp_exists = False
            else:
                # Revalidate the SAME identity right before commit. Serialises this agent's writes
                # and catches external edits that happened during staging.
                latest = os.stat(basename, dir_fd=directory, follow_symlinks=False)
                expected_identity = (
                    current_info.st_dev, current_info.st_ino, current_info.st_size,
                    current_info.st_mtime_ns, current_info.st_ctime_ns,
                )
                actual_identity = (
                    latest.st_dev, latest.st_ino, latest.st_size,
                    latest.st_mtime_ns, latest.st_ctime_ns,
                )
                if expected_identity != actual_identity or not stat.S_ISREG(latest.st_mode):
                    raise ValueError("the file changed before the atomic commit")
                os.replace(temporary, basename, src_dir_fd=directory, dst_dir_fd=directory)
                temp_exists = False
            os.fsync(directory)
            self._write_ok(pending)
        finally:
            if temp_fd is not None:
                os.close(temp_fd)
            if temp_exists:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except OSError:
                    pass
            os.close(directory)

    def _write_ok(self, pending: GovernanceWrite) -> None:
        self._queue(encode_json(TAG_WRITE_OK, {
            "request_id": pending.request_id,
            "path": pending.path,
            "operation": pending.operation,
            "sha": pending.content_sha,
            "bytes": pending.content_bytes,
        }))

    def _write_error(self, request_id: str, code: str, reason: str) -> None:
        self._queue(encode_json(TAG_WRITE_ERR, {
            "request_id": request_id, "error": code, "reason": reason,
        }))

    def _resolve_command(self, mode: str) -> list[str] | None:
        if mode == "harness":
            if self.bundle["harness_command"] is not None:
                return self.bundle["harness_command"]
            if self.bundle.get("tmux_tui") is not None:
                return resolve_tmux_tui_command(self.bundle)
            return resolve_openclaw_tui_command(self.bundle)
        for candidate in self.bundle["shell_candidates"]:
            if os.access(candidate[0], os.X_OK):
                return candidate
        return None

    def _child_environment(self) -> dict[str, str]:
        # Minimal and built here, never inherited wholesale: TERM/COLORTERM make the TUI render,
        # PROMPT_EOL_MARK='' stops the inverse-video '%' that bash prints on partial lines.
        return {
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "HOME": self.bundle["home"],
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "PROMPT_EOL_MARK": "",
        }

    def _spawn(self, session_id: str, mode: str, argv: list[str], rows: int, cols: int) -> PtySession:
        environment = self._child_environment()
        home = self.bundle["home"]
        pid, master = pty.fork()
        if pid == 0:  # pragma: no cover - the child never returns
            try:
                for number in (signal.SIGINT, signal.SIGQUIT, signal.SIGTERM, signal.SIGHUP, signal.SIGPIPE):
                    signal.signal(number, signal.SIG_DFL)
                try:
                    os.chdir(home)
                except OSError:
                    os.chdir("/")
                os.execve(argv[0], argv, environment)
            except BaseException:
                os._exit(127)
        _cloexec(master)
        os.set_blocking(master, False)
        set_window_size(master, rows, cols)
        return PtySession(session_id, pid, master, mode, argv)

    def _on_stdin(self, session_id: str, data: bytes) -> None:
        session = self.sessions.get(session_id)
        if session is None:
            return  # tombstoned or unknown: late keystrokes never reach a fresh session
        if session.mode in READ_ONLY_MODES:
            # Discarded BEFORE touching the descriptor, and not queued: storing it would be a leak
            # that would drain itself as soon as the mode changed or the pty accepted writes.
            if not session.refused_input:
                session.refused_input = True
                log(f"input refused on a read-only session mode={session.mode} session={session_id}")
            return
        self._enqueue_session_input(session, data)

    def _on_terminal_response(self, session_id: str, data: bytes) -> None:
        # Validated even if the session is already gone: a malformed frame never gains a permissive
        # path by arriving late.
        if not is_terminal_emulator_response(data):
            raise ProtocolError("TERMINAL_RESPONSE is not an allowed DA/DSR response")
        session = self.sessions.get(session_id)
        if session is None:
            return
        if session.mode not in READ_ONLY_MODES:
            raise ProtocolError("TERMINAL_RESPONSE is only valid for a read-only session")
        self._enqueue_session_input(session, data)

    def _on_resize(self, request: dict[str, Any]) -> None:
        session_id = request.get("session_id")
        if not isinstance(session_id, str):
            raise ProtocolError("RESIZE carries an invalid session id")
        session = self.sessions.get(session_id)
        if session is None:
            return
        rows, cols = _window(request)
        try:
            set_window_size(session.fd, rows, cols)
        except OSError:
            pass

    def _on_close(self, request: dict[str, Any]) -> None:
        session_id = request.get("session_id")
        if not isinstance(session_id, str):
            raise ProtocolError("CLOSE carries an invalid session id")
        session = self.sessions.get(session_id)
        if session is None:
            return
        reason = request.get("reason")
        self._hangup(session, reason if isinstance(reason, str) and reason else "relay_close")

    def _on_output_flow(self, request: dict[str, Any], paused: bool) -> None:
        session_id = request.get("session_id")
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            raise ProtocolError("output flow control carries an invalid session id")
        session = self.sessions.get(session_id)
        if session is not None:
            was_paused = session.output_paused
            session.output_paused = paused
            # RESUME is session-scoped and makes already-buffered bytes eligible immediately.
            # Waiting for a later timer made a resumed terminal appear stuck for another flush
            # interval; touching no other session is part of the wire contract.
            if was_paused and not paused:
                self._flush_session(session)

    def _enqueue_session_input(self, session: PtySession, data: bytes) -> None:
        if len(session.pending_input) + len(data) > SESSION_INPUT_HIGH_WATER:
            session.pending_input.clear()
            self._hangup(session, "input_flood")
            return
        session.pending_input.extend(data)
        self._write_session(session)

    def _hangup(self, session: PtySession, reason: str | None = None) -> None:
        if reason is not None and session.close_reason is None:
            session.close_reason = reason[:120]
        if session.kill_deadline is not None:
            return
        session.kill_deadline = time.monotonic() + KILL_GRACE
        self._signal(session, signal.SIGHUP)

    @staticmethod
    def _signal(session: PtySession, number: int) -> None:
        try:
            os.killpg(session.pid, number)
        except OSError:
            try:
                os.kill(session.pid, number)
            except OSError:
                pass

    # -- io ------------------------------------------------------------------------------------

    def _read_session(self, session: PtySession) -> None:
        while len(session.out) < SESSION_HIGH_WATER:
            try:
                chunk = os.read(session.fd, 65536)
            except BlockingIOError:
                return
            except OSError as error:
                # EIO is how Linux reports "the slave side is gone" on a pty master.
                if error.errno not in (errno.EIO, errno.EBADF):
                    raise
                session.eof = True
                return
            if not chunk:
                session.eof = True
                return
            session.out.extend(chunk)

    def _write_session(self, session: PtySession) -> None:
        while session.pending_input:
            try:
                written = os.write(session.fd, bytes(session.pending_input[:MAX_FRAME]))
            except BlockingIOError:
                return
            except OSError:
                session.pending_input.clear()
                session.eof = True
                return
            del session.pending_input[:written]

    def _flush_session(self, session: PtySession, force: bool = False) -> None:
        if not session.out:
            return
        # PAUSE_OUTPUT means that bytes already buffered before the pause must stop as well. The
        # old guard existed only on read(), so a pending >= FLUSH_BYTES chunk leaked through from
        # _maintain. `force` is reserved for the explicit terminal CLOSED path: once the child is
        # retired its last bytes and CLOSED must stay ordered and the session cannot await RESUME.
        if session.output_paused and not force:
            return
        if not force and len(self.outbound) >= OUTBOUND_HIGH_WATER:
            return  # the relay is not draining; hold the bytes where the backpressure works
        now = time.monotonic()
        if not force and len(session.out) < FLUSH_BYTES and now - session.last_flush < FLUSH_INTERVAL:
            return
        while session.out:
            chunk = bytes(session.out[:MAX_DATA])
            del session.out[:MAX_DATA]
            self._queue(encode_data(TAG_STDOUT, session.session_id, chunk))
        session.last_flush = now

    # -- maintenance ---------------------------------------------------------------------------

    def _maintain(self) -> None:
        now = time.monotonic()
        self._reap()
        for session in list(self.sessions.values()):
            if session.kill_deadline is not None and now >= session.kill_deadline and not session.reaped:
                session.kill_deadline = now + KILL_GRACE
                self._signal(session, signal.SIGKILL)
            self._flush_session(session)
            if session.reaped and session.eof:
                self._retire(session)
        for session_id, expiry in list(self.tombstones.items()):
            if now >= expiry:
                del self.tombstones[session_id]
        if self.bundle.get("openclaw_tui") is not None and now >= self.next_dynamic_capability_check:
            self.next_dynamic_capability_check = now + DYNAMIC_CAPABILITY_CHECK_INTERVAL
            if self._advertised_modes() != self.modes:
                # Reconnecting withdraws/publishes the capability through a fresh HELLO. Keeping
                # the socket would advertise a TUI that the next OPEN can no longer resolve.
                raise ProtocolError("dynamic harness capability changed")
        if self.acknowledged and now - self.last_ping > PING_TIMEOUT:
            raise ProtocolError("relay stopped sending PING")
        if not self.acknowledged and now - self.connected_at > HELLO_TIMEOUT:
            raise ProtocolError("relay did not acknowledge the hello")

    def _reap(self) -> None:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
            for session in self.sessions.values():
                if session.pid != pid:
                    continue
                session.reaped = True
                if os.WIFSIGNALED(status):
                    session.exit_signal = os.WTERMSIG(status)
                else:
                    session.exit_code = os.WEXITSTATUS(status)
                # The child is gone but the master may still hold its last writes; drain them so
                # the operator sees the final output before CLOSED.
                self._read_session(session)
                session.eof = True

    def _retire(self, session: PtySession) -> None:
        self._flush_session(session, force=True)
        self._queue(encode_json(TAG_CLOSED, {
            "session_id": session.session_id,
            "exit_code": session.exit_code,
            "signal": session.exit_signal,
            "reason": session.close_reason or "agent_closed",
        }))
        try:
            os.close(session.fd)
        except OSError:
            pass
        del self.sessions[session.session_id]
        # A TUI the operator believed finished must never come back: no respawn, and the id stays
        # poisoned for 30 s so late STDIN/RESIZE frames cannot land on a new session.
        self.tombstones[session.session_id] = time.monotonic() + TOMBSTONE_SECONDS
        log(f"CLOSED session={session.session_id} exit={session.exit_code} signal={session.exit_signal}")

    def _terminate_sessions(self) -> None:
        for session in list(self.sessions.values()):
            self._signal(session, signal.SIGHUP)
        deadline = time.monotonic() + KILL_GRACE
        while self.sessions and time.monotonic() < deadline:
            self._reap()
            for session in list(self.sessions.values()):
                if session.reaped:
                    try:
                        os.close(session.fd)
                    except OSError:
                        pass
                    del self.sessions[session.session_id]
            if self.sessions:
                time.sleep(0.05)
        for session in list(self.sessions.values()):
            self._signal(session, signal.SIGKILL)
            try:
                os.close(session.fd)
            except OSError:
                pass
            del self.sessions[session.session_id]

    def stop(self) -> None:
        self.stopping = True


def assert_not_root() -> None:
    """First effective statement of the program. The PTY never runs as root: the whole point of
    the channel is a shell as the mapped runtime user, and a root euid means the launcher (or the
    unit) was tampered with, so the agent refuses fail-closed with the supervisor's own code 78."""
    if os.geteuid() == 0:
        fail("cauce-pty-agent refuses to run as root: the PTY must run as the mapped runtime user", PERMANENT_EXIT)


def main(argv: list[str] | None = None) -> int:
    assert_not_root()
    parser = argparse.ArgumentParser(description="Cauce V3 PTY agent (runs inside the fleet container)")
    parser.add_argument("--bundle", required=True, help="absolute path to the launcher drop file (0400, unlinked on read)")
    arguments = parser.parse_args(argv)
    try:
        bundle = load_bundle(arguments.bundle)
    except (PermanentError, OSError) as error:
        fail(f"cauce-pty-agent bundle is unusable: {error}", PERMANENT_EXIT)
    agent = PtyAgent(bundle)
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: agent.stop())
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    log(f"starting alias={bundle['alias']} container={bundle['container_id'][:12]} uid={os.geteuid()} version={bundle['agent_version']}")
    return agent.run()


if __name__ == "__main__":
    raise SystemExit(main())
