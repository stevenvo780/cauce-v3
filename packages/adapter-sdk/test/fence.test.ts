import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseFinalText } from '../src/sdk/output-parser.js';

test('desenvuelve la salida estructurada que el modelo envolvio en una valla de codigo', () => {
  const crudo = '```json\n{"reply":"Arreglado y verificado.","messages":[],"status":"done","retryable":false,"artifacts":[]}\n```';
  const salida = parseFinalText(crudo, 'OpenClaw');
  assert.equal(salida.reply, 'Arreglado y verificado.');
  assert.equal(salida.status, 'done');
});

test('acepta la valla sin etiqueta de lenguaje', () => {
  const salida = parseFinalText('```\n{"reply":"hola","messages":[],"status":"done","retryable":false,"artifacts":[]}\n```', 'OpenClaw');
  assert.equal(salida.reply, 'hola');
});

test('una respuesta de texto que empieza con un bloque de codigo NO se reinterpreta', () => {
  const salida = parseFinalText('```bash\nls -la\n```', 'OpenClaw');
  assert.match(String(salida.reply), /ls -la/u);
});

// Before, a truncated object was a hard failure even if the
// `reply` was complete, and that cost the ENTIRE turn: Steven got "contained a malformed JSON object"
// from jarvis twice in a row, losing minutes of work and a reply the
// agent had already written. Now, if the reply can be rescued, it is delivered and the accessory
// fields (which are not trustworthy in a cut envelope) are discarded. It stays a hard failure
// when there is no rescuable reply: that case leaves a readable `failed` result, with no delegations.
test('un objeto truncado dentro de la valla entrega el reply rescatado, no un fallo', () => {
  assert.equal(parseFinalText('```json\n{"reply":"a\n```', 'OpenClaw').reply, 'a');
});

test('el camino sin valla no cambia', () => {
  assert.equal(parseFinalText('{"reply":"directo","messages":[],"status":"done","retryable":false,"artifacts":[]}', 'X').reply, 'directo');
  assert.match(String(parseFinalText('texto plano', 'X').reply), /texto plano/u);
});

// ---------------------------------------------------------------------------
// 2026-08-05: Steven got "OpenClaw result contained a malformed JSON
// object" from jarvis twice in a row. The whole turn was lost —minutes of work and the reply ALREADY written—
// because the envelope was cut on an ACCESSORY field, after the reply. The reply is the work:
// no malformed accessory field can cost a turn.
// ---------------------------------------------------------------------------

test("un sobre truncado DESPUES del reply entrega igual la respuesta", () => {
  const truncado = '{"reply":"Ya revisé el bridge y está sano.","messages":[{"to":"argos","bo';
  const salida = parseFinalText(truncado, "OpenClaw");
  assert.equal(salida.reply, "Ya revisé el bridge y está sano.");
  // The accessories of a truncated envelope are NOT trustworthy: they are discarded on purpose.
  assert.deepEqual(salida.messages, []);
  assert.equal(salida.status, "done");
});

test("respeta el escapado: unas comillas dentro del reply no lo cortan a la mitad", () => {
  const truncado = '{"reply":"El error decía \\"token expired\\" y por eso fallaba.","notify":[';
  const salida = parseFinalText(truncado, "OpenClaw");
  assert.equal(salida.reply, 'El error decía "token expired" y por eso fallaba.');
});

test("si el corte cae DENTRO del reply, se entrega lo que alcanzó a escribir", () => {
  const salida = parseFinalText('{"reply":"Estaba diagnosticando el adaptador cuando', "OpenClaw");
  assert.match(salida.reply ?? "", /Estaba diagnosticando/u);
});

test("sin reply rescatable falla cerrado pero deja un resultado legible", () => {
  const salida = parseFinalText('{"messages":[{"to":"x"', "OpenClaw");
  assert.equal(salida.status, "failed");
  assert.equal(salida.retryable, false);
  assert.deepEqual(salida.messages, []);
  assert.match(salida.reply ?? "", /no quedo ni una linea de texto rescatable/u);
});
