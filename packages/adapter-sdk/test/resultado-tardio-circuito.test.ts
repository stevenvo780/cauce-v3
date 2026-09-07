/**
 * El CIRCUITO real: `healCurrentQuarantine` rescatando un sobre tardío de la transcripción.
 *
 * Esta prueba existe porque la unitaria no bastó. En `5a526fed` el rescate leía `pending.file`,
 * que es el MARCADOR `<quarantineFile>.<correlación>.pending` —y encima lo borra el propio
 * saneo—, así que buscaba la respuesta en el único sitio donde no puede estar y el `catch` lo
 * tapaba. Las pruebas con lector simulado pasaban igual porque devolvían el sobre mirase donde
 * mirase. Lo cazó astra revisando el parche. Acá los dos ficheros son REALES y DISTINTOS: el
 * marcador vive en `state/` y la transcripción en el directorio de sesión del arnés.
 */
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
  // La primera entrega se pierde: el pegado no llega y la generación queda en cuarentena.
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

  // EL ARNÉS TERMINA TARDE: cinco minutos después, en el caso real. Escribe su sobre en la
  // TRANSCRIPCIÓN, correlacionado con la entrega que ya está muerta.
  const userUuid = randomUUID();
  await appendFile(transcripcion, `${userEntry(userUuid, head, perdida, sessionId)}\n`);
  await appendFile(
    transcripcion,
    `${assistantEntry(randomUUID(), userUuid, envelopeText(TARDIA, correlacionMuerta), sessionId)}\n`,
  );

  // El panel vuelve a estar ocioso y la siguiente entrega levanta la cuarentena: ahí es donde el
  // rescate tiene su única oportunidad.
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

  // EL EFECTO: el trabajo de la entrega muerta existe en disco y es legible.
  const carpeta = join(state, "resultados-tardios");
  const guardados = await readdir(carpeta);
  assert.deepEqual(guardados, [`${correlacionMuerta}.json`], "un fichero, con la correlación muerta");
  const rescatado = JSON.parse(await readFile(join(carpeta, guardados[0]!), "utf8")) as
    Record<string, unknown>;
  assert.equal(rescatado.correlation_id, correlacionMuerta);
  assert.match(String(rescatado.texto), /graf-admin-dev-00062-jzr/u);

  // CONTROL: no se rescata la respuesta de la entrega que SÍ se entregó. Sólo la huérfana.
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
