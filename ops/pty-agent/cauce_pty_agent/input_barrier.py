"""Live, fail-closed probes of the shared tmux pane behind a writable TUI.

Three independent local sources can hold the keyboard of a `harness_rw` session, and the relay is
none of them:

  1. the adapter's paste, which fences the pane with the `@cauce_input_barrier` option for the
     duration of the paste (`acquirePaneInputBarrier` / `releasePaneInputBarrier` in
     packages/adapter-sdk/src/shared-session/tmux/mutation.ts). It is read here and never
     written: its lifetime belongs to the writer that took it.
  2. this agent's own governance write transactions, which are rewriting the very files the
     harness reads to answer the turn.
  3. the tmux prefix itself. A `harness_rw` attach is a full tmux client, so the prefix reaches
     the tmux command prompt, from where `run-shell` executes as the runtime user and
     `set-option -pu` would clear the very barrier of point 1. The burst carrying it is refused
     here so the console cannot dismantle its own governance.

While any of them holds it the burst is DROPPED. It is never queued: a stored burst would drain
into somebody else's turn the moment the holder let go, which is exactly the accident the barrier
exists to prevent. Both tmux probes fail CLOSED -- a pane that cannot be read is a held pane -- and
the geometry probe answers `None` instead of a guess.
"""
from __future__ import annotations

import re
import subprocess
from typing import Any

from .tmux import tmux_tui_target

INPUT_BARRIER_OPTION = "@cauce_input_barrier"
# A keystroke must never become a `tmux` fork: the pane answer is reused for this long and the
# first byte after the window lapses pays for the next probe. The geometry probe shares it.
INPUT_BARRIER_TTL = 0.25
INPUT_BARRIER_TIMEOUT = 2.0
# The three reasons INPUT_REFUSED can carry. Frozen in tests/terminal-pty/vectors.json.
REFUSED_BY_PANE = "pane_input_barrier"
REFUSED_BY_GOVERNANCE = "governance_write_in_flight"
REFUSED_BY_TMUX_PREFIX = "tmux_prefix"

WINDOW_SIZE_RE = re.compile(r"([0-9]{1,4}) ([0-9]{1,4})")
PANE_ID_RE = re.compile(r"%[0-9]{1,10}")
CONTROL_KEY_RE = re.compile(r"[Cc]-(.)")
# `C-<x>` keys whose byte is not `ord(upper) - 0x40`.
CONTROL_KEY_BYTES = {"@": 0x00, "[": 0x1B, "\\": 0x1C, "]": 0x1D, "^": 0x1E, "_": 0x1F, "?": 0x7F}
DEFAULT_TMUX_PREFIX_BYTE = 0x02


def _tmux_output(bundle: dict[str, Any], arguments: list[str]) -> str | None:
    """One short read-only tmux command on the alias socket. `None` means «unreadable»."""
    config = bundle.get("tmux_tui")
    if not isinstance(config, dict):
        return None
    try:
        completed = subprocess.run(
            [config["path"], "-L", config["socket"], *arguments],
            capture_output=True, timeout=INPUT_BARRIER_TIMEOUT, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.decode("utf-8", "replace").strip()


def _prefix_byte(name: str) -> int | None:
    """The single byte a tmux key name puts on the wire, or `None` when it is not one byte."""
    if name.lower() in ("c-space", "^space"):
        return 0x00
    match = CONTROL_KEY_RE.fullmatch(name)
    if match is None:
        return None
    key = match.group(1)
    if key.isascii() and key.isalpha():
        return ord(key.upper()) - 0x40
    return CONTROL_KEY_BYTES.get(key)


def tmux_prefix_bytes(bundle: dict[str, Any]) -> frozenset[int]:
    """The byte(s) that open the tmux command prompt on THIS server.

    An unreadable server falls back to the tmux default `C-b` instead of an empty set: an empty
    set would forward the one byte this gate exists to stop. It cannot be the only defence
    either -- a harness that spawns shells of its own is a capability of the harness, not of the
    prefix -- so this is defence in depth over the pane barrier, not a replacement for it.
    """
    found = {
        byte for option in ("prefix", "prefix2")
        if (byte := _prefix_byte(_tmux_output(bundle, ["show-options", "-gv", option]) or "")) is not None
    }
    return frozenset(found or {DEFAULT_TMUX_PREFIX_BYTE})


def tmux_tui_pane(bundle: dict[str, Any]) -> str | None:
    """The one pane of the harness window, or `None` when the window is no longer that shape.

    `show-options -p -t <window>` answers for the ACTIVE pane, so a window the operator split
    after attaching would hide a fenced, non-active pane and read as free. `window_panes == 1` is
    the condition the attach itself asserts; anything else here is unreadable, not free.
    """
    target = tmux_tui_target(bundle)
    if target is None:
        return None
    value = _tmux_output(bundle, ["list-panes", "-t", target, "-F", "#{pane_id}"])
    if value is None:
        return None
    panes = value.split("\n")
    if len(panes) != 1 or not PANE_ID_RE.fullmatch(panes[0]):
        return None
    return panes[0]


def pane_input_barrier_held(bundle: dict[str, Any]) -> bool:
    """Is somebody pasting into the shared pane right now? An unprovable pane counts as held."""
    pane = tmux_tui_pane(bundle)
    if pane is None:
        return True
    value = _tmux_output(bundle, ["show-options", "-pqv", "-t", pane, INPUT_BARRIER_OPTION])
    return value is None or value != ""


def tmux_window_geometry(bundle: dict[str, Any]) -> tuple[int, int] | None:
    """(cols, rows) measured on the real shared window, or `None` when it cannot be measured."""
    target = tmux_tui_target(bundle)
    if target is None:
        return None
    value = _tmux_output(
        bundle, ["display-message", "-p", "-t", target, "#{window_width} #{window_height}"])
    match = WINDOW_SIZE_RE.fullmatch(value or "")
    return (int(match.group(1)), int(match.group(2))) if match is not None else None


class InputBarrier:
    """Per-agent cache of the tmux probes, and the verdict the session layer acts on."""

    def __init__(self, bundle: dict[str, Any]) -> None:
        self.bundle = bundle
        self.held = False
        self.deadline = 0.0
        self.geometry: tuple[int, int] | None = None
        self.geometry_deadline = 0.0
        self.prefixes: frozenset[int] | None = None

    def pane_held(self, now: float) -> bool:
        if now < self.deadline:
            return self.held
        self.held = pane_input_barrier_held(self.bundle)
        self.deadline = now + INPUT_BARRIER_TTL
        return self.held

    def window_geometry(self, now: float) -> tuple[int, int] | None:
        """The measured window, coalesced on the same TTL as the pane probe.

        A window drag emits one RESIZE per changed cell column, and each measurement is a
        blocking fork inside the single-threaded select loop that also serves STDOUT and PING.
        """
        if now < self.geometry_deadline:
            return self.geometry
        self.geometry = tmux_window_geometry(self.bundle)
        self.geometry_deadline = now + INPUT_BARRIER_TTL
        return self.geometry

    def prefix_bytes(self) -> frozenset[int]:
        """Read once per agent: the prefix of a tmux server does not change under it."""
        if self.prefixes is None:
            self.prefixes = tmux_prefix_bytes(self.bundle)
        return self.prefixes

    def refusal(self, data: bytes, governance_in_flight: bool, now: float) -> str | None:
        """Which holder owns the keyboard, if any. Governance goes first: it costs no fork."""
        if governance_in_flight:
            return REFUSED_BY_GOVERNANCE
        if any(byte in data for byte in self.prefix_bytes()):
            return REFUSED_BY_TMUX_PREFIX
        return REFUSED_BY_PANE if self.pane_held(now) else None
