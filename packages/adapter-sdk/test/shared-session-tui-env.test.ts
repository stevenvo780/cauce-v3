import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  cliSharedSessionSpec,
  loadSharedSessionConfig,
  sharedSessionPaneEnvironment,
} from "../src/shared-session/config.js";
import {
  ensureSharedSession,
  paneEnvironmentPrefix,
  transcriptDirectory,
  transcriptDirectoryIn,
} from "../src/shared-session/session.js";
import { CliTmux } from "../src/shared-session/tmux.js";
import { FakeTmux, freshState } from "./shared-session-fixtures.js";

const immediate = (): Promise<void> => Promise.resolve();

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
  assert.deepEqual(cli.environment, adapter?.paneEnvironment);

  // claude uses its own variable, and it is the SAME one used to resolve transcripts.
  const claude = loadSharedSessionConfig("claude", "kratos", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  assert.deepEqual(claude?.paneEnvironment, { CLAUDE_CONFIG_DIR: "/home/dev/.claude" });
  assert.equal(claude?.configDirectory, "/home/dev/.claude");
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
  assert.equal(raro.ok && raro.prefix.includes("'\\''"), true);
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
    const socket = `cauce-identity-${process.pid}-${randomUUID().slice(0, 8)}`;
    const tmux = new CliTmux(socket);
    try {
      const created = await tmux.run([
        "new-session", "-d", "-s", "cauce-kratos", "-n", "agente", "exec sleep 30",
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