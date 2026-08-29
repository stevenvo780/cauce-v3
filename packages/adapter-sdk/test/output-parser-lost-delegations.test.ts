import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeOutput, parseFinalText, parseOpenClawOutput } from "../src/sdk/output-parser.js";

/**
 * BUG 2 — the plain-text fallback swallowed the contract envelope and, with it, the delegations.
 *
 * The two cases below are real production transcripts (`messages` table, 2026-07-29): the model
 * prefixes a sentence before the envelope, `JSON.parse` fails on the whole text, the text does not
 * start with `{`, and everything falls into the fallback: `messages` vanishes and the raw JSON is
 * published into the chat. 160 replies like that.
 */

const DELEGATION = "argos: verificá el diagnóstico contra el journal de kant antes de cerrar.";

test("un sobre precedido de una frase conserva las delegaciones en vez de tragárselas", () => {
  // Real case from `janus` (2026-07-29 08:45): prose + envelope in the same reply.
  const crudo = [
    "Recibido. Encaja perfecto con lo que ya había hecho: nunca arranqué el encargo.",
    "",
    JSON.stringify({
      reply: "Recibido el STAND DOWN. Confirmo: nunca empecé ese encargo.",
      messages: [{ to: "argos", body: DELEGATION }],
      status: "done",
      retryable: false,
      artifacts: [],
    }),
  ].join("\n");

  const salida = parseFinalText(crudo, "OpenClaw result");

  assert.deepEqual(salida.messages, [{ to: "argos", body: DELEGATION }]);
  assert.equal(salida.status, "done");
  assert.equal(salida.reply, "Recibido el STAND DOWN. Confirmo: nunca empecé ese encargo.");
  // And, along the way, the raw contract dump stops being published as if it were the reply.
  assert.equal(String(salida.reply).includes('"messages"'), false);
});

test("un sobre en una valla con prosa alrededor tampoco pierde la delegación", () => {
  // Real case from `zeus` (2026-07-29 05:42): "Delivering the answer to argos" and the envelope in a fence.
  const crudo = [
    "Full diagnosis complete. Delivering the answer to argos and unblocking kant.",
    "",
    "```json",
    JSON.stringify({
      reply: "ARGOS — diagnosticado.",
      messages: [{ to: "argos", body: DELEGATION }],
      status: "done",
      retryable: false,
      artifacts: [],
    }),
    "```",
  ].join("\n");

  const salida = parseFinalText(crudo, "Claude Code result");

  assert.deepEqual(salida.messages, [{ to: "argos", body: DELEGATION }]);
  assert.equal(salida.reply, "ARGOS — diagnosticado.");
});

test("dos sobres embebidos se rechazan en vez de adivinar cuál delegación es la real", () => {
  const crudo = [
    "Dudé entre dos formas, mando las dos:",
    JSON.stringify({
      reply: "a", messages: [{ to: "argos", body: DELEGATION }], status: "done", retryable: false, artifacts: [],
    }),
    JSON.stringify({
      reply: "b", messages: [{ to: "socrates", body: DELEGATION }], status: "done", retryable: false, artifacts: [],
    }),
  ].join("\n");

  assert.throws(
    () => parseFinalText(crudo, "Codex agent message"),
    /more than one structured output envelope/u,
  );
});

test("un sobre embebido inválido falla fuerte en vez de degradarse a texto", () => {
  const crudo = `Listo.\n${JSON.stringify({
    reply: "hecho",
    messages: [{ to: "NO-ES-UN-ALIAS", body: DELEGATION }],
    status: "done",
    retryable: false,
    artifacts: [],
  })}`;

  assert.throws(() => parseFinalText(crudo, "Hermes result"), /canonical lowercase alias/u);
});

test("el texto sin sobre alguno sigue cayendo al fallback de siempre", () => {
  const salida = parseFinalText("Listo, ya está desplegado y verificado.", "Codex agent message");
  assert.equal(salida.reply, "Listo, ya está desplegado y verificado.");
  assert.deepEqual(salida.messages, []);
  assert.equal(salida.status, "done");

  // A JSON blob that is not the contract envelope is not reinterpreted either.
  const conJsonAjeno = parseFinalText('El healthcheck devolvió {"ok":true,"latency_ms":12}.', "Hermes result");
  assert.match(String(conJsonAjeno.reply), /healthcheck/u);
  assert.deepEqual(conJsonAjeno.messages, []);
});

test("la recuperación vale para los dialectos nativos, no sólo para el texto suelto", () => {
  const sobre = JSON.stringify({
    reply: "informe entregado",
    messages: [{ to: "kant", body: DELEGATION }],
    status: "done",
    retryable: false,
    artifacts: [],
  });

  const claude = parseClaudeOutput(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `Delego a kant y cierro.\n${sobre}`,
    session_id: "claude-native",
  }));
  assert.deepEqual(claude.output.messages, [{ to: "kant", body: DELEGATION }]);

  const openclaw = parseOpenClawOutput(JSON.stringify({
    result: { payloads: [{ text: `Delego a kant y cierro.\n${sobre}` }] },
    session_id: "openclaw-native",
  }));
  assert.deepEqual(openclaw.output.messages, [{ to: "kant", body: DELEGATION }]);
});

test("las llaves dentro de una cadena no rompen el rastreo del sobre", () => {
  const sobre = JSON.stringify({
    reply: 'usá el literal {"a":1} en el payload',
    messages: [{ to: "kant", body: 'mandá {"probe":true} al gateway' }],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const salida = parseFinalText(`Ahí va.\n${sobre}`, "Hermes result");
  assert.deepEqual(salida.messages, [{ to: "kant", body: 'mandá {"probe":true} al gateway' }]);
  assert.equal(salida.reply, 'usá el literal {"a":1} en el payload');
});
