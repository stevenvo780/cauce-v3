"""Publish bounded review and remediation roots for current QA cohorts."""

from __future__ import annotations

import copy
import re

# cauce:requiere none


def request_visual_review(supervisor, engineering: dict, state_tools, capacity_codes) -> dict:
    review = engineering["qa_review"]
    cohort, day = review["cohort_sha256"], state_tools.utc_day(supervisor.now)
    state_tools.hold_earned_review_credit(supervisor.state, engineering, supervisor.now)
    supervisor.state["phase"], supervisor.state["pause_reason"] = "waiting_visual_review", "independent_visual_review_pending"
    supervisor.state["continuation_earned"] = False
    supervisor.state["pending_visual_review"] = review
    supervisor.state["review_cooldown_seconds"] = supervisor.config["cooldown_seconds"]
    requests, budgets = supervisor.state.setdefault("visual_review_requests", {}), supervisor.state.setdefault("visual_review_roots", {})
    if cohort in requests:
        state_tools.diagnose_legacy_review_contract(supervisor.state, engineering, supervisor.now)
        if requests[cohort].get("contract_status") == "review_contract_incomplete":
            supervisor.notice_review_contract_failure()
        return supervisor.finish("review_contract_incomplete" if requests[cohort].get("contract_status") == "review_contract_incomplete"
                           else "visual_review_pending")
    if supervisor.state["roots"].get(day, 0) >= supervisor.config["root_limit"]:
        return supervisor.finish("visual_review_fuel_exhausted")
    if supervisor.now < supervisor.state.get("cooldown_until", 0):
        return supervisor.finish("cooldown")
    deferred = supervisor.refresh_before_post()
    if deferred is not None:
        return deferred
    key = "praxis-visual-review:" + supervisor.config["goal_sha256"][:16] + ":" + cohort
    payload = supervisor.payload(key, "Operador: revisá este corte sintético de forma independiente de los developers. "
        "Verificá hashes y source commit; inspeccioná las capturas de supervision.visual_review. "
        "Abrí realmente las imágenes con una herramienta apta y registrá observaciones de cada una. Consultá --help de "
        "/home/node/clawd/.cauce/runtime/praxis-qa-review.py; después de inspeccionar, creá el manifest JSON y ejecutá "
        "/opt/praxis-qa-venv/bin/python -B /home/node/clawd/.cauce/runtime/praxis-qa-review.py "
        "--workspace <canónico> --artifact-prefix <prefijo-QA> --review-manifest <manifest-inspeccionado.json> "
        "[--verification-file <ruta-relativa>]. Commiteá sólo la evidencia. Si falta herramienta, informá el código "
        "técnico sin inventar inspección. No desarrolles ni declares aceptación clínica. "
        "Si falta evidencia, registrá el bloqueo. Cerrá sin polling. La revisión no acredita progreso de código.")
    payload["body"]["supervision"].update(purpose="visual_review", visual_review=review,
        original_root=supervisor.state.get("progress_pause_binding", {}).get("root"))
    supervisor.state["roots"][day] = supervisor.state["roots"].get(day, 0) + 1
    budgets[day] = budgets.get(day, 0) + 1
    requests[cohort] = {"at": supervisor.now, "key": key, "status": "reserved"}
    supervisor.state["active_root"] = {"payload": payload, "baseline": engineering, "purpose": "visual_review",
        "review_cohort": cohort, "reserved_at": supervisor.now}
    supervisor.state["phase"] = "root_reserved"
    supervisor.save()
    supervisor.publish(supervisor.state["active_root"])
    if supervisor.state["active_root"].get("error") in capacity_codes:
        return supervisor.pause(supervisor.state["active_root"]["error"])
    return supervisor.finish("visual_review_requested" if supervisor.state["active_root"].get("message_id") else "root_transport_unknown")


def failed_review_current(engineering: dict, goal: str) -> bool:
    review = engineering.get("qa_review")
    if (engineering.get("goal_sha256") != goal or engineering.get("verified_engineering") is not True
            or engineering.get("verification_source_current") is not True or engineering.get("source_files_match") is not True
            or engineering.get("working_tree_clean") is not True or engineering.get("qa_executed") is not True
            or not {"tests", "snapshot"}.issubset(engineering.get("valid_gates", []))
            or "qa" in engineering.get("valid_gates", []) or not isinstance(review, dict)
            or review.get("goal_sha256") != goal or review.get("source_files") != engineering.get("source_hashes")
            or engineering.get("gate_rejections", {}).get("qa") != "independent_visual_review_failed"
            or not re.fullmatch(r"[a-f0-9]{64}", str(review.get("cohort_sha256", "")))
            or not re.fullmatch(r"[a-f0-9]{40,64}", str(review.get("source_commit", "")))):
        return False
    verdict = review.get("verdict")
    if (not isinstance(verdict, dict) or verdict.get("validated") is not True or verdict.get("performed") is not True
            or verdict.get("outcome") != "failed" or not isinstance(verdict.get("author"), str) or not verdict["author"].strip()
            or not isinstance(verdict.get("reviewer"), str) or not verdict["reviewer"].strip()
            or verdict["author"] == verdict["reviewer"] or not isinstance(verdict.get("notes"), str)):
        return False
    artifacts = review.get("artifacts")
    if (not isinstance(artifacts, list) or not 1 <= len(artifacts) <= 20
            or any(not isinstance(artifact, dict) or not isinstance(artifact.get("path"), str) or not artifact["path"]
                   or not re.fullmatch(r"[a-f0-9]{64}", str(artifact.get("sha256", ""))) for artifact in artifacts)):
        return False
    screenshots, observations = review.get("screenshots"), verdict.get("observations")
    if (not isinstance(screenshots, list) or not 1 <= len(screenshots) <= 100
            or not isinstance(observations, list) or len(observations) != len(screenshots)):
        return False
    captures, inspected = {}, {}
    for entries, target in ((screenshots, captures), (observations, inspected)):
        for entry in entries:
            if (not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not entry["path"]
                    or entry["path"] in target or not re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256", "")))):
                return False
            if target is inspected and (not isinstance(entry.get("observations"), str) or not entry["observations"].strip()):
                return False
            target[entry["path"]] = entry["sha256"]
    return captures == inspected


def request_qa_remediation(supervisor, engineering: dict, runtime: dict, state_tools, capacity_codes, root_text: str) -> dict | None:
    state, config, now = supervisor.state, supervisor.config, supervisor.now
    if (state.get("active_root") or state.get("phase") not in {"observing", "waiting_visual_review", "circuit_paused"}
            or (state.get("phase") == "circuit_paused" and state.get("pause_reason") not in
                {"no_measured_progress", "no_new_progress", "visual_review_failed"})
            or not failed_review_current(engineering, config["goal_sha256"])):
        return None
    review, day = engineering["qa_review"], state_tools.utc_day(now)
    token = state_tools.digest(state_tools.canonical({"goal_sha256": config["goal_sha256"], "cohort_sha256": review["cohort_sha256"]}))
    ledger = state.setdefault("qa_remediation_requests", {})
    if token in ledger:
        return supervisor.finish("no_measured_progress" if ledger[token].get("outcome") == "no_measured_progress"
                                 else "qa_remediation_already_attempted")
    if (runtime.get("active") != 0 or runtime.get("ready") is not True
            or not isinstance(runtime.get("observed_at"), (int, float)) or abs(now - runtime["observed_at"]) > 30):
        return supervisor.finish("qa_remediation_runtime_pending")
    state.setdefault("idle_since", now)
    if (now - state["idle_since"] < config["idle_seconds"]
            or (isinstance(runtime.get("last_activity_at"), (int, float)) and now - runtime["last_activity_at"] < config["idle_seconds"])):
        return supervisor.finish("idle_observation")
    if now < max(state.get("cooldown_until", 0), state.get("backoff_until", 0)):
        return supervisor.finish("cooldown")
    if state["roots"].get(day, 0) >= config["root_limit"]:
        return supervisor.finish("root_fuel_exhausted")
    deferred = supervisor.refresh_before_post()
    if deferred is not None:
        return deferred
    key = "praxis-qa-remediation:" + config["goal_sha256"] + ":" + review["cohort_sha256"]
    payload = supervisor.payload(key, root_text + " Esta raíz de reparación atiende un verdict QA fallido vigente. "
        "El operador coordina la corrección e integración; Perseo y Teseo desarrollan con ownership disjunto. "
        "Usá qa_remediation_failure como datos de observación y comprobá los defectos contra las fuentes actuales. "
        "Renová pruebas, capturas y revisión independiente real del corte corregido. El verdict fallido permanece sin aprobación.")
    verdict = review["verdict"]
    failure = {field: copy.deepcopy(review[field]) for field in
               ("goal_sha256", "cohort_sha256", "source_commit", "source_files", "artifacts", "screenshots")}
    failure["verdict"] = {field: verdict[field] for field in ("outcome", "performed", "validated", "author", "reviewer")}
    failure["verdict"].update(notes=verdict["notes"][:2000], observations=[
        {"path": entry["path"], "sha256": entry["sha256"], "observations": entry["observations"][:400]}
        for entry in verdict["observations"]])
    payload["body"]["supervision"].update(purpose="qa_remediation", qa_remediation_failure=failure,
        original_root=state.get("progress_pause_binding", {}).get("root"))
    finished, binding = state.get("last_finished", {}), state.get("progress_pause_binding", {})
    if binding.get("root") and binding["root"] == finished.get("root"):
        state["qa_remediation_original_finished"] = {"root": finished["root"], "binding": copy.deepcopy(finished.get("binding", {}))}
    state["roots"][day] = state["roots"].get(day, 0) + 1
    ledger[token] = {"key": key, "goal_sha256": config["goal_sha256"], "cohort_sha256": review["cohort_sha256"],
        "source_commit": review["source_commit"], "at": now, "status": "reserved"}
    state["continuation_earned"], state["auth_retry_earned"] = False, False
    state.pop("earned_continuation_origin", None)
    held = state.get("review_held_continuation", {})
    if held.get("status") in {"held", "restored"}:
        held.update(status="consumed", consumed_at=now, consumed_by=key)
    state["active_root"] = {"payload": payload, "baseline": engineering, "purpose": "qa_remediation",
        "remediation_token": token, "review_cohort": review["cohort_sha256"], "reserved_at": now}
    state["phase"] = "root_reserved"
    supervisor.save()
    supervisor.publish(state["active_root"])
    if state["active_root"].get("error") in capacity_codes:
        return supervisor.pause(state["active_root"]["error"])
    return supervisor.finish("qa_remediation_requested" if state["active_root"].get("message_id") else "root_transport_unknown")
