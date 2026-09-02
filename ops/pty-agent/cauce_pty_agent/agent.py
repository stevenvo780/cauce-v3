from __future__ import annotations

import argparse
import json
import os
import select
import signal
import socket
import ssl
import struct
import tempfile
import time
from typing import Any

from .framing import (
    AGENT_PROTOCOL_VERSION,
    MAX_FRAME,
    PERMANENT_EXIT,
    PREFIXED_TAGS,
    TAG_AGENT_HELLO,
    TAG_CLOSE,
    TAG_HELLO_ACK,
    TAG_OPEN,
    TAG_PAUSE_OUTPUT,
    TAG_PING,
    TAG_PONG,
    TAG_READ,
    TAG_RESIZE,
    TAG_RESUME_OUTPUT,
    TAG_STDIN,
    TAG_TERMINAL_RESPONSE,
    TAG_WRITE,
    TAG_WRITE_BATCH,
    TAG_WRITE_BATCH_CANCEL,
    TAG_WRITE_BATCH_DATA,
    TAG_WRITE_CANCEL,
    TAG_WRITE_DATA,
    FrameDecoder,
    PermanentError,
    ProtocolError,
    decode_data,
    encode_frame,
    encode_json,
    fail,
    log,
)
from .governance_paths import FEATURES, GovernancePathsMixin
from .governance_read import GovernanceReadMixin
from .governance_write import GovernanceWrite, GovernanceWriteBatch, GovernanceWriteMixin
from .input_barrier import InputBarrier
from .runtime_facts import load_bundle
from .session import (
    DYNAMIC_CAPABILITY_CHECK_INTERVAL,
    FLUSH_INTERVAL,
    HELLO_TIMEOUT,
    PING_TIMEOUT,
    SESSION_HIGH_WATER,
    PtySession,
    SessionMixin,
    _cloexec,
)
from .tmux import resolve_openclaw_tui_command, resolve_tmux_tui_command

BACKOFF_MIN = 1.0
BACKOFF_MAX = 30.0


SELECT_CEILING = 1.0


class PtyAgent(SessionMixin, GovernanceReadMixin, GovernanceWriteMixin, GovernancePathsMixin):
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
        self.input_barrier = InputBarrier(bundle)
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
        openclaw_ready = self.bundle.get("openclaw_tui") is not None \
            and resolve_openclaw_tui_command(self.bundle) is not None
        modes = ["shell"] + (["harness"] if static_or_tmux or openclaw_ready else [])
        # The writable TUI is announced only where it can actually be served: the tmux route is
        # the only one with a pane barrier, so it is the only one whose keyboard can be governed.
        if resolve_tmux_tui_command(self.bundle, mode="harness_rw") is not None:
            modes.append("harness_rw")
        return modes

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
