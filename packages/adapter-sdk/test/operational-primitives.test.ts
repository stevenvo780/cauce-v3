import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MESSAGE_TIMEOUT_MS } from "@cauce/protocol";
import { sameDeliveryClaim, sameEventCorrelation } from "../src/sdk/correlation.js";
import { timeoutFromBody } from "../src/sdk/engine/delivery-context.js";
import { AdapterError } from "../src/sdk/errors.js";
import { DEFAULT_MESSAGE_TIMEOUT_MS } from "../src/sdk/message-timeout.js";
import { rawDataText } from "../src/sdk/raw-data.js";

const correlation = {
  event_id: "event-1",
  delivery_id: "delivery-1",
  attempt: 3,
  claim_token: "claim-1",
};

test("event correlation requires all four coordinates", () => {
  assert.equal(sameEventCorrelation(correlation, { ...correlation }), true);
  const mutations = [
    { coordinate: "event_id", candidate: { ...correlation, event_id: "event-2" } },
    { coordinate: "delivery_id", candidate: { ...correlation, delivery_id: "delivery-2" } },
    { coordinate: "attempt", candidate: { ...correlation, attempt: 4 } },
    { coordinate: "claim_token", candidate: { ...correlation, claim_token: "claim-2" } },
  ] as const;
  for (const { coordinate, candidate } of mutations) {
    assert.equal(sameEventCorrelation(correlation, candidate), false, coordinate);
  }
});

test("delivery claim correlation requires all three claim coordinates", () => {
  assert.equal(sameDeliveryClaim(correlation, { ...correlation }), true);
  const mutations = [
    { coordinate: "delivery_id", candidate: { ...correlation, delivery_id: "delivery-2" } },
    { coordinate: "attempt", candidate: { ...correlation, attempt: 4 } },
    { coordinate: "claim_token", candidate: { ...correlation, claim_token: "claim-2" } },
  ] as const;
  for (const { coordinate, candidate } of mutations) {
    assert.equal(sameDeliveryClaim(correlation, candidate), false, coordinate);
  }
});

test("message timeout uses the protocol ceiling and the one SDK default", () => {
  assert.equal(timeoutFromBody({}, DEFAULT_MESSAGE_TIMEOUT_MS), DEFAULT_MESSAGE_TIMEOUT_MS);
  assert.equal(
    timeoutFromBody({ timeout_ms: MAX_MESSAGE_TIMEOUT_MS }, DEFAULT_MESSAGE_TIMEOUT_MS),
    MAX_MESSAGE_TIMEOUT_MS,
  );
  for (const timeout of [0, 1.5, Number.NaN, MAX_MESSAGE_TIMEOUT_MS + 1]) {
    assert.throws(
      () => timeoutFromBody({ timeout_ms: timeout }, DEFAULT_MESSAGE_TIMEOUT_MS),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.code, "INVALID_TIMEOUT");
        assert.match(error.message, new RegExp(String(MAX_MESSAGE_TIMEOUT_MS), "u"));
        return true;
      },
      String(timeout),
    );
  }
});

test("WebSocket text decoding is identical for Buffer, fragments and ArrayBuffer", () => {
  const expected = "mensaje 🚀";
  const encoded = Buffer.from(expected, "utf8");
  const fragments = [encoded.subarray(0, encoded.length - 2), encoded.subarray(encoded.length - 2)];
  const arrayBuffer = Uint8Array.from(encoded).buffer;

  assert.equal(rawDataText(encoded), expected);
  assert.equal(rawDataText(fragments), expected);
  assert.equal(rawDataText(arrayBuffer), expected);
});
