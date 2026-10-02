import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import { grokPromptLog } from "../src/shared-session/grok-dispatch.js";
import { adapterFor, correlationIdFromPrompt, envelopeText, execute } from "./shared-session-fixtures.js";
import { GrokTmux, grokFrame, grokRunner, grokWorkspace } from "./grok-shared-session-fixtures.js";

async function pagerLog(grokHome: string): Promise<(tmux: GrokTmux, text: string, drained: boolean) => Promise<void>> {
  const file = grokPromptLog(grokHome);
  await mkdir(join(grokHome, "logs"), { recursive: true });
  await writeFile(file, `${JSON.stringify({ pid: 1, msg: "startup phase" })}\n`);
  return async (tmux, text, drained) => {
    const pid = Number(tmux.panePid);
    const len = Buffer.byteLength(text, "utf8");
    await appendFile(file, `${JSON.stringify({ src: "grok-pager", pid, msg: "prompt.enqueue", ctx: { len } })}\n`
      + (drained ? `${JSON.stringify({ src: "grok-pager", pid, msg: "prompt.drain", ctx: { kind: "prompt", prompt_len: len } })}\n` : ""));
  };
}

const chipOf = (text: string): string => `[Pasted: ${String(Math.round(Buffer.byteLength(text, "utf8") / 1000))} KB]`;

test("grok: un pedido encolado y nunca entregado al modelo falla sin reintento, preserva la caja y deja la generación en cuarentena", async () => {
  const { state, grokHome } = await grokWorkspace("grok-despacho-atascado");
  const pager = await pagerLog(grokHome);
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await pager(tmux, text, false); // queued and held: the box keeps the chip, the pane is idle
    tmux.paneContent = grokFrame({ footer: "typed", box: chipOf(text) });
  };
  const adapter = await adapterFor(grokRunner({ grokHome, tmux, dispatchGraceMs: 20 }), state, "hades", "grok");

  const error = await execute(adapter).then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof ProcessExecutionError, String(error));
  assert.equal(error.code, "PROMPT_NOT_DISPATCHED");
  assert.equal(error.retryable, false, "grok may still run it from its queue: a retry would run it twice");
  assert.match(error.message, /puede seguir en su cola/u);
  assert.equal(tmux.clearedBoxes, 0, "a paste chip does not identify its underlying text");
  assert.match(tmux.paneContent, /\[Pasted:/u);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), true, "the generation stays quarantined: a late run is reconciled, nothing piles up");
});

test("grok: tras PROMPT_NOT_DISPATCHED la caja vacía NO levanta la cuarentena; sólo el sobre tardío del pedido retenido la levanta", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-despacho-retenido");
  const pager = await pagerLog(grokHome);
  const tmux = new GrokTmux();
  let held = "";
  tmux.onSubmit = async (text) => {
    held = text;
    await pager(tmux, text, false);
    tmux.paneContent = grokFrame({ footer: "typed", box: chipOf(text) });
  };
  const runner = grokRunner({ grokHome, tmux, dispatchGraceMs: 20, quarantineFile: join(state, ".shared-session-quarantine") });
  const adapter = await adapterFor(runner, state, "hades", "grok");
  const first = await execute(adapter).then(() => undefined, (failure: unknown) => failure);
  assert.ok(first instanceof ProcessExecutionError && first.code === "PROMPT_NOT_DISPATCHED");
  const submits = tmux.submittedCount;
  tmux.paneContent = grokFrame();

  // The box is empty and the pane idle, but grok still holds the prompt: another paste would pile up behind it.
  const second = await execute(adapter).then(() => undefined, (failure: unknown) => failure);
  assert.ok(second instanceof ProcessExecutionError, String(second));
  assert.equal(tmux.submittedCount, submits, "a second prompt was pasted behind the held one");

  // Someone resumes grok: the held prompt runs late and answers with its own correlation.
  await log.append(log.user(held), log.message("p-tarde", envelopeText("corrió tarde", correlationIdFromPrompt(held))), log.completed("p-tarde"));
  tmux.onSubmit = async (text) => {
    await pager(tmux, text, true);
    await log.append(log.user(text), log.message("p-ok", envelopeText("de nuevo en línea", correlationIdFromPrompt(text))), log.completed("p-ok"));
  };
  assert.equal((await execute(adapter)).reply, "de nuevo en línea");
});

for (const sameSize of [false, true]) test(`grok: preserva el pegado del dueño de tamaño ${sameSize ? "igual" : "distinto"}`, async () => {
  const { state, grokHome } = await grokWorkspace("grok-despacho-chip-ajeno");
  const pager = await pagerLog(grokHome);
  const tmux = new GrokTmux();
  let ownerFrame = "";
  tmux.onSubmit = async (text) => {
    await pager(tmux, text, false);
    ownerFrame = grokFrame({ footer: "typed", box: sameSize ? chipOf(text) : "[Pasted: 87 KB]" });
    tmux.paneContent = ownerFrame;
  };
  const error = await execute(await adapterFor(grokRunner({ grokHome, tmux, dispatchGraceMs: 20 }), state, "hades", "grok"))
    .then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof ProcessExecutionError);
  assert.equal(error.code, "PROMPT_NOT_DISPATCHED");
  assert.equal(tmux.clearedBoxes, 0, "the owner's paste was erased");
  assert.equal(tmux.paneContent, ownerFrame);
  assert.match(error.message, /sin tocar/u);
});

test("grok: un runner reiniciado sin fichero de cuarentena no libera una entrega retenida al vaciar la caja", async () => {
  const { state, grokHome } = await grokWorkspace("grok-despacho-reinicio");
  const pager = await pagerLog(grokHome);
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await pager(tmux, text, false);
    tmux.paneContent = grokFrame({ footer: "typed", box: chipOf(text) });
  };
  const options = { grokHome, tmux, dispatchGraceMs: 20 };
  const first = await execute(await adapterFor(grokRunner(options), state, "hades", "grok"))
    .then(() => undefined, (failure: unknown) => failure);
  assert.ok(first instanceof ProcessExecutionError && first.code === "PROMPT_NOT_DISPATCHED");
  const submits = tmux.submittedCount;
  tmux.paneContent = grokFrame();
  const second = await execute(await adapterFor(grokRunner(options), state, "hades", "grok"))
    .then(() => undefined, (failure: unknown) => failure);
  assert.ok(second instanceof ProcessExecutionError);
  assert.equal(tmux.submittedCount, submits);
  assert.equal(tmux.sessionOptions.has("@cauce_quarantined_pane"), true);
});

test("grok: con el registro del pager presente y el pedido entregado, el turno sigue como siempre", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-despacho-normal");
  const pager = await pagerLog(grokHome);
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await pager(tmux, text, true);
    await log.append(log.user(text), log.message("p-n", envelopeText("normal", correlationIdFromPrompt(text))), log.completed("p-n"));
  };
  const output = await execute(await adapterFor(grokRunner({ grokHome, tmux, dispatchGraceMs: 20 }), state, "hades", "grok"));
  assert.equal(output.reply, "normal");
  assert.equal(tmux.clearedBoxes, 0);
});

test("grok: un pedido que grok drena tarde, dentro del margen, no se da por perdido", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-despacho-tarde");
  const pager = await pagerLog(grokHome);
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await pager(tmux, text, false); // enqueued now, handed to the model a moment later
    setTimeout(() => {
      void (async () => {
        await pager(tmux, text, true);
        await log.append(log.user(text), log.message("p-t", envelopeText("tarde pero entró", correlationIdFromPrompt(text))), log.completed("p-t"));
      })();
    }, 150);
  };
  const runner = grokRunner({ grokHome, tmux, dispatchGraceMs: 5_000, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))) });
  const output = await execute(await adapterFor(runner, state, "hades", "grok"));
  assert.equal(output.reply, "tarde pero entró");
  assert.equal(tmux.clearedBoxes, 0);
});

test("grok: un pedido que no cabe pegado va entero a un fichero 0600 y se pega un puntero con la misma correlación", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-despacho-fichero");
  const workspace = await mkdtemp(join(tmpdir(), "cauce-grok-ws-"));
  const tmux = new GrokTmux();
  tmux.paneCurrentPath = workspace;
  let seen: { pasted: string; file: string; mode: number; content: string } | undefined;
  tmux.onSubmit = async (text) => {
    const file = /(\/\S+\.cauce\/pedidos\/[a-f0-9]{64}\.md)/u.exec(text)?.[1] ?? "";
    seen = { pasted: text, file, mode: (await stat(file)).mode & 0o777, content: await readFile(file, "utf8") };
    await log.append(log.user(text), log.message("p-f", envelopeText("leído del fichero", correlationIdFromPrompt(text))), log.completed("p-f"));
  };
  const runner = grokRunner({ grokHome, tmux, workspace });
  const body = `pedido largo\n${"línea de contexto que hace crecer el pedido\n".repeat(600)}`;

  const output = await execute(await adapterFor(runner, state, "hades", "grok"), body);

  assert.equal(output.reply, "leído del fichero");
  assert.ok(seen !== undefined);
  assert.ok(Buffer.byteLength(seen.pasted) < 12_000, `pasted ${String(Buffer.byteLength(seen.pasted))} bytes`);
  assert.equal(seen.mode, 0o600);
  assert.ok(seen.content.includes("línea de contexto que hace crecer el pedido"), "the file holds the request");
  const id = correlationIdFromPrompt(seen.pasted);
  assert.ok(seen.content.includes(id), "the file carries the same correlation id as the pointer");
  assert.deepEqual((await readdir(join(workspace, ".cauce", "pedidos"))).filter((name) => name !== ".gitignore"), [], "the file is removed once the turn ends");
  assert.equal(await readFile(join(workspace, ".cauce", "pedidos", ".gitignore"), "utf8"), "*\n", "never committed by a git add -A");
});
