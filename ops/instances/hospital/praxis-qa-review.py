#!/usr/bin/env python3
"""Record an independent review already performed with an image-capable tool.

Create the manifest ONLY AFTER inspecting every capture. This command neither
views images nor grants clinical/legal acceptance. Use synthetic observations,
without secrets or patient/customer data. Manifest schema (no extra keys):
schema_version=1, reviewer, source_commit, qa_sha256, goal_sha256,
outcome (passed/failed), notes, inspected[{path, sha256, observations}].
Notes and observations must describe the actual inspection, not an approval
assertion. Paths are workspace-relative and must match the QA capture inventory.
The legacy review.independent flag grants technical visual approval, so it is
true only for a passed verdict. review.performed records both passed and failed
inspections; failed verdicts preserve the automated QA results and stay pending.
The proof lock excludes cooperating writers only; file checks and replacements
are not compare-and-swap against arbitrary writers. Verification is published
last. Earlier write failures leave its previous hashes rejecting partial updates
and retain private original-file backups for manual recovery. Never add recovery
backups to Git. This command never restores existing files after a partial write.
"""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath

# cauce:requiere none

SPEC = importlib.util.spec_from_file_location("praxis_qa_review_proof", Path(__file__).with_name("praxis-proof.py"))
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)
HEX = re.compile(r"[a-f0-9]{64}\Z")
MANIFEST_KEYS = {"schema_version", "reviewer", "source_commit", "qa_sha256", "goal_sha256", "outcome", "notes", "inspected"}


class ReviewError(Exception):
    def __init__(self, code, recovery=None):
        super().__init__(code)
        self.recovery = recovery


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def relative_path(workspace, name):
    if (not isinstance(name, str) or not name or str(PurePosixPath(name)) != name
            or "\\" in name or not PROOF.permitted(name)):
        raise ReviewError("unsafe_relative_path")
    return PROOF.metadata_path(workspace, name)


def trusted_path(path, owner, workspace=None):
    if path != path.resolve() or any(parent.is_symlink() for parent in (path, *path.parents)):
        raise ReviewError("unsafe_file_path")
    if workspace is not None:
        for parent in (path.parent, *path.parent.parents):
            if not parent.is_relative_to(workspace):
                break
            metadata = parent.lstat()
            if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != owner
                    or metadata.st_mode & 0o022):
                raise ReviewError("unsafe_directory")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner
                or metadata.st_nlink != 1 or metadata.st_mode & 0o022 or metadata.st_size > 32_000_000):
            raise ReviewError("unsafe_file_metadata")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            value = stream.read(32_000_001)
        after = os.fstat(descriptor)
        def signature(item):
            return (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_nlink,
                    item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if len(value) > 32_000_000 or signature(after) != signature(metadata):
            raise ReviewError("file_changed_during_read")
        return {"bytes": value, "signature": signature(metadata), "mode": stat.S_IMODE(metadata.st_mode)}
    finally:
        os.close(descriptor)


class Inputs:
    def __init__(self, workspace):
        self.workspace, self.owner, self.files = workspace, workspace.stat().st_uid, {}

    def read(self, name):
        path = relative_path(self.workspace, name)
        observed = trusted_path(path, self.owner, self.workspace)
        if path in self.files and observed != self.files[path]:
            raise ReviewError("evidence_changed")
        self.files[path] = observed
        return observed["bytes"]

    def document(self, name):
        value = json.loads(self.read(name))
        if not isinstance(value, dict):
            raise ReviewError("invalid_document")
        return value

    def unchanged(self):
        for path, expected in self.files.items():
            if trusted_path(path, self.owner, self.workspace) != expected:
                raise ReviewError("evidence_changed")


def actual_notes(value):
    return (isinstance(value, str) and 20 <= len(value.strip()) <= 4096
            and len(set(re.findall(r"[^\W\d_]{2,}", value.lower()))) >= 4)


def workspace_owner(workspace):
    owner = os.geteuid()
    if owner == 0 or workspace != workspace.resolve() or workspace.stat().st_uid != owner or workspace.stat().st_mode & 0o022:
        raise ReviewError("normal_workspace_owner_required")
    return owner


def manifest_document(path, owner):
    if any(part.lower() in PROOF.FORBIDDEN or part.lower().startswith(".env") for part in path.parts):
        raise ReviewError("unsafe_manifest_path")
    original = trusted_path(path, owner)
    value = json.loads(original["bytes"])
    if (not isinstance(value, dict) or set(value) != MANIFEST_KEYS or type(value.get("schema_version")) is not int
            or value["schema_version"] != 1 or not isinstance(value.get("reviewer"), str)
            or not 3 <= len(value["reviewer"].strip()) <= 200 or value.get("outcome") not in {"passed", "failed"}
            or not PROOF.HEAD.fullmatch(str(value.get("source_commit", "")))
            or not all(HEX.fullmatch(str(value.get(key, ""))) for key in ("qa_sha256", "goal_sha256"))
            or not actual_notes(value.get("notes")) or not isinstance(value.get("inspected"), list)
            or not 1 <= len(value["inspected"]) <= 100):
        raise ReviewError("invalid_review_manifest")
    return value, original


def sources_current(inputs, sources, commit, env):
    if (not isinstance(sources, dict) or not sources or "GOAL.md" not in sources or len(sources) > 1000
            or not PROOF.HEAD.fullmatch(str(commit))):
        raise ReviewError("invalid_source_binding")
    head = PROOF.git_text(inputs.workspace, ["rev-parse", "HEAD"], env)
    if PROOF.execute(["git", "-C", str(inputs.workspace), "merge-base", "--is-ancestor", commit, head], inputs.workspace, env, 30)["exit_code"]:
        raise ReviewError("foreign_source_commit")
    for name, expected in sources.items():
        if not HEX.fullmatch(str(expected)) or sha256(inputs.read(name)) != expected:
            raise ReviewError("source_hash_mismatch")
        blob = PROOF.git_text(inputs.workspace, ["rev-parse", commit + ":" + name], env)
        if blob != PROOF.git_text(inputs.workspace, ["hash-object", "--", name], env):
            raise ReviewError("commit_source_mismatch")
    if (PROOF.source_hashes(inputs.workspace, list(sources)) != sources
            or PROOF.git_text(inputs.workspace, ["status", "--porcelain", "--untracked-files=all", "--", *sources], env)):
        raise ReviewError("uncommitted_source")


def captures(inputs, report, prefix):
    runs = report.get("runs")
    if (not isinstance(runs, list) or not 1 <= len(runs) <= 100
            or not all(isinstance(run, dict) and run.get("status") == "passed" for run in runs)):
        raise ReviewError("qa_not_executed")
    expected = {}
    for run in runs:
        rows = run.get("screenshots")
        if not isinstance(rows, list):
            raise ReviewError("invalid_capture_inventory")
        for row in rows:
            if (not isinstance(row, dict) or not isinstance(row.get("path"), str)
                    or not PurePosixPath(row["path"]).is_relative_to(PurePosixPath(prefix))
                    or not HEX.fullmatch(str(row.get("sha256", "")))):
                raise ReviewError("foreign_capture")
            name, expected_hash = row["path"], row["sha256"]
            if name in expected and expected[name] != expected_hash:
                raise ReviewError("conflicting_capture")
            if sha256(inputs.read(name)) != expected_hash:
                raise ReviewError("capture_hash_mismatch")
            expected[name] = expected_hash
    if not 1 <= len(expected) <= 100:
        raise ReviewError("capture_inventory_missing")
    return expected


def qa_report(inputs, name, prefix, env):
    report = inputs.document(name)
    sources = report.get("source_files")
    if (type(report.get("schema_version")) is not int or report["schema_version"] != 2
            or report.get("gate_id") != "qa" or report.get("status") != "passed"
            or type(report.get("exit_code")) is not int or report["exit_code"] != 0
            or not isinstance(report.get("command"), str) or not report["command"].strip()
            or report.get("source_sha256", sources) != sources):
        raise ReviewError("qa_not_passed_or_bound")
    sources_current(inputs, sources, report.get("source_commit"), env)
    if report.get("goal_sha256", sources["GOAL.md"]) != sources["GOAL.md"]:
        raise ReviewError("qa_goal_mismatch")
    nested = report.get("browser_report")
    if nested is not None:
        if (not isinstance(nested, dict) or nested.get("status") != "passed"
                or not isinstance(nested.get("source_sha256"), dict) or not nested["source_sha256"]
                or any(sources.get(name) != expected for name, expected in nested["source_sha256"].items())):
            raise ReviewError("browser_source_mismatch")
    return report, captures(inputs, report, prefix)


def qa_gates(document, report, name, old_hash):
    gates = document.get("gates")
    selected = [gate for gate in gates if isinstance(gate, dict) and gate.get("id") == "qa"] if isinstance(gates, list) else []
    if len(selected) != 1:
        raise ReviewError("qa_gate_missing_or_duplicate")
    gate = selected[0]
    artifacts = gate.get("artifacts")
    transferred = gate.get("transferred_artifacts", [])
    if (not isinstance(artifacts, list) or not artifacts or not isinstance(transferred, list)
            or gate.get("outcome") not in {"passed", "validated"}
            or type(gate.get("exit_code")) is not int or gate["exit_code"] != 0
            or gate.get("source_files") != report["source_files"] or gate.get("source_commit") != report["source_commit"]
            or gate.get("command") != report["command"]
            or not any(isinstance(item, dict) and item.get("path") == name for item in artifacts + transferred)):
        raise ReviewError("qa_gate_binding_mismatch")
    for item in artifacts + transferred:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not HEX.fullmatch(str(item.get("sha256", ""))):
            raise ReviewError("invalid_qa_artifact_reference")
        if item["path"] == name and item["sha256"] != old_hash:
            raise ReviewError("qa_reference_hash_mismatch")
    return artifacts + transferred


def replace_references(value, name, old_hash, new_hash):
    if isinstance(value, dict):
        if value.get("path") == name and "sha256" in value:
            if value["sha256"] != old_hash:
                raise ReviewError("qa_reference_hash_mismatch")
            value["sha256"] = new_hash
        for child in value.values():
            replace_references(child, name, old_hash, new_hash)
    elif isinstance(value, list):
        for child in value:
            replace_references(child, name, old_hash, new_hash)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def temporary_file(path, value, mode, prefix=".praxis-review-stage-"):
    descriptor, name = tempfile.mkstemp(prefix=prefix, dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        os.unlink(name)
        raise
    return Path(name)


def apply_updates(inputs, updates, recheck):
    staged, backups, recovery_backups, written, committed = {}, {}, [], [], False
    try:
        for name, value in updates.items():
            path = relative_path(inputs.workspace, name)
            original = inputs.files[path]
            staged[path] = temporary_file(path, value, original["mode"])
            backups[path] = temporary_file(path, original["bytes"], 0o600, ".praxis-review-backup-")
            recovery_backups.append({"path": name, "backup": str(backups[path].relative_to(inputs.workspace)),
                                     "sha256": sha256(original["bytes"]), "planned_sha256": sha256(value)})
        for path in staged:
            recheck()
            os.replace(staged[path], path)
            written.append(path)
            if len(written) == len(staged):
                committed = True
                break
            observed = trusted_path(path, inputs.owner, inputs.workspace)
            if observed["bytes"] != updates[str(path.relative_to(inputs.workspace))]:
                raise ReviewError("evidence_changed_after_replace")
            inputs.files[path] = observed
    except BaseException as error:
        if written:
            recovery = {"cause": str(error), "verification": next(reversed(updates)),
                        "written": [str(path.relative_to(inputs.workspace)) for path in written],
                        "backups": recovery_backups}
            raise ReviewError("partial_review_update_recovery_required", recovery) from error
        raise
    finally:
        disposable = [*staged.values(), *(backups.values() if committed or not written else [])]
        for path in disposable:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def record(args):
    workspace = args.workspace.absolute()
    owner = workspace_owner(workspace)
    if not PROOF.PREFIX.fullmatch(args.artifact_prefix):
        raise ReviewError("invalid_artifact_prefix")
    manifest_path = args.review_manifest.absolute()
    with tempfile.TemporaryDirectory(prefix="praxis-review-home-") as temporary:
        env = PROOF.child_environment(Path(temporary))
        lock = PROOF.installation_lock(workspace, env)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ReviewError("evidence_installation_in_progress") from error
            manifest, original_manifest = manifest_document(manifest_path, owner)
            inputs = Inputs(workspace)
            qa_name = args.artifact_prefix + "/qa.json"
            report, expected = qa_report(inputs, qa_name, args.artifact_prefix, env)
            old_hash, sources = sha256(inputs.files[workspace / qa_name]["bytes"]), report["source_files"]
            if (manifest["source_commit"] != report["source_commit"] or manifest["qa_sha256"] != old_hash
                    or manifest["goal_sha256"] != sources["GOAL.md"] or manifest["reviewer"].strip() == report.get("author")):
                raise ReviewError("review_binding_or_independence_mismatch")
            inspected = {}
            for image in manifest["inspected"]:
                if (not isinstance(image, dict) or set(image) != {"path", "sha256", "observations"}
                        or not isinstance(image.get("path"), str) or image["path"] in inspected
                        or expected.get(image["path"]) != image.get("sha256") or not actual_notes(image.get("observations"))):
                    raise ReviewError("invalid_inspected_capture")
                inspected[image["path"]] = image
            if set(inspected) != set(expected):
                raise ReviewError("incomplete_capture_inspection")
            proof_name = args.artifact_prefix + "/proof.json"
            if args.verification_file in {qa_name, proof_name, *sources} or not args.verification_file.endswith(".json"):
                raise ReviewError("invalid_verification_path")
            documents = {}
            if relative_path(workspace, proof_name).exists():
                documents[proof_name] = inputs.document(proof_name)
            documents[args.verification_file] = inputs.document(args.verification_file)
            pending = manifest["outcome"] != "passed"
            for document in documents.values():
                sources_current(inputs, document.get("source_files"), document.get("source_commit"), env)
                if document.get("goal_sha256") != sources["GOAL.md"] or any(document["source_files"].get(name) != expected_hash for name, expected_hash in sources.items()):
                    raise ReviewError("metadata_source_or_goal_mismatch")
                references = qa_gates(document, report, qa_name, old_hash)
                for reference in references:
                    if reference["path"] == qa_name:
                        continue
                    other, images = qa_report(inputs, reference["path"], str(PurePosixPath(reference["path"]).parent), env)
                    if sha256(inputs.files[workspace / reference["path"]]["bytes"]) != reference["sha256"] or other["source_files"] != sources or other["source_commit"] != report["source_commit"]:
                        raise ReviewError("related_qa_binding_mismatch")
                    review = other.get("review", {})
                    pending = pending or not (isinstance(review, dict) and review.get("independent") is True and review.get("outcome") == "passed"
                                              and isinstance(review.get("reviewer"), str) and bool(review["reviewer"].strip())
                                              and review["reviewer"].strip() != other.get("author")
                                              and {image.get("path"): image.get("sha256") for image in other.get("inspected_images", []) if isinstance(image, dict)} == images)
            review = report.get("review", {})
            if not isinstance(review, dict):
                raise ReviewError("invalid_existing_review")
            report["review"] = {**review, "independent": manifest["outcome"] == "passed", "performed": True,
                                "reviewer": manifest["reviewer"].strip(), "outcome": manifest["outcome"],
                                "notes": manifest["notes"], "reviewed_at": PROOF.timestamp(), "source_commit": report["source_commit"],
                                "goal_sha256": sources["GOAL.md"], "qa_sha256": old_hash}
            report["inspected_images"] = [copy.deepcopy(inspected[name]) for name in sorted(inspected)]
            updates = {qa_name: encoded(report)}
            new_hash = sha256(updates[qa_name])
            for name, document in documents.items():
                replace_references(document, qa_name, old_hash, new_hash)
                document["independent_review_pending"] = pending
                if name == args.verification_file and proof_name in updates:
                    replace_references(document, proof_name, sha256(inputs.files[workspace / proof_name]["bytes"]), sha256(updates[proof_name]))
                updates[name] = encoded(document)

            def recheck():
                inputs.unchanged()
                if trusted_path(manifest_path, owner) != original_manifest:
                    raise ReviewError("review_manifest_changed")
                for document in [report, *documents.values()]:
                    sources_current(inputs, document["source_files"], document["source_commit"], env)

            apply_updates(inputs, updates, recheck)
            return {"status": "review-recorded", "outcome": manifest["outcome"], "source_commit": report["source_commit"],
                    "artifact_prefix": args.artifact_prefix, "hashes": {name: sha256(value) for name, value in updates.items()},
                    "current_validity": {"checked_before_publication": True, "source_current": True, "goal_current": True, "qa_passed": True,
                                         "independent_review_pending": pending}, "exit_code": 0 if manifest["outcome"] == "passed" else 1}
        finally:
            os.close(lock)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--artifact-prefix", required=True)
    parser.add_argument("--review-manifest", type=Path, required=True)
    parser.add_argument("--verification-file", default=PROOF.VERIFICATION)
    args = parser.parse_args(argv)
    try:
        result = record(args)
        print(json.dumps(result), flush=True)
        return result["exit_code"]
    except (ReviewError, PROOF.ProofError, OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"status": "failed", "error": str(error), "recovery": getattr(error, "recovery", None)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
