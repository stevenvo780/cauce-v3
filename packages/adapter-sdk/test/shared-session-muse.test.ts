import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseMuseOutput } from "../src/sdk/output-parser.js";
import {
  harnessConfigDirectory,
  loadSharedSessionConfig,
  museReasoningEffort,
} from "../src/shared-session/config.js";
import {
  ensureMuseLoginLink,
  museConversationHistoryState,
  museSessionFiles,
  museSessionIsSecure,
  museTranscript,
  type MuseLogLine,
} from "../src/shared-session/muse.js";
import { SharedTuiPointerStore } from "../src/shared-session/native-pointer.js";
import { inputBoxState, turnInFlight } from "../src/shared-session/pane.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { resolveMuseLaunch } from "../src/shared-session/resume.js";
import { paneCommandMatches } from "../src/shared-session/session/identity.js";
import { tuiProfile } from "../src/shared-session/tui-profile.js";
import { SHARED_SESSION_HARNESSES } from "../src/shared-session/types.js";
import {
  FakeTmux,
  adapterFor,
  correlationIdFromPrompt,
  envelopeText,
  execute,
  freshState,
} from "./shared-session-fixtures.js";

// Muse Code 1.4.0 measured in ws-humanizar (tmux 130x40): a bracketed paste plus a
// SEPARATE Enter submits; `session.jsonl` records the prompt verbatim in
// `runtime.user_intent.accepted`, the answer in `assistant_message_committed` and the close in
// `terminal`, all tied by `run_id` (= the intent id on an idle TUI).

const IDLE_PANE = [
  "  Muse Code 1.4.0",
  "",
  "  Model set to muse-spark-1.3-contributor",
  "  ⎿  Your content, including inter-session messages, may be used for product improvement.",
  "",
  "❯ respondé solo con la palabra PERA",
  "",
  "◆ PERA",
  "",
  "─".repeat(130),
  "❯",
  "─".repeat(130),
  "  muse-spark-1.3-contributor · max · /workspace · YOLO",
].join("\n");

const WORKING_PANE = [
  "❯ Contá del 1 al 30, un número por línea.",
  "◇ Thinking (11s · esc to interrupt)",
  "  Evaluating whether to run a 30-step sleep loop versus providing the count without delays.",
  "• Queued input",
  "  ↳ Segundo pedido: decí solo MANZANA.",
  "─".repeat(130),
  "❯",
  "─".repeat(130),
  "  muse-spark-1.3-contributor · low · /tmp/musetest · YOLO                        steering the running turn",
].join("\n");

/** Writes `session.jsonl` records shaped like Muse 1.4.0's. */
class MuseLog {
  private sequence = 0;

  constructor(readonly file: string, readonly sessionId: string) {}

  private record(payloadType: string, payload: Record<string, unknown>): Record<string, unknown> {
    this.sequence += 1;
    return {
      schema_version: 1,
      id: randomUUID(),
      stream: { kind: "session", id: this.sessionId },
      sequence: this.sequence,
      recorded_at: 1_790_555_476_699_047 + this.sequence,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: payloadType,
      payload_schema_version: 1,
      payload,
    };
  }

  private run(runId: string, event: Record<string, unknown>): string {
    return JSON.stringify(this.record("runtime.session", { event, kind: "run", run_id: runId }));
  }

  intent(intentId: string, text: string): string {
    return JSON.stringify(this.record("runtime.user_intent.accepted", {
      bindings: [], delivery_policy: "session_current", intent_id: intentId,
      model_messages: [{ content: [{ kind: "text", text }] }],
      refill_blocks: [{ kind: "text", text }],
    }));
  }

  started(runId: string, prompt: string): string {
    return this.run(runId, { kind: "started", prompt });
  }

  message(runId: string, text: string): string {
    return this.run(runId, {
      kind: "assistant_message_committed", message_id: randomUUID(), provider_item_id: "msg_1",
      response_id: "resp_1", text,
    });
  }

  tools(runId: string): string {
    return this.run(runId, { kind: "assistant_tool_calls_committed", message_id: randomUUID(), tool_calls: [] });
  }

  terminal(runId: string, terminal = "completed", reason: unknown = null): string {
    return this.run(runId, { kind: "terminal", reason, terminal, turn_duration_ms: 10_026 });
  }

  compaction(runId: string): string {
    return this.run(runId, { kind: "context_compaction_installed", install_id: "install-1517" });
  }

  /** A `retained_frame` line: several records serialized inside `children[].record_json`. */
  frame(...lines: readonly string[]): string {
    return JSON.stringify({
      retained_frame: "session_permission_transaction",
      frame_schema_version: 1,
      outer_log_ordinal: 1,
      transaction_id: randomUUID(),
      children: lines.map((line, index) => ({ child_index: index, record_json: line })),
    });
  }

  async append(...lines: readonly string[]): Promise<void> {
    await appendFile(this.file, `${lines.join("\n")}\n`);
  }
}

function museSessionId(): string {
  // Muse mints UUIDv7; the listing only needs the canonical shape.
  const hex = randomUUID().replace(/-/gu, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function museWorkspace(name: string, options: { history?: boolean } = {}): Promise<{
  state: string;
  home: string;
  museData: string;
  log: MuseLog;
}> {
  const { state, home } = await freshState(name);
  const museData = join(home, ".local", "share", "cauce-v3", "config", "hegel", ".local", "share", "muse");
  const sessionId = museSessionId();
  const directory = join(museData, "sessions", "2026", "09", "28", sessionId);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  // Folders Muse keeps next to the sessions that are NOT conversations.
  await mkdir(join(museData, "sessions", ".msp-view-v1", sessionId), { recursive: true });
  await mkdir(join(directory, "subagent", randomUUID()), { recursive: true });
  const log = new MuseLog(join(directory, "session.jsonl"), sessionId);
  if (options.history !== false) {
    await log.append(log.intent("i-previo", "respondé solo: hola"), log.started("i-previo", "respondé solo: hola"),
      log.message("i-previo", "hola"), log.terminal("i-previo"));
  } else {
    await writeFile(log.file, "");
  }
  return { state, home, museData, log };
}

const entries = (lines: readonly string[]): MuseLogLine[] => lines.map((line) => JSON.parse(line) as MuseLogLine);

test("muse es un arnés de sesión compartida con su propia fila de comportamiento de TUI", () => {
  assert.ok(SHARED_SESSION_HARNESSES.includes("muse"));
  assert.deepEqual(tuiProfile("muse"), {
    interruptKey: "Escape",
    interruptOnlyWhileGenerating: true,
    pasteOnlyWhenIdle: true,
    clearCommand: "/clear",
    focusKey: undefined,
  });
});

test("muse: la línea de trabajo cuenta como turno en vuelo y la caja vacía como libre", () => {
  assert.equal(turnInFlight(WORKING_PANE), true);
  assert.equal(turnInFlight(IDLE_PANE), false);
  assert.equal(inputBoxState(IDLE_PANE).kind, "free");
  assert.equal(inputBoxState(IDLE_PANE.replace(/❯\n(─+)\n {2}muse/u, "❯ texto a medio escribir\n$1\n  muse")).kind, "busy");
});

test("muse: SHARED_SESSION=1 usa un XDG_DATA_HOME propio del alias, esfuerzo max y las flags del puente", () => {
  const config = loadSharedSessionConfig("muse", "hegel", "/state/hegel", {
    CAUCE_SHARED_SESSION: "1", HOME: "/home/dev",
  });
  const dataHome = "/home/dev/.local/share/cauce-v3/config/hegel/.local/share";
  assert.equal(config?.configDirectory, `${dataHome}/muse`);
  assert.deepEqual(config.paneEnvironment, { XDG_DATA_HOME: dataHome });
  assert.deepEqual(config.harnessArguments, ["--yolo", "--trust-workspace", "--reasoning-effort", "max"]);
  assert.equal(museReasoningEffort({ MUSE_REASONING_EFFORT: "xhigh" }), "xhigh");
  assert.throws(() => museReasoningEffort({ MUSE_REASONING_EFFORT: "turbo" }));
  assert.equal(harnessConfigDirectory("muse", "/home/dev", { CAUCE_MUSE_DATA_HOME: "/datos/muse" }, "hegel"),
    "/datos/muse/muse");
  assert.throws(() => harnessConfigDirectory("muse", "/home/dev", {}), /alias/u);
});

test("muse: el comando del panel se reconoce como muse y no como otro arnés", () => {
  const spec = { alias: "hegel", harness: "muse" as const, workspace: "/workspace" };
  const command = "bash -lc exec env XDG_DATA_HOME='/home/dev/.local/share/cauce-v3/config/hegel/.local/share'"
    + " muse --yolo --trust-workspace --reasoning-effort max resume 01a0e56c-52cc-71a2-afe1-2ffabe9a4e2b";
  assert.equal(paneCommandMatches(spec, command), true);
  assert.equal(paneCommandMatches({ ...spec, harness: "claude" }, command), false);
});

test("muse: localiza el pedido por su miembro de correlación y cosecha el ÚLTIMO mensaje del run", async () => {
  const { log } = await museWorkspace("muse-lector");
  const correlation = "a".repeat(64);
  const prompt = `pedido del bus\n{"cauce_correlation_id":"${correlation}"}`;
  const lines = [
    log.intent("i-bus", `${prompt}\n`),
    log.started("i-bus", prompt),
    log.message("i-bus", "Voy a revisar antes de contestar."),
    log.tools("i-bus"),
    log.message("i-bus", envelopeText("hecho desde muse", correlation)),
  ];
  const reader = museTranscript("/no-importa");
  const turn = reader.findInjected(log.file, entries(lines), prompt);
  assert.deepEqual(turn, { key: "i-bus", sessionId: log.sessionId });
  assert.equal(reader.findAnswer(entries(lines), "i-bus"), undefined, "sin terminal el turno sigue en vuelo");
  const done = entries([...lines, log.terminal("i-bus")]);
  const outcome = reader.findAnswer(done, "i-bus");
  assert.equal(outcome?.kind, "answer");
  assert.match(outcome.text, /hecho desde muse/u);
  assert.equal(outcome.sessionId, log.sessionId);
  const envelope = reader.findEnvelope?.(done, correlation, "i-bus");
  assert.equal(envelope?.kind, "answer");
});

test("muse: con el sobre escrito y sin terminal el turno está verificando, no fundido", async () => {
  const { log } = await museWorkspace("muse-verifica");
  const reader = museTranscript("/no-importa");
  const correlation = "b".repeat(64);
  const verifying = [log.intent("i-v", "pedido"), log.started("i-v", "pedido"),
    log.message("i-v", envelopeText("respuesta final", correlation))];
  const lingering = reader.lingering?.(entries(verifying), "i-v");
  assert.equal(lingering?.outcome.kind, "answer", "Double checking: ya respondió, falta el cierre");
  assert.equal(reader.lingering?.(entries([...verifying, log.tools("i-v")]), "i-v"), undefined,
    "si después del mensaje siguió trabajando, no es una respuesta");
  assert.equal(reader.lingering?.(entries([log.intent("i-w", "p"), log.message("i-w", "Voy a revisar.")]), "i-w"),
    undefined, "un mensaje intermedio que no es sobre nunca es respuesta");
  assert.equal(reader.lingering?.(entries([...verifying, log.terminal("i-v")]), "i-v"), undefined,
    "con terminal el turno ya cerró: lo resuelve findAnswer");
});

test("muse: un terminal distinto de completed es un turno fallido, no una respuesta", async () => {
  const { log } = await museWorkspace("muse-fallido");
  const reader = museTranscript("/no-importa");
  const outcome = reader.findAnswer(
    entries([log.intent("i-x", "algo"), log.message("i-x", "a medias"), log.terminal("i-x", "interrupted")]),
    "i-x",
  );
  assert.equal(outcome?.kind, "failed");
});

test("muse: los registros dentro de un retained_frame también cuentan", async () => {
  const { log } = await museWorkspace("muse-frame");
  const reader = museTranscript("/no-importa");
  const framed = entries([log.frame(log.intent("i-f", "pedido enmarcado")), log.frame(log.message("i-f", "ok"),
    log.terminal("i-f"))]);
  assert.equal(reader.findInjected(log.file, framed, "pedido enmarcado")?.key, "i-f");
  const outcome = reader.findAnswer(framed, "i-f");
  assert.equal(outcome?.kind === "answer" ? outcome.text : "", "ok");
});

test("muse: un pedido encolado como steer corre después como su propio run y se le atribuye ése", async () => {
  const { log } = await museWorkspace("muse-steer");
  const reader = museTranscript("/no-importa");
  const lines = entries([
    log.intent("i-dueño", "tarea larga del dueño"), log.started("i-dueño", "tarea larga del dueño"),
    log.intent("i-bus", "pedido del bus"), // Accepted while the owner's run is in flight: queued.
    log.message("i-dueño", "1\n2\n3"), log.terminal("i-dueño"),
    log.started("i-bus", ""), log.message("i-bus", "MANZANA"), log.terminal("i-bus"),
  ]);
  const turn = reader.findInjected(log.file, lines, "pedido del bus");
  assert.equal(turn?.key, "i-bus");
  const outcome = reader.findAnswer(lines, "i-bus");
  assert.equal(outcome?.kind === "answer" ? outcome.text : "", "MANZANA");
});

test("muse: la compactación se avisa una sola vez por su id", async () => {
  const { log } = await museWorkspace("muse-compacta");
  const notices = museTranscript("/no-importa").compactions(entries([log.compaction("i-1")]));
  assert.deepEqual(notices.map((notice) => notice.id), ["install-1517"]);
});

test("muse: la salida sintetizada la entiende el parser de muse exec --json", () => {
  const parsed = JSON.stringify(parseMuseOutput(museTranscript("/x").stdout(envelopeText("hola"), "s-1")));
  assert.match(parsed, /hola/u);
  assert.match(parsed, /s-1/u);
});

test("muse: el inventario lista sólo conversaciones, sin vistas ni subagentes", async () => {
  const { museData, log } = await museWorkspace("muse-inventario");
  assert.deepEqual(await museSessionFiles(museData), [log.file]);
  assert.equal(await museConversationHistoryState(museData), "present");
  assert.equal(await museSessionIsSecure(museData, log.sessionId), true);
  assert.equal(await museSessionIsSecure(museData, museSessionId()), false);
  assert.equal(await museConversationHistoryState(join(museData, "no-existe")), "absent");
});

test("muse: reanuda EXACTO por el puntero y sin puntero con historia se bloquea", async () => {
  const { state, museData, log } = await museWorkspace("muse-reanuda");
  const binding = { alias: "hegel", stateDirectory: state };
  const blocked = await resolveMuseLaunch(museData, "/workspace", binding);
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.detail, /SHARED_SESSION_NATIVE_ID/u);
  const pointer = { alias: "hegel", harness: "muse" as const, configDirectory: museData, workspace: "/workspace" };
  assert.equal(await new SharedTuiPointerStore(state).seed(pointer, log.sessionId), "written");
  assert.deepEqual(await resolveMuseLaunch(museData, "/workspace", binding),
    { state: "launch", args: ["resume", log.sessionId], resumed: true });
  const empty = await museWorkspace("muse-vacio", { history: false });
  assert.deepEqual(await resolveMuseLaunch(empty.museData, "/workspace", { alias: "hegel", stateDirectory: empty.state }),
    { state: "launch", args: [], resumed: false });
});

test("muse: repone el enlace ~/.config/muse al login del alias y nunca pisa uno existente", async () => {
  const { home } = await freshState("muse-enlace");
  assert.equal(await ensureMuseLoginLink(home, "hegel"), "absent", "sin login persistente no inventa nada");
  const login = join(home, ".local", "share", "cauce-v3", "config", "hegel", ".config", "muse");
  await mkdir(login, { recursive: true });
  assert.equal(await ensureMuseLoginLink(home, "hegel"), "linked");
  assert.equal(await readlink(join(home, ".config", "muse")), login);
  assert.ok((await lstat(join(home, ".config", "muse"))).isSymbolicLink());
  assert.equal(await ensureMuseLoginLink(home, "hegel"), "present");
});

test("muse: el turno del bus entra por la caja de la TUI y la respuesta sale de session.jsonl", async () => {
  const { state, museData, log } = await museWorkspace("muse-turno");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-hegel";
  tmux.paneStartCommand = "exec env XDG_DATA_HOME='/d' muse --yolo --trust-workspace --reasoning-effort max";
  tmux.paneContent = IDLE_PANE;
  tmux.onSubmit = async (text) => {
    const correlation = correlationIdFromPrompt(text);
    await log.append(
      log.intent("i-bus", text),
      log.started("i-bus", text),
      log.message("i-bus", "Reviso el estado."),
      log.tools("i-bus"),
      log.message("i-bus", envelopeText("hola desde la TUI de muse", correlation)),
    );
    // Muse writes the close ~9 s after the envelope ("Double checking"): the runner must wait for it.
    setTimeout(() => { void log.append(log.terminal("i-bus")); }, 60);
  };
  const runner = new PasteSessionRunner({
    alias: "hegel",
    harness: "muse",
    workspace: "/workspace",
    transcript: museTranscript(museData),
    tmux,
    sleep: () => Promise.resolve(),
    acquireTimeoutMs: 30,
    generatingWaitMs: 40,
    turnTimeoutMs: 2_000,
    injectTimeoutMs: 2_000,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
  });
  const adapter = await adapterFor(runner, state, "hegel", "muse");
  const output = await execute(adapter);
  assert.equal(output.reply, "hola desde la TUI de muse");
  assert.equal(tmux.submittedCount, 1);
  assert.ok(tmux.calls.some((call) => call[0] === "paste-buffer" && call.includes("-p")),
    "el pedido entra como UN pegado entre corchetes y el Enter va aparte");
  assert.equal(runner.takeDegradation(), undefined);
});
