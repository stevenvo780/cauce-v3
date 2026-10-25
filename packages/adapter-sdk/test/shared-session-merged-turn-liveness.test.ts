/** Merged child turns keep their parent delivery alive until the terminal event. */
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  FakeTmux,
  adapterFor,
  assistantEntry,
  claudeRunner,
  correlationIdFromPrompt,
  envelopeText,
  execute,
  freshState,
  randomUUID,
  userEntry,
  type TmuxResult,
} from "./shared-session-fixtures.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(ms, 1)));

test("un turno fundido callado en el transcript pero con el panel GENERANDO no se degüella", async () => {
  const { state, home, workspace } = await freshState("fundido-callado-generando");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "pensá esto largo y tendido", sessionId)}\n`);

  const tmux = new FakeTmux();
  tmux.paneContent = "✻ Herding… (esc to interrupt · ctrl+t to hide todos)\n❯ ";

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    correlationTimeoutMs: 20,
    // Silence window an order of magnitude SHORTER than the block of thinking that follows it.
    quietTimeoutMs: 60,
    turnTimeoutMs: 20_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");

  tmux.onSubmit = (text) => {
    const correlationId = correlationIdFromPrompt(text);
    void (async () => {
      // Not one byte written meanwhile: on disk this is indistinguishable from a lost paste.
      await delay(500);
      await appendFile(
        file,
        `${assistantEntry(
          randomUUID(),
          duenio,
          envelopeText("lo pensado", correlationId),
          sessionId,
        )}\n`,
      );
    })();
  };

  const output = await execute(adapter);

  assert.equal(output.status, "done");
  assert.ok((output.reply ?? "").includes("lo pensado"), output.reply ?? "(null)");
});

test("un panel que ya no se puede capturar no cuenta como vivo y la entrega se suelta igual", async () => {
  const { state, home, workspace } = await freshState("fundido-captura-rota");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  await appendFile(file, `${userEntry(randomUUID(), null, "algo viejo", sessionId)}\n`);

  const tmux = new FakeTmux();
  tmux.paneContent = "✻ Herding… (esc to interrupt)\n❯ ";
  let capturaRota = false;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    if (capturaRota && args[0] === "capture-pane") {
      return { exitCode: 1, stdout: "", stderr: "can't find pane" };
    }
    return originalRun(args, stdin, control);
  };
  // The paste is lost and, right after it, the pane stops answering captures.
  tmux.onSubmit = () => {
    capturaRota = true;
  };

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 20,
    // Long budget on purpose: what must release the session is the silence, not the deadline.
    turnTimeoutMs: 600_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");

  const empezo = Date.now();
  await assert.rejects(
    execute(adapter),
    (error: Error) => /correlation deadline of 20 ms/iu.test(error.message),
  );
  assert.ok(Date.now() - empezo < 9_000, `tardó ${String(Date.now() - empezo)} ms`);
});
