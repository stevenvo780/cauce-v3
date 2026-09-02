from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import struct
import sys
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


CLOCK_SKEW = 5.0


SESSION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TICKET_RE = re.compile(r"^v1\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$")
IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MODES = ("shell", "harness")


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
