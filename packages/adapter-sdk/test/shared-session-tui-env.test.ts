import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureSharedSessionStartup, sharedSessionRunner } from "../src/bin/shared.js";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import type { AdapterLog } from "../src/sdk/types.js";
import {
  cliSharedSessionSpec,
  loadSharedSessionConfig,
  sharedSessionPaneEnvironment,
} from "../src/shared-session/config.js";
import {
  ensureSharedSession,
  waitForAccreditedTui,
  paneEnvironmentPrefix,
  transcriptDirectory,
  transcriptDirectoryIn,
} from "../src/shared-session/session.js";
import { CliTmux, type TmuxController } from "../src/shared-session/tmux.js";
import { FakeTmux, adapterFor, assistantEntry, envelopeText, execute as executeHarness, freshState, userEntry } from "./shared-session-fixtures.js";
import { PasteSessionRunner } from '../src/shared-session/paste-runner.js';
import { PROVIDER_LOGIN_MESSAGE, providerLoginRequired } from '../src/shared-session/provider-login.js';
import { claudeTranscript } from '../src/shared-session/transcript.js';
import type { SharedSessionHarness } from '../src/shared-session/types.js';

const immediate = (): Promise<void> => Promise.resolve();

test("un binding Claude ilegible aborta antes de construir el runner compartido", async () => {
  const missing = `/tmp/cauce-missing-${randomUUID()}`;
  const configured = loadSharedSessionConfig("claude", "kratos", "/state/kratos", {
    CAUCE_SHARED_SESSION: "1",
    CAUCE_SHARED_SESSION_WORKSPACE: `${missing}/workspace`,
    CLAUDE_CONFIG_DIR: `${missing}/config`,
    HOME: `${missing}/home`,
  });
  assert.ok(configured);
  const logs: AdapterLog[] = [];
  await assert.rejects(
    sharedSessionRunner(configured, (entry) => { logs.push(entry); }),
    (error: unknown) => error instanceof ProcessExecutionError
      && error.code === "SHARED_TUI_UNAVAILABLE" && !error.retryable,
  );
  assert.deepEqual(logs.map((entry) => entry.event), ["shared_session_degraded"]);
});

test('startup creates the canonical TUI without a delivery and reacquiring the lease preserves it', async () => {
  const { state, home, workspace } = await freshState('startup-without-delivery');
  const configured = loadSharedSessionConfig('codex', 'socrates', state, {
    HOME: home, CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: workspace,
  });
  assert.ok(configured);
  const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = []; tmux.panePid = String(process.pid);
  await ensureSharedSessionStartup(configured, () => undefined, tmux);
  const firstSession = tmux.sessionId; const firstPane = tmux.paneId;
  const captures = tmux.calls.filter(call => call[0] === 'capture-pane' && call.at(-1) === firstPane).length;
  await ensureSharedSessionStartup(configured, () => undefined, tmux);
  assert.ok(tmux.calls.filter(call => call[0] === 'capture-pane' && call.at(-1) === firstPane).length > captures);
  assert.equal(tmux.calls.filter(call => call[0] === 'new-session').length, 1);
  assert.equal(tmux.sessionId, firstSession); assert.equal(tmux.paneId, firstPane);
  for (const command of ['kill-session', 'send-keys', 'paste-buffer', 'respawn-pane']) assert.equal(tmux.used(command), false);
});

test('startup refuses a foreign canonical session without replacing it or injecting a turn', async () => {
  const { state, home, workspace } = await freshState('startup-foreign-session');
  const configured = loadSharedSessionConfig('codex', 'socrates', state, {
    HOME: home, CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: workspace,
  });
  assert.ok(configured);
  const tmux = new FakeTmux(); tmux.sessionName = 'cauce-socrates'; tmux.sessionOptions.set('@cauce_harness', 'claude');
  await assert.rejects(ensureSharedSessionStartup(configured, () => undefined, tmux),
    (error: unknown) => error instanceof ProcessExecutionError && error.code === 'SHARED_TUI_UNAVAILABLE');
  assert.equal(tmux.sessionExists, true);
  for (const command of ['new-session', 'kill-session', 'send-keys', 'paste-buffer']) assert.equal(tmux.used(command), false);
});

test('startup cancellation prevents new tmux operations and reaches an active client', async () => {
  const { state, home, workspace } = await freshState('startup-cancelled');
  const configured = loadSharedSessionConfig('codex', 'socrates', state, {
    HOME: home, CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: workspace,
  });
  assert.ok(configured);
  const preAborted = new AbortController(); preAborted.abort(); const tmux = new FakeTmux();
  await assert.rejects(ensureSharedSessionStartup(configured, () => undefined, tmux, preAborted.signal), { name: 'AbortError' });
  assert.equal(tmux.calls.length, 0);
  const active = new AbortController(); let clientSignal: AbortSignal | undefined;
  const cancellingTmux: TmuxController = { run: async (args, stdin, control) => {
    clientSignal = control?.signal;
    assert.ok(clientSignal); assert.equal(clientSignal.aborted, false);
    active.abort(); assert.equal(clientSignal.aborted, true);
    return tmux.run(args, stdin, control);
  } };
  await assert.rejects(ensureSharedSessionStartup(configured, () => undefined, cancellingTmux, active.signal),
    (error: unknown) => error instanceof ProcessExecutionError && error.code === 'SHARED_TUI_UNAVAILABLE');
  assert.equal(clientSignal?.aborted, true);
  for (const command of ['new-session', 'kill-session', 'send-keys', 'paste-buffer']) assert.equal(tmux.used(command), false);
});

test('cold startup spans a canonical wait window without replacing its process or creating another session', async () => {
  const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = [];
  tmux.panePid = String(process.pid); tmux.paneContent = 'Initializing';
  const spec = { alias: 'socrates', harness: 'codex', workspace: '/workspace' } as const;
  const initial = await ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 0 });
  assert.equal(initial.ready, false); assert.equal(initial.failure, 'tui_absent'); assert.ok(initial.pane);
  const identity = { ...initial.pane }; let elapsed = 0; const pending: string[] = [];
  const ready = await waitForAccreditedTui(tmux, spec, initial.pane, {
    now: () => elapsed, log: detail => { pending.push(detail); },
    sleep: () => { elapsed += 45_000; if (elapsed >= 135_000) tmux.paneContent = '❯ '; return Promise.resolve(); },
  });
  assert.equal(ready, 'ready'); assert.equal(elapsed, 135_000); assert.deepEqual(pending, ['tui_starting']);
  assert.equal(tmux.panePid, identity.panePid); assert.equal(tmux.sessionId, identity.sessionId);
  assert.equal(tmux.paneId, identity.paneId); assert.equal(tmux.calls.filter(call => call[0] === 'new-session').length, 1);
  for (const command of ['kill-session', 'send-keys', 'paste-buffer', 'respawn-pane']) assert.equal(tmux.used(command), false);
});

test('startup waits on the created pane and shutdown cancels that wait before consuming', async () => {
  const { state, home, workspace } = await freshState('startup-wait-shutdown');
  const configured = loadSharedSessionConfig('codex', 'socrates', state, {
    HOME: home, CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: workspace,
  });
  assert.ok(configured);
  const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = [];
  tmux.panePid = String(process.pid); tmux.paneContent = 'Initializing';
  const shutdown = new AbortController(); const logs: AdapterLog[] = [];
  let cancelledAt: number | undefined;
  const controlled: TmuxController = { run: async (args, stdin, control) => {
    if (args[0] === 'capture-pane' && args.at(-1) === tmux.paneId) {
      assert.equal(control?.signal?.aborted, false); shutdown.abort();
    }
    const result = await tmux.run(args, stdin, control);
    if (shutdown.signal.aborted) cancelledAt ??= tmux.calls.length;
    return result;
  } };
  await assert.rejects(ensureSharedSessionStartup(configured, entry => { logs.push(entry); }, controlled, shutdown.signal),
    (error: unknown) => error instanceof ProcessExecutionError && error.code === 'SHARED_TUI_UNAVAILABLE');
  assert.ok(cancelledAt); assert.equal(tmux.calls.length, cancelledAt);
  assert.equal(tmux.calls.filter(call => call[0] === 'new-session').length, 1);
  assert.ok(logs.some(entry => entry.event === 'shared_session_degraded' && entry.reason === 'startup_cancelled'));
  for (const command of ['kill-session', 'send-keys', 'paste-buffer', 'respawn-pane']) assert.equal(tmux.used(command), false);
});

test('waiting startup stops on cancellation and rejects a replaced pane without mutation', async () => {
  for (const interruption of ['cancel', 'replace', 'alias', 'harness'] as const) {
    const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = [];
    tmux.panePid = String(process.pid); tmux.paneContent = 'Initializing';
    const spec = { alias: 'socrates', harness: 'codex', workspace: '/workspace' } as const;
    const initial = await ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 0 });
    assert.ok(initial.pane); const controller = new AbortController();
    let callsAtCancellation: number | undefined;
    const ready = await waitForAccreditedTui(tmux, spec, initial.pane, {
      signal: controller.signal, sleep: () => {
        if (interruption === 'cancel') { controller.abort(); callsAtCancellation = tmux.calls.length; }
        else if (interruption === 'replace') tmux.respawnPane();
        else tmux.sessionOptions.set(interruption === 'alias' ? '@cauce_alias' : '@cauce_harness', 'foreign');
        return Promise.resolve();
      },
    });
    assert.equal(ready, interruption === 'cancel' ? 'cancelled' : 'changed');
    if (callsAtCancellation !== undefined) assert.equal(tmux.calls.length, callsAtCancellation);
    assert.equal(tmux.calls.filter(call => call[0] === 'new-session').length, 1);
    for (const command of ['kill-session', 'send-keys', 'paste-buffer', 'respawn-pane']) assert.equal(tmux.used(command), false);
  }
});

test('a changed command pin while waiting cannot publish ready or recreate the session', async () => {
  const { state, workspace } = await freshState('startup-changed-pin');
  const command = `${state}/codex`; await writeFile(command, 'original', { mode: 0o700 });
  const sha256 = createHash('sha256').update('original').digest('hex');
  const spec = { alias: 'socrates', harness: 'codex', workspace, command,
    commandPins: { command, sha256, files: {} } } as const;
  const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = [];
  tmux.panePid = String(process.pid); tmux.paneContent = 'Initializing';
  const initial = await ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 0 });
  assert.ok(initial.pane);
  await assert.rejects(waitForAccreditedTui(tmux, spec, initial.pane, { sleep: async () => {
    await writeFile(command, 'changed'); tmux.paneContent = '❯ ';
  } }), /pinned harness file changed/u);
  assert.equal(tmux.calls.filter(call => call[0] === 'new-session').length, 1);
  for (const operation of ['kill-session', 'send-keys', 'paste-buffer', 'respawn-pane']) assert.equal(tmux.used(operation), false);
});

test('a stale tmux PID cannot remain accredited after the real process exits', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = [];
    tmux.panePid = String(child.pid); tmux.paneContent = 'Initializing';
    const spec = { alias: 'socrates', harness: 'codex', workspace: '/workspace' } as const;
    const initial = await ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 0 });
    assert.ok(initial.pane);
    const ready = await waitForAccreditedTui(tmux, spec, initial.pane, { sleep: async () => {
      const exited = once(child, 'exit'); child.kill(); await exited; tmux.paneContent = '❯ ';
    } });
    assert.equal(ready, 'changed'); assert.equal(tmux.panePid, String(child.pid));
    assert.equal(tmux.calls.filter(call => call[0] === 'new-session').length, 1);
    for (const command of ['kill-session', 'send-keys', 'paste-buffer', 'respawn-pane']) assert.equal(tmux.used(command), false);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
});

// ---------------------------------------------------------------------------
// Pane environment: the same no matter who creates it.
// ---------------------------------------------------------------------------

test("la TUI arranca con el mismo entorno la cree el adaptador o el CLI", () => {
  // The tmux server keeps the environment of the FIRST client that creates it and DROPS that of
  // subsequent ones (measured on ws-prizma with an isolated socket). That is why the environment
  // travels in the pane's ARGV and why both creators have to pull it from the same place.
  const environment = { HOME: "/home/dev" } as NodeJS.ProcessEnv;
  const adapter = loadSharedSessionConfig("codex", "socrates", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  const cli = cliSharedSessionSpec("codex", "socrates", "/workspace", "/home/dev", environment);
  assert.deepEqual(adapter?.paneEnvironment, { CODEX_HOME: "/home/dev/.codex" });
  assert.deepEqual(cli.environment, adapter.paneEnvironment);

  // claude uses its own variable, and it is the SAME one used to resolve transcripts.
  const claude = loadSharedSessionConfig("claude", "kratos", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  assert.deepEqual(claude?.paneEnvironment, { CLAUDE_CONFIG_DIR: "/home/dev/.claude" });
  assert.equal(claude.configDirectory, "/home/dev/.claude");
  assert.equal(
    transcriptDirectoryIn(claude.configDirectory, "/workspace"),
    transcriptDirectory("/home/dev", "/workspace"),
  );

  // A declared value wins over the default; a relative one is an error, not a silent workaround.
  assert.deepEqual(
    sharedSessionPaneEnvironment("codex", "/home/dev", { CODEX_HOME: "/datos/codex" }),
    { CODEX_HOME: "/datos/codex" },
  );
  assert.throws(() => sharedSessionPaneEnvironment("codex", "/home/dev", { CODEX_HOME: "relativo" }));
});

test("el entorno se escapa y entra en el argv del panel", async () => {
  const prefix = paneEnvironmentPrefix({ CODEX_HOME: "/home/dev/.codex" });
  assert.deepEqual(prefix, { ok: true, prefix: "env CODEX_HOME='/home/dev/.codex' " });
  // A value containing a quote cannot escape into the command line.
  const raro = paneEnvironmentPrefix({ CLAUDE_CONFIG_DIR: "/tmp/x'; rm -rf /" });
  assert.equal(raro.ok, true);
  assert.equal(raro.prefix.includes("'\\''"), true);
  // And an invalid name fails BY SAYING SO, instead of launching the TUI with less environment than requested.
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
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "kratos");
  assert.equal(tmux.sessionOptions.get("@cauce_harness"), "claude");
});

// ---------------------------------------------------------------------------
// Session identity: the name alone does not attest which harness lives inside.
// ---------------------------------------------------------------------------

test("una sesion legacy correcta se infiere una vez y queda marcada alias+harness", async () => {
  const { workspace } = await freshState("identidad-legacy");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-socrates";
  tmux.sessionOptions.clear();
  tmux.paneStartCommand = "bash -lc 'exec env CODEX_HOME=/home/dev/.codex /usr/local/bin/codex resume --last'";

  const result = await ensureSharedSession(
    tmux,
    { alias: "socrates", harness: "codex", workspace, command: "/usr/local/bin/codex" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.created, false);
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "socrates");
  assert.equal(tmux.sessionOptions.get("@cauce_harness"), "codex");
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("new-session"), false);
});

test("una sesion marcada con otro harness falla cerrado y nunca se destruye", async () => {
  const { workspace } = await freshState("identidad-harness-incompatible");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-salva";
  tmux.sessionOptions.set("@cauce_alias", "salva");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  tmux.paneStartCommand = "exec claude";

  const result = await ensureSharedSession(
    tmux,
    { alias: "salva", harness: "codex", workspace, command: "codex" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "session_harness_mismatch");
  assert.match(result.detail, /conserva intacta/u);
  assert.equal(tmux.sessionExists, true);
  assert.deepEqual(tmux.windows, ["agente"]);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("rename-window"), false);
  assert.equal(tmux.used("new-session"), false);
});

test("respawn-pane no hereda la identidad aunque conserve marcadores y pane_id", async () => {
  const { workspace } = await freshState("identidad-respawn-marcada");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-kratos";
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  const paneId = tmux.paneId;
  tmux.respawnPane("exec sh");

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "session_identity_unverified");
  assert.equal(tmux.paneId, paneId, "respawn-pane conservó %pane_id");
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("new-session"), false);
});

test("una ventana TUI con más de un pane falla cerrada sin elegir el activo", async () => {
  const { workspace } = await freshState("identidad-multipane");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-kratos";
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "claude");
  tmux.extraPaneCount = 1;

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "session_identity_unverified");
  assert.equal(tmux.used("kill-session"), false);
});

test(
  "tmux real: un respawn con otro comando invalida una sesión marcada",
  async () => {
    const socket = `cauce-identity-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket);
    try {
      const created = await tmux.run([
        "new-session", "-d", "-s", "cauce-kratos", "-n", "agente", "-c", "/tmp", "exec sleep 30",
      ]);
      assert.equal(created.exitCode, 0, created.stderr);
      assert.equal((await tmux.run([
        "set-option", "-t", "cauce-kratos", "@cauce_alias", "kratos",
      ])).exitCode, 0);
      assert.equal((await tmux.run([
        "set-option", "-t", "cauce-kratos", "@cauce_harness", "claude",
      ])).exitCode, 0);

      const before = await ensureSharedSession(
        tmux,
        { alias: "kratos", harness: "claude", workspace: "/tmp", command: "sleep" },
        { sleep: immediate, readyTimeoutMs: 30 },
      );
      assert.equal(before.ready, true, before.detail);
      assert.ok(before.pane);
      const respawned = await tmux.run([
        "respawn-pane", "-k", "-t", before.pane.paneId, "exec tail -f /dev/null",
      ]);
      assert.equal(respawned.exitCode, 0, respawned.stderr);

      const after = await ensureSharedSession(
        tmux,
        { alias: "kratos", harness: "claude", workspace: "/tmp", command: "sleep" },
        { sleep: immediate, readyTimeoutMs: 30 },
      );
      assert.equal(after.ready, false);
      assert.equal(after.failure, "session_identity_unverified");
      assert.equal((await tmux.run(["has-session", "-t", "=cauce-kratos"])).exitCode, 0);
    } finally {
      await tmux.run(["kill-server"]).catch(() => undefined);
    }
  },
);

const LOGIN: Partial<Record<SharedSessionHarness, string>> = {
  claude: 'Login expired · Please run /login\nPaste code here if prompted >',
  codex: 'Sign in with ChatGPT to use Codex as part of your paid plan\nor connect an API key for usage-based billing',
  grok: 'Sign in to Grok\nOpening your browser to sign in\nWaiting for approval',
  muse: 'Open this page to sign in:\nWaiting for approval',
};
const EXPIRED = {
  codex: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
  grok: 'Authentication required: your session has expired or your credentials were rejected. Run /login to re-authenticate, then resend your message.',
  muse: 'Your saved Meta credentials are invalid. Your message was not sent. Quit Muse Code and run `muse login`.',
};
const request = (harness: SharedSessionHarness) => ({ command: harness, harness, args: [], stdin: 'owned login canary',
  signal: new AbortController().signal, timeoutMs: 120_000 });
const loginError = (error: unknown): boolean => error instanceof ProcessExecutionError
  && error.code === 'PROVIDER_LOGIN_REQUIRED' && error.retryable && error.message === PROVIDER_LOGIN_MESSAGE;

async function fixture(harness: SharedSessionHarness, suffix: string, sleep?: (tmux: FakeTmux) => void) {
  const { state, home, workspace } = await freshState(`provider-login-${harness}-${suffix}`);
  const tmux = new FakeTmux(); tmux.paneStartCommand = `exec ${harness}`;
  tmux.sessionOptions.set('@cauce_alias', 'kratos'); tmux.sessionOptions.set('@cauce_harness', harness);
  const runner = new PasteSessionRunner({ alias: 'kratos', harness, workspace, tmux,
    transcript: claudeTranscript(join(home, '.claude'), workspace), sleep: async () => { sleep?.(tmux); },
    quarantineFile: join(state, 'quarantine'), readyTimeoutMs: 0, settleMs: 0, pollMs: 1 });
  const healthy = (): void => {
    tmux.paneContent = '❯ '; tmux.onSubmit = async text => {
      const id = randomUUID(); const sid = randomUUID();
      await writeFile(join(transcriptDirectory(home, workspace), `${sid}.jsonl`),
        `${userEntry(id, null, text, sid)}\n${assistantEntry(randomUUID(), id, envelopeText(), sid)}\n`);
    };
  };
  return { state, tmux, runner, healthy };
}

for (const harness of Object.keys(LOGIN) as SharedSessionHarness[]) {
  test(`${harness}: current auth widget is distinguished from quoted or historical login text`, () => {
    const pane = LOGIN[harness]; assert.ok(pane);
    assert.equal(providerLoginRequired(harness, pane), true);
    assert.equal(providerLoginRequired(harness, `\u001b[31m${pane}\u001b[0m`), true);
    for (const healthy of [`${pane}\n❯ `, `\u001b[31m${pane}\u001b[0m\n❯ `, `\`\`\`text\n${pane}\n\`\`\``,
      pane.split('\n').map(line => `> ${line}`).join('\n'), '❯ explain a login expired error', '']) {
      assert.equal(providerLoginRequired(harness, healthy), false);
    }
  });

  if (harness !== 'claude') test(`${harness}: a blocking expiry in the active footer survives an ordinary prompt above it`, () => {
    const text = EXPIRED[harness];
    assert.equal(providerLoginRequired(harness, `❯ \n${text}`), true);
    assert.equal(providerLoginRequired(harness, `❯ \n${text.replace(/(.{1,40})\s/gu, '$1\n')}`), true);
    assert.equal(providerLoginRequired(harness, `\u001b[31m${text}\u001b[0m\n❯ `), false);
    assert.equal(providerLoginRequired(harness, `> ${text}\n❯ `), false);
    assert.equal(providerLoginRequired(harness, `❯ \n\`\`\`text\n${text}\n\`\`\``), false);
  });

  test(`${harness}: login before paste fails explicitly and a healthy next turn reuses the same TUI`, async () => {
    const { state, tmux, runner, healthy } = await fixture(harness, 'before');
    tmux.paneContent = LOGIN[harness] ?? '';
    const identity = [tmux.sessionId, tmux.paneId, tmux.panePid];
    await assert.rejects(runner.run(request(harness)), loginError);
    assert.equal(tmux.used('paste-buffer'), false); assert.equal(tmux.submittedCount, 0);
    healthy(); const result = await runner.run(request(harness));
    assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
    assert.deepEqual([tmux.sessionId, tmux.paneId, tmux.panePid], identity);
    assert.equal((await readdir(state)).some(name => name.includes('quarantine')), false);
    for (const command of ['kill-pane', 'kill-session', 'respawn-pane', 'new-session']) assert.equal(tmux.used(command), false);
  });

  test(`${harness}: login during response wait ends promptly and clears only its pending`, async () => {
    const { state, tmux, runner, healthy } = await fixture(harness, 'during');
    tmux.onSubmit = () => { tmux.paneContent = LOGIN[harness] ?? ''; };
    const started = performance.now();
    await assert.rejects(runner.run(request(harness)), loginError);
    assert.ok(performance.now() - started < 5000); assert.equal(tmux.submittedCount, 1);
    assert.equal(tmux.paneOptions.has('@cauce_quarantined_pane'), false);
    assert.equal((await readdir(state)).some(name => name.endsWith('.pending')), false);
    healthy(); assert.equal((await runner.run(request(harness))).exitCode, 0);
    assert.equal(tmux.submittedCount, 2); assert.equal(tmux.interruptedCount, 0);
    for (const command of ['kill-pane', 'kill-session', 'respawn-pane', 'new-session']) assert.equal(tmux.used(command), false);
  });

  test(`${harness}: login replacing a busy input box stops acquisition without sending anything`, async () => {
    let changed = false;
    const { tmux, runner } = await fixture(harness, 'acquire', pane => {
      if (!changed) { changed = true; pane.paneContent = LOGIN[harness] ?? ''; }
    });
    tmux.paneContent = '❯ owner draft';
    await assert.rejects(runner.run(request(harness)), loginError);
    assert.equal(tmux.used('paste-buffer'), false); assert.equal(tmux.submittedCount, 0);
    assert.equal(tmux.interruptedCount, 0);
  });
}

test('login shown after load-buffer is rejected under the input barrier before paste and Enter', async () => {
  const { tmux, runner, healthy } = await fixture('claude', 'barrier');
  const original = tmux.run.bind(tmux);
  tmux.run = async (args, stdin, control) => {
    const result = await original(args, stdin, control);
    if (args[0] === 'load-buffer') tmux.paneContent = LOGIN.claude ?? '';
    return result;
  };
  await assert.rejects(runner.run(request('claude')), loginError);
  assert.equal(tmux.used('paste-buffer'), false); assert.equal(tmux.submittedCount, 0);
  assert.equal(tmux.buffers.size, 0); assert.equal(tmux.inputOff, false);
  tmux.run = original; healthy(); assert.equal((await runner.run(request('claude'))).exitCode, 0);
});

test('startup with an accredited login widget connects without waiting for a human to authenticate', async () => {
  const { state, home, workspace } = await freshState('provider-login-startup');
  const config = loadSharedSessionConfig('claude', 'kratos', state, { HOME: home, CAUCE_SHARED_SESSION: '1',
    CAUCE_SHARED_SESSION_WORKSPACE: workspace, CLAUDE_CONFIG_DIR: join(home, '.claude') });
  assert.ok(config);
  const tmux = new FakeTmux(); tmux.sessionExists = false; tmux.windows = [];
  tmux.panePid = String(process.pid); tmux.paneContent = LOGIN.claude ?? '';
  await ensureSharedSessionStartup(config, () => undefined, tmux);
  assert.equal(tmux.calls.filter(call => call[0] === 'new-session').length, 1);
  for (const command of ['kill-pane', 'kill-session', 'send-keys', 'paste-buffer']) assert.equal(tmux.used(command), false);
});

test('a durable correlated success wins over subsequent login expiry; the next delivery requires login', async () => {
  const { tmux, runner, healthy } = await fixture('claude', 'terminal-before-login');
  healthy(); const submit = tmux.onSubmit;
  tmux.onSubmit = async text => { await submit?.(text); tmux.paneContent = LOGIN.claude ?? ''; };
  assert.equal((await runner.run(request('claude'))).exitCode, 0);
  await assert.rejects(runner.run(request('claude')), loginError);
  assert.equal(tmux.submittedCount, 1); assert.equal(tmux.interruptedCount, 0);
});

test('an uncorrelated transcript answer cannot turn a login failure into success', async () => {
  const { tmux, runner, healthy } = await fixture('claude', 'foreign-terminal');
  healthy(); const submit = tmux.onSubmit;
  tmux.onSubmit = async () => { await submit?.('another delivery'); tmux.paneContent = LOGIN.claude ?? ''; };
  await assert.rejects(runner.run(request('claude')), loginError);
  assert.equal(tmux.submittedCount, 1); assert.equal(tmux.interruptedCount, 0);
});

test('a lone Claude expiry banner is insufficient without its active login widget', () => {
  assert.equal(providerLoginRequired('claude', 'Login expired · Please run /login'), false);
});

test('pinned Codex account-mismatch and Grok refresh failures remain provider-specific', () => {
  for (const [harness, text] of [
    ['codex', 'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.'],
    ['grok', 'Authentication could not be refreshed. Run `grok login` to sign in again.'],
  ] as const) {
    assert.equal(providerLoginRequired(harness, `❯ \n${text}`), true);
    assert.equal(providerLoginRequired(harness, `${text}\n❯ `), false);
  }
});

test('login appearing after paste prevents Enter and does not quarantine the healthy next delivery', async () => {
  let changed = false;
  const { state, tmux, runner, healthy } = await fixture('claude', 'before-enter', pane => {
    if (pane.pasted !== undefined && !changed) {
      changed = true; pane.inputContent = ''; pane.paneContent = LOGIN.claude ?? '';
    }
  });
  await assert.rejects(runner.run(request('claude')), loginError);
  assert.equal(tmux.submittedCount, 0); assert.equal(tmux.inputOff, false);
  assert.equal((await readdir(state)).some(name => name.endsWith('.pending')), false);
  healthy(); assert.equal((await runner.run(request('claude'))).exitCode, 0);
  assert.equal(tmux.submittedCount, 1); assert.equal(tmux.interruptedCount, 0);
});

test('cancelling an already-auth-blocked turn does not send Escape or kill its login widget', async () => {
  const { tmux, runner } = await fixture('claude', 'cancel');
  const controller = new AbortController();
  tmux.onSubmit = () => { tmux.paneContent = LOGIN.claude ?? ''; controller.abort(); };
  const result = await runner.run({ ...request('claude'), signal: controller.signal });
  assert.equal(result.cancelled, true); assert.equal(tmux.interruptedCount, 0);
  assert.equal(tmux.paneOptions.has('@cauce_quarantined_pane'), false);
  for (const command of ['kill-pane', 'kill-session', 'respawn-pane']) assert.equal(tmux.used(command), false);
});

test('the real HarnessAdapter preserves the explicit retryable login error before provider execution', async () => {
  const { state, tmux, runner } = await fixture('claude', 'adapter-error');
  tmux.paneContent = LOGIN.claude ?? '';
  const adapter = await adapterFor(runner, state, 'kratos', 'claude');
  await assert.rejects(executeHarness(adapter), loginError);
  assert.equal(tmux.used('paste-buffer'), false); assert.equal(tmux.submittedCount, 0);
});


test('startup degraded log carries the ensure detail and the readiness outcome', async () => {
  const { state, home, workspace } = await freshState('startup-degraded-detail');
  const configured = loadSharedSessionConfig('codex', 'socrates', state, {
    HOME: home, CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: workspace,
  });
  assert.ok(configured);
  const tmux = new FakeTmux(); tmux.sessionName = 'cauce-socrates'; tmux.sessionOptions.set('@cauce_harness', 'claude');
  const logs: AdapterLog[] = [];
  await assert.rejects(ensureSharedSessionStartup(configured, (entry) => { logs.push(entry); }, tmux),
    (error: unknown) => error instanceof ProcessExecutionError && error.code === 'SHARED_TUI_UNAVAILABLE');
  assert.equal(logs.length, 1);
  assert.match(logs[0]?.detail ?? '', /^ensure: /u);
  assert.match(logs[0]?.detail ?? '', /readiness: /u);
});
