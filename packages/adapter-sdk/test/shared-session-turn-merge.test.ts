/**
 * The paste that MERGES into an in-flight turn, and why it killed already-finished deliveries.
 *
 * When the panel is busy generating, claude does not open its own turn for what is pasted: it QUEUES
 * it and merges it into the turn that is already running (`queue-operation enqueue` and, a few seconds
 * later, `remove`). Then there is NO user entry with the text we pasted, and the ascendancy correlation
 * —locating that entry and requiring the reply to descend from it— can never hook up, no matter the budget.
 *
 * What it cost, measured on delivery `6c7cb0c4` (janus -> kratos): execution 04:14:27.49,
 * killed 04:19:28.89 = 301 s exact, "Harness exceeded its execution deadline", no retry. And the work
 * WAS DONE: kratos wrote the full deliverable at 04:17 and emitted its envelope at 04:17:52, ninety-six
 * seconds before it was declared dead. The bug did not lose time: it discarded finished work and made
 * someone send it to be redone.
 *
 * Hence the rule these tests fix: ascendancy is a TIEBREAKER, the envelope is the PROOF. If the envelope
 * appeared after the paste, the delivery does not die. The first three fail against the previous code; the
 * fourth is the guard preventing the fix from eating the 5 min net budget and returning a lock held 24 h.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter } from "../src/harnesses/shared.js";
import { claudeDefinition } from "../src/harnesses/index.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import type {
  TmuxController,
  TmuxResult,
  TmuxRunControl,
} from "../src/shared-session/tmux.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { MERGED_MARK } from "../src/shared-session/notice.js";
import { isEnvelopeText } from "../src/shared-session/envelope.js";
import { turnInFlight } from "../src/shared-session/pane.js";
import {
  claudeTranscript,
  findEnvelopeTurn,
  type TranscriptEntry,
} from "../src/shared-session/transcript.js";
import { transcriptDirectory } from "../src/shared-session/session.js";

const stateRoot = resolve(".test-state/shared-session-turn-merge");

function envelopeText(reply: string, correlationId?: string): string {
  return JSON.stringify({
    reply,
    messages: [] as const,
    status: "done" as const,
    retryable: false,
    artifacts: [] as const,
    ...(correlationId === undefined ? {} : { cauce_correlation_id: correlationId }),
  });
}

function correlationIdFromPrompt(prompt: string): string {
  const match = /"cauce_correlation_id":"([a-f0-9]{64})"/u.exec(prompt);
  assert.ok(match?.[1], "el prompt inyectado debe llevar un nonce criptográfico de 256 bits");
  return match[1];
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
  stopReason = "end_turn",
): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid, isSidechain: false, sessionId,
    message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] },
  });
}

class FakeTmux implements TmuxController {
  paneContent = "❯ ";
  readonly buffers = new Map<string, string>();
  readonly sessionOptions = new Map<string, string>([
    ["@cauce_alias", "kratos"],
    ["@cauce_harness", "claude"],
  ]);
  readonly paneOptions = new Map<string, string>();
  inputContent = "";
  pasted: string | undefined;
  submittedCount = 0;
  inputOff = false;
  paneInMode = false;
  private readonly waitSignals = new Set<string>();
  private readonly waiters = new Map<string, Set<(result: TmuxResult) => void>>();
  onSubmit: ((text: string) => Promise<void> | void) | undefined;

  private signalWaitChannel(channel: string): TmuxResult {
    const waiting = this.waiters.get(channel);
    if (waiting === undefined || waiting.size === 0) this.waitSignals.add(channel);
    else {
      this.waiters.delete(channel);
      for (const wake of waiting) wake(ok(0));
    }
    const sibling = channel.endsWith("-accepted")
      ? `${channel.slice(0, -"accepted".length)}rejected`
      : channel.endsWith("-rejected")
        ? `${channel.slice(0, -"rejected".length)}accepted`
        : undefined;
    if (sibling !== undefined) {
      const siblingWaiters = this.waiters.get(sibling);
      if (siblingWaiters !== undefined) {
        this.waiters.delete(sibling);
        for (const wake of siblingWaiters) {
          wake({ exitCode: null, stdout: "", stderr: "sibling settled" });
        }
      }
    }
    return ok(0);
  }

  private waitForChannel(channel: string, control?: TmuxRunControl): Promise<TmuxResult> {
    if (this.waitSignals.delete(channel)) return Promise.resolve(ok(0));
    return new Promise((resolveWait) => {
      let settled = false;
      const finish = (result: TmuxResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        control?.signal?.removeEventListener("abort", aborted);
        const waiting = this.waiters.get(channel);
        waiting?.delete(finish);
        if (waiting?.size === 0) this.waiters.delete(channel);
        resolveWait(result);
      };
      const aborted = (): void => {
        finish({ exitCode: null, stdout: "", stderr: "aborted" });
      };
      const timer = setTimeout(() => {
        finish({ exitCode: null, stdout: "", stderr: "timed_out" });
      }, Math.max(1, control?.timeoutMs ?? 250));
      const waiting = this.waiters.get(channel) ?? new Set<(result: TmuxResult) => void>();
      waiting.add(finish);
      this.waiters.set(channel, waiting);
      control?.signal?.addEventListener("abort", aborted, { once: true });
      if (control?.signal?.aborted === true) aborted();
    });
  }

  async run(
    args: readonly string[],
    stdin?: string,
    control?: TmuxRunControl,
  ): Promise<TmuxResult> {
    if (control?.signal?.aborted === true) {
      return { exitCode: null, stdout: "", stderr: "aborted" };
    }
    const separator = args.indexOf(";");
    if (separator >= 0) {
      const first = await this.run(args.slice(0, separator), stdin, control);
      if (first.exitCode !== 0) return first;
      const rest = await this.run(args.slice(separator + 1), undefined, control);
      return {
        exitCode: rest.exitCode,
        stdout: `${first.stdout}${rest.stdout}`,
        stderr: `${first.stderr}${rest.stderr}`,
      };
    }
    const [command] = args;
    if (command === "wait-for") {
      const channel = args.at(-1);
      if (channel === undefined) return ok(1);
      return args.includes("-S")
        ? this.signalWaitChannel(channel)
        : this.waitForChannel(channel, control);
    }
    if (command === "if-shell") {
      const condition = args.at(-3) ?? "";
      const quarantined = /#\{==:#\{@cauce_quarantined_pane\},([^}]+)\}/u
        .exec(condition)?.[1];
      if (quarantined !== undefined) {
        if (this.sessionOptions.get("@cauce_quarantined_pane") !== quarantined) {
          return this.run(args.at(-1)?.split(" ") ?? []);
        }
        return this.run(args.at(-2)?.split(" ") ?? []);
      }
      const expectedSession = /#\{==:#\{session_id\},(\$[0-9]+)\}/u.exec(condition)?.[1];
      const expectedSessionName = /#\{==:#\{session_name\},([^}]+)\}/u.exec(condition)?.[1];
      const expectedWindowId = /#\{==:#\{window_id\},(@[0-9]+)\}/u.exec(condition)?.[1];
      const expectedWindowName = /#\{==:#\{window_name\},([^}]+)\}/u.exec(condition)?.[1];
      const expectedPane = /#\{==:#\{pane_id\},(%[0-9]+)\}/u.exec(condition)?.[1];
      const expectedPid = /#\{==:#\{pane_pid\},([0-9]+)\}/u.exec(condition)?.[1];
      const expectedBarrier = /#\{==:#\{@cauce_input_barrier\},([a-f0-9]{64})\}/u
        .exec(condition)?.[1];
      const expectsBarrierEmpty = condition.includes("#{==:#{@cauce_input_barrier},}");
      const expectsInputOn = condition.includes("#{==:#{pane_input_off},0}");
      const expectsInputOff = condition.includes("#{==:#{pane_input_off},1}");
      const expectsNormalMode = condition.includes("#{==:#{pane_in_mode},0}");
      const matches = expectedSession === "$0"
        && expectedPane === "%0"
        && expectedPid === "4242"
        && (expectedSessionName === undefined || expectedSessionName === "cauce-kratos")
        && (expectedWindowId === undefined || expectedWindowId === "@0")
        && (expectedWindowName === undefined || expectedWindowName === "agente")
        && (expectedBarrier === undefined
          || this.paneOptions.get("@cauce_input_barrier") === expectedBarrier)
        && (!expectsBarrierEmpty || !this.paneOptions.has("@cauce_input_barrier"))
        && (!expectsInputOn || !this.inputOff)
        && (!expectsInputOff || this.inputOff)
        && (!expectsNormalMode || !this.paneInMode);
      if (!matches) return this.run(args.at(-1)?.split(" ") ?? []);
      return this.run(args.at(-2)?.split(" ") ?? []);
    }
    if (command === "has-session") return ok(0);
    if (command === "list-sessions") {
      return { exitCode: 0, stdout: "cauce-kratos\t$0\n", stderr: "" };
    }
    if (command === "show-options") {
      const option = args.at(-1);
      const value = option === undefined ? undefined : this.sessionOptions.get(option);
      return { exitCode: 0, stdout: value === undefined ? "" : `${value}\n`, stderr: "" };
    }
    if (command === "show-hooks") {
      const targetIndex = args.indexOf("-t");
      const namedHook = targetIndex >= 0 && targetIndex + 2 < args.length
        ? args.at(-1)
        : undefined;
      return {
        exitCode: 0,
        stdout: args.includes("-g") ? `${namedHook ?? "after-bind-key"}\n` : "",
        stderr: "",
      };
    }
    if (command === "list-windows") return { exitCode: 0, stdout: "agente\n", stderr: "" };
    if (command === "list-panes") {
      return {
        exitCode: 0,
        stdout: "$0\tcauce-kratos\t@0\tagente\t%0\t4242\t0\texec claude\n",
        stderr: "",
      };
    }
    if (command === "capture-pane") {
      const rendered = this.inputContent === ""
        ? this.paneContent
        : `${this.paneContent}\n[Pasted text #1 +${this.inputContent.split("\n").length} lines]\n❯ `;
      return { exitCode: 0, stdout: rendered, stderr: "" };
    }
    if (command === "display-message" && args[1] === "-p"
      && args.at(-1)?.includes("#{pane_input_off}")) {
      return {
        exitCode: 0,
        stdout: `$0\tcauce-kratos\t@0\tagente\t%0\t4242\t0\t${this.inputOff ? "1" : "0"}`
          + `\t${this.paneInMode ? "1" : "0"}`
          + `\t${this.paneOptions.get("@cauce_input_barrier") ?? ""}\n`,
        stderr: "",
      };
    }
    if (command === "display-message" && args[1] === "-p"
      && args.at(-1) === "#{pane_start_command}") {
      return { exitCode: 0, stdout: "exec claude\n", stderr: "" };
    }
    if (command === "display-message" && args[1] === "-p"
      && args.at(-1)?.includes("#{pane_id}")) {
      return {
        exitCode: 0,
        stdout: "$0\tcauce-kratos\t@0\tagente\t%0\t4242\t0\n",
        stderr: "",
      };
    }
    if (command === "display-message" && args[1] === "-p") {
      return { exitCode: 0, stdout: "4242\n", stderr: "" };
    }
    if (command === "load-buffer") {
      const name = args[args.indexOf("-b") + 1];
      if (name === undefined) return ok(1);
      this.buffers.set(name, stdin ?? "");
      return ok(0);
    }
    if (command === "list-buffers") {
      return {
        exitCode: 0,
        stdout: this.buffers.size === 0 ? "" : `${[...this.buffers.keys()].join("\n")}\n`,
        stderr: "",
      };
    }
    if (command === "show-buffer") {
      const name = args[args.indexOf("-b") + 1];
      const value = name === undefined ? undefined : this.buffers.get(name);
      return value === undefined ? ok(1) : { exitCode: 0, stdout: value, stderr: "" };
    }
    if (command === "paste-buffer") {
      const name = args[args.indexOf("-b") + 1];
      if (name === undefined) return ok(1);
      const value = this.buffers.get(name);
      if (value === undefined) return ok(1);
      if (this.inputOff) {
        if (args.includes("-d")) this.buffers.delete(name);
        return ok(0);
      }
      this.inputContent += value;
      this.pasted = value;
      if (args.includes("-d")) this.buffers.delete(name);
      return ok(0);
    }
    if (command === "delete-buffer") {
      const name = args[args.indexOf("-b") + 1];
      if (name === undefined) return ok(1);
      return ok(this.buffers.delete(name) ? 0 : 1);
    }
    if (command === "set-option") {
      const optionIndex = args.findIndex((value) => value.startsWith("@cauce_"));
      if (optionIndex < 0) return ok(0);
      const option = args[optionIndex];
      const value = args[optionIndex + 1];
      if (option === undefined) return ok(1);
      const paneScoped = args.some((argument) => /^-[A-Za-z]*p[A-Za-z]*$/u.test(argument));
      const options = paneScoped ? this.paneOptions : this.sessionOptions;
      if (args.some((argument) => /^-[A-Za-z]*u[A-Za-z]*$/u.test(argument))) {
        options.delete(option);
      } else {
        if (value === undefined) return ok(1);
        options.set(option, value);
      }
      return ok(0);
    }
    if (command === "select-pane") {
      if (args.includes("-d")) this.inputOff = true;
      if (args.includes("-e")) this.inputOff = false;
      return ok(0);
    }
    if (command === "send-keys" && args.includes("Enter")) {
      if (this.inputOff) return ok(0);
      const text = this.inputContent;
      this.inputContent = "";
      if (text === "") return ok(0);
      this.submittedCount += 1;
      if (this.onSubmit !== undefined) void this.onSubmit(text);
      return ok(0);
    }
    if (command === "send-keys" && (args.includes("Escape") || args.includes("C-u"))) {
      if (this.inputOff) return ok(0);
      if (args.includes("C-u")) this.inputContent = "";
      return ok(0);
    }
    return ok(0);
  }
}

function ok(exitCode: number): TmuxResult {
  return { exitCode, stdout: "", stderr: "" };
}

class RecordingFallback implements CommandRunner {
  calls = 0;
  run(_request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    return Promise.resolve({
      stdout: "{}", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false,
    });
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve_) => setTimeout(resolve_, ms));

function claudeRunner(options: {
  alias: string;
  home: string;
  workspace: string;
  tmux: FakeTmux;
  fallback: CommandRunner;
  correlationTimeoutMs?: number;
  quietTimeoutMs?: number;
  mergedGraceMs?: number;
  turnTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): PasteSessionRunner<TranscriptEntry> {
  return new PasteSessionRunner({
    alias: options.alias,
    harness: "claude",
    workspace: options.workspace,
    transcript: claudeTranscript(join(options.home, ".claude"), options.workspace),
    tmux: options.tmux,
    fallback: options.fallback,
    sleep: options.sleep ?? (() => Promise.resolve()),
    acquireTimeoutMs: 30,
    turnTimeoutMs: options.turnTimeoutMs ?? 2_000,
    settleMs: 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    ...(options.correlationTimeoutMs === undefined
      ? {}
      : { correlationTimeoutMs: options.correlationTimeoutMs }),
    ...(options.quietTimeoutMs === undefined ? {} : { quietTimeoutMs: options.quietTimeoutMs }),
    ...(options.mergedGraceMs === undefined ? {} : { mergedGraceMs: options.mergedGraceMs }),
  });
}

async function adapterFor(
  runner: CommandRunner,
  state: string,
  alias: string,
): Promise<HarnessAdapter> {
  const store = await DurableStore.open(join(state, "store"));
  return new HarnessAdapter({
    definition: claudeDefinition,
    runner,
    store,
    sessionNamespace: alias,
    sharedSession: { alias, harness: "claude", stateDirectory: state },
  });
}

function execute(adapter: HarnessAdapter, timeoutMs = 10_000): Promise<{
  reply: string | null;
  status: string;
}> {
  return adapter.execute({
    prompt: "hola",
    sessionKey: "auth-v2:prueba",
    timeoutMs,
    signal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------
// (a) The paste MERGES with the in-flight turn: there is no own turn to descend from.
// ---------------------------------------------------------------------------

test("una entrega cuyo pegado se fundió con el turno en curso se cosecha del sobre", async () => {
  const { state, home, workspace } = await freshState("fusion");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);

  // The owner typed in the panel a moment earlier (04:14:01 in the real delivery) and that turn is in
  // progress, which is why the box is free — claude empties it while generating — and the paste is queued.
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "seguí con el informe", sessionId)}\n`);

  const tmux = new FakeTmux();
  // The status line of a TUI that is GENERATING. The box is empty and the arbiter sees it as free.
  tmux.paneContent = "✻ Herding… (esc to interrupt · ctrl+t to hide todos)\n❯ ";
  const fallback = new RecordingFallback();
  tmux.onSubmit = async (text) => {
    // The merge, exactly as is: NO user entry is written with the text we pasted. The owner's
    // turn keeps going and ends up replying to both things at once, with its own envelope.
    await appendFile(
      file,
      `${assistantEntry(
        randomUUID(),
        duenio,
        envelopeText("el entregable", correlationIdFromPrompt(text)),
        sessionId,
      )}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos");
  const output = await execute(adapter);

  // Against the previous code this never arrived: the correlation did not hook up, and at
  // 300 s "Harness exceeded its execution deadline" came out.
  assert.equal(output.status, "done");
  assert.ok((output.reply ?? "").includes("el entregable"), output.reply ?? "(null)");
  assert.equal("cauce_correlation_id" in output, false, "el nonce no sale como StructuredOutput");
  // The turn went through the terminal: it didn't fall back to the usual path and wasn't run twice.
  assert.equal(fallback.calls, 0);
  assert.equal(tmux.submittedCount, 1);
  // Y se DICE que fue un turno fundido: la respuesta puede estar contestando dos pedidos a la vez.
  assert.ok((output.reply ?? "").includes(MERGED_MARK), output.reply ?? "(null)");
});

// ---------------------------------------------------------------------------
// (b) The envelope arrives AFTER the correlation deadline. The terminal was not silent for a second.
// ---------------------------------------------------------------------------

test("el sobre que llega pasado el plazo de correlación cierra la entrega igual", async () => {
  const { state, home, workspace } = await freshState("tarde");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "seguí con el informe", sessionId)}\n`);

  const tmux = new FakeTmux();
  tmux.paneContent = "✻ Herding… (esc to interrupt)\n❯ ";
  const fallback = new RecordingFallback();

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    // The correlation deadline expires immediately — like the 300 s of the real delivery facing a
    // turn that took longer — but the terminal KEEPS writing, so there is nothing to give up on.
    correlationTimeoutMs: 50,
    quietTimeoutMs: 1_000,
    turnTimeoutMs: 20_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos");

  tmux.onSubmit = (text) => {
    const correlationId = correlationIdFromPrompt(text);
// The owner's turn keeps working: tools, intermediate steps. None of this is an envelope,
      // and none of these entries is ours.
    void (async () => {
      for (let paso = 0; paso < 10; paso += 1) {
        await delay(20);
        await appendFile(
          file,
          `${assistantEntry(randomUUID(), duenio, `paso ${paso}`, sessionId, "tool_use")}\n`,
        );
      }
      // And only now, well past the correlation deadline, the envelope.
      await appendFile(
        file,
        `${assistantEntry(
          randomUUID(),
          duenio,
          envelopeText("tarde pero entero", correlationId),
          sessionId,
        )}\n`,
      );
    })();
  };

  const output = await execute(adapter, 30_000);

  assert.equal(output.status, "done");
  assert.ok((output.reply ?? "").includes("tarde pero entero"), output.reply ?? "(null)");
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// (c) The healthy case: ascendancy correlation, and NO merged-turn notice.
// ---------------------------------------------------------------------------

test("el turno que sí abre turno propio se cosecha por ascendencia y sin aviso", async () => {
  const { state, home, workspace } = await freshState("sano");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const head = randomUUID();
  await appendFile(file, `${userEntry(head, null, "hola de la terminal", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback();
  tmux.onSubmit = async (text) => {
    const userUuid = randomUUID();
    await appendFile(file, `${userEntry(userUuid, head, text, sessionId)}\n`);
    await appendFile(
      file,
      `${assistantEntry(
        randomUUID(),
        userUuid,
        envelopeText("desde la TUI", correlationIdFromPrompt(text)),
        sessionId,
      )}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos");
  const output = await execute(adapter);

  assert.equal(output.status, "done");
  assert.equal(output.reply, "desde la TUI");
  assert.equal(fallback.calls, 0);
  // No notices: the correlation worked as usual.
  assert.ok(!(output.reply ?? "").includes(MERGED_MARK));
});

test("claude ignora el sobre headless de otro fichero y rescata sólo su nonce", async () => {
  const { state, home, workspace } = await freshState("multifile-headless");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const headlessSessionId = randomUUID();
  const tuiFile = join(directory, `tui-${sessionId}.jsonl`);
  const headlessFile = join(directory, `headless-${headlessSessionId}.jsonl`);
  const owner = randomUUID();
  await appendFile(tuiFile, `${userEntry(owner, null, "turno del dueño", sessionId)}\n`);
  await appendFile(
    headlessFile,
    `${userEntry(randomUUID(), null, "otro proceso", headlessSessionId)}\n`,
  );

  const tmux = new FakeTmux();
  tmux.paneContent = "✻ Working… (esc to interrupt)\n❯ ";
  const fallback = new RecordingFallback();
  tmux.onSubmit = async (text) => {
    // A concurrent `claude --print` finishes first with a perfectly valid envelope, but does not know
    // the nonce of this injection. Before, it was harvested just for having grown another `.jsonl`.
    await appendFile(
      headlessFile,
      `${assistantEntry(
        randomUUID(),
        randomUUID(),
        envelopeText("RESPUESTA HEADLESS"),
        headlessSessionId,
      )}\n`,
    );
    await appendFile(
      tuiFile,
      `${assistantEntry(
        randomUUID(),
        owner,
        envelopeText("RESPUESTA TUI", correlationIdFromPrompt(text)),
        sessionId,
      )}\n`,
    );
  };

  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux, fallback });
  const adapter = await adapterFor(runner, state, "kratos");
  const output = await execute(adapter);

  assert.equal(output.status, "done");
  assert.ok((output.reply ?? "").includes("RESPUESTA TUI"));
  assert.ok(!(output.reply ?? "").includes("RESPUESTA HEADLESS"));
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// (d) Guard: the truly LOST paste still releases the session quickly.
// ---------------------------------------------------------------------------

test("el pegado perdido sin ninguna actividad sigue soltando la sesión como ambiguo", async () => {
  const { state, home, workspace } = await freshState("perdido");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  await appendFile(file, `${userEntry(randomUUID(), null, "algo viejo", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback();
  // The paste was lost: the TUI does not write anything at all.
  tmux.onSubmit = () => undefined;

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 20,
    // Very long budget on purpose: what has to release the session is the network, not the deadline.
    turnTimeoutMs: 600_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos");

  const empezo = Date.now();
  await assert.rejects(
    execute(adapter, 600_000),
    (error: Error) => /execution deadline/iu.test(error.message),
  );
  // And fast: the network cannot have stayed waiting the entire budget.
  assert.ok(Date.now() - empezo < 30_000, `tardó ${Date.now() - empezo} ms`);
  assert.equal(fallback.calls, 0);
});

// ---------------------------------------------------------------------------
// (e) Guard: the wait for a merged turn has a written end even if the terminal does not go quiet.
// ---------------------------------------------------------------------------

test("la espera por un turno fundido termina en su techo, no en el presupuesto", async () => {
  const { state, home, workspace } = await freshState("techo");
  const directory = transcriptDirectory(home, workspace);
  const sessionId = randomUUID();
  const file = join(directory, `${sessionId}.jsonl`);
  const duenio = randomUUID();
  await appendFile(file, `${userEntry(duenio, null, "seguí", sessionId)}\n`);

  const tmux = new FakeTmux();
  const fallback = new RecordingFallback();
  let escribiendo = true;
  tmux.onSubmit = () => {
    // The terminal NEVER goes quiet, and never emits an envelope: the paste was really lost and
    // what you see is the owner working in their panel. Without a ceiling, this would wait all
    // day.
    void (async () => {
      while (escribiendo) {
        await delay(5);
        await appendFile(
          file,
          `${assistantEntry(randomUUID(), duenio, "sigo en lo mío", sessionId, "tool_use")}\n`,
        );
      }
    })();
  };

  const runner = claudeRunner({
    alias: "kratos",
    home,
    workspace,
    tmux,
    fallback,
    correlationTimeoutMs: 20,
    quietTimeoutMs: 60_000,
    mergedGraceMs: 200,
    turnTimeoutMs: 600_000,
    sleep: delay,
  });
  const adapter = await adapterFor(runner, state, "kratos");

  const empezo = Date.now();
  try {
    await assert.rejects(
      execute(adapter, 600_000),
      (error: Error) => /execution deadline/iu.test(error.message),
    );
  } finally {
    escribiendo = false;
  }
  assert.ok(Date.now() - empezo < 30_000, `tardó ${Date.now() - empezo} ms`);
});

// ---------------------------------------------------------------------------
// The parts, separately.
// ---------------------------------------------------------------------------

test("un sobre se reconoce por su forma, y una respuesta en prosa no", () => {
  assert.equal(isEnvelopeText(envelopeText("hecho")), true);
  assert.equal(isEnvelopeText("```json\n" + envelopeText("hecho") + "\n```"), true);
  assert.equal(isEnvelopeText('{"reply":null,"messages":[],"status":"failed","retryable":true}'), true);
  assert.equal(isEnvelopeText("listo, ya lo dejé andando"), false);
  assert.equal(isEnvelopeText('{"reply":"x"}'), false);
  assert.equal(isEnvelopeText('{"reply":"x","messages":[],"status":"otra"}'), false);
  assert.equal(isEnvelopeText('{"reply":"x","messages":{},"status":"done"}'), false);
  assert.equal(isEnvelopeText(undefined), false);
});

test("el sobre se localiza sin ascendencia, y un mensaje intermedio no cuenta", () => {
  const sessionId = randomUUID();
  const duenio = randomUUID();
  const correlationId = randomUUID();
  const entries = [
    JSON.parse(userEntry(duenio, null, "seguí", sessionId)),
    JSON.parse(assistantEntry(
      randomUUID(),
      duenio,
      envelopeText("a medias", correlationId),
      sessionId,
      "tool_use",
    )),
    JSON.parse(assistantEntry(
      randomUUID(),
      duenio,
      envelopeText("el entregable", correlationId),
      sessionId,
    )),
  ] as TranscriptEntry[];
  const found = findEnvelopeTurn(entries, correlationId);
  assert.equal(found?.text, envelopeText("el entregable", correlationId));
  assert.equal(found?.sessionId, sessionId);

  // Un subagente escribe en el mismo fichero y no puede contar como el sobre del turno.
  const sidechain = [{
    ...JSON.parse(assistantEntry(randomUUID(), duenio, envelopeText("de un subagente"), sessionId)),
    isSidechain: true,
  }] as TranscriptEntry[];
  assert.equal(findEnvelopeTurn(sidechain, correlationId), undefined);
});

test("el rescate rechaza sobres sin nonce o con el nonce de otra entrega", () => {
  const sessionId = randomUUID();
  const parent = randomUUID();
  const expected = randomUUID();
  const entries = [
    JSON.parse(assistantEntry(randomUUID(), parent, envelopeText("sin nonce"), sessionId)),
    JSON.parse(assistantEntry(
      randomUUID(),
      parent,
      envelopeText("ajeno", randomUUID()),
      sessionId,
    )),
  ] as TranscriptEntry[];

  assert.equal(findEnvelopeTurn(entries, expected), undefined);
});

test("la línea de estado de una TUI generando se distingue del texto de la conversación", () => {
  // claude la dibuja justo ENCIMA de la caja; codex, justo debajo. Las dos cuentan.
  assert.equal(turnInFlight("✻ Herding… (esc to interrupt · ctrl+t to hide todos)\n❯ "), true);
  assert.equal(turnInFlight("› \nEsc to interrupt\n"), true);
  assert.equal(turnInFlight("❯ "), false);
  assert.equal(turnInFlight("✻ Herding… (esc to interrupt)\n❯ \n\n\n"), true);
  // A sentence FAR from the box is conversation, not status: if it counted, an agent talking
  // about this same mechanism would leave the panel marked as busy forever.
  const relleno: string[] = new Array<string>(20).fill("blah");
  const conversacion = ["el truco es mirar 'esc to interrupt'", ...relleno, "❯ "];
  assert.equal(turnInFlight(conversacion.join("\n")), false);
  assert.equal(turnInFlight(undefined), false);
});
