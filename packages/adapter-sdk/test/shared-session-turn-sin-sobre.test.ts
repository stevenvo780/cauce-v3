import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  FakeTmux, RecordingFallback, adapterFor, claudeRunner, execute, freshState, userEntry,
} from "./shared-session-fixtures.js";

const delay = (ms: number): Promise<void> => new Promise((resolve_) => setTimeout(resolve_, ms));

/**
 * A localized turn that ends with no envelope: the harness dies (a provider error painted by the
 * TUI, an interrupt, a cleared session) after opening its own turn. Waiting for the whole budget
 * would hold the alias's only slot for hours while the queue piles up behind it.
 */
test("un turno correlacionado que termina sin sobre se suelta cuando el panel vuelve al prompt", async () => {
  const { state, home, workspace } = await freshState("sin-sobre");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "algo viejo", sessionId)}\n`);

  const tmux = new FakeTmux();
  tmux.paneContent = "❯ ";
  const fallback = new RecordingFallback("no debería usarse");
  tmux.onSubmit = (text: string): void => {
    void appendFile(file, `${userEntry(randomUUID(), duenio, text, sessionId)}\n`);
  };

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 60,
    turnTimeoutMs: 600_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");

  const empezo = Date.now();
  await assert.rejects(
    execute(adapter),
    (error: Error) => /execution deadline/iu.test(error.message),
  );
  assert.ok(Date.now() - empezo < 30_000, `tardó ${String(Date.now() - empezo)} ms`);
  assert.equal(fallback.calls, 0);
});
