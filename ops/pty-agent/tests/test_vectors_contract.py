#!/usr/bin/env python3
"""Camina TODOS los vectores de tests/terminal-pty/vectors.json por el código del propio agente.

vectors.json es el contrato del canal PTY; la consola, el gateway y el relay lo reproducen en
TypeScript y este agente en Python. Si sólo la mitad TypeScript lo comprueba, una divergencia del
agente llega a producción en verde. Aquí cada caso se ejecuta contra `cauce_pty_agent`
(encode_frame/encode_data/decode_data/FrameDecoder, verify_ticket/authorize_ticket y los
manejadores de gobierno) y contra `derive-alias-key.py`.

Reglas de este fichero:
  - Un `kind` desconocido FALLA la prueba. Saltarlo en silencio es exactamente el fallo que este
    fichero existe para impedir.
  - Un caso `must_fail` afirma el TIPO de excepción y el motivo exacto, no «algo lanzó».
  - Cuando el agente es deliberadamente más laxo que el vector (no mira `iat`, tolera CLOCK_SKEW,
    no conoce la lista de modos anunciada), la diferencia se declara en una tabla explícita en vez
    de silenciarse.

Corre suelto (`python3 ops/pty-agent/tests/test_vectors_contract.py`) o bajo
`python3 -m unittest discover -s ops/pty-agent`.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
VECTORS_PATH = REPO_ROOT / "tests" / "terminal-pty" / "vectors.json"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402


def _load_hyphenated(name: str, filename: str):
    """`derive-alias-key.py` no es importable por nombre: el guion no es un identificador."""
    spec = importlib.util.spec_from_file_location(name, AGENT_DIR / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


derive = _load_hyphenated("derive_alias_key", "derive-alias-key.py")

VECTORS: dict[str, Any] = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
CASES: list[dict[str, Any]] = VECTORS["cases"]
TAGS: dict[str, int] = VECTORS["framing"]["tags"]
TAG_NAMES: dict[int, str] = {value: name for name, value in TAGS.items()}

DERIVE_FAILURES = {
    "bad_master_key": (ValueError, "the master key must be exactly 32 bytes"),
}

FRAME_FAILURES = {
    "frame_too_large": (agent.ProtocolError, (
        "data chunk exceeds the per-frame maximum",
        "peer announced a frame above the negotiated maximum",
    )),
    "bad_data_frame": (agent.ProtocolError, ("data frame is shorter than its session prefix",)),
}

VERIFY_STAGE = {
    "bad_signature": ("verify", "ticket_bad_signature", ""),
    "bad_b64": ("verify", "ticket_malformed", ""),
    "malformed": ("verify", "ticket_malformed", ""),
    "unsupported_version": ("verify", "ticket_malformed", ""),
    "ticket_expired": ("verify_within_skew", "ticket_expired", ""),
    "sid_mismatch": ("authorize", "session_mismatch", ""),
    "tenant_mismatch": ("authorize", "target_mismatch", "tgt.tenant"),
    "alias_mismatch": ("authorize", "target_mismatch", "tgt.alias"),
    "ticket_not_yet_valid": ("not_enforced", "", "the agent does not read iat; the relay window does"),
    "mode_not_allowed": ("not_enforced", "", "the agent checks MODES, not the modes advertised in the hello"),
}

# harness -> (segmentos bajo HOME, hecho de runtime que el gateway espeja, hoja de la memoria).
HARNESS_ROOTS = {
    "claude": ((".claude",), "claude_config_dir", "projects"),
    "codex": ((".codex",), "codex_home", "memories"),
    "openclaw": ((".openclaw", "workspace"), "openclaw_workspace", "memory"),
}


def setUpModule() -> None:
    kinds = sorted({case["kind"] for case in CASES})
    print(
        f"vectors contract: {len(CASES)} casos, {len(kinds)} kinds ({', '.join(kinds)}) "
        f"desde {VECTORS_PATH.relative_to(REPO_ROOT)}",
        file=sys.stderr,
    )


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def tag_of(name: Any) -> int:
    if isinstance(name, int):
        return name
    tag = TAGS.get(str(name))
    if tag is None:
        raise AssertionError(f"vectors.json names a tag it does not declare: {name}")
    return tag


def payload_bytes(spec: dict[str, Any]) -> bytes:
    if "data_utf8" in spec:
        return str(spec["data_utf8"]).encode("utf-8")
    if "data_hex" in spec:
        return bytes.fromhex(str(spec["data_hex"]))
    if "fill" in spec:
        return bytes([int(spec["fill"]["byte"])]) * int(spec["fill"]["count"])
    return b""


def content_of(spec: dict[str, Any]) -> bytes:
    return str(spec["text"]).encode("utf-8")


def chunks_of(content: bytes) -> list[bytes]:
    return [content[offset:offset + agent.MAX_DATA] for offset in range(0, len(content), agent.MAX_DATA)]


def make_agent(home: str, harness: str) -> tuple[agent.PtyAgent, str]:
    segments, fact, _memory = HARNESS_ROOTS[harness]
    root = os.path.join(home, *segments)
    os.makedirs(root, exist_ok=True)
    instance = agent.PtyAgent.__new__(agent.PtyAgent)
    instance.bundle = {"home": home, "harness": harness, "runtime_facts": {fact: root}}
    instance.pending_writes = {}
    instance.pending_write_batches = {}
    instance.outbound = bytearray()
    return instance, root


def drain(instance: agent.PtyAgent) -> list[tuple[int, bytes]]:
    frames = agent.FrameDecoder().feed(bytes(instance.outbound))
    instance.outbound.clear()
    return frames


def body_of(frame: tuple[int, bytes]) -> dict[str, Any]:
    return json.loads(frame[1].decode("utf-8"))


class VectorFileTests(unittest.TestCase):
    def test_the_file_is_still_the_frozen_contract(self) -> None:
        self.assertEqual(VECTORS["contract"], "cauce-v3/pty-wire/v1")
        self.assertTrue(VECTORS["frozen"])
        self.assertGreaterEqual(len(CASES), 57)

    def test_every_case_has_a_unique_name_and_an_explicit_must_fail(self) -> None:
        names = [case["name"] for case in CASES]
        self.assertEqual(len(names), len(set(names)))
        for case in CASES:
            self.assertIsInstance(case["kind"], str, case["name"])
            self.assertIsInstance(case["must_fail"], bool, case["name"])

    def test_the_framing_block_matches_the_agent_tags(self) -> None:
        """En LOS DOS SENTIDOS: un tag que el agente pone en el cable y el fichero no declara es
        justo el que a otra pata se le olvida implementar."""
        for name, value in TAGS.items():
            self.assertEqual(getattr(agent, f"TAG_{name}"), value, name)
        agent_tags = {
            name[len("TAG_"):]: getattr(agent, name)
            for name in dir(agent) if name.startswith("TAG_")
        }
        self.assertEqual(agent_tags, TAGS)
        self.assertEqual(VECTORS["framing"]["max_payload"], agent.MAX_FRAME)
        self.assertEqual(VECTORS["framing"]["session_id_bytes"], agent.SESSION_ID_BYTES)

    def test_the_prefixed_tags_are_the_ones_the_agent_prefixes(self) -> None:
        """Sin filtrar por lo que el vector declara: filtrar convertiría el hueco en un pase."""
        declared = {tag_of(name) for name in VECTORS["framing"]["prefixed_tags"]}
        self.assertEqual(declared, set(agent.PREFIXED_TAGS))
        self.assertEqual({tag_of(name) for name in ("STDIN", "STDOUT", "TERMINAL_RESPONSE")},
                         set(agent.DATA_TAGS))

    def test_the_geometry_block_is_the_agent_clamp(self) -> None:
        geometry = VECTORS["geometry"]
        self.assertEqual(geometry["min_cols"], agent.MIN_COLS)
        self.assertEqual(geometry["max_cols"], agent.MAX_COLS)
        self.assertEqual(geometry["min_rows"], agent.MIN_ROWS)
        self.assertEqual(geometry["max_rows"], agent.MAX_ROWS)

    def test_the_limits_block_is_copied_from_the_agent_constants(self) -> None:
        limits = VECTORS["limits"]
        for key, constant in (
            ("max_frame", "MAX_FRAME"), ("session_id_bytes", "SESSION_ID_BYTES"),
            ("max_data", "MAX_DATA"), ("session_high_water", "SESSION_HIGH_WATER"),
            ("session_input_high_water", "SESSION_INPUT_HIGH_WATER"),
            ("outbound_high_water", "OUTBOUND_HIGH_WATER"),
            ("max_document_bytes", "MAX_DOCUMENT_BYTES"),
            ("max_write_transactions", "MAX_WRITE_TRANSACTIONS"),
            ("max_write_batch_files", "MAX_WRITE_BATCH_FILES"),
            ("max_dir_entries", "MAX_DIR_ENTRIES"), ("max_dir_depth", "MAX_DIR_DEPTH"),
            ("dir_scan_cap", "DIR_SCAN_CAP"), ("read_index_budget", "READ_INDEX_BUDGET"),
        ):
            self.assertEqual(limits[key], getattr(agent, constant), key)

    def test_the_ttl_block_is_copied_from_the_agent_deadlines(self) -> None:
        ttls = VECTORS["ttls"]
        self.assertEqual(ttls["ping_timeout_seconds"], agent.PING_TIMEOUT)
        self.assertEqual(ttls["hello_timeout_seconds"], agent.HELLO_TIMEOUT)
        self.assertEqual(ttls["tombstone_seconds"], agent.TOMBSTONE_SECONDS)
        self.assertGreater(ttls["session_ttl_seconds"], ttls["idle_timeout_seconds"])


class VectorWalkTests(unittest.TestCase):
    """Un método por kind. `test_every_case_is_walked` impide que un kind nuevo pase inadvertido."""

    def test_every_case_is_walked(self) -> None:
        handled = {
            name[len("_walk_"):] for name in dir(self)
            if name.startswith("_walk_") and callable(getattr(self, name))
        }
        unknown = sorted({case["kind"] for case in CASES} - handled)
        self.assertEqual(unknown, [], f"vectors.json carries kinds nobody walks: {unknown}")
        for case in CASES:
            with self.subTest(case=case["name"], kind=case["kind"]):
                getattr(self, f"_walk_{case['kind']}")(case)

    # -- ticket key derivation ----------------------------------------------------------------

    def _walk_derive_alias_key(self, case: dict[str, Any]) -> None:
        master = base64.b64decode(case["input"]["master_key_b64"])
        tenant, alias = case["input"]["tenant"], case["input"]["alias"]
        if case["must_fail"]:
            reason = case["expected"]["reason"]
            self.assertIn(reason, DERIVE_FAILURES, f"unmapped derive failure {reason}")
            exception, message = DERIVE_FAILURES[reason]
            with self.assertRaises(exception) as caught:
                derive.alias_key(master, tenant, alias)
            self.assertEqual(str(caught.exception), message)
            return
        self.assertEqual(derive.alias_key(master, tenant, alias).hex(), case["expected"]["alias_key_hex"])

    def _walk_canonical_payload(self, case: dict[str, Any]) -> None:
        payload = case["input"]["payload"]
        if case["must_fail"]:
            self.assertEqual(case["expected"]["reason"], "unknown_payload_key")
            frozen = self._frozen_payload_keys()
            self.assertTrue(set(payload) - frozen, "the failing payload carries no unknown key")
            return
        canonical = case["expected"]["payload_json"]
        self.assertEqual(json.loads(canonical), payload)
        self.assertEqual(list(json.loads(canonical)), list(payload))
        encoded = canonical.encode("utf-8")
        self.assertEqual(agent.b64url_decode(b64url(encoded)), encoded)

    def _frozen_payload_keys(self) -> set[str]:
        for case in CASES:
            if case["kind"] == "canonical_payload" and not case["must_fail"]:
                return set(json.loads(case["expected"]["payload_json"]))
        raise AssertionError("no canonical_payload reference case to take the frozen keys from")

    def _walk_mint_ticket(self, case: dict[str, Any]) -> None:
        alias_key = bytes.fromhex(case["input"]["alias_key_hex"])
        payload = case["input"]["payload"]
        ticket = case["expected"]["ticket"]
        verified = agent.verify_ticket(alias_key, ticket, float(payload["iat"]))
        self.assertEqual(verified, payload)
        segment = ticket.split(".")[1]
        self.assertEqual(json.loads(agent.b64url_decode(segment).decode("utf-8")), payload)

    def _walk_verify_ticket(self, case: dict[str, Any]) -> None:
        alias_key = bytes.fromhex(case["input"]["alias_key_hex"])
        ticket = case["input"]["ticket"]
        options = case["input"]["options"]
        now = float(options["now"])
        if case["must_fail"]:
            self._walk_rejected_ticket(case, alias_key, ticket, options, now)
            return
        payload = agent.verify_ticket(alias_key, ticket, now)
        expected = case["expected"]
        self.assertEqual(payload["sid"], expected["sid"])
        self.assertEqual(payload["tgt"]["alias"], expected["alias"])
        self.assertEqual(payload["tgt"]["uid"], expected["uid"])
        self.assertEqual(payload["tgt"]["user"], expected["user"])
        mode = agent.authorize_ticket(payload, self._identity(payload, options), self._session(payload, options))
        self.assertEqual(mode, expected["mode"])
        if expected.get("agent_must_refuse") == "runs_as_root":
            with (mock.patch("os.geteuid", return_value=0), mock.patch("sys.stderr", io.StringIO()),
                  self.assertRaises(SystemExit) as caught):
                agent.assert_not_root()
            self.assertEqual(caught.exception.code, agent.PERMANENT_EXIT)

    def _walk_rejected_ticket(
        self, case: dict[str, Any], alias_key: bytes, ticket: str, options: dict[str, Any], now: float,
    ) -> None:
        reason = case["expected"]["reason"]
        self.assertIn(reason, VERIFY_STAGE, f"unmapped ticket rejection {reason}")
        stage, agent_reason, detail = VERIFY_STAGE[reason]
        if stage == "verify":
            with self.assertRaises(agent.TicketError) as caught:
                agent.verify_ticket(alias_key, ticket, now)
            self.assertEqual(caught.exception.reason, agent_reason)
            return
        if stage == "verify_within_skew":
            payload = self._payload_of(ticket)
            if now > float(payload["exp"]) + agent.CLOCK_SKEW:
                with self.assertRaises(agent.TicketError) as caught:
                    agent.verify_ticket(alias_key, ticket, now)
                self.assertEqual(caught.exception.reason, agent_reason)
                return
            self.assertEqual(agent.verify_ticket(alias_key, ticket, now), payload)
            return
        payload = agent.verify_ticket(alias_key, ticket, now)
        if stage == "not_enforced":
            agent.authorize_ticket(payload, self._identity(payload, options), self._session(payload, options))
            return
        with self.assertRaises(agent.TicketError) as caught:
            agent.authorize_ticket(payload, self._identity(payload, options), self._session(payload, options))
        self.assertEqual(caught.exception.reason, agent_reason)
        self.assertEqual(caught.exception.detail, detail)

    @staticmethod
    def _payload_of(ticket: str) -> dict[str, Any]:
        return json.loads(agent.b64url_decode(ticket.split(".")[1]).decode("utf-8"))

    @staticmethod
    def _identity(payload: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        target = payload.get("tgt", {})
        return {
            "tenant_id": options.get("tenant", target.get("tenant")),
            "alias": options.get("alias", target.get("alias")),
            "container_id": options.get("container_id", target.get("container")),
            "generation": options.get("generation", target.get("generation")),
            "runtime_uid": target.get("uid"),
        }

    @staticmethod
    def _session(payload: dict[str, Any], options: dict[str, Any]) -> str:
        return str(options.get("session_id", payload.get("sid")))

    # -- framing ------------------------------------------------------------------------------

    def _walk_encode_frame(self, case: dict[str, Any]) -> None:
        tag = tag_of(case["input"]["tag"])
        spec = case["input"]["payload"]
        kind = spec["type"]
        if case["must_fail"]:
            exception, messages = self._frame_failure(case)
            with self.assertRaises(exception) as caught:
                self._encode(tag, spec)
            self.assertIn(str(caught.exception), messages)
            return
        frame = self._encode(tag, spec)
        expected = case["expected"]
        if "frame_hex" in expected:
            self.assertEqual(frame.hex(), expected["frame_hex"])
        else:
            self.assertEqual(len(frame), expected["frame_length"])
            self.assertEqual(frame[:5].hex(), expected["header_hex"])
            self.assertEqual(sha(frame), expected["frame_sha256"])
        decoded = agent.FrameDecoder().feed(frame)
        self.assertEqual(len(decoded), 1)
        self.assertEqual(decoded[0][0], tag)
        if kind == "data":
            identifier, data = agent.decode_data(decoded[0][1])
            self.assertEqual(identifier, spec["session_id"])
            self.assertEqual(data, payload_bytes(spec))

    @staticmethod
    def _encode(tag: int, spec: dict[str, Any]) -> bytes:
        if spec["type"] == "data":
            return agent.encode_data(tag, spec["session_id"], payload_bytes(spec))
        if spec["type"] == "json":
            return agent.encode_frame(tag, json.dumps(spec["value"], separators=(",", ":")).encode("utf-8"))
        return agent.encode_frame(tag, b"")

    def _frame_failure(self, case: dict[str, Any]) -> tuple[type[BaseException], tuple[str, ...]]:
        reason = case["expected"]["reason"]
        self.assertIn(reason, FRAME_FAILURES, f"unmapped framing failure {reason}")
        return FRAME_FAILURES[reason]

    def _walk_decode_frame(self, case: dict[str, Any]) -> None:
        raw = bytes.fromhex(case["input"]["frame_hex"])
        if case["must_fail"]:
            exception, messages = self._frame_failure(case)
            with self.assertRaises(exception) as caught:
                frames = agent.FrameDecoder().feed(raw)
                agent.decode_data(frames[0][1])
            self.assertIn(str(caught.exception), messages)
            return
        frames = agent.FrameDecoder().feed(raw)
        self.assertEqual(len(frames), 1)
        tag, payload = frames[0]
        expected = case["expected"]
        self.assertEqual(TAG_NAMES.get(tag, tag), expected["tag"])
        self.assertEqual(tag in TAG_NAMES, expected["known"])
        if not expected["known"]:
            self.assertNotIn(tag, {getattr(agent, f"TAG_{name}") for name in TAGS})
        if "payload_hex" in expected:
            self.assertEqual(payload.hex(), expected["payload_hex"])
        if "session_id" in expected:
            identifier, data = agent.decode_data(payload)
            self.assertEqual(identifier, expected["session_id"])
            self.assertEqual(data.decode("utf-8"), expected["data_utf8"])

    def _walk_decode_stream(self, case: dict[str, Any]) -> None:
        stream = bytes.fromhex(case["input"]["stream_hex"])
        size = int(case["input"]["chunk_size"])
        pieces = [stream] if size <= 0 else [stream[at:at + size] for at in range(0, len(stream), size)]
        decoder = agent.FrameDecoder()
        if case["must_fail"]:
            exception, messages = self._frame_failure(case)
            with self.assertRaises(exception) as caught:
                for piece in pieces:
                    decoder.feed(piece)
            self.assertIn(str(caught.exception), messages)
            return
        collected: list[tuple[int, bytes]] = []
        for piece in pieces:
            collected.extend(decoder.feed(piece))
        expected_frames = case["expected"]["frames"]
        self.assertEqual(len(collected), len(expected_frames))
        for (tag, payload), expected in zip(collected, expected_frames, strict=True):
            self.assertEqual(TAG_NAMES.get(tag, tag), expected["tag"])
            if "session_id" in expected:
                identifier, data = agent.decode_data(payload)
                self.assertEqual(identifier, expected["session_id"])
                self.assertEqual(data.decode("utf-8"), expected["data_utf8"])
            if "payload_hex" in expected:
                self.assertEqual(payload.hex(), expected["payload_hex"])
        self.assertEqual(len(decoder._buffer), case["expected"]["pending"])

    # -- governance ---------------------------------------------------------------------------

    def _sandbox(self, case: dict[str, Any]) -> tuple[agent.PtyAgent, str]:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        home = os.path.realpath(directory.name)
        instance, root = make_agent(home, case["input"]["harness"])
        for seed in case["input"].get("files", []):
            content = (bytes([int(seed["fill"]["byte"])]) * int(seed["fill"]["count"])
                       if "fill" in seed else str(seed["text"]).encode("utf-8"))
            pathlib.Path(os.path.join(root, seed["name"])).write_bytes(content)
        memory_root = pathlib.Path(instance._memory_root_for_harness())
        memory_root.mkdir(parents=True, exist_ok=True)
        for seed in case["input"].get("memory", []):
            target = memory_root / str(seed["name"])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(str(seed["text"]).encode("utf-8"))
        return instance, root

    def _walk_governance_read(self, case: dict[str, Any]) -> None:
        instance, root = self._sandbox(case)
        request = case["input"]["request"]
        path = (instance._memory_root_for_harness() if request["kind"] == "dir"
                else os.path.join(root, request["basename"]))
        instance._on_read({
            "request_id": request["request_id"], "kind": request["kind"], "path": path,
        })
        frames = drain(instance)
        expected = case["expected"]
        self.assertEqual(TAG_NAMES[frames[-1][0]], expected["terminal_tag"])
        if case["must_fail"]:
            self.assertEqual(len(frames), 1)
            body = body_of(frames[0])
            self.assertEqual(body["error"], expected["error"])
            self.assertEqual(body["reason"], expected["reason"])
            return
        head = body_of(frames[0])
        self.assertEqual(TAG_NAMES[frames[0][0]], expected["ok_tag"])
        if request["kind"] == "dir":
            # METADATO y nada mas: READ_OK y READ_DONE, sin un solo READ_DATA con una memoria.
            self.assertEqual(len(frames), 2)
            self.assertEqual(head["path"], path)
            self.assertEqual(head["total"], expected["total"])
            self.assertEqual(head["observed_at_least"], expected["observed_at_least"])
            self.assertEqual(head["truncated"], expected["truncated"])
            # Comparado por ruta: el agente ordena por mtime y eso ningun vector lo puede fijar.
            self.assertEqual(
                sorted((row["path"], row["bytes"]) for row in head["entries"]),
                sorted((f"{path}/{row['path']}", row["bytes"]) for row in expected["entries"]),
            )
            self.assertEqual(body_of(frames[-1]), {"request_id": request["request_id"]})
            return
        self.assertEqual(head["bytes"], expected["bytes"])
        self.assertEqual(head["truncated"], expected["truncated"])
        self.assertEqual(head["chunks"], expected["chunks"])
        self.assertEqual(head["sha"], expected["sha"])
        served = b""
        for tag, payload in frames[1:-1]:
            self.assertEqual(tag, agent.TAG_READ_DATA)
            identifier, data = agent.decode_data(payload)
            self.assertEqual(identifier, request["request_id"])
            served += data
        self.assertEqual(len(frames) - 2, expected["chunks"])
        self.assertEqual(len(served), expected["served_bytes"])
        self.assertEqual(body_of(frames[-1]), {"request_id": request["request_id"]})

    def _walk_governance_write(self, case: dict[str, Any]) -> None:
        instance, root = self._sandbox(case)
        spec = case["input"]["request"]
        path = os.path.join(root, spec["basename"])
        content = content_of(spec)
        chunks = chunks_of(content)
        request = {
            "request_id": spec["request_id"],
            "path": path,
            "operation": spec["operation"],
            "content_sha": sha(content),
            "bytes": len(content),
            "chunks": len(chunks),
        }
        if "expected_sha" in spec:
            request["expected_sha"] = spec["expected_sha"]
        instance._on_write(request)
        for chunk in chunks:
            instance._on_write_data(spec["request_id"], chunk)
        frames = drain(instance)
        self.assertEqual(len(frames), 1)
        expected = case["expected"]
        self.assertEqual(TAG_NAMES[frames[0][0]], expected["terminal_tag"])
        body = body_of(frames[0])
        self.assertEqual(pathlib.Path(path).read_text(encoding="utf-8"), expected["file_text"])
        if case["must_fail"]:
            self.assertEqual(body["error"], expected["error"])
            self.assertEqual(body["reason"], expected["reason"])
            return
        self.assertEqual(body["operation"], expected["operation"])
        self.assertEqual(body["sha"], expected["sha"])
        self.assertEqual(body["bytes"], expected["bytes"])

    def _walk_governance_write_batch(self, case: dict[str, Any]) -> None:
        instance, root = self._sandbox(case)
        spec = case["input"]["request"]
        entries: list[dict[str, Any]] = []
        chunks: list[bytes] = []
        for raw in spec["entries"]:
            entry: dict[str, Any] = {
                "path": os.path.join(root, raw["basename"]),
                "mode": raw["mode"],
                "operation": raw["operation"],
                "bytes": 0,
                "chunks": 0,
            }
            if raw["mode"] == "write":
                content = content_of(raw)
                parts = chunks_of(content)
                chunks.extend(parts)
                entry.update({"content_sha": sha(content), "bytes": len(content), "chunks": len(parts)})
            if "expected_sha" in raw:
                entry["expected_sha"] = raw["expected_sha"]
            if "announce" in raw:
                # Manifiesto que se contradice a si mismo: los trozos NO se encolan, porque el
                # lote se rechaza antes de aceptar un solo byte de datos.
                del chunks[len(chunks) - len(parts):]
                entry.update(raw["announce"])
            entries.append(entry)
        instance._on_write_batch({"request_id": spec["request_id"], "entries": entries})
        for chunk in chunks:
            instance._on_write_batch_data(spec["request_id"], chunk)
        frames = drain(instance)
        self.assertEqual(len(frames), 1)
        expected = case["expected"]
        self.assertEqual(TAG_NAMES[frames[0][0]], expected["terminal_tag"])
        body = body_of(frames[0])
        if case["must_fail"]:
            self.assertEqual(body["error"], expected["error"])
            self.assertEqual(body["reason"], expected["reason"])
            for after in expected["files_after"]:
                path = pathlib.Path(os.path.join(root, after["basename"]))
                self.assertEqual(sha(path.read_bytes()), after["sha"], after["basename"])
            return
        self.assertEqual(len(body["files"]), len(expected["files"]))
        for acknowledged, want in zip(body["files"], expected["files"], strict=True):
            path = os.path.join(root, want["basename"])
            self.assertEqual(acknowledged["path"], path)
            self.assertEqual(acknowledged["operation"], want["operation"])
            self.assertEqual(acknowledged["sha"], want["sha"])
            self.assertEqual(acknowledged["bytes"], want["bytes"])
            self.assertEqual(sha(pathlib.Path(path).read_bytes()), want["sha"], want["basename"])


if __name__ == "__main__":
    unittest.main()
