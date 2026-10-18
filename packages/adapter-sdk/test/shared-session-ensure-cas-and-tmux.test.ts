import assert from "node:assert/strict";
import test from "node:test";
import { ensureSharedSession } from "../src/shared-session/session.js";
import {
  killSessionIdIfNamed,
  paneIdentity,
} from "../src/shared-session/tmux.js";
import {
  FakeTmux,
  TmuxResult,
  freshState,
} from "./shared-session-fixtures.js";

const immediate = (): Promise<void> => Promise.resolve();

test("un marcador de otro alias falla cerrado sin corregirlo ni tocar el panel", async () => {
  const { workspace } = await freshState("identidad-alias-incompatible");
  const tmux = new FakeTmux();
  tmux.sessionName = "cauce-atlas";
  tmux.sessionOptions.set("@cauce_alias", "kratos");
  tmux.sessionOptions.set("@cauce_harness", "codex");

  const result = await ensureSharedSession(
    tmux,
    { alias: "atlas", harness: "codex", workspace, command: "codex" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "session_alias_mismatch");
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "kratos");
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.used("rename-window"), false);
});

test("dos ensure concurrentes acreditan el mismo session_id y el perdedor no mata por nombre", async () => {
  const { workspace } = await freshState("ensure-doble");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const spec = { alias: "socrates", harness: "codex" as const, workspace, command: "codex" };

  const [first, second] = await Promise.all([
    ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 30 }),
    ensureSharedSession(tmux, spec, { sleep: immediate, readyTimeoutMs: 30 }),
  ]);

  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(first.sessionId, second.sessionId);
  assert.match(first.sessionId ?? "", /^\$[0-9]+$/u);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 2);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.sessionOptions.get("@cauce_alias"), "socrates");
  assert.equal(tmux.sessionOptions.get("@cauce_harness"), "codex");
});

test("el cleanup atómico rechaza un rename en la antigua frontera compare-kill", async () => {
  const tmux = new FakeTmux();
  const creationNonce = "a".repeat(64);
  tmux.sessionOptions.set("@cauce_creation_nonce", creationNonce);
  const identity = await paneIdentity(tmux, tmux.paneId);
  assert.ok(identity);
  const ownership = {
    ...identity,
    paneStartCommand: tmux.paneStartCommand,
    creationNonce,
  };
  const originalRun = tmux.run.bind(tmux);
  let raced = false;
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    if (!raced && args[0] === "if-shell"
      && args.some((argument) => argument.includes("#{session_name}"))) {
      raced = true;
      tmux.sessionName = "renombrada-antes-de-la-orden";
    }
    return originalRun(args, stdin);
  };

  const killed = await killSessionIdIfNamed(tmux, ownership);

  assert.equal(killed, false);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.sessionName, "renombrada-antes-de-la-orden");
  assert.equal(tmux.calls.filter((call) => call[0] === "if-shell").length, 1);
  assert.equal(tmux.used("list-sessions"), false, "no existe compare separado antes del kill");
  assert.equal(tmux.used("kill-session"), false);
});

test("un reemplazo con el mismo nombre falla cerrado y nunca se adopta ni se mata", async () => {
  const { workspace } = await freshState("replacement-mismo-nombre");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const originalRun = tmux.run.bind(tmux);
  let ownId: string | undefined;
  let replacementId: string | undefined;
  tmux.run = async (args, stdin): Promise<TmuxResult> => {
    const response = await originalRun(args, stdin);
    if (args[0] === "new-session" && ownId === undefined && response.exitCode === 0) {
      ownId = response.stdout.trim();
      replacementId = tmux.replaceSession({ alias: "kratos", harness: "claude" });
    }
    return response;
  };

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "session_identity_unverified");
  assert.equal(outcome.sessionId, ownId);
  assert.equal(tmux.sessionId, replacementId);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.used("kill-session"), false);
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
});

test("tmux ignora el -c pedido: el pane recién creado se mata y degrada workspace_mismatch", async () => {
  const { workspace, home } = await freshState("workspace-mismatch");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.paneCurrentPathOverride = home;

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, false);
  assert.equal(outcome.failure, "workspace_mismatch");
  assert.ok(outcome.detail.includes("fuera del workspace"), outcome.detail);
  assert.equal(tmux.sessionExists, false, "la generación recién creada debe morir, no quedar viva con otro cwd");
  assert.equal(tmux.used("kill-session"), true);
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
});

test("un workspace honrado por tmux (mismo -c) nunca degrada por workspace_mismatch", async () => {
  const { workspace } = await freshState("workspace-honrado");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];

  const outcome = await ensureSharedSession(
    tmux,
    { alias: "kratos", harness: "claude", workspace, command: "claude" },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(outcome.ready, true);
  assert.equal(outcome.created, true);
  assert.equal(tmux.sessionExists, true);
  assert.equal(tmux.used("kill-session"), false);
});
