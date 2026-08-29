import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { cliSharedSessionSpec } from "../src/shared-session/config.js";
import {
  claudeHasPreviousConversation,
  codexHasPreviousConversation,
} from "../src/shared-session/resume.js";
import {
  ensureSharedSession,
  resumeArgumentSuffix,
  transcriptDirectoryIn,
} from "../src/shared-session/session.js";
import type { ResumeSpec } from "../src/shared-session/types.js";
import { FakeTmux, freshState } from "./shared-session-fixtures.js";

const immediate = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// Rebuilding the panel must resume the existing conversation from disk.
// ---------------------------------------------------------------------------

/** A fake `ResumeSpec`, with whatever response the test wants and a call counter. */
function fakeResume(
  args: readonly string[],
  hay: boolean | (() => Promise<boolean>),
): { spec: ResumeSpec; preguntas: () => number } {
  let preguntas = 0;
  return {
    spec: {
      args,
      hasPreviousConversation: async (): Promise<boolean> => {
        preguntas += 1;
        return typeof hay === "boolean" ? hay : hay();
      },
    },
    preguntas: () => preguntas,
  };
}

test("con conversacion previa, el panel nace REANUDANDO en vez de en blanco", async () => {
  const { workspace } = await freshState("reanuda-codex");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const resume = fakeResume(["resume", "--last"], true);

  const result = await ensureSharedSession(
    tmux,
    {
      alias: "socrates", harness: "codex", workspace, command: "codex",
      environment: { CODEX_HOME: "/home/dev/.codex" },
      resume: resume.spec,
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.created, true);
  // Saying it matters as much as doing it: the notice the owner reads distinguishes "created empty"
  // from "created with its conversation", and saying the former when the latter happened is lying.
  assert.equal(result.resumed, true);
  const created = tmux.calls.find((call) => call[0] === "new-session");
  assert.equal(created?.at(-1), "exec env CODEX_HOME='/home/dev/.codex' codex resume --last");
  assert.equal(resume.preguntas(), 1);
});

test("sin conversacion previa NO se intenta reanudar: se arranca pelado", async () => {
  // `claude --continue` with nothing to continue exits with code 1 and kills the panel (measured
  // with claude 2.1.223). Asking first costs reading a directory; not asking costs a mute alias.
  const { workspace } = await freshState("reanuda-sin-nada");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.fatalPaneArguments = "--continue";
  const resume = fakeResume(["--continue"], false);

  const result = await ensureSharedSession(
    tmux,
    {
      alias: "kratos", harness: "claude", workspace, command: "claude", resume: resume.spec,
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.resumed, undefined);
  const creadas = tmux.calls.filter((call) => call[0] === "new-session");
  assert.equal(creadas.length, 1, "sin conversacion previa no hay dos intentos, hay uno");
  assert.equal(creadas[0]?.at(-1), "exec claude");
});

test("si la reanudacion mata el panel, se rehace EN BLANCO y se dice", async () => {
  // The rule that orders the two bad options: a panel without context is bad, a panel that fails
  // to start is worse. A mute alias is the most expensive failure in the fleet.
  const { workspace } = await freshState("reanuda-falla");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  // The detector says there IS a conversation, but the harness cannot open it: a broken rollout,
  // a version that changed the subcommand, a permission. That mismatch MUST be survivable.
  tmux.fatalPaneArguments = "--continue";
  const resume = fakeResume(["--continue"], true);
  const avisos: string[] = [];

  const result = await ensureSharedSession(
    tmux,
    { alias: "zeus", harness: "claude", workspace, command: "claude", resume: resume.spec },
    { sleep: immediate, readyTimeoutMs: 30, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, true, "el panel tiene que quedar EN PIE aunque la reanudacion falle");
  assert.equal(result.created, true);
  assert.equal(result.resumed, undefined, "no se puede declarar reanudado lo que arranco vacio");
  const creadas = tmux.calls.filter((call) => call[0] === "new-session");
  assert.equal(creadas.length, 2);
  assert.equal(creadas[0]?.at(-1), "exec claude --continue");
  assert.equal(creadas[1]?.at(-1), "exec claude");
  // The fatal panel took the whole session with it. It is not killed by name: if another creator
  // had occupied `cauce-zeus` at that instant, that kill would wipe THEIR conversation.
  assert.equal(tmux.calls.some((call) => call[0] === "kill-session"), false);
  // And the owner must be able to learn that their conversation did not come back.
  assert.equal(avisos.length, 1);
  assert.ok(avisos[0]?.includes("EN BLANCO"), avisos[0]);
});

test("un panel VIVO pero lento no se mata: se reporta, no se rehace", async () => {
  // A large conversation takes a long time to render —kant's weighed 38 MB—. Confusing "slow" with
  // "dead" would be committing by hand the same deletion this mechanism is designed to prevent.
  const { workspace } = await freshState("reanuda-lenta");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.paneContent = "❯ el dueño estaba escribiendo esto";  // busy box: never "ready"
  const resume = fakeResume(["resume", "--last"], true);
  const avisos: string[] = [];

  const result = await ensureSharedSession(
    tmux,
    { alias: "atlas", harness: "codex", workspace, command: "codex", resume: resume.spec },
    { sleep: immediate, readyTimeoutMs: 5, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "tui_absent");
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
  assert.equal(tmux.calls.some((call) => call[0] === "kill-session"), false);
  assert.deepEqual(avisos, []);
});

test("un detector que revienta no deja al alias sin panel", async () => {
  const { workspace } = await freshState("reanuda-detector-roto");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const avisos: string[] = [];
  const roto: ResumeSpec = {
    args: ["--continue"],
    hasPreviousConversation: () => Promise.reject(new Error("EACCES: sessions/")),
  };

  const result = await ensureSharedSession(
    tmux,
    { alias: "vulcano", harness: "claude", workspace, command: "claude", resume: roto },
    { sleep: immediate, readyTimeoutMs: 30, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, true);
  assert.equal(tmux.calls.find((call) => call[0] === "new-session")?.at(-1), "exec claude");
  assert.ok(avisos[0]?.includes("EACCES"), avisos[0]);
});

test("los argumentos de reanudacion no pueden colarse al shell", () => {
  assert.deepEqual(resumeArgumentSuffix(["resume", "--last"]), { ok: true, suffix: " resume --last" });
  assert.deepEqual(resumeArgumentSuffix(["--continue"]), { ok: true, suffix: " --continue" });
  assert.deepEqual(resumeArgumentSuffix(undefined), { ok: true, suffix: "" });
  assert.deepEqual(resumeArgumentSuffix([]), { ok: true, suffix: "" });
  // Fails closed instead of sending the login shell something nobody wrote on purpose.
  assert.equal(resumeArgumentSuffix(["; rm -rf /"]).ok, false);
  assert.equal(resumeArgumentSuffix(["$(whoami)"]).ok, false);
});

test("codex: solo cuenta una conversacion interactiva de ESTE directorio", async () => {
  const { state } = await freshState("detector-codex");
  const codexHome = join(state, ".codex");
  const dia = join(codexHome, "sessions", "2026", "08", "06");
  await mkdir(dia, { recursive: true });
  const cabecera = (cwd: string, source: unknown): string => `${JSON.stringify({
    timestamp: "2026-08-06T09:57:18.709Z",
    type: "session_meta",
    payload: { session_id: randomUUID(), cwd, source, originator: "codex-tui" },
  })}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`;

  // With nothing, there is nothing to resume. This is the branch that prevents the dead panel.
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // The one from ANOTHER directory does not count: `resume --last` filters by cwd, and promising
  // a resume that codex will not perform leaves the panel at the harness's mercy once again.
  await appendFile(join(dia, `rollout-2026-08-06T09-00-00-${randomUUID()}.jsonl`),
    cabecera("/otro/sitio", "cli"));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // The subagent's one either: codex hides it unless `--include-non-interactive`.
  await appendFile(join(dia, `rollout-2026-08-06T09-30-00-${randomUUID()}.jsonl`),
    cabecera("/workspace", { subagent: "revisor" }));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // And the owner's, in their directory, yes.
  await appendFile(join(dia, `rollout-2026-08-06T09-57-00-${randomUUID()}.jsonl`),
    cabecera("/workspace", "cli"));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), true);
});

test("claude: cuenta el transcript del directorio, y solo si tiene algo dentro", async () => {
  const { state } = await freshState("detector-claude");
  const configDirectory = join(state, ".claude");
  const proyecto = transcriptDirectoryIn(configDirectory, "/workspace");

  // The directory does not even exist: there is nothing to continue.
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  // It exists and is empty: same. `--continue` would exit with code 1 and take the panel with it.
  await mkdir(proyecto, { recursive: true });
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  // A zero-byte `.jsonl` is a freshly-created file, not a conversation.
  await appendFile(join(proyecto, `${randomUUID()}.jsonl`), "");
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  await appendFile(join(proyecto, `${randomUUID()}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1" })}\n`);
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), true);

  // And the one from ANOTHER workspace does not count: claude resumes by working directory.
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/otro"), false);
});

test("los dos creadores del panel reanudan igual", async () => {
  // The adapter and `cauce <alias>` are the only two session creators, and whichever wins the race
  // imposes its shape on the panel forever. If only one resumed, the owner's conversation would
  // depend on who arrived first — which is how kant's 38 MB were lost: via the CLI.
  const cli = cliSharedSessionSpec("codex", "socrates", "/workspace", "/home/dev", {});
  assert.deepEqual(cli.resume?.args, ["resume", "--last"]);
  const claude = cliSharedSessionSpec("claude", "kratos", "/workspace", "/home/dev", {});
  assert.deepEqual(claude.resume?.args, ["--continue"]);
});