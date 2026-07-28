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

test('un objeto realmente truncado dentro de la valla sigue siendo un fallo duro', () => {
  assert.throws(() => parseFinalText('```json\n{"reply":"a\n```', 'OpenClaw'), /malformed JSON object/u);
});

test('el camino sin valla no cambia', () => {
  assert.equal(parseFinalText('{"reply":"directo","messages":[],"status":"done","retryable":false,"artifacts":[]}', 'X').reply, 'directo');
  assert.match(String(parseFinalText('texto plano', 'X').reply), /texto plano/u);
});
