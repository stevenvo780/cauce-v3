import assert from "node:assert/strict";
import test from "node:test";
import { claudeTranscript, type TranscriptEntry } from "../src/shared-session/transcript.js";

// Claude Code >= 2.1.280 guarda lo pegado con `paste-buffer -p` envuelto en <pasted_content id="xxxx">:
// con igualdad exacta el turno inyectado no se localizaba y la entrega quedaba en `started`.
const reader = claudeTranscript("/tmp/sin-uso", "/workspace");
const PROMPT = "hacé X\ny devolvé el sobre";
const user = (content: string, uuid = "u-1"): TranscriptEntry =>
  ({ type: "user", uuid, sessionId: "s-1", message: { role: "user", content } });

test("localiza el turno pegado envuelto en pasted_content", () => {
  const wrapped = `\n\n<pasted_content id="3fa9">\n${PROMPT}</pasted_content id="3fa9">\n`;
  assert.deepEqual(reader.findInjected("f", [user(wrapped)], PROMPT), { key: "u-1", sessionId: "s-1" });
  assert.deepEqual(reader.findInjected("f", [user(`<pasted_content id="3fa9">\n${PROMPT}\n</pasted_content id="3fa9">`)], PROMPT),
    { key: "u-1", sessionId: "s-1" });
});

test("el envoltorio no afloja la igualdad del contenido ni acepta ids distintos", () => {
  assert.equal(reader.findInjected("f", [user(`<pasted_content id="3fa9">\n${PROMPT} extra</pasted_content id="3fa9">`)], PROMPT), undefined);
  assert.equal(reader.findInjected("f", [user(`<pasted_content id="3fa9">\n${PROMPT}</pasted_content id="aaaa">`)], PROMPT), undefined);
  assert.deepEqual(reader.findInjected("f", [user(PROMPT)], PROMPT), { key: "u-1", sessionId: "s-1" });
});
