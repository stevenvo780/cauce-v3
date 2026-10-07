"""Read versioned engineering evidence without treating declarations as acceptance."""

from __future__ import annotations

import csv
import io
import json
import re
import shlex
import stat
import uuid
from pathlib import Path

# cauce:requiere none

HEX = re.compile(r"[a-f0-9]{64}\Z")
HEAD = re.compile(r"[a-f0-9]{40,64}\Z")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}\Z")
PASSED = {"passed", "validated", "accepted", "validada", "aceptada"}
ACCEPTANCE_ROOT = None
TECHNICAL = {"validated", "accepted", "validada", "aceptada", "validada tecnicamente", "validada técnicamente", "aceptada para el hito"}
ACCEPTED = {"accepted", "aceptada", "aceptada para el hito"}
ADVANCED = TECHNICAL | {"advanced", "avanzada"}


def acceptance_path(config: dict, state) -> Path | None:
    value = config.get("acceptance_receipts_file")
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise state.SupervisionError("invalid_acceptance_receipts_path")
    root = ACCEPTANCE_ROOT or Path(state.project_profile(config)["acceptance_root"])
    path = Path(value)
    if (not path.is_absolute() or ".." in path.parts or path.suffix != ".json"
            or not path.is_relative_to(root) or path == root
            or path.resolve().is_relative_to(Path(config["workspace"]).resolve())
            or any(part.lower() in {"private", "credentials", "secrets", "sessions", "profiles"} or part.startswith(".env")
                   for part in path.parts) or path.name in {"auth.json", "settings.local.json"}):
        raise state.SupervisionError("invalid_acceptance_receipts_path")
    return path


def acceptance_receipts(config: dict, goal: str, state) -> dict:
    path = acceptance_path(config, state)
    if path is None:
        return {}
    if not path.exists() and not path.is_symlink():
        return {}
    for directory in reversed((path.parent, *path.parent.parents)):
        state.trusted_file(directory, directory=True)
    state.trusted_file(path)
    if stat.S_IMODE(path.lstat().st_mode) != 0o600 or path.lstat().st_nlink != 1:
        raise state.SupervisionError("untrusted_acceptance_receipts_mode")
    value = json.loads(state.read_bytes(path, 512_000))
    if (not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1
            or value.get("goal_sha256") != goal or not isinstance(value.get("receipts"), list) or len(value["receipts"]) > 1000):
        raise state.SupervisionError("invalid_acceptance_receipts")
    expected_origin = state.project_profile(config)["acceptance_origin"]
    result = {}
    for receipt in value["receipts"]:
        if not isinstance(receipt, dict):
            raise state.SupervisionError("invalid_acceptance_receipts")
        try:
            identifier = uuid.UUID(receipt.get("receipt_id"))
            valid = (str(identifier) == receipt["receipt_id"] and identifier.int != 0
                     and ID.fullmatch(str(receipt.get("issue_id", ""))) and ID.fullmatch(str(receipt.get("criterion_id", "")))
                     and HEAD.fullmatch(str(receipt.get("source_commit", ""))) and HEX.fullmatch(str(receipt.get("artifact_sha256", ""))))
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise state.SupervisionError("invalid_acceptance_receipts")
        if receipt.get("provenance") != expected_origin or receipt.get("goal_sha256") != goal:
            continue
        key = (receipt["issue_id"], receipt["criterion_id"])
        if key in result:
            raise state.SupervisionError("duplicate_acceptance_receipt")
        result[key] = receipt
    return result


def records(path: Path, config: dict, name: str, state) -> dict[str, str]:
    rows = csv.DictReader(io.StringIO(state.read_bytes(path).decode("utf-8-sig")))
    columns = config.get(name + "_columns", {"id": "id", "status": "status"})
    result = {}
    for row in rows:
        normalized = {str(key).strip().lower(): value for key, value in row.items() if key is not None}
        identifier = (normalized.get(columns["id"].lower()) or "").strip()
        status = (normalized.get(columns["status"].lower()) or "").strip().lower()
        if not ID.fullmatch(identifier) or identifier in result:
            raise state.SupervisionError("invalid_tracker")
        result[identifier] = status
    return result


def roadmap_document(path: Path, goal: str, state) -> tuple[dict, dict]:
    value = json.loads(state.read_bytes(path))
    if not isinstance(value, dict) or value.get("goal_sha256") != goal:
        raise state.SupervisionError("foreign_roadmap_goal")
    issues, criteria = value.get("issues"), {}
    if not isinstance(issues, list) or len(issues) > 1000:
        raise state.SupervisionError("invalid_roadmap")
    for issue in issues:
        if not isinstance(issue, dict) or not ID.fullmatch(str(issue.get("id", ""))):
            raise state.SupervisionError("invalid_roadmap")
        entries = issue.get("criteria", [])
        if not isinstance(entries, list) or len(entries) > 1000:
            raise state.SupervisionError("invalid_roadmap")
        for criterion in entries:
            identifier = criterion.get("id") if isinstance(criterion, dict) else None
            if not isinstance(identifier, str) or not ID.fullmatch(identifier):
                raise state.SupervisionError("invalid_roadmap")
            key = issue["id"] + ":" + identifier
            if key in criteria:
                raise state.SupervisionError("invalid_roadmap")
            criteria[key] = criterion
    return value, criteria


def artifact_list(entry: dict, version: int) -> list:
    plural = entry.get("artifacts")
    singular = entry.get("artifact")
    if plural is not None and singular is not None:
        return []
    if isinstance(plural, list):
        return plural if 1 <= len(plural) <= 20 else []
    return [singular] if version == 1 and isinstance(singular, dict) else []


class EvidenceReader:
    def __init__(self, workspace: Path, state, commit_verified=lambda _: False, receipts=None):
        self.workspace, self.state, self.commit_verified = workspace, state, commit_verified
        self.receipts = receipts or {}

    def read_artifact(self, artifact: dict) -> tuple[bytes, dict | None] | None:
        if not isinstance(artifact, dict) or not HEX.fullmatch(str(artifact.get("sha256", ""))):
            return None
        path = self.state.scoped(self.workspace, artifact.get("path"))
        if path.suffix.lower() not in {".json", ".txt", ".log", ".png", ".jpg", ".jpeg", ".webp"}:
            return None
        try:
            raw = self.state.read_bytes(path)
        except self.state.SupervisionError as error:
            if error.code == "unsafe_artifact":
                return None
            raise
        if self.state.digest(raw) != artifact["sha256"]:
            return None
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            value = None
        return raw, value if isinstance(value, dict) else None

    def source_matches(self, sources: object) -> bool:
        if not isinstance(sources, dict) or not 1 <= len(sources) <= 1000:
            return False
        for path, expected in sources.items():
            self.state.scoped(self.workspace, path)
            if not re.fullmatch(r"(?:apps/api/[A-Za-z0-9_./-]+\.py|apps/web/[A-Za-z0-9_./-]+\.(?:js|css|html)|scripts/[A-Za-z0-9_./-]+\.(?:py|mjs)|docs/evidence/[A-Za-z0-9_./-]+/(?:offer_qa|run_qa)\.py|(?:GOAL|README|AGENTS|CLAUDE)\.md)", path):
                raise self.state.SupervisionError("artifact_source_scope")
            if not HEX.fullmatch(str(expected)):
                return False
            try:
                if self.state.digest(self.state.read_bytes(self.state.scoped(self.workspace, path))) != expected:
                    return False
            except self.state.SupervisionError as error:
                if error.code == "unsafe_artifact":
                    return False
                raise
        return True

    def bound_sources(self, report: dict, expected: dict | None = None) -> dict:
        if "source_files" in report and "source_sha256" in report and report["source_files"] != report["source_sha256"]:
            return {}
        sources = report.get("source_files", report.get("source_sha256"))
        if not self.source_matches(sources) or (expected is not None and sources != expected):
            return {}
        commit = report.get("source_commit", report.get("integration_commit", report.get("implementation_commit")))
        if commit is not None and not self.commit_verified(commit):
            return {}
        return sources

    def test_coverage(self, command: str, sources: dict) -> dict:
        try:
            lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
            lexer.whitespace_split = True
            tokens = list(lexer)
        except ValueError:
            return {}
        if any(token in {";", "|", "&", "||"} for token in tokens):
            return {}
        steps = [[]]
        for token in tokens:
            if token == "&&":
                steps.append([])
            else:
                steps[-1].append(token)
        tests = set()
        for step in steps:
            if not step:
                continue
            if Path(step[0]).name == "node" and len(step) == 2 and re.fullmatch(r"apps/web/test_[A-Za-z0-9_]+\.js", step[1]):
                tests.add(step[1])
            if Path(step[0]).name not in {"python", "python3"} or "-m" not in step or "-c" in step:
                continue
            offset = step.index("-m") + 1
            if offset >= len(step) or step[offset] != "unittest":
                continue
            for token in step[offset + 1:]:
                if re.fullmatch(r"apps\.api\.test_[A-Za-z0-9_]+", token):
                    tests.add(token.replace(".", "/") + ".py")
            if "discover" in step and "-s" in step:
                offset = step.index("-s") + 1
                if offset < len(step) and step[offset] == "apps/api":
                    pattern = "test*.py"
                    if "-p" in step:
                        index = step.index("-p") + 1
                        pattern = step[index] if index < len(step) else ""
                    if re.fullmatch(r"test[A-Za-z0-9_*?]*\.py", pattern):
                        tests.update(str(path.relative_to(self.workspace)) for path in (self.workspace / "apps/api").glob(pattern))
        if not tests or not tests.issubset(sources):
            return {}
        coverage = set(tests)
        for layer, suffixes in (("apps/api", {".py"}), ("apps/web", {".js", ".css", ".html"})):
            if not any(path.startswith(layer + "/") for path in tests):
                continue
            production = {str(path.relative_to(self.workspace)) for path in (self.workspace / layer).glob("*")
                          if path.is_file() and path.suffix in suffixes and not path.name.startswith("test_")}
            if not production.issubset(sources):
                return {}
            coverage.update(production)
        return {path: sources[path] for path in coverage}

    def executed_tests(self, report: dict, command: str) -> bool:
        results = report.get("results")
        if not isinstance(results, list) or not 1 <= len(results) <= 50:
            return False
        commands, executed = [], False
        for result in results:
            if (not isinstance(result, dict) or type(result.get("exit_code")) is not int or result["exit_code"] != 0
                    or not isinstance(result.get("command"), str) or not isinstance(result.get("stdout"), str)
                    or not isinstance(result.get("stderr"), str)):
                return False
            row = result["command"]
            commands.append(row)
            if "unittest" in shlex.split(row):
                match = re.search(r"\bRan ([1-9][0-9]*) tests? in [0-9.]+s\s+OK\b", result["stdout"] + "\n" + result["stderr"])
                if not match:
                    return False
                executed = True
            if re.search(r"\bnode apps/web/test_[A-Za-z0-9_]+\.js\b", row):
                if not re.search(r"\b(?:OK|passed)\b", result["stdout"]):
                    return False
                executed = True
        return executed and " && ".join(commands) == command

    def qa_source_current(self, report: dict, expected: dict) -> bool:
        nested = report.get("browser_report")
        if nested is None:
            return True
        if not isinstance(nested, dict) or nested.get("status") != "passed":
            return False
        sources = self.bound_sources(nested)
        return bool(sources) and all(expected.get(path) == sha for path, sha in sources.items())

    def not_applicable(self, entry: dict) -> bool:
        reason = entry.get("reason")
        if (entry.get("id") not in {"typecheck", "build"} or not isinstance(reason, str)
                or len(reason.strip()) < 12 or entry.get("exit_code") is not None
                or entry.get("artifact") is not None or entry.get("artifacts") not in (None, [])):
            return False
        names = ("mypy.ini", ".mypy.ini", "pyrightconfig.json", "tsconfig.json", "tsconfig.build.json")
        if entry["id"] == "build":
            names = ("Makefile", "makefile", "package.json", "setup.py", "setup.cfg")
        if any((self.workspace / name).exists() for name in names):
            return False
        for relative in ("pyproject.toml", "setup.cfg"):
            path = self.workspace / relative
            if path.exists():
                text = self.state.read_bytes(self.state.scoped(self.workspace, relative)).decode()
                if entry["id"] == "build" or re.search(r"\[(?:tool\.)?(?:mypy|pyright)\b", text):
                    return False
        if entry["id"] == "typecheck" and any(self.workspace.glob("**/tsconfig*.json")):
            return False
        return True

    def gates(self, verification: dict, source_current: bool) -> dict:
        result = {"valid": set(), "not_applicable": {}, "artifacts": [], "tested": {}, "rejections": {}, "qa_executed": False, "qa_review": None}
        entries, version = verification.get("gates", []), verification.get("schema_version")
        if type(version) is not int or version not in {1, 2} or not isinstance(entries, list) or len(entries) > 1000:
            result["rejections"]["schema"] = "unsupported_evidence_schema"
            return result
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict) or not ID.fullmatch(str(entry.get("id", ""))):
                continue
            identifier = entry["id"]
            if identifier in seen:
                result["valid"].discard(identifier)
                result["not_applicable"].pop(identifier, None)
                result["rejections"][identifier] = "duplicate_gate"
                continue
            seen.add(identifier)
            if entry.get("outcome") == "not-applicable":
                if self.not_applicable(entry):
                    result["not_applicable"][identifier] = entry["reason"].strip()
                else:
                    result["rejections"][identifier] = "unjustified_not_applicable"
                continue
            artifacts = artifact_list(entry, version)
            command = entry.get("command")
            if (not source_current or entry.get("outcome") not in PASSED or entry.get("exit_code") != 0
                    or type(entry.get("exit_code")) is not int or not isinstance(command, str) or not artifacts):
                result["rejections"][identifier] = "gate_contract_invalid"
                continue
            expected = entry.get("source_files", verification.get("source_files"))
            source_commit = entry.get("source_commit", verification.get("integration_commit"))
            verified = self.commit_verified(source_commit) and self.source_matches(expected)
            coverage, independent, executed_all, gate_tokens, review_images = {}, True, True, [], {}
            for artifact in artifacts + entry.get("transferred_artifacts", []):
                observed = self.read_artifact(artifact)
                report = observed[1] if observed else None
                if report is None or not self.bound_sources(report, expected):
                    verified = False
                    break
                if version == 2:
                    verified = verified and (report.get("schema_version") == 2 and report.get("gate_id") == identifier
                        and report.get("status") == "passed" and type(report.get("exit_code")) is int
                        and report["exit_code"] == 0 and report.get("command") == command
                        and report.get("source_commit") == source_commit)
                elif identifier != "snapshot":
                    verified = verified and (report.get("status") in PASSED and type(report.get("exit_code")) is int and report.get("exit_code") == 0
                        and report.get("command") == command)
                if identifier == "snapshot":
                    verified = (verified and expected == verification.get("source_files")
                                and (version != 2 or report.get("source_unchanged") is True))
                if identifier == "tests":
                    coverage = self.test_coverage(command, expected) if verified else {}
                    verified = verified and bool(coverage) and self.executed_tests(report, command)
                if identifier == "qa":
                    verified = verified and self.qa_source_current(report, expected)
                    runs = report.get("runs")
                    executed = (isinstance(runs, list) and bool(runs)
                                and all(isinstance(run, dict) and run.get("status") == "passed" for run in runs))
                    executed_all = executed_all and executed
                    for run in runs if isinstance(runs, list) else []:
                        for capture in run.get("screenshots", []) if isinstance(run, dict) else []:
                            if isinstance(capture, dict) and self.read_artifact(capture) is not None:
                                review_images[capture["path"]] = capture["sha256"]
                    review, images = report.get("review", {}), report.get("inspected_images", [])
                    independent = (independent and executed and isinstance(review, dict) and review.get("independent") is True
                        and isinstance(review.get("reviewer"), str) and bool(review["reviewer"].strip())
                        and review.get("reviewer") != report.get("author") and isinstance(images, list) and bool(images)
                        and all(self.read_artifact(image) is not None for image in images))
                gate_tokens.append(identifier + ":" + artifact["sha256"])
            if identifier == "qa":
                result["qa_executed"] = bool(verified and executed_all)
                if verified and executed_all and 1 <= len(review_images) <= 100:
                    code_sources = {path: sha for path, sha in expected.items() if Path(path).suffix in {".py", ".mjs", ".js", ".css", ".html"}}
                    result["qa_review"] = {"cohort_sha256": self.state.digest(self.state.canonical({
                        "source_files": code_sources, "screenshots": sorted(set(review_images.values()))})),
                        "source_commit": source_commit, "source_files": expected, "artifacts": artifacts,
                        "screenshots": [{"path": path, "sha256": sha} for path, sha in sorted(review_images.items())]}
            if verified and independent:
                result["valid"].add(identifier)
                result["artifacts"].extend(gate_tokens)
                result["tested"].update(coverage)
            else:
                result["rejections"][identifier] = "stale_or_unbound_artifact" if not verified else "independent_visual_review_pending"
        return result

    def criterion_verified(self, issue: str, criterion: dict, record: dict, goal: str) -> bool:
        observed = self.read_artifact(criterion.get("artifact"))
        report = observed[1] if observed else None
        if (report is None or report.get("schema_version") != 2 or report.get("issue_id") != issue
                or report.get("criterion_id") != criterion.get("id") or report.get("goal_sha256") != goal
                or report.get("source_commit") != record.get("source_commit")
                or report.get("status") not in PASSED or not self.commit_verified(report.get("source_commit"))):
            return False
        sources = self.bound_sources(report)
        command = report.get("command")
        if not sources or not isinstance(command, str):
            return False
        runtime_sources = {path for path in sources if path.startswith("apps/")}
        coverage = self.test_coverage(command, sources)
        if not runtime_sources or not runtime_sources.issubset(coverage):
            return False
        test_gate = {"id": "tests", "outcome": "passed", "exit_code": 0, "command": command,
                     "source_commit": report["source_commit"], "source_files": sources,
                     "artifacts": [criterion["artifact"]]}
        gates = [test_gate]
        if any(path.startswith("apps/web/") for path in runtime_sources):
            qa = self.read_artifact(criterion.get("qa_artifact"))
            qa_report = qa[1] if qa else None
            if qa_report is None or not isinstance(qa_report.get("command"), str):
                return False
            gates.append({"id": "qa", "outcome": "passed", "exit_code": 0, "command": qa_report["command"],
                          "source_commit": report["source_commit"], "source_files": sources,
                          "artifacts": [criterion["qa_artifact"]]})
        verified = self.gates({"schema_version": 2, "source_files": sources, "integration_commit": report["source_commit"],
                              "gates": gates}, True)
        return {gate["id"] for gate in gates}.issubset(verified["valid"])

    def accepted_records(self, evidence: dict, roadmap: dict, issues: dict) -> tuple[set, set, set]:
        accepted_issues, accepted_criteria, technical = set(), set(), set()
        records_value = evidence.get("records", {})
        if type(evidence.get("schema_version")) is not int or evidence["schema_version"] not in {1, 2} or not isinstance(records_value, dict) or len(records_value) > 1000:
            return accepted_issues, accepted_criteria, technical
        for issue, record in records_value.items():
            if not isinstance(record, dict) or record.get("validation_status") not in TECHNICAL or not self.commit_verified(record.get("source_commit")):
                continue
            criteria = record.get("criteria", [])
            if not isinstance(criteria, list) or len(criteria) > 1000:
                continue
            for criterion in criteria:
                if not isinstance(criterion, dict) or criterion.get("outcome") not in PASSED:
                    continue
                key = issue + ":" + str(criterion.get("id", ""))
                if key not in roadmap or not self.criterion_verified(issue, criterion, record, evidence["goal_sha256"]):
                    continue
                technical.add(key)
                receipt = self.receipts.get((issue, criterion["id"]))
                if (receipt and receipt["source_commit"] == record["source_commit"]
                        and receipt["artifact_sha256"] == criterion["artifact"]["sha256"]):
                    accepted_criteria.add(key)
            scope = {key for key in roadmap if key.startswith(issue + ":")}
            if issues.get(issue) in ACCEPTED and scope and scope.issubset(accepted_criteria):
                accepted_issues.add(issue)
        return accepted_issues, accepted_criteria, technical


def next_work(document: dict, evidence: dict, technical: set, deferred: list[str] | None = None) -> dict | None:
    records_value = evidence.get("records", {})
    if not isinstance(records_value, dict):
        records_value = {}
    blocked = None
    issues = sorted(document["issues"], key=lambda issue: issue["id"].replace("-", "") in set(deferred or []))
    for issue in issues:
        record = records_value.get(issue["id"], {})
        record = record if isinstance(record, dict) else {}
        for criterion in issue.get("criteria", []):
            key = issue["id"] + ":" + criterion["id"]
            if key in technical:
                continue
            text = criterion.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            blocker = criterion.get("blocked_reason", record.get("blocked_reason"))
            work = {"issue_id": issue["id"], "criterion_id": criterion["id"], "criterion": text[:4000],
                    "remaining": str(record.get("remaining", ""))[:2000],
                    "blocked_reason": blocker[:1000] if isinstance(blocker, str) else None,
                    "source": "sdd-roadmap", "authority": "existing_owner_goal", "advisory": True}
            if not work["blocked_reason"]:
                return work
            blocked = blocked or work
    return blocked


def engineering_snapshot(config: dict, deadline: float, run_command, state) -> dict:
    workspace, preview = Path(config["workspace"]), Path(config["preview_root"]) if config.get("preview_root") else None
    profile = state.project_profile(config)
    goal_hash = state.digest(state.read_bytes(state.scoped(workspace, config["goal_file"])))
    if goal_hash != config["goal_sha256"]:
        raise state.SupervisionError("foreign_goal")
    head = run_command(["git", "-C", str(workspace), "rev-parse", "HEAD"], deadline).strip()
    if not HEAD.fullmatch(head):
        raise state.SupervisionError("invalid_git_head")
    clean = not run_command(["git", "-C", str(workspace), "status", "--porcelain"], deadline).strip()
    cache = {head: True}

    def commit_verified(commit):
        if not isinstance(commit, str) or not HEAD.fullmatch(commit):
            return False
        if commit not in cache:
            try:
                run_command(["git", "-C", str(workspace), "merge-base", "--is-ancestor", commit, head], deadline)
                cache[commit] = True
            except state.SupervisionError:
                cache[commit] = False
        return cache[commit]

    reader = EvidenceReader(workspace, state, commit_verified, acceptance_receipts(config, goal_hash, state))
    issues = records(state.scoped(workspace, config["issues_file"]), config, "issues", state)
    document, roadmap = roadmap_document(state.scoped(workspace, config["roadmap_file"]), goal_hash, state)
    if len(issues) != config.get("issue_count", profile["issue_count"]) or len(roadmap) != config.get("roadmap_count", profile["roadmap_count"]):
        raise state.SupervisionError("tracker_count_mismatch")
    published = {source: {"source": state.digest(state.read_bytes(state.scoped(workspace, source))),
                         "published": state.digest(state.read_bytes(state.scoped(preview, destination)))}
                 for source, destination in config["preview_files"].items()}
    web_matches = all(row["source"] == row["published"] for row in published.values())
    evidence, verification = {}, {}
    for field, target in (("evidence_file", evidence), ("verification_file", verification)):
        path = state.scoped(workspace, config[field])
        if path.exists():
            try:
                value = json.loads(state.read_bytes(path))
                if isinstance(value, dict):
                    target.update(value)
            except (ValueError, UnicodeError):
                pass
    source_files = verification.get("source_files", {})
    source_matches = reader.source_matches(source_files)
    source_paths = set(config["preview_files"]) | (set(source_files) if isinstance(source_files, dict) else set())
    source_hashes = {path: state.digest(state.read_bytes(state.scoped(workspace, path))) for path in source_paths}
    unchanged = False
    if source_matches and commit_verified(verification.get("integration_commit")):
        unchanged = not run_command(["git", "-C", str(workspace), "diff", "--name-only", verification["integration_commit"],
                                     head, "--", *sorted(source_files)], deadline).strip()
    source_current = (type(verification.get("schema_version")) is int and verification["schema_version"] in {1, 2}
                      and verification.get("goal_sha256") == goal_hash
                      and verification.get("status") in {"verified-preview", "validated", "accepted", "technical-progress"}
                      and commit_verified(verification.get("source_commit")) and unchanged
                      and set(config["preview_files"]).issubset(source_files))
    accepted_issues, accepted_criteria, technical = set(), set(), set()
    if evidence.get("goal_sha256") == goal_hash:
        accepted_issues, accepted_criteria, technical = reader.accepted_records(evidence, roadmap, issues)
    gates = reader.gates(verification, source_current)
    expected_gates = {"tests", "typecheck", "build", "qa", "snapshot"} | set(config.get("required_gates", []))
    verified_issues = verification.get("accepted_issues", [])
    verification_current = (source_current and verification.get("status") in {"verified-preview", "validated", "accepted"}
        and isinstance(verified_issues, list)
        and all(isinstance(identifier, str) and ID.fullmatch(identifier) for identifier in verified_issues)
        and set(verified_issues) == set(issues))
    complete = (len(accepted_issues) == len(issues) and len(accepted_criteria) == len(roadmap)
                and gates["valid"] | set(gates["not_applicable"]) == expected_gates
                and web_matches and verification_current and clean)
    technical_milestone = (len(technical) == len(roadmap) and source_current
                          and gates["valid"] | set(gates["not_applicable"]) == expected_gates
                          and web_matches and clean)
    verified_engineering = source_current and {"tests", "snapshot"}.issubset(gates["valid"]) and clean
    return {"goal_sha256": goal_hash, "git_head": head, "issues_total": len(issues), "roadmap_total": len(roadmap),
            "advanced_issues": sorted(key for key, status in issues.items() if status in ADVANCED),
            "accepted_issues": sorted(accepted_issues), "accepted_roadmap": sorted(accepted_criteria),
            "validated_roadmap": sorted(technical), "valid_gates": sorted(gates["valid"]),
            "not_applicable_gates": gates["not_applicable"], "gate_rejections": gates["rejections"],
            "web_matches": web_matches, "verification_current": verification_current, "source_files_match": source_matches,
            "completion_candidate": complete, "working_tree_clean": clean, "files": published,
            "technical_milestone_candidate": bool(technical_milestone), "acceptance_receipt_required": len(accepted_criteria) != len(roadmap),
            "source_hashes": source_hashes, "verification_source_current": source_current,
            "gate_artifacts": sorted(gates["artifacts"]), "tested_source_hashes": gates["tested"],
            "verified_engineering": bool(verified_engineering), "qa_executed": gates["qa_executed"],
            "production_clinical_accepted": verification.get("production_clinical_accepted", False),
            "qa_review": dict(gates["qa_review"], git_head=head, goal_sha256=goal_hash) if gates["qa_review"] else None,
            "next_work": next_work(document, evidence, technical, profile["deferred_issues"])}


def made_progress(previous: dict, current: dict) -> bool:
    old_sources, sources = previous.get("source_hashes", {}), current.get("source_hashes", {})
    fresh_tests = {token for token in current.get("gate_artifacts", []) if token.startswith("tests:")} - set(previous.get("gate_artifacts", []))
    if not current.get("verified_engineering") or not old_sources or not sources or not fresh_tests:
        return False
    changed = {path for path, sha in sources.items() if old_sources.get(path) != sha
               and (path in old_sources or path.startswith("apps/"))}
    tested = current.get("tested_source_hashes", {})
    return (all(tested.get(path) == sources[path] for path in changed)
            and (bool(changed) or previous.get("verified_engineering") is not True))
