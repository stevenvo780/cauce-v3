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

from cauce_container_base import PermanentError
from cauce_container_proc import matched_fs_credentials, open_pidfd, pidfd_matches_starttime

SGR = re.compile(r"\x1b\[([0-9;]*)m")
PROMPT = re.compile(r"^\s*(?:│\s*)?([❯›»>])(?:\s|$)")
HOOK_NAME = re.compile(r"[a-z][a-z0-9-]*")
GUARD_COMMANDS = {"show-hooks", "show-options", "list-panes", "capture-pane", "if-shell", "set-option", "select-pane"}


def hold(reason: str) -> None:
    raise PermanentError("RESTART_HOLD_" + reason)


def strip_style(line: str) -> str:
    return SGR.sub("", line)


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
        for code in (match.group(1) or "0").split(";"):
            if code in {"0", "22", ""}:
                dim = False
            elif code == "2":
                dim = True
        offset = match.end()
    text = raw[offset:]
    if offset + len(text) > start and text[max(0, start - offset):].strip(" │"):
        visible = True
        if not dim:
            return False
    return visible


def assert_empty_composer(pane: str, cursor_x: int, cursor_y: int) -> None:
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
    # Scrolled or multiline input cannot be distinguished from history here.
    if any(line.strip() for line in plain[:cursor_y]):
        hold("COMPOSER_CONTINUATION_UNKNOWN")
    prefix = plain[cursor_y][:prompt.end()]
    if cursor_x != len(prefix.rstrip()) + 1:
        hold("COMPOSER_CURSOR_AMBIGUOUS")
    content = plain[cursor_y][prompt.end():].strip(" │")
    raw = lines[cursor_y]
    mark_at = raw.find(prompt.group(1))
    if content and not dim_text(raw, mark_at + 1):
        hold("COMPOSER_NOT_EMPTY")
    for raw_line, line in zip(lines[cursor_y + 1:], plain[cursor_y + 1:], strict=True):
        if not line.strip(" │─━═╭╮╰╯┌┐└┘"):
            continue
        # Only dim status footers are distinguishable from a wrapped draft here.
        if not dim_text(raw_line) or not re.search(
            r"(?:context left|\? for shortcuts|bypass permissions|shift\+tab|permissions on|accept edits)", line, re.I):
            hold("COMPOSER_CONTINUATION_UNKNOWN")


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
        wanted = {b"HOME", b"CAUCE_ALIAS", b"CAUCE_SHARED_SESSION"}
        return {key.decode(): value.decode() for item in data.split(b"\0") if b"=" in item
                for key, value in [item.split(b"=", 1)] if key in wanted}
    except (OSError, UnicodeError):
        hold("PROCESS_ENVIRONMENT_UNKNOWN")
    raise AssertionError


class RestartPane:
    def __init__(self, document: dict[str, Any], environment: dict[str, str]):
        alias = environment.get("CAUCE_ALIAS")
        if not alias or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", alias) \
                or alias != document.get("wireAlias", document["alias"]):
            hold("SESSION_IDENTITY_UNKNOWN")
        home = environment.get("HOME", "")
        if not home.startswith("/") or "\0" in home:
            hold("HOME_UNKNOWN")
        self.target = "=cauce-" + alias + ":agente"
        self.uid, self.gid = document["runtimeUid"], document["runtimeGid"]
        self.environment = {"HOME": home, "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
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
        format_string = "#{pane_id}\t#{pane_pid}\t#{pane_in_mode}\t#{pane_dead}\t#{cursor_x}\t#{cursor_y}\t#{@cauce_input_barrier}\t#{pane_input_off}\t#{pane_width}\t#{pid}"
        lines = self.run("list-panes", "-t", self.target, "-F", format_string).splitlines()
        if len(lines) != 1:
            hold("PANE_AMBIGUOUS")
        fields = tuple(lines[0].split("\t"))
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
            assert_empty_composer(snapshot, int(fields[4]), int(fields[5]))
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
    return RestartPane(document, environment)


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
