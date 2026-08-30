#!/usr/bin/env python3
"""Tests for the PTY wire framing in ops/pty-agent/cauce_pty_agent.py.

The relay (TypeScript) and the gateway (TypeScript) encode the same frames, so the golden vector
below is the contract between the three implementations: tag 0x21, session
11111111-2222-3333-4444-555555555555, payload "hi". If this test moves, every implementation moves.

Runs standalone (`python3 ops/pty-agent/tests/test_framing.py`) or under
`python3 -m unittest discover ops/pty-agent/tests`.
"""
from __future__ import annotations

import pathlib
import sys
import unittest

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402

GOLDEN_SESSION = "11111111-2222-3333-4444-555555555555"
GOLDEN_HEX = (
    "210000002631313131313131312d323232322d333333332d343434342d3535353535353535353535356869"
)
GOLDEN_TERMINAL_RESPONSE_HEX = (
    "230000002831313131313131312d323232322d333333332d343434342d3535353535353535353535351b5b306e"
)


class GoldenVectorTests(unittest.TestCase):
    def test_stdout_frame_matches_the_golden_vector(self) -> None:
        frame = agent.encode_data(agent.TAG_STDOUT, GOLDEN_SESSION, b"hi")
        self.assertEqual(frame.hex(), GOLDEN_HEX)

    def test_golden_vector_header_is_tag_then_big_endian_length(self) -> None:
        frame = bytes.fromhex(GOLDEN_HEX)
        self.assertEqual(frame[0], 0x21)
        self.assertEqual(int.from_bytes(frame[1:5], "big"), 38)
        self.assertEqual(len(frame), 5 + 38)

    def test_golden_vector_decodes_back_to_session_and_payload(self) -> None:
        decoder = agent.FrameDecoder()
        frames = decoder.feed(bytes.fromhex(GOLDEN_HEX))
        self.assertEqual(len(frames), 1)
        tag, payload = frames[0]
        self.assertEqual(tag, agent.TAG_STDOUT)
        self.assertEqual(agent.decode_data(payload), (GOLDEN_SESSION, b"hi"))

    def test_terminal_response_has_a_distinct_cross_language_tag(self) -> None:
        frame = agent.encode_data(agent.TAG_TERMINAL_RESPONSE, GOLDEN_SESSION, b"\x1b[0n")
        self.assertEqual(frame.hex(), GOLDEN_TERMINAL_RESPONSE_HEX)
        [(tag, payload)] = agent.FrameDecoder().feed(bytes.fromhex(GOLDEN_TERMINAL_RESPONSE_HEX))
        self.assertEqual(tag, agent.TAG_TERMINAL_RESPONSE)
        self.assertEqual(agent.decode_data(payload), (GOLDEN_SESSION, b"\x1b[0n"))

    def test_session_scoped_flow_control_tags_match_the_relay(self) -> None:
        self.assertEqual(agent.TAG_PAUSE_OUTPUT, 0x24)
        self.assertEqual(agent.TAG_RESUME_OUTPUT, 0x25)

    def test_governance_write_tags_match_the_relay(self) -> None:
        self.assertEqual(
            (
                agent.TAG_WRITE, agent.TAG_WRITE_DATA, agent.TAG_WRITE_OK,
                agent.TAG_WRITE_ERR, agent.TAG_WRITE_CANCEL,
            ),
            (0x54, 0x55, 0x56, 0x57, 0x58),
        )
        frame = agent.encode_data(agent.TAG_WRITE_DATA, GOLDEN_SESSION, b"manual")
        [(tag, payload)] = agent.FrameDecoder().feed(frame)
        self.assertEqual(tag, agent.TAG_WRITE_DATA)
        self.assertEqual(agent.decode_data(payload), (GOLDEN_SESSION, b"manual"))

    def test_governance_write_batch_tags_match_the_relay(self) -> None:
        self.assertEqual(
            (
                agent.TAG_WRITE_BATCH, agent.TAG_WRITE_BATCH_DATA, agent.TAG_WRITE_BATCH_OK,
                agent.TAG_WRITE_BATCH_ERR, agent.TAG_WRITE_BATCH_CANCEL,
            ),
            (0x59, 0x5A, 0x5B, 0x5C, 0x5D),
        )
        frame = agent.encode_data(agent.TAG_WRITE_BATCH_DATA, GOLDEN_SESSION, b"profile")
        [(tag, payload)] = agent.FrameDecoder().feed(frame)
        self.assertEqual(tag, agent.TAG_WRITE_BATCH_DATA)
        self.assertEqual(agent.decode_data(payload), (GOLDEN_SESSION, b"profile"))

    def test_governance_read_done_tag_matches_the_relay(self) -> None:
        self.assertEqual(agent.TAG_READ_DONE, 0x5E)


class DecoderTests(unittest.TestCase):
    def test_one_byte_at_a_time_reassembles_the_golden_vector(self) -> None:
        decoder = agent.FrameDecoder()
        raw = bytes.fromhex(GOLDEN_HEX)
        collected = []
        for index, byte in enumerate(raw):
            frames = decoder.feed(bytes([byte]))
            if index < len(raw) - 1:
                self.assertEqual(frames, [], "no frame may surface before its last byte arrives")
            collected.extend(frames)
        self.assertEqual(len(collected), 1)
        self.assertEqual(agent.decode_data(collected[0][1]), (GOLDEN_SESSION, b"hi"))

    def test_several_frames_in_one_chunk_are_split_in_order(self) -> None:
        stream = (
            agent.encode_json(agent.TAG_PING, {"t": 1})
            + agent.encode_data(agent.TAG_STDIN, GOLDEN_SESSION, b"ls\r")
            + agent.encode_json(agent.TAG_CLOSE, {"session_id": GOLDEN_SESSION})
        )
        frames = agent.FrameDecoder().feed(stream)
        self.assertEqual([tag for tag, _ in frames], [agent.TAG_PING, agent.TAG_STDIN, agent.TAG_CLOSE])

    def test_empty_payload_frame_is_a_valid_frame(self) -> None:
        frames = agent.FrameDecoder().feed(agent.encode_frame(agent.TAG_PONG, b""))
        self.assertEqual(frames, [(agent.TAG_PONG, b"")])

    def test_announced_length_above_the_maximum_is_refused(self) -> None:
        header = bytes([agent.TAG_STDOUT]) + (agent.MAX_FRAME + 1).to_bytes(4, "big")
        with self.assertRaises(agent.ProtocolError):
            agent.FrameDecoder().feed(header)

    def test_binary_payloads_survive_a_round_trip(self) -> None:
        body = bytes(range(256)) * 12
        frames = agent.FrameDecoder().feed(agent.encode_data(agent.TAG_STDOUT, GOLDEN_SESSION, body))
        self.assertEqual(agent.decode_data(frames[0][1]), (GOLDEN_SESSION, body))


class EncoderGuardTests(unittest.TestCase):
    def test_data_chunk_above_the_per_frame_maximum_is_refused(self) -> None:
        with self.assertRaises(agent.ProtocolError):
            agent.encode_data(agent.TAG_STDOUT, GOLDEN_SESSION, b"x" * (agent.MAX_DATA + 1))

    def test_a_full_size_chunk_is_exactly_the_frame_maximum(self) -> None:
        frame = agent.encode_data(agent.TAG_STDOUT, GOLDEN_SESSION, b"x" * agent.MAX_DATA)
        self.assertEqual(len(frame), 5 + agent.MAX_FRAME)

    def test_only_data_and_terminal_response_tags_carry_a_session_prefix(self) -> None:
        with self.assertRaises(agent.ProtocolError):
            agent.encode_data(agent.TAG_OPEN, GOLDEN_SESSION, b"hi")

    def test_a_short_session_id_is_refused(self) -> None:
        with self.assertRaises(agent.ProtocolError):
            agent.encode_data(agent.TAG_STDOUT, "1111", b"hi")

    def test_a_data_frame_without_a_full_session_prefix_is_refused(self) -> None:
        with self.assertRaises(agent.ProtocolError):
            agent.decode_data(b"1111")

    def test_a_data_frame_with_a_malformed_session_id_is_refused(self) -> None:
        with self.assertRaises(agent.ProtocolError):
            agent.decode_data(b"Z" * agent.SESSION_ID_BYTES + b"hi")


class KeepaliveContractTests(unittest.TestCase):
    """PING and PONG travel EMPTY.

    The relay writes `encodeFrame(FRAME_TAGS.PING)` with no payload and ignores whatever a PONG
    carries, so a PING branch that decodes the payload as JSON tore down every healthy connection
    ten seconds after the hello was accepted. This is the contract, not an implementation detail.
    """

    @staticmethod
    def _agent() -> agent.PtyAgent:
        instance = agent.PtyAgent.__new__(agent.PtyAgent)
        instance.bundle = {"alias": "zeus", "tenant_id": "Steven"}
        instance.modes = ["shell"]
        instance.outbound = bytearray()
        instance.acknowledged = False
        instance.last_ping = 0.0
        return instance

    def test_an_empty_ping_is_answered_instead_of_parsed_as_json(self) -> None:
        instance = self._agent()
        instance._dispatch(agent.TAG_PING, b"")
        self.assertEqual(bytes(instance.outbound), agent.encode_frame(agent.TAG_PONG, b""))

    def test_a_ping_is_answered_before_the_hello_is_acknowledged(self) -> None:
        instance = self._agent()
        instance._dispatch(agent.TAG_PING, b"")
        self.assertGreater(instance.last_ping, 0.0)
        self.assertFalse(instance.acknowledged)

    def test_the_pong_we_emit_is_a_bare_five_byte_header(self) -> None:
        self.assertEqual(agent.encode_frame(agent.TAG_PONG, b"").hex(), "4100000000")


if __name__ == "__main__":
    unittest.main()
