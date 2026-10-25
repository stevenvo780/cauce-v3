"""Read-only native adapter identity and conservative local TUI absence witness."""
from __future__ import annotations

import errno
import hashlib
import json
import os
import pathlib
import re
import socket
import stat
import subprocess
import sys

MAX_JSON_BYTES = 256 * 1024 * 1024
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
PROC = pathlib.Path("/proc")
CGROUP = pathlib.Path("/sys/fs/cgroup")


class Retain(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Retain(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=20).stdout.strip()


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink)


def file_identity(info):
    return identity(info) + (info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def checked_directories(path, uid, private=False):
    require(path.is_absolute() and str(path) == os.path.normpath(path), "noncanonical directory")
    chain = []
    for directory in [pathlib.Path("/"), *reversed(list(path.parents)[:-1]), path]:
        if chain and str(directory) == chain[-1][0]:
            continue
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), "unsafe directory type")
        require(info.st_uid in (0, uid), "unsafe directory owner")
        writable = info.st_mode & 0o022
        require(not writable or info.st_uid == 0 and info.st_mode & stat.S_ISVTX, "unsafe directory mode")
        if directory == path and private:
            require(info.st_uid == uid and not info.st_mode & 0o077, "private directory required")
        chain.append((str(directory), identity(info)[:4]))
    return chain


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def invalid_constant(_value):
    raise Retain("invalid JSON constant")


class Files:
    def __init__(self, state, uid):
        self.state = state
        self.uid = uid
        self.directories = checked_directories(state, uid)
        self.observed = {}

    def read(self, name, optional=False):
        path = self.state / name
        try:
            before = path.lstat()
        except FileNotFoundError:
            require(optional, "required durable file missing")
            self.observed[name] = None
            return None
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and before.st_uid == self.uid and not before.st_mode & 0o022,
                "unsafe durable file")
        require(before.st_size <= MAX_JSON_BYTES, "durable file exceeds read limit")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            opened = os.fstat(descriptor)
            require(file_identity(opened) == file_identity(before), "durable file changed before read")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                raw = stream.read(MAX_JSON_BYTES + 1)
            require(len(raw) <= MAX_JSON_BYTES and len(raw) == opened.st_size, "durable file changed size")
            require(file_identity(os.fstat(descriptor)) == file_identity(opened)
                    and file_identity(path.lstat()) == file_identity(opened), "durable file changed during read")
        finally:
            os.close(descriptor)
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=invalid_constant)
        self.observed[name] = (file_identity(opened), digest(raw))
        return value

    def artifacts(self):
        names = os.listdir(self.state)
        require(not any(".atomic-" in name or name.endswith(".tmp") for name in names),
                "ambiguous durable atomic artifact")

    def revalidate(self):
        require(checked_directories(self.state, self.uid) == self.directories, "durable directory changed")
        previous = dict(self.observed)
        for name, original in previous.items():
            self.read(name, optional=original is None)
            require(self.observed[name] == original, "durable state changed during snapshot")
        self.artifacts()

    def evidence(self):
        return {name: None if value is None else {"sha256": value[1], "bytes": value[0][5]}
                for name, value in sorted(self.observed.items())}


def process_identity(pid):
    directory = PROC / str(pid)
    before = directory.stat()
    raw = (directory / "stat").read_text()
    fields = raw[raw.rfind(") ") + 2:].split()
    require(len(fields) >= 20 and int(raw.split("(", 1)[0]) == pid, "invalid process identity")
    status = (directory / "status").read_text()
    match = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", status, re.MULTILINE)
    require(match is not None and len(set(match.groups())) == 1, "ambiguous process uid")
    uid = int(match.group(1))
    # Linux makes nondumpable proc directories root-owned without changing the process UID.
    require(before.st_uid in (0, uid) and directory.stat().st_uid == before.st_uid, "process uid changed")
    cgroups = (directory / "cgroup").read_text().splitlines()
    groups = []
    for line in cgroups:
        pieces = line.split(":", 2)
        require(len(pieces) == 3 and pieces[2].startswith("/"), "invalid process cgroup")
        groups.append(pieces[2])
    require(groups, "missing process cgroup")
    return {"pid": pid, "uid": uid, "start": fields[19], "cgroups": groups}


def unit_identity(unit, uid):
    shown = command("systemctl", "--user", "show", unit, "-p", "MainPID", "-p", "ControlGroup", "-p", "ActiveState")
    fields = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)
    pid = int(fields.get("MainPID", "0"))
    group = fields.get("ControlGroup", "")
    require(pid > 0 and fields.get("ActiveState") == "active", "adapter is not active")
    require(group.startswith("/") and group != "/" and os.path.normpath(group) == group,
            "canonical adapter cgroup required")
    process = process_identity(pid)
    require(process["uid"] == uid and group in process["cgroups"], "adapter identity differs")
    return {"process": process, "control_group": group}


def environment(pid):
    raw = (PROC / str(pid) / "environ").read_bytes()
    result = {}
    for item in raw.split(b"\0"):
        if b"=" in item:
            key, value = item.split(b"=", 1)
            require(key not in result, "duplicate process environment field")
            result[key] = value
    return result


def codex_candidate(arguments, executable):
    for token in [executable, *arguments]:
        if not token or len(token) > 4096 or any(character.isspace() for character in token):
            continue
        name = os.path.basename(token).lower()
        if name == "codex" or name.startswith("codex-") or name.endswith("codex.js") or name.endswith("-codex"):
            return True
    return False


def vanished(pid):
    try:
        (PROC / str(pid)).lstat()
    except FileNotFoundError:
        return True
    return False


def independent_unit(groups, target):
    for group in groups:
        leaf = group.rsplit("/", 1)[-1]
        if leaf.endswith((".service", ".scope")) and group != target and not target.startswith(group + "/"):
            return True
    return False


def harness_home(env):
    value = env.get(b"CODEX_HOME")
    if value:
        return os.fsdecode(value)
    home = env.get(b"HOME")
    return str(pathlib.Path(os.fsdecode(home)) / ".codex") if home else None


def canonical_path(value, directory=False):
    path = pathlib.Path(value)
    require(path.is_absolute(), "relative process attribution path")
    canonical = path.resolve(strict=True)
    info = canonical.stat()
    require(not directory or stat.S_ISDIR(info.st_mode), "process attribution directory required")
    require(identity(path.stat()) == identity(info), "process attribution path changed")
    return (str(canonical), info.st_dev, info.st_ino)


def paths_overlap(first, second):
    return first[1:] == second[1:] or os.path.commonpath((first[0], second[0])) in (first[0], second[0])


def attributed_candidate(entry, observed, unit, adapter_env, adapter_cwd, arguments):
    candidate_env = environment(observed["pid"])
    candidate_cwd = os.readlink(entry / "cwd")
    target_home = harness_home(adapter_env)
    candidate_home = harness_home(candidate_env)
    require(target_home is not None and candidate_home is not None, "Codex configuration attribution is unknown")
    state = os.fsdecode(adapter_env[b"CAUCE_STATE_DIR"])
    target_values = (target_home, adapter_cwd, state)
    candidate_values = (candidate_home, candidate_cwd)
    pinned = {value: canonical_path(value, directory=True) for value in (*target_values, *candidate_values)}
    require(not any(paths_overlap(pinned[candidate], pinned[target])
                    for candidate in candidate_values for target in target_values),
            "Codex process matches adapter configuration, workspace or state")
    require(independent_unit(observed["cgroups"], unit["control_group"]), "Codex process has no independent unit")
    argument_pins = {}
    for argument in arguments[1:]:
        value = argument.split("=", 1)[-1]
        if value.startswith("/"):
            argument_pins[value] = canonical_path(value)
            require(not any(paths_overlap(argument_pins[value], pinned[target]) for target in target_values),
                    "Codex argv matches adapter")
    require(all(canonical_path(value, directory=True) == pin for value, pin in pinned.items())
            and all(canonical_path(value) == pin for value, pin in argument_pins.items())
            and os.readlink(entry / "cwd") == candidate_cwd and environment(observed["pid"]) == candidate_env,
            "process attribution changed during inspection")


def unit_membership(unit):
    root = CGROUP / unit["control_group"].lstrip("/")
    require(root.resolve(strict=True) == root, "unsafe adapter cgroup path")
    pending = [root]
    groups = {}
    members = set()
    while pending:
        directory = pending.pop()
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode), "unsafe adapter cgroup directory")
        groups[str(directory)] = identity(info)[:4]
        path = directory / "cgroup.procs"
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                raw = stream.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, "adapter cgroup membership exceeds limit")
            rows = raw.splitlines()
            require(all(row.isdigit() and int(row) > 0 for row in rows), "unknown adapter cgroup membership")
            members.update(int(row) for row in rows)
        finally:
            os.close(descriptor)
        for entry in directory.iterdir():
            entry_info = entry.lstat()
            require(not stat.S_ISLNK(entry_info.st_mode), "unsafe adapter cgroup entry")
            if stat.S_ISDIR(entry_info.st_mode):
                pending.append(entry)
    require(members == {unit["process"]["pid"]}, "residual or unknown adapter cgroup process")
    return groups


def process_executable(pid, privileged_proc_read=False):
    try:
        return os.readlink(PROC / str(pid) / "exe")
    except PermissionError:
        require(privileged_proc_read and PROC == pathlib.Path("/proc") and type(pid) is int and pid > 0,
                "process executable is unreadable")
        result = subprocess.run(["/usr/bin/sudo", "-n", "--", "/usr/bin/readlink", "--", f"/proc/{pid}/exe"],
                                capture_output=True, text=True, timeout=5)
        require(result.returncode == 0 and result.stdout.startswith("/")
                and len(result.stdout) <= 4096 and result.stdout.count("\n") == 1,
                "privileged process executable is unavailable")
        return result.stdout.removesuffix("\n")


def process_absence(unit, uid, adapter_env, adapter_cwd, privileged_proc_read=False):
    group = unit["control_group"]
    adapter = unit["process"]
    membership = unit_membership(unit)
    owned = 0
    for entry in PROC.iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        try:
            owner = entry.stat().st_uid
            if owner != uid:
                if owner != 0:
                    continue
                status = (entry / "status").read_text()
                match = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", status, re.MULTILINE)
                require(match is not None, "process uid cannot be classified")
                if uid not in (int(value) for value in match.groups()):
                    continue
            observed = process_identity(pid)
            owned += 1
            if pid == adapter["pid"]:
                require(observed == adapter, "adapter process changed")
                continue
            in_group = any(value == group or value.startswith(group + "/") for value in observed["cgroups"])
            require(not in_group, "residual process in adapter cgroup")
            raw = (entry / "cmdline").read_bytes()
            arguments = [os.fsdecode(item) for item in raw.split(b"\0") if item]
            executable = process_executable(pid, privileged_proc_read)
            if codex_candidate(arguments, executable):
                attributed_candidate(entry, observed, unit, adapter_env, adapter_cwd, arguments)
            require(process_identity(pid) == observed, "process identity changed during inspection")
        except (OSError, ValueError):
            if vanished(pid):
                continue
            raise Retain("process inspection is ambiguous") from None
    require(owned > 0, "adapter process not observed")
    require(unit_membership(unit) == membership, "adapter cgroup membership changed")
    return {"unit_processes": 1, "residual_codex_candidates": 0}


class SocketWitness:
    def __init__(self, base, uid, pid):
        self.base = pathlib.Path(base)
        self.uid = uid
        self.pid = pid
        self.path = self.base / ("tmux-" + str(uid)) / "cauce"
        self.before = self.inspect()

    def inspect(self):
        directories = checked_directories(self.base, self.uid)
        parent = self.path.parent
        try:
            parent.lstat()
        except FileNotFoundError:
            parent_identity = None
            socket_identity = None
        else:
            parent_identity = checked_directories(parent, self.uid, private=True)
            try:
                info = self.path.lstat()
            except FileNotFoundError:
                socket_identity = None
            else:
                require(stat.S_ISSOCK(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1
                        and not info.st_mode & 0o007, "unsafe tmux socket")
                socket_identity = identity(info)
        rows = (PROC / str(self.pid) / "net/unix").read_text().splitlines()
        registered = False
        for row in rows[1:]:
            fields = row.split(None, 7)
            require(len(fields) >= 7, "invalid Unix socket inventory")
            if len(fields) == 8 and fields[7] == str(self.path):
                registered = True
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(1)
        try:
            connection.connect(str(self.path))
        except OSError as error:
            if socket_identity is None:
                require(error.errno == errno.ENOENT and not registered, "tmux absence is ambiguous")
                result = "missing"
            else:
                require(error.errno == errno.ECONNREFUSED and not registered, "tmux socket is ambiguous")
                result = "refused"
        else:
            require(socket_identity is not None and registered, "tmux server identity is ambiguous")
            result = "present"
        finally:
            connection.close()
        return {"directories": directories, "parent": parent_identity, "socket": socket_identity, "result": result}

    def revalidate(self):
        require(self.inspect() == self.before, "tmux socket changed during snapshot")

    def evidence(self):
        return {"path_sha256": digest(os.fsencode(self.path)), "status": self.before["result"],
                "identity": self.before["socket"]}


def records(value):
    require(isinstance(value, dict), "invalid inbox records")
    counts = {key: 0 for key in ("accepted", "started", "done", "failed")}
    for key, record in value.items():
        require(isinstance(record, dict) and record.get("delivery_id") == key, "invalid inbox record")
        state = record.get("state")
        require(isinstance(state, str) and state in counts, "unknown inbox record state")
        counts[state] += 1
    require(not counts["accepted"] and not counts["started"], "local delivery remains active")
    return counts


def versioned(value):
    require(isinstance(value, dict) and type(value.get("version")) is int and value["version"] == 1,
            "unsupported durable schema")


def transaction_id(value):
    return isinstance(value, str) and UUID.fullmatch(value) is not None


def local_absence(files):
    files.artifacts()
    inbox = files.read("inbox.json")
    versioned(inbox)
    counts = records(inbox.get("deliveries"))
    outbox = files.read("outbox.json", optional=True)
    if outbox is not None:
        versioned(outbox)
        require(isinstance(outbox.get("pending"), list) and all(isinstance(item, dict) for item in outbox["pending"]),
                "invalid outbox records")
    wal = files.read("delivery-transaction.json", optional=True)
    if wal is not None:
        versioned(wal)
        require(set(wal) <= {"version", "transaction_id", "inbox_updates", "inbox_deletes", "outbox_pending"},
                "unknown transaction fields")
        tx = wal.get("transaction_id")
        require(transaction_id(tx), "invalid transaction identity")
        targets = set(wal) & {"inbox_updates", "inbox_deletes", "outbox_pending"}
        require(targets, "transaction has no known target")
        if "inbox_updates" in wal:
            records(wal["inbox_updates"])
        if "inbox_deletes" in wal:
            require(isinstance(wal["inbox_deletes"], list)
                    and all(isinstance(item, dict) and isinstance(item.get("delivery_id"), str)
                            and isinstance(item.get("record_digest"), str) for item in wal["inbox_deletes"]),
                    "invalid transaction deletions")
        if targets & {"inbox_updates", "inbox_deletes"}:
            require(inbox.get("last_transaction_id") == tx, "inbox transaction is not settled")
        if "outbox_pending" in wal:
            require(isinstance(wal["outbox_pending"], list)
                    and all(isinstance(item, dict) for item in wal["outbox_pending"]), "invalid transaction outbox")
            require(outbox is not None and outbox.get("last_transaction_id") == tx,
                    "outbox transaction is not settled")
    return {"inbox_states": counts, "outbox_pending": len(outbox["pending"]) if outbox else 0,
            "wal": "settled" if wal is not None else "absent"}


def present_identity(alias, files, uid):
    rows = command("tmux", "-L", "cauce", "list-panes", "-s", "-t", "=cauce-" + alias,
                   "-F", "#{session_id}|#{window_id}|#{window_name}|#{pane_id}|#{pane_pid}").splitlines()
    parts = [row.split("|") for row in rows]
    require(all(len(row) == 5 for row in parts), "invalid canonical pane inventory")
    parts = [row for row in parts if row[2] == "agente"]
    require(len(parts) == 1, "sole canonical TUI pane required")
    pane = parts[0]
    pid = int(pane[-1])
    process = process_identity(pid)
    require(process["uid"] == uid, "canonical pane uid differs")
    value = files.read("sessions.json")
    versioned(value)
    sessions = value.get("sessions")
    require(isinstance(sessions, dict), "invalid session store")
    pointer = sessions.get("codex:" + alias + ":shared:" + alias, {})
    require(isinstance(pointer, dict), "invalid conversation pointer")
    native = pointer.get("native_id")
    require(pointer.get("initialized") is True and transaction_id(native),
            "canonical Codex conversation witness required")
    require(process_identity(pid) == process, "canonical pane process changed")
    return {"pane": pane[:2] + pane[3:], "pane_start": process["start"],
            "conversation_sha256": digest(native.encode())}, process


def snapshot(unit, alias, uid, expected_state="", privileged_proc_read=False):
    initial = unit_identity(unit, uid)
    pid = initial["process"]["pid"]
    env = environment(pid)
    require(b"CAUCE_STATE_DIR" in env, "adapter state directory is unknown")
    state = pathlib.Path(os.fsdecode(env[b"CAUCE_STATE_DIR"]))
    require(not expected_state or str(state) == expected_state, "adapter state directory differs")
    base = os.fsdecode(env.get(b"TMUX_TMPDIR", b"/tmp"))
    files = Files(state, uid)
    witness = SocketWitness(base, uid, pid)
    os.environ.pop("TMUX_TMPDIR", None)
    if b"TMUX_TMPDIR" in env:
        os.environ["TMUX_TMPDIR"] = base
    if witness.before["result"] == "present":
        canonical, pane = present_identity(alias, files, uid)
        result = {"adapter_pid": pid, "identity": canonical, "tui": "present"}
    else:
        require(env.get(b"CAUCE_SHARED_SESSION") == b"1", "shared session is not enabled")
        adapter_cwd = os.readlink(PROC / str(pid) / "cwd")
        processes = process_absence(initial, uid, env, adapter_cwd, privileged_proc_read)
        local = local_absence(files)
        result = {"adapter_pid": pid, "identity": None, "tui": "absent", "absence": {
            "adapter": {"pid": pid, "uid": uid, "start": initial["process"]["start"],
                        "control_group_sha256": digest(initial["control_group"].encode())},
            "socket": witness.evidence(), "state_sha256": digest(os.fsencode(state)),
            "processes": processes, "local_deliveries": local, "files": files.evidence()}}
        require(process_absence(initial, uid, env, adapter_cwd, privileged_proc_read) == processes
                and os.readlink(PROC / str(pid) / "cwd") == adapter_cwd, "process absence changed")
    files.revalidate()
    witness.revalidate()
    require(unit_identity(unit, uid) == initial and environment(pid) == env, "adapter identity changed")
    if result["tui"] == "present":
        require(process_identity(pane["pid"]) == pane, "canonical pane process changed")
    return result


def main():
    require(len(sys.argv) in (4, 5, 6), "snapshot identity arguments required")
    unit, alias, uid = sys.argv[1:4]
    require(re.fullmatch(r"[a-z][a-z0-9-]*", alias) is not None and uid.isdecimal(), "invalid snapshot identity")
    require(len(sys.argv) != 6 or sys.argv[5] == "--privileged-proc-read", "unknown snapshot option")
    result = snapshot(unit, alias, int(uid), sys.argv[4] if len(sys.argv) >= 5 else "", len(sys.argv) == 6)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({"status": "retained", "reason": "native TUI snapshot is ambiguous"}), file=sys.stderr)
        raise SystemExit(1) from None
