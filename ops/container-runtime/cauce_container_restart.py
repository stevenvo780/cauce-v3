from __future__ import annotations

import os
import pathlib
import re
import secrets
import subprocess
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from cauce_container_base import IDENTITY_ENV_KEYS, PermanentError, framed_hash
from cauce_container_proc import (
    expected_environment,
    matched_fs_credentials,
    open_pidfd,
    pidfd_matches_starttime,
    proc_stat,
)

SGR = re.compile(r"\x1b\[([0-9;:]*)m")
# The composer prompt sits at column 0 or right inside a box edge; drafts indent their continuation lines.
PROMPT = re.compile(r"^(?:\s*│\s?)?([❯›»>])(?:\s|$)")
# A drawn rule or box edge, which may carry a status label after its run of strokes.
RULE = re.compile(r"^\s*[─━═╭╰┌└][─━═]{2,}")
ATTACHMENT = re.compile(r"^ {2}\[Image #[1-9][0-9]*\]\s*$")
FOOTER = re.compile(r"context left|context \d+% left|\d+% context left|\? for shortcuts|bypass permissions|shift\+tab"
                    r"|permissions on|accept edits", re.I)
HOOK_NAME = re.compile(r"[a-z][a-z0-9-]*")
GUARD_COMMANDS = {"show-hooks", "show-options", "list-panes", "capture-pane", "if-shell", "set-option", "select-pane"}
PROC = "/proc"


def hold(reason: str) -> None:
    raise PermanentError("RESTART_HOLD_" + reason)


def strip_style(line: str) -> str:
    return SGR.sub("", line)


def dim_after_sgr(dim: bool, sequence: str) -> bool | None:
    codes = (sequence or "0").split(";")
    index = 0
    while index < len(codes):
        code = codes[index]
        if ":" in code:
            parts = code.split(":")
            if parts[0] not in {"38", "48", "58"} or parts[1:2] not in (["2"], ["5"]):
                return None
        elif code in {"38", "48", "58"}:
            mode = codes[index + 1:index + 2]
            count = 3 if mode == ["2"] else 1 if mode == ["5"] else 0
            values = codes[index + 2:index + 2 + count]
            if not count or len(values) != count or any(not value.isdigit() or int(value) > 255 for value in values):
                return None
            index += 2 + count
            continue
        elif code in {"0", "22", ""}:
            dim = False
        elif code == "2":
            dim = True
        index += 1
    return dim


def dim_text(raw: str, start: int = 0) -> bool:
    dim = False
    visible = False
    offset = 0
    for match in SGR.finditer(raw):
        text = raw[offset:match.start()]
        if offset + len(text) > start and text[max(0, start - offset):].strip(" │"):
            visible = True
            if not dim:
                return False
        changed = dim_after_sgr(dim, match.group(1))
        if changed is None:
            return False
        dim = changed
        offset = match.end()
    text = raw[offset:]
    if offset + len(text) > start and text[max(0, start - offset):].strip(" │"):
        visible = True
        if not dim:
            return False
    return visible


def codex_status_line(raw: str) -> bool:
    foreground: tuple[int, ...] | None = None
    cells: list[tuple[str, tuple[int, ...] | None]] = []
    offset = 0
    for match in SGR.finditer(raw):
        cells.extend((char, foreground) for char in raw[offset:match.start()])
        codes = (match.group(1) or "0").split(";")
        index = 0
        while index < len(codes):
            if not codes[index].isdigit():
                return False
            code = int(codes[index])
            if code in {38, 48, 58}:
                mode = codes[index + 1:index + 2]
                count = 3 if mode == ["2"] else 1 if mode == ["5"] else 0
                values = codes[index + 2:index + 2 + count]
                if not count or len(values) != count or any(not value.isdigit() or int(value) > 255 for value in values):
                    return False
                if code == 38:
                    foreground = (int(mode[0]), *(int(value) for value in values))
                index += 2 + count
                continue
            if code in {0, 39}:
                foreground = None
            elif 30 <= code <= 37 or 90 <= code <= 97:
                foreground = (code,)
            elif code not in {1, 2, 3, 4, 7, 9, 21, 22, 23, 24, 27, 29, 49, 59} \
                    and not 40 <= code <= 47 and not 100 <= code <= 107:
                return False
            index += 1
        offset = match.end()
    cells.extend((char, foreground) for char in raw[offset:])
    if any(not char.isprintable() for char, _ in cells) or "".join(char for char, _ in cells[:2]) != "  ":
        return False
    while cells and cells[-1][0] == " ":
        cells.pop()
    body = cells[2:]
    if not body or body[0][0].isspace() or body[0][1] is None:
        return False
    component = body[0][1]
    separator: tuple[int, ...] | None = None
    components = 1
    index = 0
    while index < len(body):
        if body[index][1] == component:
            index += 1
            continue
        delimiter = body[index:index + 3]
        if "".join(char for char, _ in delimiter) != " · " or len({color for _, color in delimiter}) != 1:
            return False
        color = delimiter[0][1]
        following = body[index + 3:index + 4]
        if not following or following[0][0].isspace() or following[0][1] in {None, color}:
            return False
        if components > 1 and color != separator:
            return False
        separator = color
        component = following[0][1]
        components += 1
        index += 3
    return components >= 2


def assert_empty_composer(pane: str, cursor_x: int, cursor_y: int, harness: str = "codex") -> None:
    lines = pane.splitlines()
    if not 0 <= cursor_y < len(lines):
        hold("PANE_UNREADABLE")
    plain = [strip_style(line) for line in lines]
    if any(re.search(r"esc(?:ape)? to interrupt|ctrl\+c.*cancel|\[Pasted text|paste again to expand", line, re.I)
           for line in plain[-12:]):
        hold("TURN_OR_PASTE_ACTIVE")
    prompt = PROMPT.match(plain[cursor_y])
    if prompt is None or any(PROMPT.match(line) for line in plain[cursor_y + 1:]):
        hold("PROMPT_UNKNOWN")
    border = plain[cursor_y].find("│", 0, prompt.start(1))
    if harness not in {"codex", "claude", "grok", "muse", "gemini"} \
            or (harness == "grok") != (border >= 0):
        hold("COMPOSER_FAMILY_UNKNOWN")
    frame_left = border if border >= 0 else 0

    def frame_rule(line: str) -> bool:
        return bool(RULE.match(line)) and len(line) - len(line.lstrip()) == frame_left

    previous = plain[cursor_y - 1] if cursor_y else ""
    bounded = frame_rule(previous)
    if previous.strip() and not bounded:
        hold("COMPOSER_CONTINUATION_UNKNOWN")
    if cursor_y >= 2 and not previous.strip() and ATTACHMENT.fullmatch(plain[cursor_y - 2]):
        hold("COMPOSER_ATTACHMENT_PENDING")
    prefix = plain[cursor_y][:prompt.end()]
    if cursor_x != len(prefix.rstrip()) + 1:
        hold("COMPOSER_CURSOR_AMBIGUOUS")
    content = plain[cursor_y][prompt.end():].strip(" │")
    if re.search(r"\[(?:Image #\d+|Pasted text[^\]]*)\]", content, re.I):
        hold("COMPOSER_ATTACHMENT_PENDING")
    raw = lines[cursor_y]
    mark_at = raw.find(prompt.group(1))
    placeholder = bool(content) and dim_text(raw, mark_at + 1)
    if content and not placeholder:
        hold("COMPOSER_NOT_EMPTY")
    if harness == "codex" and not placeholder:
        hold("COMPOSER_EMPTY_STATE_UNKNOWN")
    if harness == "grok" and not bounded:
        hold("COMPOSER_EMPTY_STATE_UNKNOWN")
    # Editor continuation columns cannot close a frame or impersonate its status area.
    for index, line in enumerate(plain[cursor_y + 1:]):
        if frame_rule(line):
            return
        styled_status = harness == "codex" and index == 1 and not plain[cursor_y + 1].strip() \
            and codex_status_line(lines[cursor_y + 2])
        if line.strip() and (bounded or not placeholder or index == 0 or not (FOOTER.search(line) or styled_status)):
            hold("COMPOSER_CONTINUATION_UNKNOWN")
    # A scrolled nonempty buffer can expose only blank rows without an authentic placeholder.
    if bounded or not placeholder:
        hold("COMPOSER_EMPTY_STATE_UNKNOWN")


def adapter_harness(document: dict[str, Any]) -> str:
    try:
        with matched_fs_credentials(document["runtimeUid"], document["runtimeGid"]):
            raw = (pathlib.Path("/proc") / str(document["pid"]) / "cmdline").read_bytes()
        if framed_hash([raw]) != document["executable"]["cmdlineSha256"]:
            hold("PROCESS_COMMAND_CHANGED")
        arguments = raw.rstrip(b"\0").decode().split("\0")
    except (OSError, UnicodeError, KeyError):
        hold("ADAPTER_ENTRY_UNKNOWN")
    entries = []
    for argument in arguments[1:]:
        match = re.fullmatch(r"/(?:[A-Za-z0-9_.-]+/)+(?:packages/adapter-sdk/dist|adapter)/src/bin/"
                            r"(codex|claude|grok|muse|gemini)\.js", argument)
        if match and os.path.normpath(argument) == argument:
            entries.append(match.group(1))
    if len(entries) != 1:
        hold("ADAPTER_ENTRY_UNKNOWN")
    return entries[0]


def process_identity(pid: int) -> tuple[int, int]:
    try:
        path = pathlib.Path("/proc") / str(pid)
        fields = (path / "stat").read_text().rsplit(") ", 1)[1].split()
        return int(fields[19]), path.stat().st_uid
    except (OSError, ValueError, IndexError):
        hold("PROCESS_IDENTITY_UNKNOWN")
    raise AssertionError


def process_environment(pid: int, uid: int, gid: int) -> dict[str, str]:
    try:
        with matched_fs_credentials(uid, gid):
            data = (pathlib.Path("/proc") / str(pid) / "environ").read_bytes()
        wanted = {b"HOME", b"CAUCE_SHARED_SESSION", b"TMUX_TMPDIR"} | {key.encode() for key in IDENTITY_ENV_KEYS}
        values = {}
        for item in data.split(b"\0"):
            if b"=" not in item:
                continue
            key, value = item.split(b"=", 1)
            if key not in wanted:
                continue
            name = key.decode()
            if name in values:
                hold("PROCESS_ENVIRONMENT_UNKNOWN")
            values[name] = value.decode()
        return values
    except (OSError, UnicodeError):
        hold("PROCESS_ENVIRONMENT_UNKNOWN")
    raise AssertionError


class RestartPane:
    def __init__(self, document: dict[str, Any], environment: dict[str, str]):
        alias = environment.get("CAUCE_ALIAS")
        if not alias or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", alias) \
                or {key: environment[key] for key in IDENTITY_ENV_KEYS if key in environment} != expected_environment(document):
            hold("SESSION_IDENTITY_UNKNOWN")
        home = environment.get("HOME", "")
        if not home.startswith("/") or "\0" in home:
            hold("HOME_UNKNOWN")
        temporary = environment.get("TMUX_TMPDIR")
        if temporary is not None and temporary != document["stateDirectory"]:
            hold("TMUX_DIRECTORY_UNKNOWN")
        self.target = "=cauce-" + document["alias"] + ":agente"
        self.document = document
        self.uid, self.gid = document["runtimeUid"], document["runtimeGid"]
        self.environment = {"HOME": home, "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
        if temporary is not None:
            self.environment["TMUX_TMPDIR"] = document["stateDirectory"]
        self.credentials = {"user": self.uid, "group": self.gid, "extra_groups": [self.gid]} if os.geteuid() == 0 else {}
        if os.geteuid() != 0 and (os.getuid() != self.uid or os.getgid() != self.gid):
            hold("RUNTIME_IDENTITY_UNKNOWN")

    def run(self, *arguments: str) -> str:
        try:
            result = subprocess.run(["/usr/bin/tmux", "-N", "-L", "cauce", *arguments],
                                    capture_output=True, timeout=4, check=False, env=self.environment,
                                    cwd="/", **self.credentials)
        except (OSError, subprocess.TimeoutExpired):
            hold("TMUX_UNAVAILABLE")
        if result.returncode or len(result.stdout) > 262144:
            hold("TMUX_UNREADABLE")
        try:
            return result.stdout.decode()
        except UnicodeError:
            hold("TMUX_UNREADABLE")
        raise AssertionError

    def hooks(self) -> None:
        # The tmux control plane must resolve inspection commands to builtins.
        # Inspect the complete hook catalog before commands which may trigger it.
        for scope in (("-g",), (), ("-w",), ("-p",)):
            lines = self.run("show-hooks", *scope, "-t", self.target).splitlines()
            if scope == ("-g",) and not lines or any(not HOOK_NAME.fullmatch(line) for line in lines if line):
                hold("TMUX_HOOKS")
        aliases = self.run("show-options", "-s", "command-alias")
        for line in aliases.splitlines():
            match = re.fullmatch(r'command-alias\[\d+\]\s+"?([a-z-]+)=.*', line)
            if match is None or match.group(1) in GUARD_COMMANDS:
                hold("TMUX_COMMAND_ALIAS")

    def fields(self, token: str = "") -> tuple[str, ...]:
        self.hooks()
        format_string = "#{pane_id}|#{pane_pid}|#{pane_in_mode}|#{pane_dead}|#{cursor_x}|#{cursor_y}|#{@cauce_input_barrier}|#{pane_input_off}|#{pane_width}|#{pid}"
        lines = self.run("list-panes", "-t", self.target, "-F", format_string).splitlines()
        if len(lines) != 1:
            hold("PANE_AMBIGUOUS")
        fields = tuple(lines[0].split("|"))
        if len(fields) != 10 or not re.fullmatch(r"%[0-9]+", fields[0]) or not fields[1].isdigit() \
                or fields[2:4] != ("0", "0") or fields[6] != token or fields[7] != str(int(bool(token))) \
                or not fields[8].isdigit() or not fields[9].isdigit():
            hold("PANE_NOT_IDLE")
        if process_identity(int(fields[1]))[1] != self.uid:
            hold("PANE_IDENTITY_UNKNOWN")
        return fields

    def read(self, token: str = "") -> tuple[tuple[str, ...], str]:
        fields = self.fields(token)
        snapshot = self.run("capture-pane", "-p", "-e", "-t", fields[0])
        try:
            assert_empty_composer(snapshot, int(fields[4]), int(fields[5]), adapter_harness(self.document))
        except ValueError:
            hold("PANE_UNREADABLE")
        identity = (*fields[:6], *fields[8:], str(process_identity(int(fields[1]))[0]),
                    str(process_identity(int(fields[9]))[0]))
        return identity, snapshot

    def barrier(self, fields: tuple[str, ...], token: str, *, release: bool) -> None:
        pane_id, provider_pid, server_pid = fields[0], fields[1], fields[9]
        requirements = [("pane_id", pane_id), ("pane_pid", provider_pid), ("pid", server_pid),
                        ("pane_in_mode", "0"), ("pane_dead", "0"),
                        ("pane_input_off", "1" if release else "0"),
                        ("@cauce_input_barrier", token if release else "")]
        expressions = ["#{==:#{" + key + "}," + value + "}" for key, value in requirements]
        condition = expressions.pop()
        for expression in expressions:
            condition = "#{&&:" + expression + "," + condition + "}"
        if release:
            commands = f"select-pane -e -t {pane_id} ; set-option -pu -t {pane_id} @cauce_input_barrier"
        else:
            commands = f"set-option -p -t {pane_id} @cauce_input_barrier {token} ; select-pane -d -t {pane_id}"
        self.run("if-shell", "-F", "-t", pane_id, condition, commands, "")


def shared_pane(document: dict[str, Any]) -> RestartPane | None:
    pid, starttime, uid = document["pid"], document["starttime"], document["runtimeUid"]
    if process_identity(pid) != (starttime, uid):
        hold("PROCESS_IDENTITY_CHANGED")
    environment = process_environment(pid, uid, document["runtimeGid"])
    if environment.get("CAUCE_SHARED_SESSION") is None:
        return None
    if environment.get("CAUCE_SHARED_SESSION") != "1":
        hold("SHARED_SESSION_UNKNOWN")
    pane = RestartPane(document, environment)
    return None if tmux_absent() else pane


def tmux_absent() -> bool:
    # A shared session that never got its TUI, or whose TUI died, has no composer left to protect.
    # Any non-zombie tmux in this PID namespace, whatever its socket or user, keeps the fail-closed pane checks.
    try:
        entries = [entry.path for entry in os.scandir(PROC) if entry.name.isdigit()]
    except OSError:
        hold("TMUX_PROCESS_UNKNOWN")
    for entry in entries:
        try:
            with open(os.path.join(entry, "comm"), "rb") as handle:
                name = handle.read()
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError:
            hold("TMUX_PROCESS_UNKNOWN")
        if name.startswith(b"tmux"):
            try:
                if proc_stat(int(os.path.basename(entry)))["state"] != "Z":
                    return False
            except (FileNotFoundError, ProcessLookupError):
                continue
            except (OSError, ValueError, KeyError, PermanentError):
                hold("TMUX_PROCESS_UNKNOWN")
    return True


def assert_restart_safe(document: dict[str, Any]) -> None:
    pane = shared_pane(document)
    if pane is None:
        return
    first = pane.read()
    time.sleep(0.03)
    if pane.read() != first or process_identity(document["pid"]) != (document["starttime"], document["runtimeUid"]):
        hold("PANE_CHANGED")


@contextmanager
def restart_fence(document: dict[str, Any]) -> Iterator[None]:
    pane = shared_pane(document)
    if pane is None:
        yield
        return
    first = pane.read()
    fields = pane.fields()
    token = secrets.token_hex(32)
    pins: list[tuple[int, int, int]] = []
    acquired = False
    attempted = False
    try:
        for pid in (int(fields[1]), int(fields[9])):
            starttime, uid = process_identity(pid)
            fd = open_pidfd(pid)
            pins.append((pid, fd, starttime))
            if uid != pane.uid or not pidfd_matches_starttime(pid, fd, starttime):
                hold("PANE_IDENTITY_CHANGED")
        if pane.read() != first:
            hold("PANE_CHANGED")
        attempted = True
        pane.barrier(fields, token, release=False)
        pane.fields(token)
        acquired = True
        if any(not pidfd_matches_starttime(pid, fd, ticks) for pid, fd, ticks in pins) \
                or pane.read(token) != first:
            hold("PANE_CHANGED")
        yield
    finally:
        try:
            if attempted:
                try:
                    current = pane.fields(token)
                    if current[:2] != fields[:2] or current[9] != fields[9] \
                            or any(not pidfd_matches_starttime(pid, fd, ticks) for pid, fd, ticks in pins):
                        raise PermanentError("RESTART_PARTIAL_INPUT_FENCE_IDENTITY_CHANGED")
                    pane.barrier(fields, token, release=True)
                    pane.fields()
                except BaseException as error:
                    if acquired or not str(error).startswith("RESTART_PARTIAL_"):
                        raise PermanentError("RESTART_PARTIAL_INPUT_FENCE_RESTORE_UNCONFIRMED") from error
                    raise
        finally:
            for _pid, fd, _ticks in pins:
                os.close(fd)
