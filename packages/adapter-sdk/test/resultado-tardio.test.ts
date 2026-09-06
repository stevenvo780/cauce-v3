import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  directorioResultadosTardios, rescatarResultadoTardio,
} from "../src/shared-session/paste-runner/resultado-tardio.js";
import type { TranscriptReader, TurnOutcome } from "../src/shared-session/types.js";

/**
 * Reproduce cd484926 (astra -> kratos, 2026-09-06): la entrega murió a las 23:21:12 y el arnés
 * terminó a las 23:26:16. El sobre existe en la transcripción y hoy se tira.
 */
const CORRELACION = "c9edd58d6154ee8ddeeaf9ded61e2054063665393dbcc266c09deafd6500ca91";
const RESPUESTA = "Los tres remates corregidos y publicados en `graf-admin-dev-00062-jzr`.";

function lector(sobre: TurnOutcome | undefined): TranscriptReader<string> {
  return {
    files: async () => ["transcripcion.jsonl"],
    read: async () => ({ entries: ["una", "dos"], appended: ["dos"] }),
    findInjected: () => undefined,
    findAnswer: () => undefined,
    findEnvelope: (_entries: readonly string[], correlationId: string) =>
      (correlationId === CORRELACION ? sobre : undefined),
    compactions: () => [],
  } as unknown as TranscriptReader<string>;
}

async function carpetaTemporal(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "zeus-tardio-"));
}

test("rescata el sobre que llegó DESPUÉS de morir la entrega", async () => {
  const dir = await carpetaTemporal();
  const cuarentena = join(dir, "quarantine.json");
  const rescatado = await rescatarResultadoTardio({
    transcript: lector({ kind: "answer", text: RESPUESTA, sessionId: "49faed9d" }),
    quarantineFile: cuarentena,
    file: join(dir, "transcripcion.jsonl"),
    correlationId: CORRELACION,
    tamano: async () => 5_000_000,
  });
  assert.ok(rescatado, "tenía que rescatarlo");
  const guardado = JSON.parse(await readFile(rescatado.ruta, "utf8")) as Record<string, unknown>;
  assert.equal(guardado.correlation_id, CORRELACION);
  assert.equal(guardado.texto, RESPUESTA);
  assert.equal(guardado.session_id, "49faed9d");
});

test("CONTROL: no duplica — el segundo rescate de la misma correlación no reescribe", async () => {
  const dir = await carpetaTemporal();
  const cuarentena = join(dir, "quarantine.json");
  const comun = {
    quarantineFile: cuarentena,
    file: join(dir, "transcripcion.jsonl"),
    correlationId: CORRELACION,
    tamano: async () => 10,
  };
  const primero = await rescatarResultadoTardio({
    ...comun, transcript: lector({ kind: "answer", text: RESPUESTA }),
  });
  assert.ok(primero);
  const segundo = await rescatarResultadoTardio({
    ...comun, transcript: lector({ kind: "answer", text: "TEXTO DISTINTO QUE NO DEBE PISAR" }),
  });
  assert.equal(segundo, undefined, "el segundo no debe rescatar nada");
  const guardado = JSON.parse(await readFile(primero.ruta, "utf8")) as Record<string, unknown>;
  assert.equal(guardado.texto, RESPUESTA, "el fichero original no se pisa");
  assert.equal((await readdir(directorioResultadosTardios(cuarentena))).length, 1);
});

test("CONTROL: si no hay sobre, no inventa un fichero", async () => {
  const dir = await carpetaTemporal();
  const cuarentena = join(dir, "quarantine.json");
  const nada = await rescatarResultadoTardio({
    transcript: lector(undefined),
    quarantineFile: cuarentena,
    file: join(dir, "transcripcion.jsonl"),
    correlationId: CORRELACION,
    tamano: async () => 10,
  });
  assert.equal(nada, undefined);
  await assert.rejects(readdir(directorioResultadosTardios(cuarentena)));
});

test("CONTROL: un turno FALLIDO no se guarda como resultado", async () => {
  const dir = await carpetaTemporal();
  const cuarentena = join(dir, "quarantine.json");
  const nada = await rescatarResultadoTardio({
    transcript: lector({ kind: "failed", detail: "reventó" }),
    quarantineFile: cuarentena,
    file: join(dir, "transcripcion.jsonl"),
    correlationId: CORRELACION,
    tamano: async () => 10,
  });
  assert.equal(nada, undefined);
});

test("CONTROL: sin cuarentena o sin fichero no hace nada y no lanza", async () => {
  const dir = await carpetaTemporal();
  assert.equal(await rescatarResultadoTardio({
    transcript: lector({ kind: "answer", text: RESPUESTA }),
    quarantineFile: undefined,
    file: join(dir, "t.jsonl"),
    correlationId: CORRELACION,
  }), undefined);
  assert.equal(await rescatarResultadoTardio({
    transcript: lector({ kind: "answer", text: RESPUESTA }),
    quarantineFile: join(dir, "q.json"),
    file: undefined,
    correlationId: CORRELACION,
  }), undefined);
});
