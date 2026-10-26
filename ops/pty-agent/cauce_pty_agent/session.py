from __future__ import annotations

import errno
import fcntl
import os
import pty
import re
import signal
import struct
import termios
import time
from typing import Any

from .framing import (
    MAX_DATA,
    MAX_FRAME,
    SESSION_ID_RE,
    TAG_CLOSED,
    TAG_GEOMETRY,
    TAG_INPUT_REFUSED,
    TAG_OPEN_ERR,
    TAG_OPEN_OK,
    TAG_STDOUT,
    ProtocolError,
    TicketError,
    authorize_ticket,
    encode_data,
    encode_json,
    log,
    verify_ticket,
)
from .openclaw_input import OpenClawInput
from .tmux import dynamic_tmux_capability, resolve_openclaw_tui_command, resolve_tmux_tui_command, tmux_tui_available
from .tui_environment import PATH_KEYS, measured_environment, openclaw_environment

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
# Editing a space replaces the TUI pane of a connected agent. Its published TUI stays up this long
# so `cauce <alias>` neither sees it offline nor lands on a shell, and the TUI OPENs that arrive in
# the gap wait for the new pane, below the relay's 10 s OPEN timeout.
TUI_RESTART_WAIT = 30.0
OPEN_TUI_WAIT = 8.0
TUI_POLL_INTERVAL = 0.5
TOMBSTONE_SECONDS = 30.0
KILL_GRACE = 2.0
HELLO_TIMEOUT = 15.0


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

# Modes that drive a real TUI, and therefore the ones the emulator owes its DA/DSR answer to.
# That gate used to be written as the complement of READ_ONLY_MODES, which silently denied the
# technical channel to a writable TUI: it would attach and never learn what terminal it is on.
TUI_MODES = frozenset({"harness", "harness_rw"})
# Derived, so the two cannot drift: the TUI that types is the one the pane barrier governs.
WRITABLE_TUI_MODES = TUI_MODES - READ_ONLY_MODES


class OpenRefused(RuntimeError):
    """The route resolved for this mode cannot serve it; `reason`/`detail` travel in OPEN_ERR."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(reason if not detail else f"{reason}:{detail}")
        self.reason = reason
        self.detail = detail


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
        self.openclaw_input = OpenClawInput()
        self.openclaw_paths: dict[str, str] | None = None
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
        self.recovery_pending_until: float | None = None


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


class SessionMixin:
    # -- request handlers ----------------------------------------------------------------------

    def _on_open(self, request: dict[str, Any], deferred: bool = False) -> None:
        session_id = request.get("session_id")
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            raise ProtocolError("OPEN carries an invalid session id")
        if session_id in self.sessions or session_id in self.tombstones or session_id in self.pending_opens:
            self._open_error(session_id, "duplicate_session")
            return
        try:
            payload = verify_ticket(self.alias_key, request.get("ticket"), time.time())
            mode = authorize_ticket(payload, self.identity, session_id)
        except TicketError as error:
            log(f"OPEN refused session={session_id} reason={error.reason} {error.detail}".rstrip())
            self._open_error(session_id, error.reason, error.detail)
            return
        # The browser names no container, user or command: mode comes from the signed ticket, argv from the bundle.
        if request.get("mode") not in (None, mode):
            self._open_error(session_id, "mode_mismatch")
            return
        if (mode in TUI_MODES and not deferred and self._tui_restart_tracked()
                and not tmux_tui_available(self.bundle) and self._tui_restart_pending(time.monotonic())):
            if len(self.sessions) + len(self.pending_opens) >= MAX_SESSIONS:
                self._open_error(session_id, "too_many_sessions")
                return
            self.pending_opens[session_id] = (request, time.monotonic() + OPEN_TUI_WAIT)
            log(f"OPEN deferred session={session_id} mode={mode} until the TUI pane is back")
            return
        try:
            argv = self._resolve_command(mode)
        except OpenRefused as refusal:
            log(f"OPEN refused session={session_id} reason={refusal.reason} {refusal.detail}")
            self._open_error(session_id, refusal.reason, refusal.detail)
            return
        if argv is None:
            self._open_error(session_id, "mode_unavailable")
            return
        pending = next((session for session in self.sessions.values()
                        if mode in TUI_MODES and session.recovery_pending_until is not None
                        and not session.reaped and session.kill_deadline is None and session.argv == argv
                        and time.monotonic() < session.recovery_pending_until), None)
        if (mode in TUI_MODES and pending is None
                and any(session.recovery_pending_until is not None for session in self.sessions.values())):
            self._open_error(session_id, "mode_unavailable", "recovered_conversation_changed")
            return
        if pending is None and len(self.sessions) >= MAX_SESSIONS:
            self._open_error(session_id, "too_many_sessions")
            return
        rows, cols = _window(request)
        try:
            if pending is not None:
                set_window_size(pending.fd, rows, cols)
                del self.sessions[pending.session_id]
                pending.session_id = session_id
                pending.mode = mode
                pending.recovery_pending_until = None
                pending.output_paused = False
                session = pending
            else:
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
        if mode in TUI_MODES:
            self._send_geometry(session)
        log(f"OPEN accepted session={session_id} mode={mode} pid={session.pid} argv0={argv[0]}")

    def _tui_restart_tracked(self) -> bool:
        return (dynamic_tmux_capability(self.bundle) and isinstance(self.bundle.get("tmux_tui"), dict)
                and "harness" in self.modes)

    def _tui_restart_pending(self, now: float) -> bool:
        if self.tui_restart_until is None:
            self.tui_restart_until = now + TUI_RESTART_WAIT
            log(f"TUI pane gone alias={self.bundle['alias']}; presence kept up to {TUI_RESTART_WAIT:.0f}s")
        return now < self.tui_restart_until

    def _pump_pending_opens(self, now: float) -> None:
        if not self.pending_opens or now < self.next_pending_open_poll:
            return
        self.next_pending_open_poll = now + TUI_POLL_INTERVAL
        available = tmux_tui_available(self.bundle)
        for session_id, (request, deadline) in list(self.pending_opens.items()):
            if not available and now < deadline:
                continue
            del self.pending_opens[session_id]
            if available:
                self._on_open(request, deferred=True)
            else:
                log(f"OPEN refused session={session_id} reason=mode_unavailable tui_restarting")
                self._open_error(session_id, "mode_unavailable", "tui_restarting")

    def _send_geometry(self, session: PtySession) -> None:
        """The measured size of the shared window, so the console fits its font to the real TUI.

        Silence is the honest answer when tmux cannot be read: a guessed geometry would repaint
        the operator's pane at a size nobody has.
        """
        size = self.input_barrier.window_geometry(time.monotonic())
        if size is None:
            return
        rows, cols = _window({"cols": size[0], "rows": size[1]})
        self._queue(encode_json(TAG_GEOMETRY, {
            "session_id": session.session_id, "cols": cols, "rows": rows,
        }))

    def _open_error(self, session_id: str, reason: str, detail: str = "") -> None:
        document: dict[str, Any] = {"session_id": session_id, "reason": reason}
        if detail:
            document["detail"] = detail
        self._queue(encode_json(TAG_OPEN_ERR, document))

    def _resolve_command(self, mode: str) -> list[str] | None:
        """Resolve the current conversation; static commands cannot receive governed input."""
        if mode in TUI_MODES:
            writable = mode in WRITABLE_TUI_MODES
            if self.bundle["harness_command"] is not None:
                if writable:
                    raise OpenRefused("writable_tui_unavailable", "harness_command")
                return self.bundle["harness_command"]
            if self.bundle.get("tmux_tui") is not None:
                return resolve_tmux_tui_command(self.bundle, mode)
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
        tui_paths = None
        if mode in TUI_MODES and self.bundle.get("openclaw_tui") is not None:
            tui_environment = openclaw_environment(self.bundle)
            tui_paths = {key: value for key, value in tui_environment.items() if key in PATH_KEYS}
            if (resolve_openclaw_tui_command(self.bundle) != argv
                    or measured_environment(self.bundle) != tui_paths
                    or self.bundle["openclaw_tui"].get("local") is True and not tui_paths):
                raise OSError(errno.ESTALE, "OpenClaw runtime changed")
            environment.update(tui_environment)
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
        session = PtySession(session_id, pid, master, mode, argv)
        session.openclaw_paths = tui_paths
        return session

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
        if session.mode in WRITABLE_TUI_MODES:
            if self.bundle.get("openclaw_tui") is not None \
                    and (resolve_openclaw_tui_command(self.bundle) != session.argv
                         or session.openclaw_paths is not None
                         and measured_environment(self.bundle) != session.openclaw_paths):
                self._hangup(session, "native_session_changed")
                return
            refusal = self.input_barrier.refusal(
                data, bool(self.pending_writes or self.pending_write_batches), time.monotonic())
            if refusal is not None:
                # Dropped, not queued: the burst would otherwise drain into the next turn, the
                # very accident the barrier exists to stop. One frame per burst, never per byte.
                self._queue(encode_json(TAG_INPUT_REFUSED, {
                    "session_id": session_id, "reason": refusal,
                }))
                return
        if session.mode in WRITABLE_TUI_MODES and self.bundle.get("openclaw_tui") is not None:
            data = session.openclaw_input.translate(data)
        self._enqueue_session_input(session, data)

    def _on_terminal_response(self, session_id: str, data: bytes) -> None:
        # Validated even if the session is already gone: a malformed frame never gains a permissive
        # path by arriving late.
        if not is_terminal_emulator_response(data):
            raise ProtocolError("TERMINAL_RESPONSE is not an allowed DA/DSR response")
        session = self.sessions.get(session_id)
        if session is None:
            return
        if session.mode not in TUI_MODES:
            raise ProtocolError("TERMINAL_RESPONSE is only valid for a TUI session")
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
        if session.mode in WRITABLE_TUI_MODES:
            # The shared window follows the browser while control is held, so the size the
            # console must fit is the one tmux ends up with, not the one it asked for.
            self._send_geometry(session)

    def _on_close(self, request: dict[str, Any]) -> None:
        session_id = request.get("session_id")
        if not isinstance(session_id, str):
            raise ProtocolError("CLOSE carries an invalid session id")
        if self.pending_opens.pop(session_id, None) is not None:
            self.tombstones[session_id] = time.monotonic() + TOMBSTONE_SECONDS
            return
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
            if session.recovery_pending_until is not None and now >= session.recovery_pending_until:
                self._hangup(session, "recovery_terminal_not_opened")
            if session.kill_deadline is not None and now >= session.kill_deadline and not session.reaped:
                session.kill_deadline = now + KILL_GRACE
                self._signal(session, signal.SIGKILL)
            self._flush_session(session)
            if session.reaped and session.eof:
                self._retire(session)
        for session_id, expiry in list(self.tombstones.items()):
            if now >= expiry:
                del self.tombstones[session_id]
        self._pump_pending_opens(now)
        dynamic_tui = self.bundle.get("openclaw_tui") is not None \
            or dynamic_tmux_capability(self.bundle)
        if dynamic_tui and now >= self.next_dynamic_capability_check:
            self.next_dynamic_capability_check = now + DYNAMIC_CAPABILITY_CHECK_INTERVAL
            observed = self._advertised_modes()
            if observed == self.modes:
                if self.tui_restart_until is not None:
                    log(f"TUI pane back alias={self.bundle['alias']}; presence unchanged")
                    self.tui_restart_until = None
            elif set(observed) < set(self.modes) and self._tui_restart_tracked() \
                    and self._tui_restart_pending(now):
                self.next_dynamic_capability_check = now + TUI_POLL_INTERVAL
            elif self.sessions and set(observed) > set(self.modes):
                # A gained mode leaves every open session valid and the gateway still refuses the
                # unpublished one, so the reconnect waits for the last session instead of cutting it.
                if observed != self.deferred_modes:
                    self.deferred_modes = observed
                    log(f"capability gained modes={','.join(observed)}; reconnect deferred "
                        f"while {len(self.sessions)} session(s) are open")
            elif observed != self.modes:
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
        if session.recovery_pending_until is None:
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
