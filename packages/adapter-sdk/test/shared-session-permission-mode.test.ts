import assert from "node:assert/strict";
import test from "node:test";
import {
  claudePermissionArguments,
  cliSharedSessionSpec,
  loadSharedSessionConfig,
} from "../src/shared-session/config.js";
import { ensureSharedSession } from "../src/shared-session/session.js";
import { FakeTmux, freshState } from "./shared-session-fixtures.js";

const immediate = (): Promise<void> => Promise.resolve();

test("toda TUI compartida arranca sin permisos finitos: claude con --dangerously-skip-permissions, codex con --yolo", () => {
  // Regla del dueno: nunca permisos finitos. La variable de modo no puede rebajarlo.
  for (const environment of [{}, { CAUCE_CLAUDE_PERMISSION_MODE: "" }, { CAUCE_CLAUDE_PERMISSION_MODE: "bypassPermissions" }, { CAUCE_CLAUDE_PERMISSION_MODE: "plan" }]) {
    assert.deepEqual(claudePermissionArguments("claude", environment), ["--dangerously-skip-permissions"]);
    assert.deepEqual(claudePermissionArguments("codex", environment), ["--yolo"]);
  }
});

test("adaptador y CLI arrancan la TUI con los mismos flags de permisos", () => {
  const environment = { HOME: "/home/dev" } as NodeJS.ProcessEnv;
  const adapter = loadSharedSessionConfig("claude", "kratos", "/estado", {
    ...environment, CAUCE_SHARED_SESSION: "1",
  });
  const cli = cliSharedSessionSpec("claude", "kratos", "/workspace", "/home/dev", environment);
  assert.deepEqual(adapter?.harnessArguments, ["--dangerously-skip-permissions"]);
  assert.deepEqual(cli.harnessArguments, adapter.harnessArguments);
  const codex = cliSharedSessionSpec("codex", "socrates", "/workspace", "/home/dev", environment);
  assert.deepEqual(codex.harnessArguments, ["--yolo"]);
});

test("los flags de permisos van SIEMPRE en el argv del panel, haya o no conversación que reanudar", async () => {
  const { home, workspace } = await freshState("permisos-argv");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  await ensureSharedSession(
    tmux,
    {
      alias: "kratos", harness: "claude", workspace, command: "claude",
      environment: { CLAUDE_CONFIG_DIR: `${home}/.claude` },
      harnessArguments: ["--dangerously-skip-permissions"],
      resume: { args: ["--continue"], hasPreviousConversation: () => Promise.resolve(true) },
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );
  const created = tmux.calls.find((call) => call[0] === "new-session");
  assert.equal(
    created?.at(-1),
    `exec env CLAUDE_CONFIG_DIR='${home}/.claude' claude --dangerously-skip-permissions --continue`,
  );

  const blank = new FakeTmux();
  blank.sessionExists = false;
  blank.windows = [];
  await ensureSharedSession(
    blank,
    {
      alias: "kratos", harness: "claude", workspace, command: "claude",
      harnessArguments: ["--permission-mode", "plan"],
      resume: { args: ["--continue"], hasPreviousConversation: () => Promise.resolve(false) },
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );
  const fresh = blank.calls.find((call) => call[0] === "new-session");
  assert.equal(fresh?.at(-1), "exec claude --permission-mode plan");

  // A flag that cannot travel through the shell is refused, never silently dropped.
  const bad = new FakeTmux();
  bad.sessionExists = false;
  bad.windows = [];
  const result = await ensureSharedSession(
    bad,
    { alias: "kratos", harness: "claude", workspace, command: "claude", harnessArguments: ["--x; rm -rf /"] },
    { sleep: immediate, readyTimeoutMs: 30 },
  );
  assert.equal(result.ready, false);
  assert.equal(bad.used("new-session"), false);
});
