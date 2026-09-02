from __future__ import annotations

import json
import os
import re
import stat
from typing import Any

from .framing import PermanentError

OPENCLAW_NATIVE_SESSION_RE = re.compile(r"^[A-Za-z0-9._:-]{1,512}$")
TMUX_SOCKET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TMUX_IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
# The only producer of this window name is packages/adapter-sdk/src/shared-session/types.ts.
TMUX_TUI_WINDOW = "agente"
MAX_SESSION_STORE_BYTES = 1 << 20


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


def tmux_tui_target(bundle: dict[str, Any]) -> str | None:
    """`cauce-<alias>:agente`, the only window this agent may ever address, or nothing.

    The live probes of `input_barrier.py` name the same window the attach names, so a pane read
    can never drift onto another alias's session while the attach stays fenced.
    """
    config = bundle.get("tmux_tui")
    alias = bundle.get("alias")
    if not isinstance(config, dict) or not isinstance(alias, str):
        return None
    if not TMUX_IDENTITY_RE.fullmatch(alias) or bundle.get("harness") not in ("claude", "codex"):
        return None
    return f"cauce-{alias}:{TMUX_TUI_WINDOW}"


def resolve_tmux_tui_command(bundle: dict[str, Any], mode: str = "harness") -> list[str] | None:
    """Build one fail-closed tmux command that validates and attaches on the same server.

    `if-shell -F` evaluates the target formats and executes `attach-session` inside one tmux
    command. If the server was restarted, the mutable name was reused, a marker changed, or the
    pane died, the false branch exits 77. There is no preflight/attach TOCTOU and no frozen `$N`.

    `mode` only changes the attach: the writable TUI drops `-r`, and with it `-f ignore-size`, so
    the shared window follows the browser for as long as the operator holds control. Every
    identity condition and the false branch stay byte for byte the same in both modes.
    """
    config = bundle.get("tmux_tui")
    target = tmux_tui_target(bundle)
    if not isinstance(config, dict) or target is None:
        return None
    alias = bundle["alias"]
    harness = bundle["harness"]
    conditions = (
        f"#{{&&:#{{==:#{{session_name}},cauce-{alias}}},"
        f"#{{&&:#{{==:#{{window_name}},{TMUX_TUI_WINDOW}}},"
        f"#{{&&:#{{==:#{{window_panes}},1}},"
        f"#{{&&:#{{==:#{{@cauce_alias}},{alias}}},"
        f"#{{&&:#{{==:#{{@cauce_harness}},{harness}}},"
        "#{==:#{pane_dead},0}}}}}}}}}}"
    )
    attach = (f"attach-session -t {target}" if mode == "harness_rw"
              else f"attach-session -r -f ignore-size -t {target}")
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
