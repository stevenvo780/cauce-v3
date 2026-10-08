from __future__ import annotations

import http.client
import json
import pathlib
import ssl
import time
from urllib.parse import urlsplit


class ProbeError(ValueError):
    pass


def request(origin: str, context: ssl.SSLContext, method: str, endpoint: str, phase: str, body=None):
    url = urlsplit(origin)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ProbeError("probe transport is not verified TLS")
    connection = http.client.HTTPSConnection(url.hostname, url.port, context=context, timeout=10)
    try:
        encoded = None if body is None else json.dumps(body).encode()
        headers = {"x-cauce-bootstrap-phase": phase}
        if encoded is not None:
            headers["content-type"] = "application/json"
        connection.request(method, endpoint, body=encoded, headers=headers)
        response = connection.getresponse()
        limit = 262144 if endpoint.startswith("/v3/bootstrap/profile?") else 16384
        raw = response.read(limit + 1)
        if len(raw) > limit or response.status not in {200, 201}:
            raise ProbeError("probe response is unavailable")
        return json.loads(raw)
    finally:
        connection.close()


def credential_context(packet: dict, phase: str) -> ssl.SSLContext:
    agent = packet["agent"]
    view = pathlib.Path(agent["state_directory"]) / ".cauce-credentials" / phase
    if agent.get("runtime_mode") == "container":
        view = pathlib.Path("/run/cauce-credentials") / agent["runtime_key"] / phase
    context = ssl.create_default_context(cafile=str(view / "ca.crt"))
    context.load_cert_chain(str(view / "agent.crt"), str(view / "agent.key"))
    return context


def probe(packet: dict) -> dict:
    phase = packet.get("phase", "bootstrap")
    if phase not in {"bootstrap", "normal"}:
        raise ProbeError("invalid phase")
    origin = packet["transport"]["bootstrap_url" if phase == "bootstrap" else "gateway_url"]
    context = credential_context(packet, phase)
    query = "/v3/bootstrap/profile?operation_id=" + packet["operation_id"]
    profile = request(origin, context, "GET", query, phase)
    expected = {field: packet["agent"][field] for field in ("tenant_id", "alias", "runtime_key", "harness_id")}
    expected.update(
        operation_id=packet["operation_id"],
        phase=phase,
        account_id=packet["account_id"],
        model_id=packet["agent"].get("model_id"),
    )
    if (
        any(profile.get(key) != value for key, value in expected.items())
        or type(profile.get("profile_revision")) is not int
        or profile["profile_revision"] <= 0
    ):
        raise ProbeError("profile identity changed")
    create = {
        "operation_id": packet["operation_id"],
        "phase": phase,
        "action": packet["step"],
        "nonce": packet["nonce"],
        "account_id": packet["account_id"],
        "profile_revision": profile["profile_revision"],
    }
    receipt = request(origin, context, "POST", "/v3/bootstrap/probes", phase, create)
    descriptor = receipt.get("probe")
    if not isinstance(descriptor, dict) or any(
        descriptor.get(key) != value for key, value in {**expected, **create}.items()
    ):
        raise ProbeError("probe identity changed")
    deadline = time.monotonic() + 40
    endpoint = "/v3/bootstrap/probes/" + descriptor["probe_id"]
    while receipt.get("state") != "succeeded" and time.monotonic() < deadline:
        time.sleep(0.2)
        receipt = request(origin, context, "GET", endpoint, phase)
        if receipt.get("probe") != descriptor:
            raise ProbeError("probe descriptor changed")
    proof = receipt.get("proof")
    if receipt.get("state") != "succeeded" or not isinstance(proof, dict):
        raise ProbeError("runtime did not acknowledge the probe")
    fields = {key: value for key, value in expected.items() if key not in {"tenant_id", "alias"}}
    fields.update(
        nonce=packet["nonce"], profile_revision=profile["profile_revision"], documents=descriptor["documents"]
    )
    if any(proof.get(key) != value for key, value in fields.items()):
        raise ProbeError("runtime proof changed")
    if packet["step"] == "profile":
        if proof.get("harness_started") is not False or proof.get("reply") is not None:
            raise ProbeError("profile proof is not a document acknowledgement")
        return {"profile_verified": True}
    if proof.get("harness_started") is not True or proof.get("reply") != "CAUCE_BOOTSTRAP_" + packet["nonce"]:
        raise ProbeError("runtime did not demonstrate the provider roundtrip")
    return {"profile_verified": True, "provider_verified": True, "bootstrap_verified": True, "roundtrip_verified": True}
