import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { CommandRunResult } from "../src/sdk/types.js";
import type { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import type { TranscriptEntry } from "../src/shared-session/transcript.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  FakeTmux, assistantEntry, claudeRunner, correlationIdFromPrompt, envelopeText, freshState,
  userEntry,
} from "./shared-session-fixtures.js";

const realSleep = (ms: number): Promise<void> =>
  new Promise((listo) => setTimeout(listo, Math.max(ms, 1)));

const TARDIA = "Los tres remates corregidos y publicados en `graf-admin-dev-00062-jzr`.";

function runOnce(runner: PasteSessionRunner<TranscriptEntry>, stdin: string): Promise<CommandRunResult> {
  return runner.run({
    command: "claude", args: [], harness: "claude", stdin,
    timeoutMs: 10_000, signal: new AbortController().signal,
  });
}

test("el sobre que llega DESPUÉS de morir la entrega se rescata al levantarse la cuarentena", async () => {
  const { state, home, workspace } = await freshState("resultado-tardio-circuito");
  const quarantineFile = join(state, "quarantine");
  const transcripcion = join(transcriptDirectory(home, workspace), `${randomUUID()}.jsonl`);
  const sessionId = randomUUID();
  const head = randomUUID();
  await appendFile(transcripcion, `${userEntry(head, null, "turno previo", sessionId)}\n`);

  const tmux = new FakeTmux();
  let perdida: string | undefined;
  tmux.onSubmit = (text: string) => { perdida = text; return undefined; };

  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, quarantineFile,
    correlationTimeoutMs: 20, quietTimeoutMs: 20, turnTimeoutMs: 600_000, sleep: realSleep,
  });

  const primera = await runOnce(runner, "la que muere por deadline");
  assert.equal(primera.timedOut, true, primera.stderr);
  assert.ok(perdida, "el runner tuvo que intentar pegar algo");
  const correlacionMuerta = correlationIdFromPrompt(perdida);

  const userUuid = randomUUID();
  await appendFile(transcripcion, `${userEntry(userUuid, head, perdida, sessionId)}\n`);
  await appendFile(
    transcripcion,
    `${assistantEntry(randomUUID(), userUuid, envelopeText(TARDIA, correlacionMuerta), sessionId)}\n`,
  );

  tmux.onSubmit = async (text: string) => {
    const uuid = randomUUID();
    await appendFile(transcripcion, `${userEntry(uuid, head, text, sessionId)}\n`);
    await appendFile(
      transcripcion,
      `${assistantEntry(randomUUID(), uuid, envelopeText("la siguiente sí", correlationIdFromPrompt(text)), sessionId)}\n`,
    );
  };
  const segunda = await runOnce(runner, "la siguiente");
  assert.equal(segunda.timedOut, false, segunda.stderr);

  const carpeta = join(state, "resultados-tardios");
  const guardados = await readdir(carpeta);
  assert.deepEqual(guardados, [`${correlacionMuerta}.json`], "un fichero, con la correlación muerta");
  const rescatado = JSON.parse(await readFile(join(carpeta, `${correlacionMuerta}.json`), "utf8")) as
    Record<string, unknown>;
  assert.equal(rescatado.correlation_id, correlacionMuerta);
  assert.match(String(rescatado.texto), /graf-admin-dev-00062-jzr/u);

  assert.equal(guardados.length, 1);
  assert.doesNotMatch(String(rescatado.texto), /la siguiente sí/u);
});

test("CONTROL: si el turno muerto NO dejó sobre, no se inventa ningún rescate", async () => {
  const { state, home, workspace } = await freshState("resultado-tardio-sin-sobre");
  const quarantineFile = join(state, "quarantine");
  const transcripcion = join(transcriptDirectory(home, workspace), `${randomUUID()}.jsonl`);
  const sessionId = randomUUID();
  const head = randomUUID();
  await appendFile(transcripcion, `${userEntry(head, null, "turno previo", sessionId)}\n`);

  const tmux = new FakeTmux();
  tmux.onSubmit = () => undefined;
  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, quarantineFile,
    correlationTimeoutMs: 20, quietTimeoutMs: 20, turnTimeoutMs: 600_000, sleep: realSleep,
  });
  assert.equal((await runOnce(runner, "la que muere sin dejar nada")).timedOut, true);

  tmux.onSubmit = async (text: string) => {
    const uuid = randomUUID();
    await appendFile(transcripcion, `${userEntry(uuid, head, text, sessionId)}\n`);
    await appendFile(
      transcripcion,
      `${assistantEntry(randomUUID(), uuid, envelopeText("ok", correlationIdFromPrompt(text)), sessionId)}\n`,
    );
  };
  assert.equal((await runOnce(runner, "la siguiente")).timedOut, false);
  await assert.rejects(readdir(join(state, "resultados-tardios")), { code: "ENOENT" });
});
