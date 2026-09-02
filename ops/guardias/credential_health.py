from __future__ import annotations

import json
import math
import subprocess
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

REFRESHABLE = "refreshable"
LONG_LIVED = "long_lived"
UNREFRESHABLE = "unrefreshable"
UNKNOWN_EXPIRY = "unknown_expiry"


@dataclass(frozen=True)
class CredentialHealth:
    fingerprint: str | None
    state: str
    hours_until_expiry: float | None
    problem: bool

    @property
    def operational_state(self) -> str:
        if self.state == LONG_LIVED:
            return "TOKEN-LARGO"
        if self.problem:
            return "MUERTO"
        return "OK"


@dataclass(frozen=True)
class CredentialPolicy:
    expiry_key: str
    long_lived_after_hours: float
    unknown_expiry_is_problem: bool


FLEET_GUARD_POLICY = CredentialPolicy(
    expiry_key="expiresAt",
    long_lived_after_hours=720,
    unknown_expiry_is_problem=True,
)
DOCTOR_POLICY = CredentialPolicy(
    expiry_key="exp",
    long_lived_after_hours=168,
    unknown_expiry_is_problem=False,
)


def hours_until_expiry(expires_at: object, *, now_epoch: float) -> float | None:
    if isinstance(expires_at, bool):
        return None
    if isinstance(expires_at, str):
        try:
            expiry = float(expires_at.strip())
        except ValueError:
            return None
    elif isinstance(expires_at, (int, float)):
        expiry = float(expires_at)
    else:
        return None
    current = float(now_epoch)
    if not math.isfinite(expiry) or not math.isfinite(current) or expiry <= 0:
        return None
    if expiry > 100_000_000_000:
        expiry /= 1_000
    return (expiry - current) / 3_600


def classify_credential(
    fingerprint: str | None,
    expires_at: object,
    *,
    now_epoch: float,
    long_lived_after_hours: float,
    unknown_expiry_is_problem: bool,
) -> CredentialHealth:
    fingerprint = fingerprint if isinstance(fingerprint, str) and fingerprint else None
    hours = hours_until_expiry(expires_at, now_epoch=now_epoch)
    if fingerprint:
        return CredentialHealth(fingerprint, REFRESHABLE, hours, False)
    if hours is None:
        return CredentialHealth(None, UNKNOWN_EXPIRY, None, unknown_expiry_is_problem)
    if hours > long_lived_after_hours:
        return CredentialHealth(None, LONG_LIVED, hours, False)
    return CredentialHealth(None, UNREFRESHABLE, hours, True)


def classify_credential_record(
    record: Mapping[str, object],
    *,
    now_epoch: float,
    policy: CredentialPolicy,
) -> CredentialHealth:
    return classify_credential(
        record.get("huella"),
        record.get(policy.expiry_key),
        now_epoch=now_epoch,
        long_lived_after_hours=policy.long_lived_after_hours,
        unknown_expiry_is_problem=policy.unknown_expiry_is_problem,
    )


def classify_fleet_guard_record(
    record: Mapping[str, object], *, now_epoch: float
) -> CredentialHealth:
    return classify_credential_record(record, now_epoch=now_epoch, policy=FLEET_GUARD_POLICY)


def classify_doctor_record(
    record: Mapping[str, object], *, now_epoch: float
) -> CredentialHealth:
    return classify_credential_record(record, now_epoch=now_epoch, policy=DOCTOR_POLICY)


def shared_fingerprints(
    observations: Iterable[tuple[str, str, str]],
) -> dict[str, list[str]]:
    containers: dict[str, set[str]] = {}
    subjects: dict[str, list[str]] = {}
    for fingerprint, subject, container in observations:
        containers.setdefault(fingerprint, set()).add(container)
        grouped_subjects = subjects.setdefault(fingerprint, [])
        if subject not in grouped_subjects:
            grouped_subjects.append(subject)
    return {
        fingerprint: subjects[fingerprint]
        for fingerprint, locations in containers.items()
        if len(locations) > 1
    }


CREDENTIAL_PROBE_SOURCE = r'''
import json,io,os,sys,hashlib
p=sys.argv[1]
if not os.path.exists(p):
    print(json.dumps({"falta":True})); raise SystemExit
d=json.load(io.open(p,encoding="utf-8"))
o=d.get("claudeAiOauth") or d.get("tokens") or d
rt=o.get("refreshToken") or o.get("refresh_token") or ""
at=o.get("accessToken") or o.get("access_token") or ""
print(json.dumps({
  "huella": hashlib.sha256(rt.encode()).hexdigest()[:10] if rt else None,
  "huella_acc": hashlib.sha256(at.encode()).hexdigest()[:10] if at else None,
  "expiresAt": o.get("expiresAt") or o.get("expires_at"),
  "last_refresh": d.get("last_refresh"),
  "at_len": len(at)}))
'''


def probe_container(container: str, path: str, *, timeout: float = 25, docker: Sequence[str] = ("docker",)) -> dict:
    """Read one credential file inside a container without ever printing the secret.

    The probe emits fingerprints, lengths and expiry only, so every consumer can classify the
    credential while the token itself never leaves the container. Shapes returned, which are the
    ones the guards already handle: {"falta": True} when the file is absent, {"error": <=60 chars}
    when the probe could not run or its output could not be parsed, otherwise the parsed record.
    """
    command = [*docker, "exec", container, "python3", "-c", CREDENTIAL_PROBE_SOURCE, path]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        if completed.returncode != 0:
            return {"error": (completed.stderr or "").strip()[:60] or f"rc={completed.returncode}"}
        return json.loads(completed.stdout.strip().splitlines()[-1])
    except Exception as error:
        return {"error": f"{type(error).__name__}: {str(error)[:50]}"}
