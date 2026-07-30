import assert from "node:assert/strict";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter } from "../src/harnesses/shared.js";
import { claudeDefinition, codexDefinition } from "../src/harnesses/index.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import type { TmuxController, TmuxResult } from "../src/shared-session/tmux.js";
import { ClaudeSharedSessionRunner } from "../src/shared-session/claude-runner.js";
import {
  CodexSharedSessionRunner,
  type AppServerLink,
  type AppServerMessage,
} from "../src/shared-session/codex-runner.js";
import { CONTEXT_MARK, DEGRADED_MARK, RESET_MARK } from "../src/shared-session/notice.js";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import { inputBoxState } from "../src/shared-session/pane.js";
import {
  descendsFrom,
  findFinalAssistant,
  indexByUuid,
  stripJsonFence,
  type TranscriptEntry,
} from "../src/shared-session/transcript.js";
import {
  ensureSharedSession,
  paneEnvironmentPrefix,
  transcriptDirectory,
  transcriptDirectoryIn,
} from "../src/shared-session/session.js";
import {
  cliSharedSessionSpec,
  loadSharedSessionConfig,
  sharedSessionPaneEnvironment,
} from "../src/shared-session/config.js";

const stateRoot = resolve(".test-state/shared-session");

const ENVELOPE = {
  reply: "hecho",
  messages: [] as const,
  status: "done" as const,
  retryable: false,
  artifacts: [] as const,
};

function envelopeText(reply = "hecho"): string {
  return JSON.stringify({ ...ENVELOPE, reply });
}

async function freshState(name: string): Promise<{ state: string; home: string; workspace: string }> {
  const directory = join(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  const home = join(directory, "home");
  const workspace = "/workspace";
  await mkdir(transcriptDirectory(home, workspace), { recursive: true });
  await mkdir(directory, { recursive: true });
  return { state: directory, home, workspace };
}

/** Una entrada de transcript con la misma forma que escribe `claude` de verdad. */
function userEntry(uuid: string, parentUuid: string | null, text: string, sessionId: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid, isSidechain: false, sessionId,
    promptSource: "typed", message: { role: "user", content: text },
  });
}

function assistantEntry(
  uuid: string,
  parentUuid: string,
  text: string,
  sessionId: string,
  stopReason: string = "end_turn",
): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid, isSidechain: false, sessionId,
    message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] },
  });
}

/**
 * tmux simulado con la fidelidad que estas pruebas necesitan: qué comandos recibió, qué había en
 * la caja de entrada y qué se llegó a pegar. El transcript lo escribe el propio test cuando la
 * "TUI" recibe un Enter, igual que hace claude.
 */
class FakeTmux implements TmuxController {
  readonly calls: string[][] = [];
  sessionExists = true;
  /** Ventanas realmente presentes en la sesión. Por defecto, la de la TUI. */
  windows: string[] = ["agente"];
  paneContent = "❯ ";
  panePid = "4242";
  newSessionFails = false;
  pasted: string | undefined;
  submittedCount = 0;
  onSubmit: ((text: string) => Promise<void> | void) | undefined;

  async run(args: readonly string[], stdin?: string): Promise<TmuxResult> {
    this.calls.push([...args]);
    const [command] = args;
    if (command === "has-session") return ok(this.sessionExists ? 0 : 1);
    // `list-windows` es la única fuente honesta de qué ventanas hay: `display-message` cae a la
    // ventana actual cuando la pedida no existe. El doble modela eso, no lo esquiva.
    if (command === "list-windows") {
      if (!this.sessionExists) return { exitCode: 1, stdout: "", stderr: "can't find session" };
      return { exitCode: 0, stdout: `${this.windows.join("\n")}\n`, stderr: "" };
    }
    if (command === "new-session" || command === "new-window") {
      if (this.newSessionFails) return { exitCode: 1, stdout: "", stderr: "no server running" };
      this.sessionExists = true;
      const nameIndex = args.indexOf("-n");
      const created = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
      if (command === "new-session") this.windows = [];
      if (created !== undefined && !this.windows.includes(created)) this.windows.push(created);
      return ok(0);
    }
    // El renombrado importa de verdad: es lo que enclavaba la sesión. El doble lo aplica sobre la
    // lista de ventanas para que `list-windows` deje de ver la ventana vieja, igual que tmux.
    if (command === "rename-window") {
      const target = args[2] ?? "";
      const from = target.slice(target.lastIndexOf(":") + 1);
      const to = args[3];
      const index = this.windows.indexOf(from);
      if (index < 0 || to === undefined) return { exitCode: 1, stdout: "", stderr: "can't find window" };
      this.windows[index] = to;
      return ok(0);
    }
    if (command === "capture-pane") return { exitCode: 0, stdout: this.paneContent, stderr: "" };
    if (command === "display-message" && args[1] === "-p") {
      return { exitCode: 0, stdout: `${this.panePid}\n`, stderr: "" };
    }
    if (command === "load-buffer") {
      this.pasted = stdin ?? "";
      return ok(0);
    }
    if (command === "send-keys" && args.includes("Enter")) {
      this.submittedCount += 1;
      const text = this.pasted;
      if (text !== undefined && this.onSubmit !== undefined) await this.onSubmit(text);
      return ok(0);
    }
    return ok(0);
  }

  used(command: string): boolean {
    return this.calls.some((call) => call[0] === command);
  }
}

function ok(exitCode: number): TmuxResult {
  return { exitCode, stdout: "", stderr: "" };
}

/** El camino de siempre. Registra si lo llamaron, que es justo lo que hay que poder afirmar. */
class RecordingFallback implements CommandRunner {
  calls = 0;
  constructor(private readonly stdout: string) {}
  run(_request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    return Promise.resolve({
      stdout: this.stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false,
    });
  }
}

const immediate = (): Promise<void> => Promise.resolve();

function claudeRunner(
  options: { alias: string; home: string; workspace: string; tmux: FakeTmux; fallback: CommandRunner },
): ClaudeSharedSessionRunner {
  return new ClaudeSharedSessionRunner({
    alias: options.alias,
    home: options.home,
    workspace: options.workspace,
    tmux: options.tmux,
    fallback: options.fallback,
    sleep: immediate,
    acquireTimeoutMs: 30,
    turnTimeoutMs: 2_000,
    pollMs: 1,
    readyTimeoutMs: 30,
  });
}

async function adapterFor(
  runner: CommandRunner,
  state: string,
  alias: string,
  harness: "claude" | "codex",
): Promise<HarnessAdapter> {
  const store = await DurableStore.open(join(state, "store"));
  return new HarnessAdapter({
    definition: harness === "claude" ? claudeDefinition : codexDefinition,
    runner,
    store,
    sessionNamespace: alias,
    sharedSession: { alias, harness, stateDirectory: state },
  });
}

function execute(adapter: HarnessAdapter, prompt = "hola"): Promise<{
  reply: string | null;
  messages: readonly unknown[];
  status: string;
}> {
  return adapter.execute({
    prompt,
    sessionKey: "auth-v2:prueba",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------
// 1. El bus sigue produciendo el sobre, y lo hace a través de la TUI real.
// ---------------------------------------------------------------------------

test("el turno del bus produce el sobre completo cosechado del transcript", async () => {
  const { state, home, workspace } = await freshState("sobre");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    // El modelo responde envuelto en vallado Markdown, como se midió en la TUI de verdad.
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), userUuid, "```json\n" + envelopeText("desde la TUI") + "\n```", sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "desde la TUI");
  assert.equal(output.status, "done");
  assert.deepEqual(output.messages, []);
  // El sobre salió de la sesión compartida, no del camino de siempre.
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  // Y sin ningún aviso pegado: el turno sí pasó por la terminal.
  assert.ok(!(output.reply ?? "").includes(DEGRADED_MARK));
  assert.deepEqual(await readDegradations(state), []);
});

// ---------------------------------------------------------------------------
// 2. La TUI del dueño NO tiene que hablar el contrato del bus.
// ---------------------------------------------------------------------------

test("los turnos en prosa del dueño conviven con el sobre del bus", async () => {
  const { state, home, workspace } = await freshState("prosa");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  // Conversación previa del dueño: preguntas y respuestas en prosa, sin una sola llave.
  let head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "que tal vas?", sessionId)}\n`);
  const proseAnswer = randomUUID();
  await appendFile(file, `${assistantEntry(proseAnswer, head, "Bien, terminando el informe.", sessionId)}\n`);
  head = proseAnswer;

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("respuesta del bus"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // La prosa del dueño no rompió nada y no se coló como resultado del bus.
  assert.equal(output.reply, "respuesta del bus");
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// 3. Los dos ven el MISMO contexto: una sola rama, y se verifica la descendencia.
//    Esta es la prueba de regresión exacta de por qué la salida (a) quedó descartada.
// ---------------------------------------------------------------------------

test("no se cosecha una respuesta de una rama hermana", async () => {
  const { state, home, workspace } = await freshState("rama");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const shared = randomUUID();
  await appendFile(file, `${userEntry(shared, null, "cabeza comun", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    // Rama HERMANA: cuelga del mismo padre que nuestro turno, exactamente como pasaba con
    // `--print --resume` corriendo en paralelo a la TUI. No debe cosecharse jamás.
    const sibling = randomUUID();
    await appendFile(file, `${userEntry(sibling, shared, "otro pedido", sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), sibling, envelopeText("RAMA HERMANA"), sessionId)}\n`);
    // Nuestra rama, colgando de la cabeza de la propia TUI.
    const mine = randomUUID();
    await appendFile(file, `${userEntry(mine, shared, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), mine, envelopeText("MI RAMA"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "MI RAMA");
});

test("el turno del bus cuelga de la cabeza viva de la TUI, no de la raiz", async () => {
  const { state, home, workspace } = await freshState("cabeza");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const root = randomUUID();
  const head = randomUUID();
  await appendFile(file, `${userEntry(root, null, "primero", sessionId)}\n`);
  await appendFile(file, `${assistantEntry(head, root, "listo", sessionId)}\n`);

  let injectedParent: string | undefined;
  const tmux = new FakeTmux();
  tmux.onSubmit = async (text) => {
    // La TUI encadena desde su cabeza en memoria: eso es lo que da UNA sola rama.
    injectedParent = head;
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("ok"), sessionId)}\n`);
  };

  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback: new RecordingFallback("{}"),
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  await execute(adapter);
  assert.equal(injectedParent, head);
});

// ---------------------------------------------------------------------------
// 4. Escrituras simultáneas: el bus NUNCA escribe encima del dueño.
// ---------------------------------------------------------------------------

test("con la caja ocupada el bus espera y no pega nada", async () => {
  const { state, home, workspace } = await freshState("ocupada");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.paneContent = "❯ estoy escribiendo algo a medias";
  let releases = 0;
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    if (args[0] === "capture-pane") {
      releases += 1;
      // El dueño suelta la línea al tercer sondeo.
      if (releases >= 3) tmux.paneContent = "❯ ";
      // Antes de soltarla no se pudo haber pegado nada.
      if (releases < 3) assert.equal(tmux.pasted, undefined);
    }
    return originalRun(args, stdin);
  };
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("tras esperar"), sessionId)}\n`);
  };

  const runner = claudeRunner({
    alias: "kratos", home, workspace, tmux, fallback: new RecordingFallback("{}"),
  });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(output.reply, "tras esperar");
  assert.ok(releases >= 3, "tuvo que sondear hasta que la caja quedo libre");
});

test("una caja que nunca se libera degrada con aviso y sin inyectar", async () => {
  const { state, home, workspace } = await freshState("nunca-libre");
  const tmux = new FakeTmux();
  tmux.paneContent = "❯ el dueno dejo esto a medias";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("por el camino viejo") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // Nunca se tocó la caja del dueño.
  assert.equal(tmux.pasted, undefined);
  assert.equal(tmux.submittedCount, 0);
  // Se respondió, pero DICIÉNDOLO.
  assert.equal(fallback.calls, 1);
  assert.ok((output.reply ?? "").includes(DEGRADED_MARK));
  assert.ok((output.reply ?? "").includes("input_busy"));
  assert.ok((output.reply ?? "").includes("por el camino viejo"));
});

// ---------------------------------------------------------------------------
// 5. El mecanismo caído SE AVISA. Es donde murió el intento anterior.
// ---------------------------------------------------------------------------

test("sin sesion compartida se responde igual pero el aviso viaja en el reply", async () => {
  const { state, home, workspace } = await freshState("caido");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.newSessionFails = true;
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("respuesta clasica") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.equal(fallback.calls, 1);
  const reply = output.reply ?? "";
  assert.ok(reply.includes(DEGRADED_MARK), "el aviso tiene que llegar por Telegram");
  assert.ok(reply.includes("session_absent"));
  assert.ok(reply.includes("cauce kratos"), "tiene que decir como restablecerlo");
  assert.ok(reply.includes("respuesta clasica"), "la respuesta real no se pierde");

  // Y queda registrado de forma durable, que es lo que `cauce <alias>` muestra al entrar.
  const records = await readDegradations(state);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.reason, "session_absent");
  assert.equal(records[0]?.alias, "kratos");
  assert.equal(records[0]?.fellBack, true);

  // Y el panel del dueño lo dice también: mensaje inmediato + barra en rojo.
  assert.ok(tmux.calls.some((call) => call[0] === "display-message" && call.includes("-d")));
  assert.ok(tmux.calls.some((call) => call[0] === "set-option" && call.includes("status-style")));
  // Pero SIN renombrar la ventana. Ver la prueba de enclavamiento de más abajo.
  assert.equal(tmux.used("rename-window"), false);
});

test("una TUI reiniciada avisa aunque el turno si pase por la terminal", async () => {
  const { state, home, workspace } = await freshState("reinicio");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("sigo aca"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  await execute(adapter);

  // claude se auto-actualiza y se relanza: el panel pasa a ser otro proceso.
  tmux.panePid = "9999";
  const second = await execute(adapter, "segundo");

  const reply = second.reply ?? "";
  assert.ok(reply.includes(RESET_MARK), "el reinicio se tiene que ver");
  assert.ok(reply.includes("context_reset"));
  assert.ok(reply.includes("sigo aca"), "el turno si paso por la terminal");
  assert.equal(fallback.calls, 0, "un reinicio NO es motivo para caer al camino viejo");
});

// ---------------------------------------------------------------------------
// codex: el sobre llega como campo tipado del protocolo.
// ---------------------------------------------------------------------------

class FakeLink implements AppServerLink {
  readonly sent: Record<string, unknown>[] = [];
  private queue: AppServerMessage[] = [];
  private waiter: ((value: IteratorResult<AppServerMessage>) => void) | undefined;
  private ended = false;

  /**
   * `eager` emite las notificaciones del turno ANTES de contestar a `turn/start`. El servidor
   * puede hacerlo, y un cliente que descarte lo que llega mientras espera una respuesta se queda
   * colgado para siempre.
   */
  constructor(
    private readonly threads: readonly string[],
    private readonly answer?: string,
    private readonly eager = false,
  ) {}

  open(): Promise<void> {
    return Promise.resolve();
  }

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
    const id = message.id;
    if (message.method === "initialize") this.push({ id, result: {} });
    if (message.method === "thread/loaded/list") this.push({ id, result: { data: this.threads } });
    if (message.method === "thread/resume") this.push({ id, result: {} });
    if (message.method === "turn/start") {
      const threadId = this.threads[this.threads.length - 1];
      const answer = (): void => {
        // El pedido vuelve como `userMessage`: un TIPO DISTINTO. Por eso no existe la ambigüedad
        // del eco que descalificó a la salida (b).
        this.push({
          method: "item/completed",
          params: { threadId, turnId: "t1", item: { id: "i0", type: "userMessage", content: [] } },
        });
        this.push({
          method: "item/completed",
          params: {
            threadId, turnId: "t1",
            item: { id: "i1", type: "agentMessage", text: this.answer ?? envelopeText("desde codex"), phase: "final_answer" },
          },
        });
        this.push({ method: "turn/completed", params: { threadId, turn: { id: "t1", status: "completed", items: [] } } });
      };
      if (this.eager) answer();
      this.push({ id, result: { turn: { id: "t1", status: "inProgress", items: [] } } });
      if (!this.eager) answer();
    }
  }

  messages(): AsyncIterable<AppServerMessage> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AppServerMessage> => ({
        next: (): Promise<IteratorResult<AppServerMessage>> => {
          const value = this.queue.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (this.ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolveNext) => {
            this.waiter = resolveNext;
          });
        },
      }),
    };
  }

  close(): void {
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  private push(message: AppServerMessage): void {
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.queue.push(message);
      return;
    }
    this.waiter = undefined;
    waiter({ value: message, done: false });
  }
}

function codexRunner(
  alias: string,
  tmux: FakeTmux,
  fallback: CommandRunner,
  link: AppServerLink,
): CodexSharedSessionRunner {
  return new CodexSharedSessionRunner({
    alias,
    workspace: "/workspace",
    // El socket se comprueba con `access`; se apunta a un fichero que sí existe para que la
    // prueba ejercite el protocolo y no el chequeo de presencia.
    socketPath: resolve("package.json"),
    tmux,
    fallback,
    sleep: immediate,
    turnTimeoutMs: 2_000,
    readyTimeoutMs: 30,
    connect: () => link,
  });
}

test("codex saca el sobre de un campo tipado del protocolo", async () => {
  const { state } = await freshState("codex-sobre");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const link = new FakeLink(["019fb4a9-25f7-7f10-92ac-871fd93b2989"]);

  const runner = codexRunner("socrates", tmux, fallback, link);
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "desde codex");
  assert.equal(fallback.calls, 0);
  // `thread/resume` es lo que suscribe: sin él no llega ninguna notificación.
  const methods = link.sent.map((message) => message.method);
  assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/resume", "turn/start"]);
});

test("codex sin hilo vivo degrada con aviso en vez de fingir que comparte", async () => {
  const { state } = await freshState("codex-sin-hilo");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback(
    [JSON.stringify({ type: "thread.started", thread_id: "x" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: envelopeText("clasico") } })].join("\n"),
  );
  const link = new FakeLink([]);

  const runner = codexRunner("socrates", tmux, fallback, link);
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(fallback.calls, 1);
  const reply = output.reply ?? "";
  assert.ok(reply.includes(DEGRADED_MARK));
  assert.ok(reply.includes("tui_absent"));
  assert.ok(reply.includes("clasico"));
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "tui_absent");
});

test("codex no pierde las notificaciones que llegan antes de la respuesta", async () => {
  const { state } = await freshState("codex-eager");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  // El servidor emite el turno completo ANTES de contestar a `turn/start`.
  const link = new FakeLink(["019fb4a9-25f7-7f10-92ac-871fd93b2989"], undefined, true);

  const runner = codexRunner("socrates", tmux, fallback, link);
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "desde codex");
  assert.equal(fallback.calls, 0);
});

test("una sesion viva sin panel de TUI se reporta como tui_absent, no como ausente", async () => {
  const { state, home, workspace } = await freshState("sin-panel");
  const tmux = new FakeTmux();
  tmux.sessionExists = true;
  // La sesión responde a has-session pero el panel no existe: la TUI se murió dentro.
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    if (args[0] === "display-message" && args[1] === "-p") return { exitCode: 1, stdout: "", stderr: "" };
    return originalRun(args, stdin);
  };
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.ok((output.reply ?? "").includes("tui_absent"));
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "tui_absent");
});

test("la ventana de la TUI que no existe NO se confunde con otra ventana de la sesión", async () => {
  // Regresión de un fallo medido en ws-prizma el 2026-07-30. Con la sesión `cauce-socrates`
  // teniendo sólo la ventana `servidor`, `tmux display-message -p -t cauce-socrates:agente` NO
  // falla: cae a la ventana actual y devuelve su PID con exit 0. Ni el prefijo `=` lo evita.
  //
  // Consecuencia real: `ensure` decía `ready:true`, `cauce socrates` anunciaba COMPARTIDA y el
  // adaptador daba por compartida una conversación con una ventana que no existía — la clase de
  // éxito silencioso que este trabajo existe para eliminar. La única defensa es enumerar con
  // `list-windows` y comparar por igualdad exacta.
  const { state, home, workspace } = await freshState("ventana-fantasma");
  const tmux = new FakeTmux();
  tmux.sessionExists = true;
  tmux.windows = ["servidor"]; // la ventana `agente` se murió al nacer
  const originalRun = tmux.run.bind(tmux);
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    // El tmux real MIENTE acá: responde por otra ventana en vez de fallar.
    if (args[0] === "display-message" && args[1] === "-p") {
      return { exitCode: 0, stdout: "14667\n", stderr: "" };
    }
    return originalRun(args, stdin);
  };
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  // Cayó al camino de siempre y lo dijo, en vez de creerse el PID prestado.
  assert.equal(fallback.calls, 1);
  assert.ok((output.reply ?? "").includes("tui_absent"));
  assert.equal((await readDegradations(state))[0]?.reason, "tui_absent");
});

// ---------------------------------------------------------------------------
// Piezas sueltas cuyo comportamiento exacto sostiene todo lo de arriba.
// ---------------------------------------------------------------------------

test("la caja de entrada se reconoce ocupada en los casos medidos", () => {
  assert.equal(inputBoxState("❯ ").occupied, false);
  assert.equal(inputBoxState("linea\n❯ ").occupied, false);
  assert.equal(inputBoxState("❯ algo a medias").occupied, true);
  assert.equal(inputBoxState("│ ❯ dentro del recuadro │").occupied, true);
  // Un pegado sin enviar cuenta como ocupada aunque el cursor parezca libre.
  assert.equal(inputBoxState("[Pasted text #1 +12 lines]\n❯ ").occupied, true);
  assert.equal(inputBoxState("paste again to expand\n❯ ").occupied, true);
  // Fallar cerrado: sin panel legible no se inyecta.
  assert.equal(inputBoxState(undefined).occupied, true);
  assert.equal(inputBoxState("sin caja de entrada").occupied, true);
});

test("el vallado Markdown se quita solo cuando envuelve todo el texto", () => {
  assert.equal(stripJsonFence("```json\n{\"a\":1}\n```"), '{"a":1}');
  assert.equal(stripJsonFence("```\n{\"a\":1}\n```"), '{"a":1}');
  assert.equal(stripJsonFence('{"a":1}'), '{"a":1}');
  // Un bloque de código EN MEDIO es contenido, no transporte: no se toca.
  const mixed = "texto\n```json\n{\"a\":1}\n```\nmas texto";
  assert.equal(stripJsonFence(mixed), mixed);
});

// ---------------------------------------------------------------------------
// Regresión de los agujeros que midieron los tres diagnósticos del 2026-07-30.
// Cada prueba de acá reproduce un fallo OBSERVADO, no uno imaginado.
// ---------------------------------------------------------------------------

/** Una compactación real, con la forma exacta que escribe claude 2.1.220. */
function boundaryEntry(
  uuid: string,
  logicalParentUuid: string,
  trigger: "auto" | "manual",
  preTokens: number,
  postTokens: number,
): string {
  return JSON.stringify({
    type: "system", subtype: "compact_boundary", uuid, parentUuid: null, logicalParentUuid,
    isSidechain: false, content: "Conversation compacted", level: "info",
    compactMetadata: {
      trigger, preTokens, postTokens,
      cumulativeDroppedTokens: preTokens - postTokens, durationMs: 153_352,
    },
  });
}

function parseEntries(...lines: readonly string[]): readonly TranscriptEntry[] {
  return lines.map((line) => JSON.parse(line) as TranscriptEntry);
}

test("la cosecha atraviesa una compactación a mitad de turno", () => {
  // El fallo medido: una compactación CORTA la cadena de padres —el `compact_boundary` trae
  // `parentUuid: null` y la continuidad sólo vive en `logicalParentUuid`— y además REEMITE el
  // segmento preservado con los MISMOS uuid recolgados del resumen (1.873 uuid repetidos en un
  // transcript real de 13.976 entradas). Con cualquiera de las dos cosas sin tratar,
  // `findFinalAssistant` devuelve `undefined`: el runner no cosecha nunca, agota una hora de
  // presupuesto y entrega AMBIGUO. El agente contestó y el dueño ve una entrega muerta.
  const inj = "11111111-1111-4111-8111-111111111111";
  const a1 = "22222222-2222-4222-8222-222222222222";
  const leaf = "33333333-3333-4333-8333-333333333333";
  const boundary = "44444444-4444-4444-8444-444444444444";
  const summary = "55555555-5555-4555-8555-555555555555";
  const final = "66666666-6666-4666-8666-666666666666";
  const sid = "sesion-1";

  const entries = parseEntries(
    userEntry(inj, null, "pedido del bus", sid),
    assistantEntry(a1, inj, "voy a mirar", sid, "tool_use"),
    userEntry(leaf, a1, "resultado de la herramienta", sid),
    boundaryEntry(boundary, leaf, "auto", 767_812, 12_269),
    userEntry(summary, boundary, "resumen de la conversación", sid),
    // La copia REEMITIDA del segmento preservado: mismo uuid, otro padre.
    userEntry(leaf, summary, "resultado de la herramienta", sid),
    assistantEntry(final, summary, envelopeText("tras compactar"), sid),
  );

  const answer = findFinalAssistant(entries, inj);
  assert.notEqual(answer, undefined);
  assert.ok((answer?.text ?? "").includes("tras compactar"));

  // Y las dos piezas por separado, para que se vea qué sostiene qué.
  const byUuid = indexByUuid(entries);
  assert.equal(byUuid.get(leaf)?.parentUuid, a1, "el índice se queda con la PRIMERA aparición");
  assert.equal(descendsFrom(byUuid, entries[6]!, inj), true);
});

test("una compactación durante el turno se cosecha Y se avisa con sus cifras", async () => {
  const { state, home, workspace } = await freshState("compactacion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const injected = randomUUID();
    const leaf = randomUUID();
    const boundary = randomUUID();
    const summary = randomUUID();
    await appendFile(file, `${userEntry(injected, head, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(leaf, injected, "trabajando", sessionId, "tool_use")}\n`);
    await appendFile(file, `${boundaryEntry(boundary, leaf, "auto", 767812, 12269)}\n`);
    await appendFile(file, `${userEntry(summary, boundary, "resumen", sessionId)}\n`);
    await appendFile(
      file,
      `${assistantEntry(randomUUID(), summary, envelopeText("respondido tras compactar"), sessionId)}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  // 1. La entrega NO se pierde.
  assert.ok(reply.includes("respondido tras compactar"));
  assert.equal(fallback.calls, 0, "compactar no es motivo para caer al camino viejo");
  // 2. Y el remitente se entera de que la memoria ya no es la que cree, con las cifras del evento.
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_compacted"));
  assert.ok(reply.includes("auto"));
  assert.ok(reply.includes("767812"), "las cifras las trae el propio evento");
  assert.ok(reply.includes("12269"));
  // 3. Y el dueño también, en su panel, sin teñirlo de rojo (no es una caída).
  assert.ok(tmux.calls.some((call) =>
    call[0] === "display-message" && call.some((part) => part.includes("context_compacted"))));
  assert.equal(
    tmux.calls.some((call) => call[0] === "set-option" && call.includes("status-style")
      && call.includes("bg=red,fg=white")),
    false,
  );
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "context_compacted");
  assert.equal(records[0]?.fellBack, false);
});

test("un /clear del dueño se dice en la respuesta en vez de mentir", async () => {
  // Medido: `/clear` cierra el `.jsonl` y abre otro con sessionId nuevo, sin marcar el viejo y SIN
  // reiniciar el proceso (`pane_pid` idéntico), así que el heurístico de PID no lo ve jamás. La
  // cosecha seguía funcionando perfecta: el bus entregaba una respuesta impecable producida por un
  // contexto vacío, con cero señal en ninguna superficie.
  const { state, home, workspace } = await freshState("clear");
  const directory = transcriptDirectory(home, workspace);
  const primera = randomUUID();
  const segunda = randomUUID();
  let sessionId = primera;

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const file = join(directory, `${sessionId}.jsonl`);
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("respondido"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const first = await execute(adapter);
  assert.ok(!(first.reply ?? "").includes(CONTEXT_MARK), "el primer turno no puede avisar de nada");

  // El dueño teclea /clear: fichero nuevo, sessionId nuevo, MISMO proceso en el panel.
  sessionId = segunda;
  const second = await execute(adapter, "segundo pedido");

  const reply = second.reply ?? "";
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_cleared"));
  assert.ok(reply.includes("respondido"), "el turno SÍ pasó por la terminal: no se degrada");
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.panePid, "4242", "sin reinicio de proceso: el PID no delata nada");
  const records = await readDegradations(state);
  assert.equal(records[0]?.reason, "context_cleared");
  assert.equal(records[0]?.fellBack, false);
});

test("resucitar la sesión no puede parecer una sesión compartida de siempre", async () => {
  // Medido: borrada la sesión entera, la entrega creó una TUI nueva, contestó en 75,9 s con
  // `exitCode 0` y CERO avisos. `ensure` ya devolvía `created:true` y el runner lo descartaba.
  const { state, home, workspace } = await freshState("resurreccion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("desde una TUI nueva"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.ok(reply.includes("desde una TUI nueva"), "el turno sí se sirvió");
  assert.equal(fallback.calls, 0, "crear la sesión NO es caer al camino viejo");
  assert.ok(reply.includes(RESET_MARK));
  assert.ok(reply.includes("session_created"));
  assert.equal((await readDegradations(state))[0]?.reason, "session_created");
});

test("un diálogo abierto no se confunde con una línea a medio escribir", async () => {
  const { state, home, workspace } = await freshState("modal");
  const tmux = new FakeTmux();
  // El diálogo real de confianza de carpeta, tal como lo dibuja claude 2.1.220.
  tmux.paneContent = "Quick safety check\n❯ 1. Yes, I trust this folder";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("por el camino viejo") }));

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.equal(tmux.pasted, undefined, "no se pega NADA dentro de un diálogo");
  assert.ok(reply.includes("modal_blocking"));
  assert.ok(reply.includes("contestá el diálogo"), "la salida es contestar, no borrar");
  assert.ok(!reply.includes("input_busy"));
  assert.equal((await readDegradations(state))[0]?.reason, "modal_blocking");
});

test("una degradación NO deja la sesión enclavada para siempre", async () => {
  // El defecto más grave que encontró el diagnóstico 2, verificado de punta a punta: al degradar,
  // la versión anterior renombraba la ventana a `⚠ CAUCE-DEGRADADO`; `tuiTarget()` la busca por
  // nombre, así que a partir de ahí TODAS las entregas degradaban `tui_absent` en 0,2 s, para
  // siempre, con la TUI viva y sana delante, y diciéndole al dueño la mentira «la sesión existe
  // pero no tiene panel de TUI».
  const { state, home, workspace } = await freshState("enclavada");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  tmux.paneContent = "❯ el dueno esta escribiendo";
  const fallback = new RecordingFallback(JSON.stringify({ result: envelopeText("clasico") }));
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("de vuelta en la terminal"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const degraded = await execute(adapter);
  assert.ok((degraded.reply ?? "").includes(DEGRADED_MARK));
  assert.deepEqual(tmux.windows, ["agente"], "la ventana conserva su identidad");

  // El dueño suelta la caja: el turno siguiente tiene que volver a la terminal.
  tmux.paneContent = "❯ ";
  const recovered = await execute(adapter, "segundo");
  assert.ok((recovered.reply ?? "").includes("de vuelta en la terminal"));
  assert.equal(fallback.calls, 1, "sólo degradó el primero");
});

test("una sesión ya enclavada por el build viejo se repara sola", async () => {
  const { state, home, workspace } = await freshState("reparacion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  const tmux = new FakeTmux();
  // Como quedan hoy las sesiones que ya degradaron con la versión que renombraba.
  tmux.windows = ["⚠ CAUCE-DEGRADADO"];
  const fallback = new RecordingFallback("{}");
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, null, text, sessionId)}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), userUuid, envelopeText("resucitada"), sessionId)}\n`);
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos", "claude");
  const output = await execute(adapter);

  assert.ok((output.reply ?? "").includes("resucitada"));
  assert.deepEqual(tmux.windows, ["agente"]);
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// codex: el hilo del dueño, el turno del bus y la compactación.
// ---------------------------------------------------------------------------

/**
 * Un app-server programable. A diferencia de `FakeLink`, deja escribir el guion de notificaciones
 * de cada turno, que es lo que hace falta para reproducir un `/new`, un turno ajeno o una
 * compactación.
 */
class ScriptedLink implements AppServerLink {
  readonly sent: Record<string, unknown>[] = [];
  private queue: AppServerMessage[] = [];
  private waiter: ((value: IteratorResult<AppServerMessage>) => void) | undefined;
  private ended = false;
  turns = 0;

  constructor(
    readonly threads: string[],
    private readonly script: (context: {
      readonly threadId: string;
      readonly turnId: string;
      readonly push: (message: AppServerMessage) => void;
    }) => void,
  ) {}

  open(): Promise<void> {
    this.ended = false;
    this.queue = [];
    return Promise.resolve();
  }

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
    const id = message.id;
    if (message.method === "initialize") this.push({ id, result: {} });
    if (message.method === "thread/loaded/list") this.push({ id, result: { data: [...this.threads] } });
    if (message.method === "thread/resume") this.push({ id, result: {} });
    if (message.method === "turn/start") {
      this.turns += 1;
      const turnId = `turno-${this.turns}`;
      const threadId = String((message.params as { threadId?: unknown }).threadId);
      this.push({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      this.script({ threadId, turnId, push: (value) => this.push(value) });
    }
  }

  messages(): AsyncIterable<AppServerMessage> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AppServerMessage> => ({
        next: (): Promise<IteratorResult<AppServerMessage>> => {
          const value = this.queue.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (this.ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolveNext) => {
            this.waiter = resolveNext;
          });
        },
      }),
    };
  }

  close(): void {
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  private push(message: AppServerMessage): void {
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.queue.push(message);
      return;
    }
    this.waiter = undefined;
    waiter({ value: message, done: false });
  }
}

/** El guion normal: el turno contesta el sobre y termina. */
function answersWith(text: string) {
  return (context: {
    readonly threadId: string;
    readonly turnId: string;
    readonly push: (message: AppServerMessage) => void;
  }): void => {
    context.push({
      method: "item/completed",
      params: {
        threadId: context.threadId, turnId: context.turnId,
        item: { id: "i1", type: "agentMessage", text, phase: "final_answer" },
      },
    });
    context.push({
      method: "turn/completed",
      params: { threadId: context.threadId, turn: { id: context.turnId, status: "completed", items: [] } },
    });
  };
}

test("tras un /new el bus sigue al hilo NUEVO, no al abandonado", async () => {
  // Probado en vivo el 2026-07-30: `/new` NO cierra el hilo viejo —no hay `thread/closed` y
  // `thread/loaded/list` pasa a devolver los dos—. Al preferir el hilo del turno anterior, el
  // adaptador se quedaba hablando con el hilo ABANDONADO: `turn/start` aceptado, `agentMessage`
  // correcto, `turn/completed` correcto… y en el panel del dueño no aparecía NADA.
  const { state } = await freshState("codex-new");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const link = new ScriptedLink(["hilo-viejo"], answersWith(envelopeText("desde el hilo vivo")));

  const runner = codexRunner("socrates", tmux, fallback, link);
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  await execute(adapter);

  // El dueño teclea /new: aparece un hilo más y el viejo SIGUE cargado.
  link.threads.push("hilo-nuevo");
  const second = await execute(adapter, "segundo pedido");

  const starts = link.sent.filter((message) => message.method === "turn/start");
  assert.equal((starts[1]?.params as { threadId?: string }).threadId, "hilo-nuevo");
  const reply = second.reply ?? "";
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_cleared"));
  assert.equal(fallback.calls, 0);
});

test("si el hilo anterior DESAPARECE es un reinicio, no un /new", async () => {
  const { state } = await freshState("codex-reinicio");
  const tmux = new FakeTmux();
  const link = new ScriptedLink(["hilo-a"], answersWith(envelopeText("ok")));
  const runner = codexRunner("socrates", tmux, new RecordingFallback("{}"), link);
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  await execute(adapter);

  link.threads.splice(0, link.threads.length, "hilo-b");
  const second = await execute(adapter, "segundo");

  assert.ok((second.reply ?? "").includes("context_reset"));
  assert.ok((second.reply ?? "").includes(RESET_MARK));
});

test("el turno del dueño no puede cortar la cosecha del turno del bus", async () => {
  // El hilo es COMPARTIDO: mientras corre el turno del bus, el dueño puede lanzar el suyo. Sin
  // filtrar por `turnId`, su `turn/completed` cerraba la cosecha y el bus se llevaba la respuesta
  // ajena —o un `exitCode 1` inventado—. `turn/start` devuelve el id del nuestro, así que no hay
  // que adivinarlo.
  const { state } = await freshState("codex-turno-ajeno");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const link = new ScriptedLink(["hilo"], (context) => {
    context.push({
      method: "item/completed",
      params: {
        threadId: context.threadId, turnId: "turno-del-dueño",
        item: { id: "ajeno", type: "agentMessage", text: envelopeText("RESPUESTA AJENA"), phase: "final_answer" },
      },
    });
    context.push({
      method: "turn/completed",
      params: { threadId: context.threadId, turn: { id: "turno-del-dueño", status: "completed", items: [] } },
    });
    answersWith(envelopeText("MI RESPUESTA"))(context);
  });

  const runner = codexRunner("socrates", tmux, fallback, link);
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  assert.equal(output.reply, "MI RESPUESTA");
  assert.equal(fallback.calls, 0);
});

test("codex avisa cuando compacta durante el turno", async () => {
  const { state } = await freshState("codex-compactacion");
  const tmux = new FakeTmux();
  const fallback = new RecordingFallback("{}");
  const link = new ScriptedLink(["hilo"], (context) => {
    // Forma real de 0.145.0: la automática y la de `/compact` son EL MISMO item, sin ningún campo
    // que las distinga.
    context.push({
      method: "item/completed",
      params: {
        threadId: context.threadId, turnId: context.turnId,
        item: { id: "019fb544-e7b3", type: "contextCompaction" },
      },
    });
    answersWith(envelopeText("respondido tras compactar"))(context);
  });

  const runner = codexRunner("socrates", tmux, fallback, link);
  const adapter = await adapterFor(runner, state, "socrates", "codex");
  const output = await execute(adapter);

  const reply = output.reply ?? "";
  assert.ok(reply.includes("respondido tras compactar"));
  assert.ok(reply.includes(CONTEXT_MARK));
  assert.ok(reply.includes("context_compacted"));
  assert.equal(fallback.calls, 0);
  assert.equal((await readDegradations(state))[0]?.fellBack, false);
});

// ---------------------------------------------------------------------------
// El entorno del panel: el mismo lo cree quien lo cree.
// ---------------------------------------------------------------------------

test("la TUI arranca con el mismo entorno la cree el adaptador o el CLI", () => {
  // El servidor tmux se queda con el entorno del PRIMER cliente que lo crea y DESCARTA el de los
  // siguientes (medido en ws-prizma con un socket aislado). Por eso el entorno viaja en el ARGV del
  // panel y por eso los dos creadores tienen que sacarlo del mismo sitio.
  const environment = { HOME: "/home/dev" } as NodeJS.ProcessEnv;
  const adapter = loadSharedSessionConfig("codex", "socrates", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  const cli = cliSharedSessionSpec("codex", "socrates", "/workspace", "/home/dev", environment);
  assert.deepEqual(adapter?.paneEnvironment, { CODEX_HOME: "/home/dev/.codex" });
  assert.deepEqual(cli.environment, adapter?.paneEnvironment);

  // claude usa su propia variable, y es la MISMA con la que se resuelven los transcripts.
  const claude = loadSharedSessionConfig("claude", "kratos", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  assert.deepEqual(claude?.paneEnvironment, { CLAUDE_CONFIG_DIR: "/home/dev/.claude" });
  assert.equal(claude?.configDirectory, "/home/dev/.claude");
  assert.equal(
    transcriptDirectoryIn(claude!.configDirectory, "/workspace"),
    transcriptDirectory("/home/dev", "/workspace"),
  );

  // Un valor declarado manda sobre el defecto; uno relativo es un error, no un apaño silencioso.
  assert.deepEqual(
    sharedSessionPaneEnvironment("codex", "/home/dev", { CODEX_HOME: "/datos/codex" }),
    { CODEX_HOME: "/datos/codex" },
  );
  assert.throws(() => sharedSessionPaneEnvironment("codex", "/home/dev", { CODEX_HOME: "relativo" }));
});

test("el entorno se escapa y entra en el argv del panel", async () => {
  const prefix = paneEnvironmentPrefix({ CODEX_HOME: "/home/dev/.codex" });
  assert.deepEqual(prefix, { ok: true, prefix: "env CODEX_HOME='/home/dev/.codex' " });
  // Un valor con comilla no puede salirse a la línea de comandos.
  const raro = paneEnvironmentPrefix({ CLAUDE_CONFIG_DIR: "/tmp/x'; rm -rf /" });
  assert.equal(raro.ok, true);
  assert.equal(raro.ok && raro.prefix.includes("'\\''"), true);
  // Y un nombre inválido falla DICIÉNDOLO, en vez de arrancar la TUI con menos entorno del pedido.
  assert.equal(paneEnvironmentPrefix({ "MAL NOMBRE": "x" }).ok, false);

  const { home, workspace } = await freshState("entorno-argv");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  await ensureSharedSession(
    tmux,
    {
      alias: "kratos", harness: "claude", workspace, command: "claude",
      environment: { CLAUDE_CONFIG_DIR: `${home}/.claude` },
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );
  const created = tmux.calls.find((call) => call[0] === "new-session");
  assert.ok(created?.at(-1)?.startsWith(`exec env CLAUDE_CONFIG_DIR='${home}/.claude' claude`));
});
