import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PasteSessionRunner, turnBudgetMs } from "../src/shared-session/paste-runner.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import {
  claudeTranscript,
  findFinalAssistant,
  type TranscriptEntry,
} from "../src/shared-session/transcript.js";
import {
  FakeTmux,
  RecordingFallback,
  claudeRunner,
  freshState,
  userEntry,
} from "./shared-session-fixtures.js";

const immediate = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// A turn's budget comes from the configured delivery, not from implicit limits.
// ---------------------------------------------------------------------------

test("sin recorte explicito, el turno usa el presupuesto de la entrega", () => {
  const veinticuatroHoras = 24 * 60 * 60_000;
  assert.equal(turnBudgetMs(veinticuatroHoras), veinticuatroHoras);
});

test("no queda ningun techo de una hora escondido", () => {
  const unaHora = 3_600_000;
  // El caso exacto que mato las entregas de kratos: la entrega pedia mucho mas de una hora.
  assert.ok(turnBudgetMs(6 * unaHora) > unaHora, "un turno de 6 h no puede recortarse a 1 h");
  assert.equal(turnBudgetMs(unaHora + 1), unaHora + 1);
});

test("un recorte explicito acota, y solo hacia abajo", () => {
  assert.equal(turnBudgetMs(10_000, 2_000), 2_000);
  // Un recorte mayor que el presupuesto no puede AMPLIARLO: la entrega manda.
  assert.equal(turnBudgetMs(2_000, 10_000), 2_000);
});

// ---------------------------------------------------------------------------
// The correlation cut releases the session if a paste never appears in the transcript.
// ---------------------------------------------------------------------------

test("un pegado que nunca aparece en el registro suelta la sesion en vez de retenerla", async () => {
  const { state: _state, home, workspace } = await freshState("pegado-perdido");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-zeus";
  const fallback = new RecordingFallback("{}");
  // The paste is lost: the TUI NEVER writes the entry into the transcript.
  tmux.onSubmit = async () => {
    return;
  };

  const runner = new PasteSessionRunner({
    alias: "zeus",
    harness: "claude",
    workspace,
    transcript: claudeTranscript(join(home, ".claude"), workspace),
    tmux,
    fallback,
    sleep: immediate,
    acquireTimeoutMs: 30,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    // Huge budget (like the real 24 h), short correlation cut.
    turnTimeoutMs: 60 * 60_000,
    correlationTimeoutMs: 20,
    // Since `fix/fusion-turnos-20260806`, releasing a lost paste requires TWO things: the
    // correlation deadline must expire AND the transcript must go `quietTimeoutMs` without
    // growing. Trimming only the first one no longer shortens anything: the silence stayed at
    // its 5 min default and this test took 300 s of clock time —measured: 300003 ms, 90% of the
    // whole adapter-sdk suite— and under load dragged two `engine-session-queue` tests into
    // `cancelledByParent`. Nothing changes in production, so recalibrating the test is enough:
    // with the defaults the two deadlines start together at t0 and expire together at 5 min.
    quietTimeoutMs: 20,
  });

  const outcome = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "pedido que se perdio",
    timeoutMs: 24 * 60 * 60_000,
    signal: new AbortController().signal,
  });

  // Releases the session as AMBIGUOUS...
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.harnessStarted, undefined);
  // ...and does NOT re-run it through the fallback path: if the paste had actually entered, it would run twice.
  assert.equal(fallback.calls, 0);
  assert.match(outcome.stderr, /correlated boundary.*cuarentena/u);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  tmux.paneContent = "✻ Herding… (esc to interrupt)\n❯ ";
  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "la siguiente entrega no reutiliza el pane",
    timeoutMs: 24 * 60 * 60_000,
    signal: new AbortController().signal,
  });
  assert.equal(fallback.calls, 1, "el pane sigue generando: la cuarentena no se levanta sola");
  assert.equal(tmux.submittedCount, 1, "no se pega nada en una generacion que no prueba estar ociosa");
});

test("el timeout general con turno correlacionado bloquea la generación hasta un límite terminal", async () => {
  const { home, workspace } = await freshState("timeout-correlacionado-sin-final");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "turno previo", sessionId)}\n`);
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    await appendFile(file, `${userEntry(randomUUID(), head, text, sessionId)}\n`);
    tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  };
  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    turnTimeoutMs: 20,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(ms, 1))),
  });

  const first = await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "turno correlacionado sin desenlace",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(first.timedOut, true);
  assert.equal(first.harnessStarted, undefined);
  assert.match(first.stderr, /budget ended.*cuarentena/u);
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  assert.match(tmux.sessionOptions.get("@cauce_quarantined_pane") ?? "", /^\$0:@0:%0:4242$/u);

  await runner.run({
    command: "claude",
    args: [],
    harness: "claude",
    stdin: "no compartir pane tras timeout ambiguo",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(fallback.calls, 1);
  assert.equal(tmux.submittedCount, 1);
});

// ---------------------------------------------------------------------------
// A compaction with non-linear references must not prevent harvesting the final response.
// ---------------------------------------------------------------------------

test("una compactacion con la cadena rota no deja la respuesta sin cosechar", () => {
  // Reproduces the exact shape: injected user -> compaction -> response, with the cycle.
  const entries = [
    { type: "user", uuid: "u-inyectado", message: { role: "user", content: "pedido del bus" } },
    { type: "system", subtype: "compact_boundary", uuid: "b-boundary", parentUuid: null, logicalParentUuid: "x-adelante" },
    { type: "assistant", uuid: "a-1", parentUuid: "b-boundary", message: { role: "assistant", content: [{ type: "text", text: "intermedio" }] } },
    { type: "user", uuid: "x-adelante", parentUuid: "a-1", message: { role: "user", content: "resumen" } },
    {
      type: "assistant",
      uuid: "a-final",
      parentUuid: "x-adelante",
      message: { role: "assistant", content: [{ type: "text", text: "la respuesta de verdad" }], stop_reason: "end_turn" },
    },
  ] as unknown as TranscriptEntry[];

  const encontrada = findFinalAssistant(entries, "u-inyectado");
  assert.ok(encontrada !== undefined, "la respuesta posterior a una compactacion tiene que cosecharse");
  assert.equal(encontrada.text, "la respuesta de verdad");
});

test("sin compactacion de por medio se sigue exigiendo descendencia real", () => {
  // What the owner types in parallel does NOT descend from our entry and must not be harvested.
  const entries = [
    { type: "user", uuid: "u-inyectado", message: { role: "user", content: "pedido del bus" } },
    { type: "user", uuid: "u-del-dueno", message: { role: "user", content: "otra cosa" } },
    {
      type: "assistant",
      uuid: "a-del-dueno",
      parentUuid: "u-del-dueno",
      message: { role: "assistant", content: [{ type: "text", text: "respuesta ajena" }], stop_reason: "end_turn" },
    },
  ] as unknown as TranscriptEntry[];

  assert.equal(findFinalAssistant(entries, "u-inyectado"), undefined);
});