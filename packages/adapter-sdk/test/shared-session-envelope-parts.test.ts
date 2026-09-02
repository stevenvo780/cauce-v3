import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { isEnvelopeText } from "../src/shared-session/envelope.js";
import { turnInFlight } from "../src/shared-session/pane.js";
import { findEnvelopeTurn, type TranscriptEntry } from "../src/shared-session/transcript.js";
import { assistantEntry, envelopeText, userEntry } from "./shared-session-fixtures.js";

test("un sobre se reconoce por su forma, y una respuesta en prosa no", () => {
  assert.equal(isEnvelopeText(envelopeText("hecho")), true);
  assert.equal(isEnvelopeText("```json\n" + envelopeText("hecho") + "\n```"), true);
  assert.equal(isEnvelopeText('{"reply":null,"messages":[],"status":"failed","retryable":true}'), true);
  assert.equal(isEnvelopeText("listo, ya lo dejé andando"), false);
  assert.equal(isEnvelopeText('{"reply":"x"}'), false);
  assert.equal(isEnvelopeText('{"reply":"x","messages":[],"status":"otra"}'), false);
  assert.equal(isEnvelopeText('{"reply":"x","messages":{},"status":"done"}'), false);
  assert.equal(isEnvelopeText(undefined), false);
});

test("el sobre se localiza sin ascendencia, y un mensaje intermedio no cuenta", () => {
  const sessionId = randomUUID();
  const duenio = randomUUID();
  const correlationId = randomUUID();
  const entries = [
    JSON.parse(userEntry(duenio, null, "seguí", sessionId)),
    JSON.parse(assistantEntry(
      randomUUID(),
      duenio,
      envelopeText("a medias", correlationId),
      sessionId,
      "tool_use",
    )),
    JSON.parse(assistantEntry(
      randomUUID(),
      duenio,
      envelopeText("el entregable", correlationId),
      sessionId,
    )),
  ] as TranscriptEntry[];
  const found = findEnvelopeTurn(entries, correlationId);
  assert.equal(found?.text, envelopeText("el entregable", correlationId));
  assert.equal(found.sessionId, sessionId);

  // A subagent writes to the same file and cannot count as the turn's envelope.
  const sidechain = [{
    ...JSON.parse(assistantEntry(randomUUID(), duenio, envelopeText("de un subagente"), sessionId)),
    isSidechain: true,
  }] as TranscriptEntry[];
  assert.equal(findEnvelopeTurn(sidechain, correlationId), undefined);
});

test("el rescate rechaza sobres sin nonce o con el nonce de otra entrega", () => {
  const sessionId = randomUUID();
  const parent = randomUUID();
  const expected = randomUUID();
  const entries = [
    JSON.parse(assistantEntry(randomUUID(), parent, envelopeText("sin nonce"), sessionId)),
    JSON.parse(assistantEntry(
      randomUUID(),
      parent,
      envelopeText("ajeno", randomUUID()),
      sessionId,
    )),
  ] as TranscriptEntry[];

  assert.equal(findEnvelopeTurn(entries, expected), undefined);
});

test("la línea de estado de una TUI generando se distingue del texto de la conversación", () => {
  // claude draws it just ABOVE the box; codex, just below. Both count.
  assert.equal(turnInFlight("✻ Herding… (esc to interrupt · ctrl+t to hide todos)\n❯ "), true);
  assert.equal(turnInFlight("› \nEsc to interrupt\n"), true);
  assert.equal(turnInFlight("❯ "), false);
  assert.equal(turnInFlight("✻ Herding… (esc to interrupt)\n❯ \n\n\n"), true);
  // A sentence FAR from the box is conversation, not status: if it counted, an agent talking
  // about this same mechanism would leave the panel marked as busy forever.
  const relleno: string[] = new Array<string>(20).fill("blah");
  const conversacion = ["el truco es mirar 'esc to interrupt'", ...relleno, "❯ "];
  assert.equal(turnInFlight(conversacion.join("\n")), false);
  assert.equal(turnInFlight(undefined), false);
});
