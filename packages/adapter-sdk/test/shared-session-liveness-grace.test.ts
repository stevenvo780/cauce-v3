import assert from "node:assert/strict";
import test from "node:test";
import {
  adapterFor,
  correlationIdFromPrompt,
  envelopeText,
  execute,
} from "./shared-session-fixtures.js";
import type { TmuxResult } from "./shared-session-fixtures.js";
import { GrokTmux, grokRunner, grokWorkspace } from "./grok-shared-session-fixtures.js";

// ---------------------------------------------------------------------------------------------
// perseo 16c3a019 / teseo 8f1a58d9 (2026-11-04): on a host saturated by I/O one liveness read of
// the pane missed its tmux budget while the TUI kept working; the turn was fenced as ambiguous
// and died, although the same generation answered half an hour later.
// ---------------------------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** While `blackout()` holds, every read of the exact pane and every pane listing fails. */
function paneReadsFailWhile(tmux: GrokTmux, blackout: () => boolean): { failed: number } {
  const counter = { failed: 0 };
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control): Promise<TmuxResult> => {
    const exactPaneRead = args[0] === "display-message" && args.some((argument) => /^%[0-9]+$/u.test(argument));
    if (blackout() && (exactPaneRead || args[0] === "list-panes")) {
      counter.failed += 1;
      return { exitCode: 1, stdout: "", stderr: "tmux: timed out\n" };
    }
    return originalRun(args, stdin, control);
  };
  return counter;
}

test("una lectura del pane que falla un rato no mata el turno: la respuesta llega igual", async () => {
  const { state, grokHome, log } = await grokWorkspace("liveness-ciego-breve");
  const tmux = new GrokTmux();
  let blind = false;
  const reads = paneReadsFailWhile(tmux, () => blind);
  tmux.onSubmit = async (text) => {
    const correlation = correlationIdFromPrompt(text);
    await log.append(log.user(text), log.thought("p-carga"));
    blind = true;
    void (async () => {
      await delay(60);
      blind = false;
      await delay(20);
      await log.append(log.message("p-carga", envelopeText("respondí pese a la carga", correlation)), log.completed("p-carga"));
    })();
  };

  const runner = grokRunner({ grokHome, tmux, livenessGraceMs: 5_000 });
  const output = await execute(await adapterFor(runner, state, "teseo", "grok"));

  assert.equal(output.reply, "respondí pese a la carga");
  assert.ok(reads.failed > 0, "el turno sí atravesó lecturas fallidas del pane");
  assert.equal(runner.takeDegradation(), undefined);
});

test("si el pane sigue ilegible más allá de la gracia, el turno queda ambiguo como antes", async () => {
  const { grokHome, log } = await grokWorkspace("liveness-ciego-largo");
  const tmux = new GrokTmux();
  let blind = false;
  paneReadsFailWhile(tmux, () => blind);
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.thought("p-ciego"));
    blind = true;
  };

  const outcome = await grokRunner({ grokHome, tmux, livenessGraceMs: 40 }).run({
    command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /dejó de acreditar la generación/u);
});

test("la gracia no tapa una generación reemplazada: eso sigue cerrando el turno al instante", async () => {
  const { grokHome, log } = await grokWorkspace("liveness-ciego-y-reemplazo");
  const tmux = new GrokTmux();
  let blind = false;
  paneReadsFailWhile(tmux, () => blind);
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.thought("p-reemplazo"));
    blind = true;
    void (async () => {
      await delay(30);
      tmux.sessionExists = false;
      blind = false;
    })();
  };

  const outcome = await grokRunner({ grokHome, tmux, livenessGraceMs: 5_000 }).run({
    command: "grok", args: [], harness: "grok", stdin: "pedido", timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /desapareció o cambió/u);
});
