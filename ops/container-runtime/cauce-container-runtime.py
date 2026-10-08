#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import time
from collections.abc import Callable
from typing import Any

from cauce_container_adoption import LifecycleAdoptionServer, mutation_guard
from cauce_container_base import (
    ADAPTER_RESTART_EXIT,
    ALIAS_RE,
    CONTAINER_ID_RE,
    DIGEST_RE,
    GENERATION_RE,
    PERMANENT_EXIT,
    RESERVED_SUPERVISOR_EXITS,
    SCHEMA_VERSION,
    TENANT_RE,
    WIRE_ALIAS_RE,
    AdapterExitedBeforeIdentity,
    DirectoryAccessError,
    PermanentError,
    bundle_digest,
    canonical_absolute,
    fail,
    open_control_directory,
    open_directory,
    prepare_control,
    prepare_state,
)
from cauce_container_proc import (
    alias_generation_pids,
    atomic_metadata,
    controller_is_live,
    descendants,
    guard_exec,
    lock_control,
    lock_is_held,
    pid_exists,
    pidfd_running,
    proc_stat,
    read_metadata,
    remove_metadata,
    require_current_generation,
    set_dumpable,
    set_subreaper,
    stale_generation_is_quiescent,
    starting_executable_identity,
    validate_metadata,
    verify_adapter,
    verify_controller,
)
from cauce_container_tree import (
    PinnedLeaderTree,
    signal_known_tree,
    terminate_from_metadata,
    wait_for_exec,
    wait_process_tracking,
)


def child_credentials(runtime_uid: int, runtime_gid: int) -> dict[str, Any]:
    # Decide how the adapter child is launched. In production the controller runs
    # as root and drops the child to the exact non-root runtime UID/GID (rejecting
    # 0). In an unprivileged test the controller cannot change identity, so the
    # requested identity must equal the current one and no privilege change occurs.
    if os.geteuid() == 0:
        if runtime_uid <= 0 or runtime_gid <= 0:
            raise PermanentError("runtime uid/gid must be a non-root identity")
        return {"user": runtime_uid, "group": runtime_gid, "extra_groups": [runtime_gid]}
    if runtime_uid != os.getuid() or runtime_gid != os.getgid():
        raise PermanentError("a non-root controller cannot change the runtime identity")
    return {}


def remap_child_exit(status: int) -> int:
    if status < 0:
        return ADAPTER_RESTART_EXIT
    if status in RESERVED_SUPERVISOR_EXITS:
        return ADAPTER_RESTART_EXIT
    return status


def phase_gate(phase: str, should_stop: Callable[[], bool]) -> None:
    # Test-only, env-gated, bounded barrier used to exercise "stop during phase X".
    # Production never sets CAUCE_CONTAINER_TEST_PHASE_GATE, so this is a no-op there.
    spec = os.environ.get("CAUCE_CONTAINER_TEST_PHASE_GATE")
    if not spec:
        return
    parts = spec.split("|")
    if len(parts) != 3 or parts[0] != phase:
        return
    marker, seconds = parts[1], parts[2]
    try:
        limit = float(seconds)
    except ValueError:
        return
    try:
        with open(marker, "w", encoding="utf-8") as stream:
            stream.write(f"{phase}:{os.getpid()}\n")
    except OSError:
        return
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if should_stop():
            return
        time.sleep(0.02)


def startup_metadata(control_fd: int, alias: str, state_directory: str, container_id: str, generation: str) -> None:
    document, _ = read_metadata(control_fd)
    if document is None:
        return
    if document["alias"] != alias or document["stateDirectory"] != state_directory:
        raise PermanentError("lifecycle metadata alias/state mismatch was preserved")
    if stale_generation_is_quiescent(
        control_fd,
        document,
        alias,
        state_directory,
        container_id,
        generation,
        probe_lock=False,
    ):
        remove_metadata(control_fd)
        return
    if document["phase"] == "running":
        if pid_exists(document["pid"]):
            try:
                verify_adapter(document, alias, state_directory)
            except (PermanentError, ProcessLookupError) as error:
                raise PermanentError("live PID metadata mismatch was preserved") from error
            raise PermanentError("an adapter process is already live for this alias")
        if document["containerId"] == container_id and document["containerGeneration"] == generation:
            raise PermanentError("missing PID belongs to the current generation; metadata was preserved")
        remove_metadata(control_fd)
        return
    # starting phase left behind by a prior controller
    if controller_is_live(document):
        raise PermanentError("another lifecycle controller is already starting for this alias")
    if alias_generation_pids(alias, generation, state_directory, exclude={os.getpid()}):
        raise PermanentError("a prior start for the current generation left live processes; metadata was preserved")
    if document["containerId"] == container_id and document["containerGeneration"] == generation:
        raise PermanentError("a prior controller for the current generation vanished mid-start; metadata was preserved")
    remove_metadata(control_fd)


def run_adapter(args: argparse.Namespace) -> int:
    if not args.command:
        raise PermanentError("adapter command is required")
    launch_credentials = child_credentials(args.runtime_uid, args.runtime_gid)
    set_dumpable()
    control_fd = open_control_directory(args.control_dir)
    guard_fd = mutation_guard(control_fd)
    try:
        lock_fd = lock_control(control_fd)
    finally:
        os.close(guard_fd)
    state_fd = open_directory(args.state)
    process: subprocess.Popen[bytes] | None = None
    process_tree: PinnedLeaderTree | None = None
    running_document: dict[str, Any] | None = None
    published_starting = False
    termination_requested = False
    adoption_server = None

    def should_stop() -> bool:
        return termination_requested

    def forward(_signum: int, _frame: Any) -> None:
        nonlocal termination_requested
        termination_requested = True
        if process_tree is not None and (adoption_server is None or not adoption_server.fenced):
            process_tree.signal(signal.SIGTERM)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    signal.signal(signal.SIGHUP, forward)
    try:
        startup_metadata(control_fd, args.alias, args.state, args.container_id, args.generation)
        # Phase "pre-metadata": we own the lock but have not published yet. A
        # concurrent stop must detect us (held lock / env identity) and refuse,
        # never fail-open.
        phase_gate("pre-metadata", should_stop)
        if termination_requested:
            raise PermanentError("adapter launch was cancelled before metadata publication")
        controller_starttime = int(proc_stat(os.getpid())["starttime"])
        base_document = {
            "schemaVersion": SCHEMA_VERSION,
            "phase": "starting",
            "alias": args.alias,
            **({"wireAlias": args.wire_alias, "tenantId": args.tenant} if args.wire_alias is not None else {}),
            "stateDirectory": args.state,
            "controlDirectory": args.control_dir,
            "runtimeUid": args.runtime_uid,
            "runtimeGid": args.runtime_gid,
            "pid": None,
            "pgid": None,
            "sid": None,
            "starttime": None,
            "controllerPid": os.getpid(),
            "controllerStarttime": controller_starttime,
            "containerId": args.container_id,
            "containerGeneration": args.generation,
            "bundleDigest": args.bundle_digest,
            "executable": starting_executable_identity(args.command[0]),
        }
        # Publish before long operations so concurrent stop can identify this controller.
        validate_metadata(base_document)
        atomic_metadata(control_fd, base_document)
        published_starting = True

        phase_gate("starting", should_stop)
        if termination_requested:
            remove_metadata(control_fd)
            raise PermanentError("adapter launch was cancelled before process creation")

        if bundle_digest(args.bundle) != args.bundle_digest:
            remove_metadata(control_fd)
            raise PermanentError("active bundle digest differs before adapter launch")
        set_subreaper()

        phase_gate("pre-child", should_stop)
        if termination_requested:
            remove_metadata(control_fd)
            raise PermanentError("adapter launch was cancelled before process creation")

        process = subprocess.Popen(args.command, start_new_session=True, close_fds=True, **launch_credentials)
        try:
            # Pin before any phase wait, exec inspection or process.wait()/poll()
            # can observe and reap the leader.
            process_tree = PinnedLeaderTree(process.pid)
        except BaseException:
            # The direct Popen child has not been reaped, so its numeric PID cannot
            # yet be reused. Refuse lifecycle startup after best-effort leader cleanup.
            process.terminate()
            try:
                process.wait(timeout=max(1.0, args.kill_seconds))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=max(1.0, args.kill_seconds))
            raise
        try:
            phase_gate("post-child", should_stop)
            if termination_requested:
                signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=False)
                wait_process_tracking(process, process_tree, timeout=max(1.0, args.kill_seconds))
                raise PermanentError("adapter launch was cancelled before metadata publication")
            executable = wait_for_exec(process_tree, args.command[0])
            try:
                details = proc_stat(process.pid)
                if details["pgid"] != process.pid or details["sid"] != process.pid:
                    raise PermanentError("adapter did not start in a dedicated process session")
                running_document = dict(base_document)
                running_document.update({
                    "phase": "running",
                    "pid": process.pid,
                    "pgid": process.pid,
                    "sid": process.pid,
                    "starttime": int(details["starttime"]),
                    "executable": executable,
                })
                validate_metadata(running_document)
                verify_adapter(running_document, args.alias, args.state)
            except ProcessLookupError as error:
                raise AdapterExitedBeforeIdentity from error
            except (OSError, PermanentError) as error:
                if not pidfd_running(process_tree.leader_fd):
                    raise AdapterExitedBeforeIdentity from error
                raise
            atomic_metadata(control_fd, running_document)
            if os.environ.get('CAUCE_ADOPTION_LIFECYCLE_FENCE') == '1':
                adoption_server = LifecycleAdoptionServer(control_fd, args.control_dir, lock_fd,
                    {key: running_document[key] for key in ('alias', 'containerId', 'containerGeneration', 'controllerPid', 'controllerStarttime')})
        except AdapterExitedBeforeIdentity:
            # Preserve the child status and clean up only descendants pinned while it lived.
            status = wait_process_tracking(process, process_tree, timeout=max(1.0, args.kill_seconds))
            signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=True)
            remove_metadata(control_fd)
            return remap_child_exit(status)
        except BaseException:
            signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=False)
            try:
                wait_process_tracking(process, process_tree, timeout=max(1.0, args.kill_seconds))
            except subprocess.TimeoutExpired:
                pass
            remove_metadata(control_fd)
            raise

        if adoption_server is None:
            status = wait_process_tracking(process, process_tree)
        else:
            while True:
                adoption_server.poll(0.02)
                if termination_requested and not adoption_server.fenced:
                    process_tree.signal(signal.SIGTERM)
                try:
                    status = wait_process_tracking(process, process_tree, timeout=0.02)
                    adoption_server.close()
                    adoption_server = None
                    break
                except subprocess.TimeoutExpired:
                    pass
        signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=True)
        current, _ = read_metadata(control_fd)
        if current is not None and current != running_document:
            raise PermanentError("lifecycle metadata changed while adapter was running; it was preserved")
        remove_metadata(control_fd)
        return remap_child_exit(status)
    except BaseException:
        if published_starting and process is None:
            remove_metadata(control_fd)
        raise
    finally:
        if adoption_server is not None:
            adoption_server.close()
        if process_tree is not None:
            process_tree.close()
        os.close(lock_fd)
        os.close(state_fd)
        os.close(control_fd)


def stop_adapter(args: argparse.Namespace) -> None:
    try:
        guarded_control = open_control_directory(args.control_dir)
    except DirectoryAccessError:
        raise
    except PermanentError:
        return _stop_adapter(args)
    try:
        guard_fd = mutation_guard(guarded_control)
        try:
            _stop_adapter(args)
        finally:
            os.close(guard_fd)
    finally:
        os.close(guarded_control)


def _stop_adapter(args: argparse.Namespace) -> None:
    try:
        control_fd = open_control_directory(args.control_dir)
    except DirectoryAccessError:
        # Inaccessibility cannot be treated as absence: neither metadata nor a
        # held lock can be inspected, so stopped state is not provable.
        raise
    except PermanentError as err:
        # No usable control directory for this generation. Prove nothing survives.
        if alias_generation_pids(args.alias, args.generation, args.state, exclude={os.getpid()}):
            raise PermanentError("untracked processes still carry this alias generation; nothing was signalled") from err
        return
    try:
        document, _ = read_metadata(control_fd)
        if document is None:
            # Fail-closed: a held lock (controller mid-startup pre-publication) or any
            # surviving alias+generation process is ambiguous and must not report stopped.
            if lock_is_held(control_fd):
                raise PermanentError("a lifecycle controller holds the lock without published metadata; preserved")
            if alias_generation_pids(args.alias, args.generation, args.state, exclude={os.getpid()}):
                raise PermanentError("untracked processes still carry this alias generation; nothing was signalled")
            return
        if stale_generation_is_quiescent(
            control_fd,
            document,
            args.alias,
            args.state,
            args.container_id,
            args.generation,
            probe_lock=True,
        ):
            # Pre-start stop deliberately leaves stale metadata in place.  The
            # subsequent run command owns the lifecycle lock and removes it
            # durably before publishing the replacement generation.
            return
        require_current_generation(document, args.container_id, args.generation)
        if document["phase"] == "running":
            terminate_from_metadata(
                document, args.alias, args.state, args.term_seconds, args.kill_seconds,
            )
        else:
            # No adapter leader identity exists yet. Controller PID/starttime is
            # lifecycle metadata, not authority to signal an unregistered target.
            raise PermanentError("adapter leader is not published; metadata was preserved and no signal was sent")
        remove_metadata(control_fd)
    finally:
        os.close(control_fd)


def check_adapter(args: argparse.Namespace) -> None:
    control_fd = open_control_directory(args.control_dir)
    try:
        document, _ = read_metadata(control_fd)
        if document is None:
            raise PermanentError("adapter lifecycle metadata is absent")
        require_current_generation(document, args.container_id, args.generation)
        if document["phase"] != "running":
            raise PermanentError("adapter is still starting; running state is not proven")
        if document["bundleDigest"] != args.bundle_digest:
            raise PermanentError("active bundle digest differs from lifecycle metadata")
        verify_adapter(document, args.alias, args.state)
        verify_controller(document)
        if document["pid"] not in descendants(document["controllerPid"]):
            raise PermanentError("adapter leader is not a descendant of its lifecycle controller")
        if bundle_digest(args.bundle) != args.bundle_digest:
            raise PermanentError("active bundle content digest differs")
        print(f"adapter {args.alias} is running")
    finally:
        os.close(control_fd)


def assert_stopped(args: argparse.Namespace) -> None:
    try:
        control_fd = open_control_directory(args.control_dir)
    except DirectoryAccessError:
        raise
    except PermanentError:
        control_fd = None
    try:
        if control_fd is not None:
            document, _ = read_metadata(control_fd)
            if document is not None:
                if not stale_generation_is_quiescent(
                    control_fd,
                    document,
                    args.alias,
                    args.state,
                    args.container_id,
                    args.generation,
                    probe_lock=True,
                ):
                    require_current_generation(document, args.container_id, args.generation)
                    if document["phase"] == "running" and pid_exists(document["pid"]):
                        raise PermanentError("adapter lifecycle metadata still identifies a live PID")
                    if controller_is_live(document):
                        raise PermanentError("a lifecycle controller is still starting for this alias")
                    raise PermanentError("adapter lifecycle metadata remains; stopped state is not proven")
            if lock_is_held(control_fd):
                raise PermanentError("a lifecycle controller holds the lock; stopped state is not proven")
        stragglers = alias_generation_pids(args.alias, args.generation, args.state, exclude={os.getpid()})
        if stragglers:
            raise PermanentError("an untracked adapter process still has this alias identity")
        print(f"adapter {args.alias} is stopped")
    finally:
        if control_fd is not None:
            os.close(control_fd)


def common_lifecycle(parser: argparse.ArgumentParser, *, require_bundle: bool) -> None:
    parser.add_argument("--alias", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--control-dir", required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--generation", required=True)
    if require_bundle:
        parser.add_argument("--bundle", required=True)
        parser.add_argument("--bundle-digest", required=True)
    parser.add_argument("--term-seconds", type=float, default=25.0)
    parser.add_argument("--kill-seconds", type=float, default=5.0)


parser = argparse.ArgumentParser(description="Fail-closed Cauce container lifecycle helper")
subparsers = parser.add_subparsers(dest="action", required=True)
prepare = subparsers.add_parser("prepare-state")
prepare.add_argument("--mount", required=True)
prepare.add_argument("--state", required=True)
prepare.add_argument("--uid", type=int, required=True)
prepare.add_argument("--gid", type=int, required=True)
prepare_control_parser = subparsers.add_parser("prepare-control")
prepare_control_parser.add_argument("--base", required=True)
prepare_control_parser.add_argument("--alias", required=True)
digest_parser = subparsers.add_parser("bundle-digest")
digest_parser.add_argument("path")
guard_parser = subparsers.add_parser("guard-exec")
guard_parser.add_argument("--init-starttime", type=int, required=True)
guard_parser.add_argument("command", nargs=argparse.REMAINDER)
run_parser = subparsers.add_parser("run")
common_lifecycle(run_parser, require_bundle=True)
run_parser.add_argument("--wire-alias")
run_parser.add_argument("--tenant")
run_parser.add_argument("--runtime-uid", type=int, required=True)
run_parser.add_argument("--runtime-gid", type=int, required=True)
run_parser.add_argument("command", nargs=argparse.REMAINDER)
stop_parser = subparsers.add_parser("stop")
common_lifecycle(stop_parser, require_bundle=False)
check_parser = subparsers.add_parser("check")
common_lifecycle(check_parser, require_bundle=True)
stopped_parser = subparsers.add_parser("stopped")
common_lifecycle(stopped_parser, require_bundle=False)
arguments = parser.parse_args()


def _validate_identity(namespace: argparse.Namespace, *, require_bundle: bool) -> None:
    if not ALIAS_RE.fullmatch(namespace.alias) or not CONTAINER_ID_RE.fullmatch(namespace.container_id) \
            or not GENERATION_RE.fullmatch(namespace.generation):
        raise PermanentError("lifecycle identity arguments are invalid")
    wire_alias, tenant = getattr(namespace, "wire_alias", None), getattr(namespace, "tenant", None)
    if (wire_alias is None) != (tenant is None) or (wire_alias is not None
            and (not WIRE_ALIAS_RE.fullmatch(wire_alias) or not TENANT_RE.fullmatch(tenant))):
        raise PermanentError("lifecycle wire identity arguments are invalid")
    canonical_absolute(namespace.control_dir, "control directory")
    canonical_absolute(namespace.state, "state directory")
    if require_bundle and not DIGEST_RE.fullmatch(namespace.bundle_digest):
        raise PermanentError("lifecycle identity arguments are invalid")


try:
    if arguments.action == "prepare-state":
        prepare_state(arguments.mount, arguments.state, arguments.uid, arguments.gid)
    elif arguments.action == "prepare-control":
        prepare_control(arguments.base, arguments.alias)
    elif arguments.action == "bundle-digest":
        print(bundle_digest(arguments.path))
    elif arguments.action == "guard-exec":
        guard_exec(arguments.init_starttime, arguments.command)
    elif arguments.action == "run":
        _validate_identity(arguments, require_bundle=True)
        raise SystemExit(run_adapter(arguments))
    elif arguments.action == "stop":
        _validate_identity(arguments, require_bundle=False)
        stop_adapter(arguments)
    elif arguments.action == "check":
        _validate_identity(arguments, require_bundle=True)
        check_adapter(arguments)
    elif arguments.action == "stopped":
        _validate_identity(arguments, require_bundle=False)
        assert_stopped(arguments)
except PermanentError as error:
    fail(str(error), PERMANENT_EXIT)
