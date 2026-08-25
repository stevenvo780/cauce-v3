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
TAG_CLOSE = 0x30
TAG_CLOSED = 0x31
TAG_PING = 0x40
TAG_PONG = 0x41
# Lectura de ficheros de gobierno (CLAUDE.md / AGENTS.md y el indice de memoria). Es una
# transaccion suelta, no una sesion: por eso no reusa TAG_OPEN, que abre un PTY con estado.
TAG_READ = 0x50
TAG_READ_OK = 0x51
TAG_READ_ERR = 0x52
TAG_READ_DATA = 0x53

MAX_FRAME = 65536
# DATA frames (0x20/0x21) carry the 36 ASCII bytes of the session UUID before the raw bytes.
SESSION_ID_BYTES = 36
MAX_DATA = MAX_FRAME - SESSION_ID_BYTES
DATA_TAGS = frozenset({TAG_STDIN, TAG_STDOUT})
# Tags cuyo payload empieza por un identificador de 36 bytes ASCII. READ_DATA lleva el
# `request_id` de la peticion, no una sesion, pero el formato del prefijo es el mismo a proposito:
# asi el relay reusa su decodificador de tramas de datos sin una segunda ruta de codigo.
PREFIXED_TAGS = DATA_TAGS | frozenset({TAG_READ_DATA})

MAX_SESSIONS = 2
# A TUI over the network is unusable if every keystroke echo becomes its own packet, so output is
# coalesced: flush at 16 ms or 8 KiB, whichever comes first.
FLUSH_INTERVAL = 0.016
FLUSH_BYTES = 8192
# Per-session backpressure: while this much output is still queued the master fd is not read, so
# the pressure lands on the writer inside the container instead of on our heap (a `ls -R /` must
# not balloon the agent nor stall the relay for the other session).
SESSION_HIGH_WATER = 262144
# Same idea one level up: while this much is already queued for the relay nothing new is coalesced
# into it, so a slow relay pushes the pressure back to SESSION_HIGH_WATER and from there to the pty.
OUTBOUND_HIGH_WATER = 1 << 20
PING_TIMEOUT = 45.0
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

# --- Lectura de ficheros de gobierno ----------------------------------------------------------
#
# El agente NO conoce el juego cerrado del gateway (no sabe que arnes corre de verdad ni cual es
# el HOME del arnes, que puede no ser el suyo). Por eso no puede comprobar "esta ruta es la que el
# gateway resolvio". Lo que SI puede hacer, y hace, es no ser nunca la pieza que entrega algo
# distinto de un manual: una lista BLANCA de nombres base, contencion dentro de su propio home, y
# nada de enlaces. Con eso, un gateway comprometido no consigue `/etc/passwd` ni `~/.ssh/id_ed25519`
# aunque los pida: el peor caso es leer un CLAUDE.md, que es exactamente el proposito de la via.
FEATURES = ("read_governance",)

# Unicos nombres que esta via sirve. Cualquier otro se rechaza aunque el gateway lo pida.
READ_ALLOWED_BASENAMES = frozenset({"CLAUDE.md", "AGENTS.md"})

# Nunca se sirven ni se listan, esten donde esten. Espejo de NEVER_SERVE_BASENAMES del gateway
# (`services/gateway/src/console/agent-documents.ts`): las dos listas se defienden por separado a
# proposito, porque un fallo en una sola no debe bastar para filtrar una credencial.
NEVER_SERVE_BASENAMES = frozenset({
    ".credentials.json", "auth.json", ".claude.json", "openclaw.json", ".env", ".netrc",
    "id_ed25519", "id_rsa", "known_hosts", "authorized_keys",
})
NEVER_SERVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx")

READ_KINDS = ("file", "dir")
MAX_READ_PATH = 4096
# 256 KB: el CLAUDE.md mas grande medido en la flota es el de zeus (10.733 B) y el AGENTS.md de
# hermes llega a 75 KB. Sobra margen sin convertir la via en un canal de volcado.
MAX_DOCUMENT_BYTES = 256 * 1024
# Indice de memoria: sale metadato, nunca contenido.
MAX_DIR_ENTRIES = 200
MAX_DIR_DEPTH = 3
DIR_SCAN_CAP = 5000
# Presupuesto en bytes para las entradas del indice dentro de su UNICA trama (MAX_FRAME = 64 KiB).
READ_INDEX_BUDGET = 48 * 1024

BUNDLE_KEYS = (
    "tenant_id", "alias", "container_id", "generation", "image_id", "runtime_user", "runtime_uid",
    "runtime_gid", "home", "shell_candidates", "harness", "relay_host", "relay_port",
    "alias_key_hex", "client_cert_pem", "client_key_pem", "ca_pem", "agent_version",
)


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
        raise ProtocolError("only STDIN/STDOUT/READ_DATA carry a 36 byte prefix")
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
    return base64.b64decode(normalized + "=" * (-len(normalized) % 4))


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
        raise TicketError("ticket_malformed") from None
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
    for key in ("client_cert_pem", "client_key_pem", "ca_pem"):
        if not isinstance(document.get(key), str) or "-----BEGIN" not in document[key]:
            raise PermanentError(f"bundle field is invalid: {key}")
    return document


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
        self.last_flush = time.monotonic()
        self.eof = False
        self.reaped = False
        self.exit_code: int | None = None
        self.exit_signal: int | None = None
        self.kill_deadline: float | None = None


def set_window_size(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _window(request: dict[str, Any]) -> tuple[int, int]:
    rows = request.get("rows", 24)
    cols = request.get("cols", 80)
    if not isinstance(rows, int) or isinstance(rows, bool) or not 1 <= rows <= 1000:
        rows = 24
    if not isinstance(cols, int) or isinstance(cols, bool) or not 1 <= cols <= 1000:
        cols = 80
    return rows, cols


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
        self.modes = ["shell"] + (["harness"] if bundle["harness_command"] else [])
        self.sessions: dict[str, PtySession] = {}
        self.tombstones: dict[str, float] = {}
        self.connection: ssl.SSLSocket | None = None
        self.outbound = bytearray()
        self.decoder = FrameDecoder()
        self.acknowledged = False
        self.connected_at = 0.0
        self.last_ping = 0.0
        self.stopping = False

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
        # The relay is the only path to the operator: if it disappears (container stopped, network
        # cut) the shells it fronted are unreachable, so they are terminated instead of orphaned.
        self._terminate_sessions()

    # -- main loop -----------------------------------------------------------------------------

    def _serve(self, connection: ssl.SSLSocket) -> None:
        self.connection = connection
        self.connected_at = time.monotonic()
        self.last_ping = self.connected_at
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
            # El agente SABE su HOME (lo usa para lanzar la sesion) y hasta ahora no lo publicaba.
            # Sin este campo el gateway no puede componer la ruta del fichero de gobierno del alias
            # y el modal de directiva dice "contenedor sin identificar" aunque la lectura funcione.
            "home": self.bundle["home"],
            "agent_version": self.bundle["agent_version"],
            "modes": self.modes,
            # El relay NO manda TAG_READ a un agente que no lo anuncie. Un agente viejo trata un
            # tag desconocido como violacion de protocolo y se tira la conexion encima (ver
            # `_dispatch`), asi que sin esta declaracion desplegar el relay antes que el agente
            # dejaria terminales caidas por toda la flota.
            "features": list(FEATURES),
        }))
        while not self.stopping:
            self._pump_writes()
            readable: list[Any] = [connection]
            writable: list[Any] = [connection] if self.outbound else []
            for session in self.sessions.values():
                if not session.eof and len(session.out) < SESSION_HIGH_WATER:
                    readable.append(session.fd)
                if session.pending_input:
                    writable.append(session.fd)
            ready_read, ready_write, _ = select.select(readable, writable, [], self._timeout())
            if connection in ready_read or connection.pending():
                self._read_relay(connection)
            for session in list(self.sessions.values()):
                if session.fd in ready_write:
                    self._write_session(session)
                if session.fd in ready_read:
                    self._read_session(session)
            self._maintain()

    def _timeout(self) -> float:
        now = time.monotonic()
        deadlines = [self.last_ping + PING_TIMEOUT]
        if not self.acknowledged:
            deadlines.append(self.connected_at + HELLO_TIMEOUT)
        for session in self.sessions.values():
            if session.out:
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
        if tag in DATA_TAGS:
            if tag != TAG_STDIN:
                raise ProtocolError("relay may only send STDIN data frames")
            session_id, data = decode_data(payload)
            self._on_stdin(session_id, data)
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
        elif tag == TAG_RESIZE:
            self._on_resize(document)
        elif tag == TAG_CLOSE:
            self._on_close(document)
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
        # La respuesta puede pesar 256 KB. Si la cola de salida ya va cargada se rechaza en vez de
        # invertir la presion sobre las terminales, que son lo que de verdad no puede esperar.
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
        except PermissionError:
            self._read_error(request_id, "permission_denied", "permission denied")
        except FileNotFoundError:
            # Carrera legitima: existia al validar y ya no. Se cuenta como lo que es.
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
        # Se exige forma canonica: ni `..`, ni `.`, ni barras dobles, ni barra final. Cualquier
        # otra forma se rechaza en vez de normalizarse, porque normalizar es justo donde aparecen
        # las diferencias entre lo que valida el gateway y lo que abre el agente.
        if ".." in segments or "." in segments or "" in segments[1:]:
            return ("invalid_path", "path is not canonical")
        base = segments[-1]
        if base in NEVER_SERVE_BASENAMES:
            return ("permission_denied", f"{base} is never served")
        if base.endswith(NEVER_SERVE_SUFFIXES):
            return ("permission_denied", "looks like credential material")
        if kind == "file" and base not in READ_ALLOWED_BASENAMES:
            return ("permission_denied", f"{base} is not a governance document")
        # Contencion: el agente no sirve nada fuera de su propio home, lo pida quien lo pida.
        home = str(self.bundle["home"]).rstrip("/")
        if not home.startswith("/") or (path != home and not path.startswith(home + "/")):
            return ("permission_denied", "path is outside the agent home")
        # `realpath` resuelve TODOS los componentes, asi que esto tambien caza un directorio padre
        # enlazado — que es exactamente el vector que una lista negra de nombres no ve.
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
        if kind == "file" and not stat.S_ISREG(info.st_mode):
            return ("invalid_path", "not a regular file")
        if kind == "dir" and not stat.S_ISDIR(info.st_mode):
            return ("invalid_path", "not a directory")
        return None

    def _send_document(self, request_id: str, path: str) -> None:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_DOCUMENT_BYTES + 1)
            info = os.fstat(handle.fileno())
        truncated = len(raw) > MAX_DOCUMENT_BYTES
        if truncated:
            raw = raw[:MAX_DOCUMENT_BYTES]
        # Se manda UTF-8 valido SIEMPRE: el corte por bytes puede partir un caracter por la mitad y
        # el relay y el gateway decodifican sin red. Un fichero que no sea texto sale con
        # reemplazos, no revienta la lectura.
        payload = raw.decode("utf-8", "replace").encode("utf-8")
        chunks = [payload[offset:offset + MAX_DATA] for offset in range(0, len(payload), MAX_DATA)]
        self._queue(encode_json(TAG_READ_OK, {
            "request_id": request_id,
            "kind": "file",
            "path": path,
            # Tamaño REAL del fichero, aunque el texto vaya recortado: el que mira tiene que poder
            # ver que lo que lee no es todo.
            "bytes": info.st_size,
            "truncated": truncated,
            "modified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(info.st_mtime)),
            "chunks": len(chunks),
        }))
        for chunk in chunks:
            self._queue(encode_data(TAG_READ_DATA, request_id, chunk))

    def _send_memory_index(self, request_id: str, root: str) -> None:
        """Indice de memoria: sale METADATO, nunca contenido."""
        found: list[tuple[str, int, float]] = []
        capped = False
        stack = [(root, 0)]
        while stack and not capped:
            current, depth = stack.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        if len(found) >= DIR_SCAN_CAP:
                            capped = True
                            break
                        # Ni se siguen los enlaces ni se nombran: el nombre de un enlace ya dice
                        # que algo existe al otro lado.
                        if entry.is_symlink():
                            continue
                        if entry.name in NEVER_SERVE_BASENAMES or entry.name.endswith(NEVER_SERVE_SUFFIXES):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if depth + 1 < MAX_DIR_DEPTH:
                                stack.append((entry.path, depth + 1))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        info = entry.stat(follow_symlinks=False)
                        found.append((entry.path, info.st_size, info.st_mtime))
            except OSError:
                # Un subdirectorio ilegible no invalida el indice: se omite y se sigue.
                continue
        found.sort(key=lambda item: item[2], reverse=True)
        # El indice viaja en UNA trama y una trama tiene tope duro (MAX_FRAME). 200 rutas de 4 KB
        # no caben, y pasarse no seria un indice recortado sino una ProtocolError que tira la
        # conexion y con ella las terminales abiertas. Se corta por PRESUPUESTO, no solo por conteo.
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
            # `total` es lo que se encontro. Cuando `truncated` es cierto es un SUELO, no el total
            # del disco: el barrido para en DIR_SCAN_CAP.
            "total": len(found),
            "truncated": capped or len(rows) < len(found),
            "entries": rows,
        }))

    def _read_error(self, request_id: str, code: str, reason: str) -> None:
        self._queue(encode_json(TAG_READ_ERR, {
            "request_id": request_id, "error": code, "reason": reason,
        }))

    def _resolve_command(self, mode: str) -> list[str] | None:
        if mode == "harness":
            return self.bundle["harness_command"]
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
        session.pending_input.extend(data)
        self._write_session(session)

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
        self._hangup(session)

    def _hangup(self, session: PtySession) -> None:
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
            if session.reaped and session.eof and not session.out:
                self._retire(session)
        for session_id, expiry in list(self.tombstones.items()):
            if now >= expiry:
                del self.tombstones[session_id]
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
