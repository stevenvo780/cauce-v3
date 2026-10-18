import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseFinalText } from '../src/sdk/output-parser.js';

// ---------------------------------------------------------------------------
//
// THE CAUSE, with the raw output of all four turns in front of us, IS ONE SINGLE CHARACTER: the
// separator between key and value arrived as `>` instead of `:`. All four envelopes start literally
// `{"reply">"**…` and `JSON.parse` always dies at the same position 8. They were NOT truncated
// (`stopReason: "stop"`): all four close cleanly with
// `…,"notify":[],"status":"done","retryable":false,"artifacts":[]}`, and substituting that single
// character they parse perfectly —six keys, `status:"done"`, replies from 2,743 to 3,683 chars—.
// The model was `claude-opus-5[1m]` for `provider: claude-cli`, and the pattern `"reply">` appears
// 4 times in the WHOLE fleet, all four in argos. The `task_runs` from openclaw show `succeeded`
// with `terminal_summary=completed` and no error: the turn RAN FINE and died on parse.
//
// `rescataReply` already existed and did not rescue it because its mark was `/"reply"\s*:\s*"/u`,
// which requires the literal `:`. It also only covered the envelope truncated AFTER an intact
// `reply`; the parser was run case by case over the other broken envelope shapes (not from
// memory) and 20 more died in that same `throw`. They are all below, each with its own literal
//

const SOBRE = '"messages":[],"status":"done","retryable":false,"artifacts":[]';

// --- Family 0: THE ARGOS CASE. Corrupt separator between key and value ---------------------------

// LITERAL prefix of the raw delivery `c8fb53c6`, with its real closing. This test fails against the
// previous parser —`OpenClaw result contained a malformed JSON object`, `result` NULL— and passes
// with the patch.

// `bea579a8` carried 2 legitimate `messages`. Since the envelope closes cleanly, the fix repairs
// the separator and revalidates the WHOLE envelope: rescuing only the text would have saved the
// reply and thrown away the two delegations, which is the same damage `recoverEmbeddedEnvelope`
// already documents.
test('un sobre de argos con delegaciones las conserva: se repara y se revalida entero', () => {
  const crudo = '{"reply">"El GO ya esta dado.","messages":[{"to":"kant","body":"segui con el despliegue"},{"to":"zeus","body":"mira el limite de salida"}],"notify":[],"status":"done","retryable":false,"artifacts":[]}';
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.status, 'done');
  assert.equal(salida.messages.length, 2);
  assert.deepEqual(salida.messages.map((mensaje) => mensaje.to), ['kant', 'zeus']);
});

test('un separador AUSENTE no se adivina', () => {
  assert.equal(parseFinalText('{"reply""Ya revise el bridge.","messages":[{"to":"ka', 'X').status, 'failed');
});

// --- Family 1: RAW control characters inside the string ------------------------------------------
// The most likely of all, and the one with NO truncation at all: the model writes its JSON by
// hand and inserts the real newline instead of `\n`. The `reply` is COMPLETE and still the whole
// turn was lost. Here only the reply is not rescued: the envelope is repaired and recovered WHOLE.

test('un salto de linea REAL sin escapar ya no cuesta el turno: se repara el sobre entero', () => {
  const crudo = `{"reply":"Primera linea\nSegunda linea",${SOBRE}}`;
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'Primera linea\nSegunda linea');
  assert.equal(salida.status, 'done');
});

test('dos sobres pegados NO se adivinan: se cae al reply del primero, sin delegar', () => {
  // Ambiguity. `recoverEmbeddedEnvelope` refuses to pick, and the step below delivers the reply
  // with empty `messages`: better lose the delegation than dispatch work at random.
  const crudo = `{"reply":"primero",${SOBRE}}{"reply":"segundo",${SOBRE}}`;
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'primero');
  assert.deepEqual(salida.messages, []);
});

// --- Family 5: the FLOOR. With nothing rescuable, the turn stays alive --------------------------
// Before this was `throw`, and a throw leaves `deliveries.result` NULL: the asker gets NOTHING
// —no reply, no notice, no reason—. That is the state of argos's 4 turns today and the 5 on
// 31-jul. Now it degrades to "failed" WITH TEXT, the same move `validateDeliveryOutput` already
// made twice (janus's MISSING_FINAL_REPLY and openclaw's tool dump). It does not become "done":
// the turn truly produced no legible reply and metrics must keep counting it as the failure it was.

test('un sobre con "reply": null y el resto cortado degrada a failed con texto, no a result NULL', () => {
  const salida = parseFinalText('{"reply":null,"messages":[{"to":"kant","bo', 'OpenClaw result');
  assert.equal(salida.status, 'failed');
  assert.equal(salida.retryable, false);
  assert.match(salida.reply ?? '', /no quedo ni una linea de texto rescatable/u);
  // The envelope sample travels bounded inside the technical block: without it the diagnosis is
  // back to guessing which character broke the JSON.
  assert.match(salida.reply ?? '', /Empieza asi: \{"reply":null/u);
});

test('el andamiaje mal formado se normaliza; lo que puede hacer dano sigue siendo fallo duro', () => {
  const conRetryableRoto = parseFinalText('{"reply":"hola","retryable":"si"}', 'X');
  assert.equal(conRetryableRoto.reply?.startsWith('hola'), true,
    'el reply ES el trabajo: 27 turnos de 8 alias se perdieron enteros por andamiaje mal escrito');
  assert.equal(conRetryableRoto.retryable, false);
  const conStatusRoto = parseFinalText('{"reply":"hola","status":"ok"}', 'X');
  assert.equal(conStatusRoto.status, 'done',
    'un status fuera del contrato no puede costar el turno, solo dejar constancia');
  assert.throws(() => parseFinalText('{"reply":"hola","messages":{}}', 'X'), /'messages' must be an array/u,
    'messages sigue muriendo a proposito: una lista a medias podria despachar trabajo a quien no toca');
});

test('una respuesta en prosa sigue siendo una respuesta en prosa', () => {
  assert.match(String(parseFinalText('Ya revise el bridge y esta sano.', 'X').reply), /bridge/u);
  assert.equal(parseFinalText('Ya revise el bridge.', 'X').status, 'done');
});

test('el camino feliz no se toca', () => {
  const salida = parseFinalText(`{"reply":"directo",${SOBRE}}`, 'X');
  assert.equal(salida.reply, 'directo');
  assert.equal(salida.status, 'done');
});
