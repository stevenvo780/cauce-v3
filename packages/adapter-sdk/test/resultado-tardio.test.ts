import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  directorioResultadosTardios, rescatarResultadoTardio,
} from "../src/shared-session/paste-runner/resultado-tardio.js";

const CORRELACION = "c9edd58d6154ee8ddeeaf9ded61e2054063665393dbcc266c09deafd6500ca91";
const TEXTO = '{"reply":"Los tres remates publicados en `graf-admin-dev-00062-jzr`."}';

async function cuarentena(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "zeus-tardio-")), "quarantine.json");
}

test("guarda el sobre tardío con su correlación", async () => {
  const q = await cuarentena();
  const r = await rescatarResultadoTardio({ quarantineFile: q, correlationId: CORRELACION, texto: TEXTO });
  assert.ok(r);
  const guardado = JSON.parse(await readFile(r.ruta, "utf8")) as Record<string, unknown>;
  assert.equal(guardado.correlation_id, CORRELACION);
  assert.equal(guardado.texto, TEXTO);
  assert.match(String(guardado.rescatado_en), /^\d{4}-\d{2}-\d{2}T/u);
});

test("CONTROL: no duplica ni pisa el original", async () => {
  const q = await cuarentena();
  const primero = await rescatarResultadoTardio({ quarantineFile: q, correlationId: CORRELACION, texto: TEXTO });
  assert.ok(primero);
  const segundo = await rescatarResultadoTardio({
    quarantineFile: q, correlationId: CORRELACION, texto: "NO DEBE PISAR",
  });
  assert.equal(segundo, undefined);
  const guardado = JSON.parse(await readFile(primero.ruta, "utf8")) as Record<string, unknown>;
  assert.equal(guardado.texto, TEXTO);
  assert.equal((await readdir(directorioResultadosTardios(q))).length, 1);
});

test("CONTROL: sin cuarentena o con texto vacío no escribe nada ni lanza", async () => {
  assert.equal(await rescatarResultadoTardio({
    quarantineFile: undefined, correlationId: CORRELACION, texto: TEXTO,
  }), undefined);
  const q = await cuarentena();
  assert.equal(await rescatarResultadoTardio({
    quarantineFile: q, correlationId: CORRELACION, texto: "   ",
  }), undefined);
  await assert.rejects(readdir(directorioResultadosTardios(q)));
});
