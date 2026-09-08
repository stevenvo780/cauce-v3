import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseFinalText } from '../src/sdk/output-parser.js';

const SOBRE = (artifacts: string): string =>
  `{"reply":"la respuesta que costo el turno","messages":[],"notify":[],`
  + `"status":"done","retryable":false,"artifacts":${artifacts}}`;

test('una ruta suelta en artifacts ya no mata el turno: la reply sobrevive', () => {
  const salida = parseFinalText(SOBRE('["/workspace/INFORME.md"]'), 'artifacts');
  assert.equal(salida.status, 'done');
  assert.ok(salida.reply?.startsWith('la respuesta que costo el turno'));
  assert.deepEqual(salida.artifacts, []);
});

test('y el agente se entera de por que se descarto', () => {
  const salida = parseFinalText(SOBRE('["/workspace/INFORME.md"]'), 'artifacts');
  assert.match(salida.reply ?? '', /\[Cauce\]/u);
  assert.match(salida.reply ?? '', /artifacts\[0\] descartado/u);
  assert.match(salida.reply ?? '', /\{name, uri\}/u);
});

test('artifacts que no es lista se descarta entero sin perder la reply', () => {
  const salida = parseFinalText(SOBRE('"/workspace/INFORME.md"'), 'artifacts');
  assert.equal(salida.status, 'done');
  assert.ok(salida.reply?.startsWith('la respuesta que costo el turno'));
  assert.deepEqual(salida.artifacts, []);
  assert.match(salida.reply ?? '', /no era una lista/u);
});

test('media_type y sha256 con tipo equivocado descartan SOLO su entrada', () => {
  const salida = parseFinalText(SOBRE(
    '[{"name":"a.md","uri":"file:///a.md","media_type":7},'
    + '{"name":"b.md","uri":"file:///b.md","sha256":7},'
    + '{"name":"c.md","uri":"file:///c.md"}]',
  ), 'artifacts');
  assert.equal(salida.status, 'done');
  assert.deepEqual(salida.artifacts.map((a) => a.name), ['c.md']);
  assert.match(salida.reply ?? '', /artifacts\[0\] descartado/u);
  assert.match(salida.reply ?? '', /artifacts\[1\] descartado/u);
});

test('un artifact bien formado sigue pasando entero y sin aviso', () => {
  const salida = parseFinalText(SOBRE('[{"name":"INFORME.md","uri":"file:///workspace/INFORME.md"}]'), 'artifacts');
  assert.equal(salida.status, 'done');
  assert.equal(salida.reply, 'la respuesta que costo el turno');
  assert.deepEqual(salida.artifacts, [{ name: 'INFORME.md', uri: 'file:///workspace/INFORME.md' }]);
});
