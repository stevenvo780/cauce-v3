#!/usr/bin/env python3
"""Tests for the second, independent ticket check in ops/pty-agent/cauce_pty_agent.py.

The relay already verified the ticket before forwarding OPEN; the agent verifies it again with the
per-alias key that only exists inside the container. These tests pin the golden ticket the gateway
must be able to produce, and then walk every refusal: expired, wrong alias (by target and by
signing key), wrong container generation, tampered HMAC and a replayed session id.

The root refusal (euid 0 => exit 78) lives here too: it is the same fail-closed boundary.

Runs standalone (`python3 ops/pty-agent/tests/test_ticket.py`) or under
`python3 -m unittest discover ops/pty-agent/tests`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import pathlib
import sys
import unittest
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402

# Golden vector: the key derived for Steven/jarvis from the documented master, and a ticket the
# gateway signed with it. Byte-for-byte identical across the gateway, the relay and this agent.
ALIAS_KEY_HEX = "33ab99cc766ee43031f9c22b8db78aeae5b04bc0ebedddfe8539330af7233efa"
ALIAS_KEY = bytes.fromhex(ALIAS_KEY_HEX)
GOLDEN_TICKET = (
    "v1.eyJ2IjoxLCJzaWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJvcCI6InVuYXR0cmli"
    "dXRlZDpjb25zb2xlLWJhc2ljLWF1dGgiLCJzdWIiOiJTdGV2ZW46a2FudCIsInRndCI6eyJ0ZW5hbnQiOiJTdGV2ZW4i"
    "LCJhbGlhcyI6ImphcnZpcyIsImNvbnRhaW5lciI6ImNsYXciLCJnZW5lcmF0aW9uIjoiZ2VuLTEiLCJpbWFnZSI6InNo"
    "YTI1NjpkZWFkYmVlZiIsInVpZCI6MTAwMCwidXNlciI6ImNsYXcifSwibW9kZSI6InNoZWxsIiwiaWF0IjoxNzUwMDAw"
    "MDAwLCJleHAiOjE3NTAwMDAwMzB9."
    "034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY"
)
SESSION = "11111111-2222-3333-4444-555555555555"
NOW = 1750000000.0
IDENTITY = {
    "tenant_id": "Steven",
    "alias": "jarvis",
    "container_id": "claw",
    "generation": "gen-1",
    "runtime_uid": 1000,
}


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def noncanonical_encoding_of_same_bytes(encoded: str) -> str:
    expected = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    for final_character in alphabet:
        candidate = encoded[:-1] + final_character
        if candidate == encoded:
            continue
        decoded = base64.urlsafe_b64decode(candidate + "=" * (-len(candidate) % 4))
        if decoded == expected:
            return candidate
    raise AssertionError("fixture has no alternate non-canonical base64url spelling")


def mint(payload: dict, key: bytes = ALIAS_KEY) -> str:
    encoded = b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(key, ("v1." + encoded).encode("ascii"), hashlib.sha256).digest()
    return f"v1.{encoded}.{b64url(signature)}"


def payload(**overrides) -> dict:
    target = {
        "tenant": "Steven", "alias": "jarvis", "container": "claw", "generation": "gen-1",
        "image": "sha256:deadbeef", "uid": 1000, "user": "claw",
    }
    target.update(overrides.pop("tgt", {}))
    document = {
        "v": 1, "sid": SESSION, "op": "unattributed:console-basic-auth", "sub": "Steven:kant",
        "tgt": target, "mode": "shell", "iat": 1750000000, "exp": 1750000030,
    }
    document.update(overrides)
    return document


class GoldenTicketTests(unittest.TestCase):
    def test_the_golden_ticket_verifies_and_authorizes(self) -> None:
        claims = agent.verify_ticket(ALIAS_KEY, GOLDEN_TICKET, NOW)
        self.assertEqual(claims["sid"], SESSION)
        self.assertEqual(claims["tgt"]["alias"], "jarvis")
        self.assertEqual(agent.authorize_ticket(claims, IDENTITY, SESSION), "shell")

    def test_the_golden_ticket_is_reproducible_from_its_claims(self) -> None:
        claims = agent.verify_ticket(ALIAS_KEY, GOLDEN_TICKET, NOW)
        encoded = GOLDEN_TICKET.split(".")[1]
        self.assertEqual(json.loads(agent.b64url_decode(encoded).decode("utf-8")), claims)


class RefusalTests(unittest.TestCase):
    def _reason(self, ticket: str, now: float = NOW, identity: dict | None = None) -> str:
        try:
            claims = agent.verify_ticket(ALIAS_KEY, ticket, now)
            agent.authorize_ticket(claims, identity or IDENTITY, SESSION)
        except agent.TicketError as error:
            return error.reason
        return "accepted"

    def test_an_expired_ticket_is_refused(self) -> None:
        # 5 s of tolerance is allowed, so the refusal is asserted one second past it.
        self.assertEqual(self._reason(GOLDEN_TICKET, now=1750000036.0), "ticket_expired")

    def test_a_ticket_inside_the_skew_window_still_verifies(self) -> None:
        self.assertEqual(self._reason(GOLDEN_TICKET, now=1750000034.0), "accepted")

    def test_a_ticket_for_another_alias_is_refused(self) -> None:
        ticket = mint(payload(tgt={"alias": "kant"}))
        self.assertEqual(self._reason(ticket), "target_mismatch")

    def test_a_ticket_signed_with_another_alias_key_is_refused(self) -> None:
        other = bytes.fromhex("11" * 32)
        self.assertEqual(self._reason(mint(payload(), key=other)), "ticket_bad_signature")

    def test_a_ticket_for_another_tenant_is_refused(self) -> None:
        self.assertEqual(self._reason(mint(payload(tgt={"tenant": "Miguel"}))), "target_mismatch")

    def test_a_ticket_for_another_generation_is_refused(self) -> None:
        # The container restarted between issue and use: every outstanding ticket dies with it.
        self.assertEqual(self._reason(mint(payload(tgt={"generation": "gen-2"}))), "target_mismatch")

    def test_a_ticket_for_another_container_is_refused(self) -> None:
        self.assertEqual(self._reason(mint(payload(tgt={"container": "ctrl-infra"}))), "target_mismatch")

    def test_a_ticket_for_another_uid_is_refused(self) -> None:
        self.assertEqual(self._reason(mint(payload(tgt={"uid": 0}))), "target_mismatch")

    def test_a_tampered_hmac_is_refused(self) -> None:
        head, body, signature = GOLDEN_TICKET.split(".")
        flipped = ("A" if signature[0] != "A" else "B") + signature[1:]
        self.assertEqual(self._reason(f"{head}.{body}.{flipped}"), "ticket_bad_signature")

    def test_a_noncanonical_hmac_spelling_is_refused(self) -> None:
        head, body, signature = GOLDEN_TICKET.split(".")
        alternate = noncanonical_encoding_of_same_bytes(signature)
        self.assertEqual(
            base64.urlsafe_b64decode(alternate + "=" * (-len(alternate) % 4)),
            base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)),
        )
        self.assertEqual(self._reason(f"{head}.{body}.{alternate}"), "ticket_bad_signature")

    def test_a_tampered_payload_is_refused(self) -> None:
        head, _, signature = GOLDEN_TICKET.split(".")
        forged = b64url(json.dumps(payload(tgt={"alias": "kant"}), separators=(",", ":")).encode("utf-8"))
        self.assertEqual(self._reason(f"{head}.{forged}.{signature}"), "ticket_bad_signature")

    def test_a_ticket_bound_to_another_session_is_refused(self) -> None:
        ticket = mint(payload(sid="99999999-2222-3333-4444-555555555555"))
        self.assertEqual(self._reason(ticket), "session_mismatch")

    def test_a_malformed_ticket_is_refused(self) -> None:
        for ticket in ("", "v1.", "v2.abc.def", "not-a-ticket", GOLDEN_TICKET.replace("v1.", "v9.", 1)):
            self.assertEqual(self._reason(ticket), "ticket_malformed", ticket)

    def test_a_ticket_without_an_expiry_is_refused(self) -> None:
        claims = payload()
        del claims["exp"]
        self.assertEqual(self._reason(mint(claims)), "ticket_malformed")

    def test_an_unknown_mode_is_refused(self) -> None:
        self.assertEqual(self._reason(mint(payload(mode="rootshell"))), "mode_unknown")


class RootRefusalTests(unittest.TestCase):
    def test_the_agent_refuses_to_run_as_root_with_exit_78(self) -> None:
        # The PTY must always be the mapped runtime user. A root euid means the launcher or the
        # unit was tampered with, so the agent stops before it can touch the network.
        with mock.patch.object(agent.os, "geteuid", return_value=0):
            with self.assertRaises(SystemExit) as raised:
                agent.assert_not_root()
        self.assertEqual(raised.exception.code, agent.PERMANENT_EXIT)
        self.assertEqual(agent.PERMANENT_EXIT, 78)

    def test_main_refuses_before_it_reads_the_bundle(self) -> None:
        with mock.patch.object(agent.os, "geteuid", return_value=0), \
                mock.patch.object(agent, "load_bundle", side_effect=AssertionError("bundle was read as root")):
            with self.assertRaises(SystemExit) as raised:
                agent.main(["--bundle", "/var/tmp/.cauce-pty-bundle-jarvis.json"])
        self.assertEqual(raised.exception.code, agent.PERMANENT_EXIT)

    def test_a_bundle_declaring_a_root_runtime_identity_is_refused(self) -> None:
        document = _bundle(runtime_uid=0)
        with self.assertRaises(agent.PermanentError):
            agent.validate_bundle(document)


class BundleTests(unittest.TestCase):
    def test_a_well_formed_bundle_is_accepted(self) -> None:
        document = agent.validate_bundle(_bundle())
        self.assertEqual(document["shell_candidates"], [["/bin/bash", "-l"], ["/bin/sh", "-l"]])
        self.assertIsNone(document["harness_command"])

    def test_a_relative_shell_candidate_is_refused(self) -> None:
        with self.assertRaises(agent.PermanentError):
            agent.validate_bundle(_bundle(shell_candidates=[["bash", "-l"]]))

    def test_a_short_alias_key_is_refused(self) -> None:
        with self.assertRaises(agent.PermanentError):
            agent.validate_bundle(_bundle(alias_key_hex="00" * 16))

    def test_a_harness_command_enables_the_harness_mode(self) -> None:
        document = agent.validate_bundle(_bundle(harness_command=["/usr/local/bin/openclaw", "attach"]))
        self.assertEqual(document["harness_command"], ["/usr/local/bin/openclaw", "attach"])


def _bundle(**overrides) -> dict:
    document = {
        "tenant_id": "Steven", "alias": "jarvis", "container_id": "claw", "generation": "gen-1",
        "image_id": "sha256:deadbeef", "runtime_user": "claw", "runtime_uid": 1000, "runtime_gid": 1000,
        "home": "/home/claw", "shell_candidates": [["/bin/bash", "-l"], ["/bin/sh", "-l"]],
        "harness_command": None, "harness": "openclaw", "relay_host": "100.64.0.6", "relay_port": 8445,
        "alias_key_hex": ALIAS_KEY_HEX, "client_cert_pem": "-----BEGIN CERTIFICATE-----\n",
        "client_key_pem": "-----BEGIN PRIVATE KEY-----\n", "ca_pem": "-----BEGIN CERTIFICATE-----\n",
        "agent_version": "1",
    }
    document.update(overrides)
    return document


if __name__ == "__main__":
    unittest.main()
