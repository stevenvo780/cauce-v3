#!/usr/bin/env python3
"""Regression test suite for the container supervisor's child reaping behavior.

Verifies that orphaned child processes adopted via PR_SET_CHILD_SUBREAPER are reaped
properly without altering the adapter process exit code.

Run: python3 ops/tests/test_container_runtime_reaping.py
"""
from __future__ import annotations

import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

OPS = pathlib.Path(__file__).resolve().parents[1]
RUNTIME = OPS / "container-runtime" / "cauce-container-runtime.py"
REAP_CALL = "reap_children(protected=process.pid)"
ALIAS = "kant"
CONTAINER_ID = "b" * 64
GENERATION = "c" * 64
ORPHANS = 24
ADAPTER_EXIT = 42

FAKE_ADAPTER = """#!/usr/bin/env python3
# Reproduces what a real harness does: it spawns helpers that detach into their own
# session (every leaked PID observed in production had a unique PGID) and abandons
# them. The intermediate fork is reaped here, so anything left <defunct> under the
# supervisor can only have arrived through PR_SET_CHILD_SUBREAPER adoption.
import os, sys, time

orphans = int(os.environ["FAKE_ORPHANS"])
for _ in range(orphans):
    middle = os.fork()
    if middle == 0:
        if os.fork() == 0:
            os.setsid()
            time.sleep(0.30)
            os._exit(0)
        os._exit(0)
    os.waitpid(middle, 0)
open(os.environ["FAKE_MARKER"], "w").write(str(orphans))
time.sleep(float(os.environ["FAKE_SLEEP"]))
sys.exit(int(os.environ["FAKE_EXIT"]))
"""

failures: list[str] = []
checks = 0


def check(condition: bool, label: str, detail: str = "") -> None:
    global checks
    checks += 1
    if condition:
        print(f"  ok   {label}{(' :: ' + detail) if detail else ''}")
    else:
        print(f"  FAIL {label}{(' :: ' + detail) if detail else ''}")
        failures.append(label)


def children_states(pid: int) -> list[str]:
    try:
        raw = open(f"/proc/{pid}/task/{pid}/children", encoding="utf-8").read()
    except OSError:
        return []
    states = []
    for child in raw.split():
        try:
            stat = open(f"/proc/{child}/stat", encoding="utf-8").read()
        except OSError:
            continue
        states.append(stat[stat.rfind(")") + 2:].split()[0])
    return states


def zombie_count(pid: int) -> int:
    return sum(1 for state in children_states(pid) if state == "Z")


def wait_for(predicate, timeout: float, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def variant_scripts(root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    """Materialize the shipped script and a baseline with only the reap call removed."""
    source = RUNTIME.read_text(encoding="utf-8")
    patched = root / "patched.py"
    patched.write_text(source, encoding="utf-8")
    patched.chmod(0o755)

    kept = [line for line in source.splitlines(keepends=True) if REAP_CALL not in line]
    removed = len(source.splitlines()) - len(kept)
    if removed != 1:
        raise AssertionError(
            f"expected exactly one '{REAP_CALL}' call in the supervisor wait loop, found {removed}")
    baseline = root / "baseline.py"
    baseline.write_text("".join(kept), encoding="utf-8")
    baseline.chmod(0o755)
    return baseline, patched


def bundle_digest(bundle: pathlib.Path) -> str:
    result = subprocess.run([sys.executable, str(RUNTIME), "bundle-digest", str(bundle)],
                            capture_output=True, text=True, check=True)
    return result.stdout.strip()


def launch(script: pathlib.Path, root: pathlib.Path, name: str, *, sleep: float,
           orphans: int = ORPHANS) -> tuple[subprocess.Popen, pathlib.Path]:
    state = root / f"state-{name}"
    control = root / f"control-{name}"
    bundle = root / f"bundle-{name}"
    state.mkdir(mode=0o700)
    control.mkdir(mode=0o700)
    bundle.mkdir(mode=0o700)
    adapter = bundle / "fake-adapter.py"
    adapter.write_text(FAKE_ADAPTER, encoding="utf-8")
    adapter.chmod(0o755)
    marker = root / f"marker-{name}"

    environment = dict(os.environ)
    environment.update({
        "CAUCE_ALIAS": ALIAS,
        "CAUCE_STATE_DIR": str(state),
        "CAUCE_CONTROL_DIR": str(control),
        "CAUCE_CONTAINER_ID": CONTAINER_ID,
        "CAUCE_CONTAINER_GENERATION": GENERATION,
        "FAKE_ORPHANS": str(orphans),
        "FAKE_SLEEP": str(sleep),
        "FAKE_EXIT": str(ADAPTER_EXIT),
        "FAKE_MARKER": str(marker),
    })
    command = [
        sys.executable, str(script), "run",
        "--alias", ALIAS, "--state", str(state), "--control-dir", str(control),
        "--container-id", CONTAINER_ID, "--generation", GENERATION,
        "--term-seconds", "0.2", "--kill-seconds", "1",
        "--runtime-uid", str(os.getuid()), "--runtime-gid", str(os.getgid()),
        "--bundle", str(bundle), "--bundle-digest", bundle_digest(bundle),
        str(adapter),
    ]
    supervisor = subprocess.Popen(command, env=environment,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return supervisor, marker


def terminate(supervisor: subprocess.Popen) -> None:
    if supervisor.poll() is None:
        supervisor.send_signal(signal.SIGTERM)
        try:
            supervisor.wait(timeout=5)
        except subprocess.TimeoutExpired:
            supervisor.kill()
            supervisor.wait(timeout=5)


def measure(script: pathlib.Path, root: pathlib.Path, name: str) -> tuple[int, int]:
    """Zombie children the supervisor still holds, sampled while the adapter is alive.

    The metric is retention, never the instantaneous peak: an orphan burst that lands
    between two reap ticks is legitimately visible for a moment in a fixed build. What
    separates the two builds is whether the count ever comes back down -- the unpatched
    supervisor holds every orphan until the adapter dies, hours or days later.
    """
    supervisor, marker = launch(script, root, name, sleep=10.0)
    try:
        if not wait_for(marker.exists, 30.0):
            raise AssertionError(f"{name}: adapter never reported its orphan burst "
                                 f"({supervisor.stderr.read().decode(errors='replace')[-400:]})")
        spawned = int(marker.read_text(encoding="utf-8").strip())
        if spawned != ORPHANS:
            raise AssertionError(f"{name}: fixture spawned {spawned} orphans, expected {ORPHANS}")
        # The orphans exit 0.30s after their fork; give the burst room to land, then let
        # any reaper converge. Both windows are generous so load cannot decide the result.
        time.sleep(1.5)
        peak = zombie_count(supervisor.pid)
        deadline = time.monotonic() + 4.0
        residual = peak
        while time.monotonic() < deadline and residual != 0:
            if supervisor.poll() is not None:
                raise AssertionError(f"{name}: adapter exited before the window closed")
            residual = zombie_count(supervisor.pid)
            peak = max(peak, residual)
            time.sleep(0.05)
        if supervisor.poll() is not None:
            raise AssertionError(f"{name}: adapter exited before the window closed")
        return peak, residual
    finally:
        terminate(supervisor)


def scenario_leak_and_fix(root: pathlib.Path) -> None:
    print("[1] orphan reaping while the adapter is alive")
    baseline, patched = variant_scripts(root)

    peak, leaked = measure(baseline, root, "baseline")
    check(leaked >= ORPHANS, "baseline holds every orphaned descendant <defunct> for good",
          f"{leaked} still <defunct> after 5.5s (peak {peak}, expected >= {ORPHANS})")

    peak, residual = measure(patched, root, "patched")
    check(residual == 0, "patched supervisor drains the adopted orphans",
          f"{residual} <defunct> left (peak {peak})")


def scenario_exit_code_preserved(root: pathlib.Path) -> None:
    print("[2] the adapter exit code survives the reaping")
    _, patched = variant_scripts(root / "exit")
    supervisor, marker = launch(patched, root / "exit", "code", sleep=0.4)
    try:
        wait_for(marker.exists, 20.0)
        status = supervisor.wait(timeout=30)
    finally:
        terminate(supervisor)
    check(status == ADAPTER_EXIT, "supervisor propagates the real adapter exit code",
          f"exit={status} (expected {ADAPTER_EXIT})")


def scenario_naive_fixes_destroy_the_exit_code(root: pathlib.Path) -> None:
    """The trap: both naive reapers turn any adapter failure into a clean exit 0."""
    print("[3] why not SIGCHLD=SIG_IGN and why not a bare waitpid(-1)")
    probe = root / "probe.py"
    probe.write_text("#!/usr/bin/env python3\nimport sys\nsys.exit(42)\n", encoding="utf-8")
    probe.chmod(0o755)

    ignored = subprocess.run([sys.executable, "-c", (
        "import os, signal, subprocess, sys, time\n"
        "signal.signal(signal.SIGCHLD, signal.SIG_IGN)\n"
        "child = subprocess.Popen([sys.executable, sys.argv[1]])\n"
        "time.sleep(0.5)\n"
        "print(child.poll())\n"), str(probe)], capture_output=True, text=True)
    check(ignored.stdout.strip() == "0",
          "SIGCHLD=SIG_IGN rewrites exit 42 as 0 (auto-reap; ECHILD -> returncode 0)",
          f"Popen.poll() -> {ignored.stdout.strip()}")

    stolen = subprocess.run([sys.executable, "-c", (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, sys.argv[1]])\n"
        "time.sleep(0.5)\n"
        "os.waitpid(-1, os.WNOHANG)\n"
        "print(child.poll())\n"), str(probe)], capture_output=True, text=True)
    check(stolen.stdout.strip() == "0",
          "bare waitpid(-1) steals the tracked status and Popen reports 0",
          f"Popen.poll() -> {stolen.stdout.strip()}")

    kept = subprocess.run([sys.executable, "-c", (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, sys.argv[1]])\n"
        "time.sleep(0.5)\n"
        "peeked = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)\n"
        "print(peeked.si_pid == child.pid, child.poll())\n"), str(probe)],
        capture_output=True, text=True)
    check(kept.stdout.strip() == "True 42",
          "waitid(WNOWAIT) peeks the same PID and leaves 42 pending for Popen",
          f"-> {kept.stdout.strip()}")


def main() -> int:
    if not sys.platform.startswith("linux"):
        print("skipped: the container supervisor is Linux-only")
        return 0
    if os.getuid() == 0:
        # child_credentials() refuses to drop to uid 0; the unprivileged path is the
        # one this suite exercises.
        print("skipped: run this suite unprivileged")
        return 0
    root = pathlib.Path(tempfile.mkdtemp(prefix="cauce-runtime-reaping-"))
    (root / "exit").mkdir()
    try:
        scenario_leak_and_fix(root)
        scenario_exit_code_preserved(root)
        scenario_naive_fixes_destroy_the_exit_code(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        for label in failures:
            print(f"failed: {label}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
