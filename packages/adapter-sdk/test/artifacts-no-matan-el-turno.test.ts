import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseFinalText } from '../src/sdk/output-parser.js';

// ---------------------------------------------------------------------------
//
// MEASURED, twice, against zeus in production: deliveries 1c0278c3 (2026-09-06 16:14Z, Steven's
// request about socrates) and ba77e0c8 (2026-09-07 08:24Z, jarvis's plugin approval route) both
// died in `failed` with attempt 1 and the same `last_error`:
//
//     artifacts[0] must contain string 'name' and 'uri'
//
// The turn had RUN: the answer was written, the repair applied. What was malformed was the
// accessory field -- `artifacts` carried a bare path string instead of `{name, uri}` -- and the
// whole turn was thrown away with the reply inside it. jarvis never received its diagnosis.
//
// `parseNotify`, ten lines above in the same file, already did the right thing: it drops the bad
// entry, records a `descarte` and lets the turn live. `parseArtifacts` threw. These tests pin the
// two behaviours together: nothing accessory may cost a turn, and the agent must be TOLD what was
// dropped or it repeats the mistake next turn.

const SOBRE = (artifacts: string): string =>
  `{"reply":"la respuesta que costo el turno","messages":[],"notify":[],`
  + `"status":"done","retryable":false,"artifacts":${artifacts}}`;

test('una ruta suelta en artifacts ya no mata el turno: la reply sobrevive', () => {
  const salida = parseFinalText(SOBRE('["/workspace/INFORME.md"]'));
  assert.equal(salida.status, 'done');
  assert.ok(salida.reply?.startsWith('la respuesta que costo el turno'));
  assert.deepEqual(salida.artifacts, []);
});

test('y el agente se entera de por que se descarto', () => {
  const salida = parseFinalText(SOBRE('["/workspace/INFORME.md"]'));
  assert.match(salida.reply ?? '', /\[Cauce\]/u);
  assert.match(salida.reply ?? '', /artifacts\[0\] descartado/u);
  assert.match(salida.reply ?? '', /\{name, uri\}/u);
});

test('artifacts que no es lista se descarta entero sin perder la reply', () => {
  const salida = parseFinalText(SOBRE('"/workspace/INFORME.md"'));
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
  ));
  assert.equal(salida.status, 'done');
  assert.deepEqual(salida.artifacts.map((a) => a.name), ['c.md']);
  assert.match(salida.reply ?? '', /artifacts\[0\] descartado/u);
  assert.match(salida.reply ?? '', /artifacts\[1\] descartado/u);
});

test('un artifact bien formado sigue pasando entero y sin aviso', () => {
  const salida = parseFinalText(SOBRE('[{"name":"INFORME.md","uri":"file:///workspace/INFORME.md"}]'));
  assert.equal(salida.status, 'done');
  assert.equal(salida.reply, 'la respuesta que costo el turno');
  assert.deepEqual(salida.artifacts, [{ name: 'INFORME.md', uri: 'file:///workspace/INFORME.md' }]);
});
