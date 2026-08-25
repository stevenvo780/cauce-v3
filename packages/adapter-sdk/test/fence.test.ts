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

// CONTRATO CAMBIADO A PROPOSITO el 2026-08-05. Antes un objeto truncado era fallo duro aunque el
// `reply` estuviera completo, y eso costaba el turno ENTERO: a Steven le llegó dos veces seguidas
// "contained a malformed JSON object" de jarvis, perdiendo minutos de trabajo y una respuesta que
// el agente ya había escrito. Ahora, si el reply se puede rescatar, se entrega y se descartan los
// campos accesorios (que en un sobre cortado no son confiables). Sigue siendo fallo duro cuando no
// hay reply rescatable: en ese caso queda un resultado `failed` legible, sin delegaciones.
test('un objeto truncado dentro de la valla entrega el reply rescatado, no un fallo', () => {
  assert.equal(parseFinalText('```json\n{"reply":"a\n```', 'OpenClaw').reply, 'a');
});

test('el camino sin valla no cambia', () => {
  assert.equal(parseFinalText('{"reply":"directo","messages":[],"status":"done","retryable":false,"artifacts":[]}', 'X').reply, 'directo');
  assert.match(String(parseFinalText('texto plano', 'X').reply), /texto plano/u);
});

// ---------------------------------------------------------------------------
// 2026-08-05: a Steven le llegó dos veces seguidas "OpenClaw result contained a malformed JSON
// object" de jarvis. El turno entero se perdía —minutos de trabajo y la respuesta YA escrita—
// porque el sobre se cortaba en un campo ACCESORIO, después del reply. La respuesta es el trabajo:
// ningún campo accesorio mal formado puede costar un turno.
// ---------------------------------------------------------------------------

test("un sobre truncado DESPUES del reply entrega igual la respuesta", () => {
  const truncado = '{"reply":"Ya revisé el bridge y está sano.","messages":[{"to":"argos","bo';
  const salida = parseFinalText(truncado, "OpenClaw");
  assert.equal(salida.reply, "Ya revisé el bridge y está sano.");
  // Los accesorios de un sobre truncado NO son confiables: se descartan a propósito.
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
