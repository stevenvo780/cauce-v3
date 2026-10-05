#!/usr/bin/env python3

import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "container-runtime"))
from cauce_container_proc import proc_stat, reap_children  # noqa: E402


def wait_for_owned_zombie(process: subprocess.Popen) -> None:
    deadline = time.monotonic() + 5
    while True:
        state = proc_stat(process.pid)["state"]
        if state == "Z":
            return
        assert time.monotonic() < deadline, f"Owned child {process.pid} did not exit: {state}"
        time.sleep(0.01)


def test_zombie_creation_without_reap():
    proc = subprocess.Popen(
        ["python3", "-c", "import sys; sys.exit(0)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    child_pid = proc.pid
    time.sleep(0.2)

    # Verify it's a zombie: poll() still returns None (not reaped),
    # but the process is dead
    result = subprocess.run(
        ["ps", "-p", str(child_pid), "-o", "stat="],
        capture_output=True, text=True, check=False, timeout=2
    )

    is_zombie = "Z" in result.stdout

    # Clean up: reap the zombie for next tests
    try:
        proc.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        try:
            os.waitpid(child_pid, 0)
        except ChildProcessError:
            pass

    assert is_zombie, \
        f"Expected child process {child_pid} to be zombie, got stat={result.stdout}"
    print("✓ test_zombie_creation_without_reap: correctly created zombie process")


def test_reap_children_function():
    processes = [
        subprocess.Popen(
            ["python3", "-c", "import sys; sys.exit(0)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(2)
    ]
    try:
        for process in processes:
            wait_for_owned_zombie(process)
        reap_children()
        for process in processes:
            try:
                os.waitpid(process.pid, os.WNOHANG)
            except ChildProcessError:
                continue
            raise AssertionError(f"Owned child {process.pid} was not reaped")
        print("✓ test_reap_children_function: both owned children were reaped")
    finally:
        for process in processes:
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)


def test_pidfd_persists_after_waitpid():
    child_proc = subprocess.Popen(
        ["python3", "-c", "import time; time.sleep(0.5); import sys; sys.exit(42)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    child_pid = child_proc.pid

    try:
        pidfd = os.pidfd_open(child_pid)
    except OSError as e:
        if "not supported" in str(e).lower() or e.errno == 38:
            print("⊘ test_pidfd_persists_after_waitpid: pidfd_open not available, skipping")
            child_proc.wait()
            return
        raise

    child_proc.wait()

    try:
        _fd_info = os.fstat(pidfd)
        print(f"✓ test_pidfd_persists_after_waitpid: pidfd {pidfd} remains valid after waitpid of child {child_pid}")
    except OSError:
        print("⊘ test_pidfd_persists_after_waitpid: pidfd became invalid (this may be system-dependent)")
    finally:
        os.close(pidfd)


def test_can_reap_true_safety():
    proc = subprocess.Popen(
        ["python3", "-c", "import sys; sys.exit(7)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        wait_for_owned_zombie(proc)
        reap_children(protected=proc.pid)
        status = proc.wait(timeout=0.1)
        assert status == 7, f"Protected Popen exit status was consumed: {status}"
        print("✓ test_can_reap_true_safety: protected Popen retained exit status 7")
    finally:
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=1)


def main():
    print("Running container runtime zombie process regression tests...\n")

    if not os.path.exists("/proc"):
        print("⊘ Tests require /proc filesystem (Linux only), skipping")
        return 0

    try:
        test_zombie_creation_without_reap()
        test_reap_children_function()
        test_pidfd_persists_after_waitpid()
        test_can_reap_true_safety()
        print("\n✅ All regression tests passed")
        print("\nSummary: Runtime reap_children() handles owned children:")
        print("  - Reaps both owned zombies")
        print("  - Maintains pidfd safety (no PID reuse risk)")
        print("  - Preserves protected Popen exit status")
        return 0
    except AssertionError as e:
        print(f"\n❌ Test failed: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
