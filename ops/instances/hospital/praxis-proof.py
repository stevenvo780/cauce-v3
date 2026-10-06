#!/usr/bin/env python3
"""Generate fresh synthetic proof in a detached public-source clone."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

# cauce:requiere none

HEAD = re.compile(r"[0-9a-f]{40,64}\Z")
PREFIX = re.compile(r"docs/evidence/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}\Z")
FORBIDDEN = {".git", ".env", "auth.json", "settings.local.json", "secrets", "credentials", "sessions", "profiles", "cookies", "history", "private", "vault", "_accesos"}
VERIFICATION = "specs/003-espacio-profesional/verification.json"


class ProofError(Exception):
    pass


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def child_environment(home):
    package_paths = [path for path in sys.path if path and "site-packages" in path]
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home), "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": os.pathsep.join(package_paths), "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"}


def execute(argv, cwd, env, timeout):
    started = timestamp()
    clock = time.monotonic()
    try:
        with subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
                code = process.returncode
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                stdout, stderr = process.communicate(timeout=5)
                code, stderr = 124, stderr + "\ncommand_timeout"
    except OSError as error:
        code, stdout, stderr = 127, "", str(error)
    return {"command": shlex.join([str(value) for value in argv]), "argv": list(map(str, argv)),
            "exit_code": code, "started_at": started, "finished_at": timestamp(),
            "duration_seconds": round(time.monotonic() - clock, 6),
            "stdout": stdout, "stderr": stderr}


def git_text(workspace, arguments, env):
    result = execute(["git", "-c", "core.hooksPath=/dev/null", "-C", str(workspace), *arguments],
                     workspace, env, 30)
    if result["exit_code"]:
        raise ProofError("git_command_failed: " + result["stderr"].strip())
    return result["stdout"].strip()


def permitted(name):
    path = PurePosixPath(name)
    return (not path.is_absolute() and ".." not in path.parts
            and not any(part.lower() in FORBIDDEN or part.lower().startswith(".env")
                        or part.endswith((".token", ".sqlite", ".sqlite3", ".db")) for part in path.parts))


def source_names(names):
    selected = []
    for name in names:
        path = PurePosixPath(name)
        if (name in {"GOAL.md", "AGENTS.md", "README.md"}
                or (name.startswith("apps/api/") and path.suffix == ".py")
                or (name.startswith("apps/web/") and path.suffix in {".js", ".css", ".html"})
                or (name.startswith("scripts/") and path.suffix in {".py", ".mjs"})
                or name == "docs/evidence/prax-015-offer-20261005/offer_qa.py"):
            selected.append(name)
    required = {"GOAL.md", "apps/api/server.py", "apps/api/store.py", "apps/web/app.js",
                "apps/web/app.css", "apps/web/index.html", "scripts/qa_professional.py",
                "scripts/qa_browser_fixture.py"}
    if not required.issubset(selected):
        raise ProofError("required_source_missing")
    return sorted(selected)


def sources_committed(workspace, names, env):
    candidates = set(names)
    for pattern in ("apps/api/*.py", "apps/web/*.js", "apps/web/*.css", "apps/web/*.html", "scripts/*.py", "scripts/*.mjs"):
        candidates.update(str(path.relative_to(workspace)) for path in workspace.glob(pattern))
    return candidates == set(names) and not git_text(workspace, ["status", "--porcelain", "--untracked-files=no", "--", *names], env)


def metadata_path(workspace, relative):
    if not permitted(relative):
        raise ProofError("private_metadata_path")
    path = workspace / relative
    if (not path.resolve().is_relative_to(workspace.resolve())
            or any(parent.is_symlink() for parent in [path, *path.parents] if parent.is_relative_to(workspace))):
        raise ProofError("unsafe_metadata_path")
    return path


def source_hashes(workspace, names):
    result = {}
    root = workspace.resolve()
    for name in names:
        path = workspace / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
            raise ProofError("unsafe_source_path: " + name)
        result[name] = digest(path)
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def artifact(output, prefix, name):
    return {"path": prefix + "/" + name, "sha256": digest(output / name)}


def gate_report(gate_id, command, commit, sources, results, **extra):
    code = next((row["exit_code"] for row in results if row["exit_code"]), 0)
    return {"schema_version": 2, "gate_id": gate_id, "status": "passed" if code == 0 else "failed",
            "exit_code": code, "command": command, "source_commit": commit,
            "source_files": sources, "results": results, **extra}


def test_commands(python):
    compile_code = ("import pathlib; paths=[*pathlib.Path('apps/api').glob('*.py'),"
                    "*pathlib.Path('scripts').glob('*.py')]; "
                    "[compile(p.read_bytes(),str(p),'exec') for p in paths]; "
                    "print('Python syntax validated:',len(paths),'files')")
    return [[python, "-B", "-m", "unittest", "discover", "-s", "apps/api", "-p", "test_*.py"],
            ["node", "apps/web/test_app.js"], ["node", "apps/web/test_runtime.js"],
            [python, "-B", "-c", compile_code],
            ["node", "--check", "apps/web/app.js"], ["node", "--check", "apps/web/test_app.js"],
            ["node", "--check", "apps/web/test_runtime.js"], ["node", "--check", "scripts/qa_browser.mjs"]]


def actual_results(results):
    api = [row for row in results if "-m unittest" in row["command"]
           and ("apps.api.test_" in row["command"] or "-s apps/api" in row["command"])]
    count = sum(int(match.group(1)) for row in api
                if (match := re.search(r"Ran (\d+) tests? in ", row["stdout"] + row["stderr"])))
    return {"count": count, "api_tests": count,
            "web_suites": sum(row["argv"][:1] == ["node"] and row["argv"][1:2] in
                              (["apps/web/test_app.js"], ["apps/web/test_runtime.js"])
                              and row["exit_code"] == 0 for row in results)}


def bound_qa(workspace, gate, sources, commit, env):
    try:
        if (not isinstance(gate, dict) or gate.get("id") != "qa" or gate.get("source_files") != sources
                or not HEAD.fullmatch(str(gate.get("source_commit", "")))
                or not isinstance(gate.get("command"), str) or not isinstance(gate.get("artifacts"), list)
                or not gate["artifacts"]):
            return False
        ancestry = execute(["git", "-C", str(workspace), "merge-base", "--is-ancestor", gate["source_commit"], commit], workspace, env, 30)
        if ancestry["exit_code"]:
            return False
        for item in gate["artifacts"] + gate.get("transferred_artifacts", []):
            path = metadata_path(workspace, item["path"])
            if not str(item["path"]).startswith("docs/evidence/") or digest(path) != item["sha256"]:
                return False
            report = json.loads(path.read_text())
            if (report.get("schema_version") != 2 or report.get("gate_id") != "qa"
                    or report.get("source_commit") != gate["source_commit"] or report.get("source_files") != sources
                    or report.get("command") != gate["command"] or report.get("exit_code") != gate.get("exit_code")
                    or report.get("source_sha256", sources) != sources):
                return False
            if gate.get("outcome") == "failed":
                if report.get("status") != "failed" or type(report.get("exit_code")) is not int or report["exit_code"] == 0:
                    return False
                continue
            runs = report.get("runs")
            if (gate.get("outcome") not in {"passed", "validated"} or report.get("status") != "passed"
                    or type(report.get("exit_code")) is not int or report["exit_code"] != 0
                    or not isinstance(runs, list) or not runs or not all(row.get("status") == "passed" for row in runs)):
                return False
            browser = report.get("browser_report")
            if browser is not None and (not isinstance(browser, dict) or browser.get("status") != "passed"
                    or not browser.get("source_sha256") or any(sources.get(key) != value for key, value in browser["source_sha256"].items())):
                return False
            if report.get("review", {}).get("independent") is True:
                images = report.get("inspected_images")
                if (not isinstance(images, list) or not images or not isinstance(report["review"].get("reviewer"), str)
                        or not report["review"]["reviewer"].strip()
                        or report["review"]["reviewer"] == report.get("author")):
                    return False
                for image in images:
                    if (not image["path"].startswith("docs/evidence/")
                            or digest(metadata_path(workspace, image["path"])) != image["sha256"]):
                        return False
        return True
    except (ProofError, KeyError, TypeError, OSError, ValueError, AttributeError):
        return False


def installation_lock(workspace, env):
    marker = workspace / ".git"
    owner = workspace.stat().st_uid
    if marker.is_symlink() or marker.stat().st_uid != owner:
        raise ProofError("unsafe_git_metadata")
    directory = Path(git_text(workspace, ["rev-parse", "--absolute-git-dir"], env))
    if marker.is_dir():
        expected = marker
    elif marker.is_file() and marker.stat().st_size <= 4096:
        lines = marker.read_text().splitlines()
        if len(lines) != 1 or not lines[0].startswith("gitdir: "):
            raise ProofError("unsafe_git_metadata")
        expected = workspace / lines[0][8:]
    else:
        raise ProofError("unsafe_git_metadata")
    if (not directory.is_absolute() or directory != directory.resolve() or expected.resolve() != directory
            or not directory.is_dir() or directory.stat().st_uid != owner
            or any(part.lower() in FORBIDDEN - {".git"} for part in directory.parts)):
        raise ProofError("unsafe_git_metadata")
    try:
        lock = os.open(directory / "praxis-proof.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except OSError as error:
        raise ProofError("unsafe_installation_lock") from error
    metadata = os.fstat(lock)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner or metadata.st_nlink != 1
            or metadata.st_size != 0 or metadata.st_mode & 0o022):
        os.close(lock)
        raise ProofError("unsafe_installation_lock")
    return lock


def install_evidence(workspace, output, prefix, proof, env):
    if not PREFIX.fullmatch(prefix) or not permitted(prefix):
        raise ProofError("invalid_artifact_prefix")
    target = metadata_path(workspace, prefix)
    verification = metadata_path(workspace, VERIFICATION)
    if target.exists():
        raise ProofError("evidence_destination_exists")
    if not verification.is_file():
        raise ProofError("verification_missing")
    sources, commit = proof["source_files"], proof["source_commit"]
    def current():
        return (git_text(workspace, ["rev-parse", "HEAD"], env) == commit
                and source_hashes(workspace, list(sources)) == sources
                and sources_committed(workspace, list(sources), env))
    if not current():
        raise ProofError("installation_source_mismatch")
    gates = {gate["id"]: gate for gate in proof["gates"]}
    if any(gates.get(name, {}).get("exit_code") != 0 or gates[name].get("outcome") not in {"passed", "validated"}
           for name in ("tests", "snapshot")):
        raise ProofError("tests_or_snapshot_not_passed")
    target.parent.mkdir(parents=True, exist_ok=True)
    lock = installation_lock(workspace, env)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ProofError("evidence_installation_in_progress") from error
        original = verification.read_bytes()
        merged = json.loads(original)
        if not isinstance(merged, dict) or not isinstance(merged.get("gates", []), list):
            raise ProofError("invalid_existing_verification")
        prior_qa = [gate for gate in merged.get("gates", []) if isinstance(gate, dict) and gate.get("id") == "qa"]
        retained = prior_qa[0] if len(prior_qa) == 1 and bound_qa(workspace, prior_qa[0], sources, commit, env) else None
        installed_gates = list(proof["gates"])
        installed_gates.extend(gate for gate in merged.get("gates", []) if isinstance(gate, dict)
                               and gate.get("id") not in {"tests", "snapshot", "qa", "typecheck", "build"})
        if "qa" not in gates:
            installed_gates.append(retained or {"id": "qa", "outcome": "pending", "reason": "No prior QA bound to the current committed source was retained.", "artifacts": []})
        if not current():
            raise ProofError("installation_source_mismatch")
        target.mkdir()
        for name in ("tests.json", "snapshot.json", "proof.json", "qa.json"):
            source = output / name
            if source.exists():
                if source.is_symlink():
                    raise ProofError("unsafe_output_artifact")
                shutil.copyfile(source, target / name)
        if (output / "qa").exists():
            (target / "qa").mkdir()
            for image in (output / "qa").glob("*.png"):
                if image.is_symlink():
                    raise ProofError("unsafe_output_artifact")
                shutil.copyfile(image, target / "qa" / image.name)
        for gate in installed_gates:
            if gate.get("id") in {"tests", "snapshot"} or (gate.get("id") == "qa" and "qa" in gates):
                for item in gate["artifacts"]:
                    if digest(metadata_path(workspace, item["path"])) != item["sha256"]:
                        raise ProofError("installed_artifact_mismatch")
        if verification.read_bytes() != original or not current():
            raise ProofError("verification_or_source_changed")
        merged.update({key: proof[key] for key in ("schema_version", "status", "source_commit", "integration_commit", "source_files", "goal_sha256")})
        merged.setdefault("accepted_issues", [])
        merged["gates"] = installed_gates
        merged["technical_installation"] = {"artifact_prefix": prefix, "source_commit": commit, "installed_at": timestamp()}
        selected_qa = gates.get("qa") or retained
        merged["qa_executed"] = bool(selected_qa and selected_qa.get("outcome") in {"passed", "validated"})
        reviews = [json.loads(metadata_path(workspace, item["path"]).read_text()).get("review", {})
                   for item in selected_qa.get("artifacts", [])] if merged["qa_executed"] else []
        merged["independent_review_pending"] = not reviews or not all(review.get("independent") is True for review in reviews)
        fd, temporary = tempfile.mkstemp(prefix=".verification-", dir=verification.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, verification)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"verification": VERIFICATION, "artifact_prefix": prefix, "retained_qa": bool(retained and "qa" not in gates)}
    finally:
        os.close(lock)


def generate(args, invocation):
    workspace = args.workspace.resolve()
    output = args.output.resolve()
    if not PREFIX.fullmatch(args.artifact_prefix) or not permitted(args.artifact_prefix):
        raise ProofError("invalid_artifact_prefix")
    if output.exists() or output == workspace or output.is_relative_to(workspace / ".git"):
        raise ProofError("output_must_be_new")
    if any(part.lower() in FORBIDDEN or part.lower().startswith(".env") for part in output.parts):
        raise ProofError("unsafe_output_path")
    if getattr(args, "install_evidence", False):
        destination = metadata_path(workspace, args.artifact_prefix)
        if destination.exists():
            raise ProofError("evidence_destination_exists")
        if output == destination or output.is_relative_to(destination):
            raise ProofError("output_collides_with_metadata")
        if not metadata_path(workspace, VERIFICATION).is_file():
            raise ProofError("verification_missing")
    if not 1 <= args.timeout <= 300:
        raise ProofError("invalid_timeout")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="praxis-proof-") as temporary:
        root = Path(temporary)
        home = root / "home"
        home.mkdir()
        env = child_environment(home)
        commit = git_text(workspace, ["rev-parse", "HEAD"], env)
        if not HEAD.fullmatch(commit) or (args.commit and commit != args.commit):
            raise ProofError("source_commit_mismatch")
        tracked = git_text(workspace, ["ls-tree", "-r", "--name-only", commit], env).splitlines()
        if any(not permitted(name) for name in tracked):
            raise ProofError("non_public_tracked_path")
        names = source_names(tracked)
        sources = source_hashes(workspace, names)
        if not sources_committed(workspace, names, env):
            raise ProofError("tracked_tree_dirty")
        clone = root / "source"
        cloned = execute(["git", "-c", "core.hooksPath=/dev/null", "clone", "--local", "--no-hardlinks",
                          "--no-checkout", str(workspace), str(clone)], workspace, env, 30)
        if cloned["exit_code"]:
            raise ProofError("isolated_clone_failed: " + cloned["stderr"].strip())
        git_text(clone, ["checkout", "--detach", commit], env)
        if source_hashes(clone, names) != sources:
            raise ProofError("isolated_source_mismatch")
        staging = root / "artifacts"
        staging.mkdir()
        started = timestamp()
        results = []
        for argv in test_commands(sys.executable):
            row = execute(argv, clone, env, args.timeout)
            results.append(row)
            print(json.dumps({"gate": "tests", "command": row["command"], "exit_code": row["exit_code"],
                              "duration_seconds": row["duration_seconds"]}), flush=True)
        tests_command = " && ".join(row["command"] for row in results)
        tests = gate_report("tests", tests_command, commit, sources, results,
                            actual_results=actual_results(results),
                            environment="isolated detached clone; synthetic fixtures only")
        if tests["actual_results"]["count"] == 0:
            tests["error"] = "no_api_tests_executed"
            if tests["exit_code"] == 0:
                tests.update(status="failed", exit_code=1)
        write_json(staging / "tests.json", tests)
        gates = [{"id": "tests", "outcome": "passed" if tests["exit_code"] == 0 else "failed",
                  "exit_code": tests["exit_code"], "command": tests_command, "source_commit": commit,
                  "source_files": sources, "artifacts": [artifact(staging, args.artifact_prefix, "tests.json")]}]
        if args.qa:
            qa_relative = "proof-generated/qa"
            row = execute([sys.executable, "-B", "scripts/qa_professional.py", "--output", qa_relative],
                          clone, env, args.timeout)
            qa_path = clone / qa_relative / "browser-qa.json"
            qa_data = json.loads(qa_path.read_text()) if qa_path.is_file() else {}
            valid = (row["exit_code"] == 0 and qa_data.get("status") == "passed"
                     and bool(qa_data.get("runs"))
                     and all(run.get("status") == "passed" for run in qa_data["runs"])
                     and all(sources.get(name) == value for name, value in qa_data.get("source_sha256", {}).items())
                     and bool(qa_data.get("source_sha256")))
            if not valid and not row["exit_code"]:
                row["exit_code"] = 1
                row["stderr"] += "\nqa_report_missing_or_invalid"
            for run in qa_data.get("runs", []):
                for image in run.get("screenshots", []):
                    original = clone / image["path"]
                    if original.is_symlink() or not original.resolve().is_relative_to(clone / qa_relative):
                        raise ProofError("unsafe_screenshot_path")
                    if digest(original) != image["sha256"]:
                        raise ProofError("screenshot_digest_mismatch")
                    destination = "qa/" + original.name
                    (staging / "qa").mkdir(exist_ok=True)
                    shutil.copyfile(original, staging / destination)
                    image["path"] = args.artifact_prefix + "/" + destination
            qa = gate_report("qa", invocation, commit, sources, [row], source_sha256=sources,
                             browser_report=qa_data, runs=qa_data.get("runs", []),
                             browser_version=qa_data.get("browser_version"), inspected_images=[],
                             review={"independent": False, "reviewer": None},
                             conclusion="QA executed; independent image inspection pending.")
            write_json(staging / "qa.json", qa)
            gates.append({"id": "qa", "outcome": "passed" if qa["exit_code"] == 0 else "failed",
                          "exit_code": qa["exit_code"], "command": invocation, "source_commit": commit,
                          "source_files": sources, "artifacts": [artifact(staging, args.artifact_prefix, "qa.json")]})
        after = source_hashes(workspace, names)
        same = (after == sources and source_hashes(clone, names) == sources
                and git_text(workspace, ["rev-parse", "HEAD"], env) == commit
                and sources_committed(workspace, names, env))
        snapshot = gate_report("snapshot", invocation, commit, sources, [], source_sha256=after,
                               source_unchanged=same, isolated_commit=commit)
        if not same:
            snapshot.update(status="failed", exit_code=1)
        write_json(staging / "snapshot.json", snapshot)
        gates.append({"id": "snapshot", "outcome": "validated" if same else "failed",
                      "exit_code": snapshot["exit_code"], "command": invocation, "source_commit": commit,
                      "source_files": sources, "artifacts": [artifact(staging, args.artifact_prefix, "snapshot.json")]})
        gates.extend([
            {"id": "typecheck", "outcome": "not-applicable", "reason": "Python standard-library API and plain JavaScript; Python compilation and Node syntax checks are recorded in tests.", "artifacts": []},
            {"id": "build", "outcome": "not-applicable", "reason": "Static HTML/CSS/JavaScript served directly with Python; no package manifest, bundler or build step.", "artifacts": []}])
        success = same and all(gate.get("exit_code", 0) == 0 for gate in gates)
        engineering = same and tests["exit_code"] == 0
        proof = {"schema_version": 2, "status": "technical-progress" if engineering else "failed",
                 "source_commit": commit, "integration_commit": commit, "source_files": sources,
                 "goal_sha256": sources["GOAL.md"], "gates": gates,
                 "acceptance_scope": "Separate validated tracker; technical proof does not write acceptance records.",
                 "started_at": started, "finished_at": timestamp(),
                 "qa_executed": bool(args.qa), "independent_review_pending": True,
                 "limits": ["Synthetic fixtures only; no clinical acceptance, real channels or patient data.",
                            "No verified-preview claim without separate independent image review."]}
        write_json(staging / "proof.json", proof)
        shutil.copytree(staging, output)
        installation = install_evidence(workspace, output, args.artifact_prefix, proof, env) if getattr(args, "install_evidence", False) else None
        print(json.dumps({"status": proof["status"], "source_commit": commit,
                          "source_files": len(sources), "output": str(output), "installation": installation}), flush=True)
        return 0 if success else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artifact-prefix", required=True)
    parser.add_argument("--commit")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--qa", action="store_true")
    parser.add_argument("--install-evidence", action="store_true")
    args = parser.parse_args(argv)
    invocation = shlex.join([sys.executable, "-B", str(Path(__file__).resolve()), *(argv if argv is not None else sys.argv[1:])])
    try:
        return generate(args, invocation)
    except (ProofError, OSError, ValueError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
