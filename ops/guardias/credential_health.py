from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
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
