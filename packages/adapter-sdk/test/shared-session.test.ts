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
import { DEGRADED_MARK, RESET_MARK } from "../src/shared-session/notice.js";
import { readDegradations } from "../src/shared-session/degradation-log.js";
import { inputBoxState } from "../src/shared-session/pane.js";
import { stripJsonFence } from "../src/shared-session/transcript.js";
import { transcriptDirectory } from "../src/shared-session/session.js";

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

  // Y el panel del dueño lo dice también.
  assert.ok(tmux.used("rename-window"));
  assert.ok(tmux.calls.some((call) => call[0] === "display-message" && call.includes("-d")));
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
