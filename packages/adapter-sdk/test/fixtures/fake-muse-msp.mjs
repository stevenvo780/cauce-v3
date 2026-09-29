#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const launchArgs = process.argv.slice(2);
if (launchArgs[0] !== "serve" || launchArgs.at(-1) !== "--trust-workspace"
  || (launchArgs.length !== 2 && !(launchArgs.length === 3 && launchArgs[1] === "--disable-sandbox"))) process.exit(2);

const home = process.env.HOME;
const configHome = process.env.XDG_CONFIG_HOME;
const dataHome = process.env.XDG_DATA_HOME;
if (!home || !configHome || !dataHome || process.env.MUSE_NO_AUTO_UPDATE !== "1") process.exit(3);
mkdirSync(dataHome, { recursive: true });
const statePath = join(dataHome, "fake-muse-state.json");
const state = (() => {
  try { return JSON.parse(readFileSync(statePath, "utf8")); }
  catch { return { sessions: {}, turns: [], hostEnv: [] }; }
})();
state.hostEnv.push({ home, configHome, dataHome, codexHome: process.env.CODEX_HOME ?? null, args: launchArgs });

function persist() { writeFileSync(statePath, JSON.stringify(state)); }
function response(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function error(id, code, kind, reason) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0", id,
    error: { code, message: reason, data: { kind, reason } },
  })}\n`);
}
function notify(method, params) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
function session(id) { return state.sessions[id]; }
function opened(id) {
  const held = session(id);
  return {
    sessionId: id,
    workspaceRoot: held.workspaceRoot,
    modelId: held.modelId,
    providerId: "meta",
    approvalMode: { mode: held.approvalMode, source: "startup", lastCommandId: null },
    status: "idle",
    activeTurnId: null,
    path: join(dataHome, "muse", id),
    turnCount: held.turnCount,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    forkedFrom: null,
  };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  const p = frame.params ?? {};
  switch (frame.method) {
    case "initialize":
      response(frame.id, {
        experimentalApi: false,
        grantedCapabilities: [],
        museHome: join(dataHome, "muse"),
        platformFamily: "unix",
        platformOs: "linux",
        schema: { fingerprint: "sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81", version: "1" },
        serverInfo: { name: "fake-muse", version: "1.4.0" },
        sessionDurability: "durable",
        userAgent: "fake-muse",
      });
      break;
    case "session/start":
      if (session(p.sessionId)) { error(frame.id, -32030, "commandRejected", "session_id_conflict"); break; }
      state.sessions[p.sessionId] = {
        workspaceRoot: p.workspaceRoot,
        modelId: p.modelId ?? null,
        approvalMode: p.approvalMode,
        turnCount: 0,
      };
      persist();
      response(frame.id, { session: opened(p.sessionId), viewCursor: "1" });
      break;
    case "session/resume":
      if (!session(p.sessionId)) { error(frame.id, -32020, "sessionNotFound", "missing"); break; }
      response(frame.id, {
        session: opened(p.sessionId), viewCursor: "2", history: { mode: "none" }, pendingRequests: [],
      });
      break;
    case "session/setApprovalMode":
      session(p.sessionId).approvalMode = p.mode;
      persist();
      response(frame.id, {
        commandId: p.commandId, status: "accepted", applyOutcome: "completed",
        effectiveMode: { mode: p.mode, source: "approvalReconfigure", lastCommandId: p.commandId },
      });
      break;
    case "session/setModel":
      session(p.sessionId).modelId = p.model.modelId;
      persist();
      response(frame.id, { commandId: p.commandId, status: "accepted" });
      break;
    case "turn/start": {
      const held = session(p.sessionId);
      held.turnCount += 1;
      state.turns.push({ sessionId: p.sessionId, input: p.input, reasoningEffort: p.reasoningEffort ?? null });
      persist();
      response(frame.id, {
        commandId: p.commandId, status: "accepted", turnId: p.commandId,
        disposition: "started", startedNewTurn: true,
      });
      setImmediate(() => {
        const scenarioPath = join(process.cwd(), "fake-muse-scenario.json");
        let scenario = {};
        try { scenario = JSON.parse(readFileSync(scenarioPath, "utf8")); } catch { scenario = {}; }
        notify("turn/started", {
          sessionId: p.sessionId, turnId: p.commandId, commandId: p.commandId,
          viewCursor: "3", sourceRange: {},
        });
        if (scenario.hang) return;
        const steps = scenario.slowSteps ?? 0;
        for (let step = 0; step < steps; step += 1) {
          setTimeout(() => {
            notify("item/completed", {
              sessionId: p.sessionId, viewCursor: "4", sourceRange: {},
              item: {
                itemId: `0198f0aa-1111-7000-8000-${String(step).padStart(12, "0")}`, turnId: p.commandId,
                kind: "agentMessage", status: "completed", revision: 1, text: `paso ${String(step)}`,
                sourceRange: {},
              },
            });
          }, (step + 1) * (scenario.stepMs ?? 50));
        }
        const finish = () => {
        const answer = scenario.answer ?? JSON.stringify({
          reply: "Muse responde", messages: [], notify: [], status: "done", retryable: false, artifacts: [],
        });
        notify("item/completed", {
          sessionId: p.sessionId, viewCursor: "4", sourceRange: {},
          item: {
            itemId: "0198f0aa-1111-7000-8000-0000000000aa", turnId: p.commandId,
            kind: "agentMessage", status: "completed", revision: 1, text: answer,
            sourceRange: {},
          },
        });
        notify("turn/completed", {
          sessionId: p.sessionId, turnId: p.commandId,
          terminal: scenario.terminal ?? "completed",
          ...(scenario.terminal === "failed"
            ? { error: { kind: "modelError", message: "synthetic model failure", retryable: false } }
            : {}),
          viewCursor: "5", sourceRange: {},
        });
        };
        if (steps === 0) finish(); else setTimeout(finish, (steps + 1) * (scenario.stepMs ?? 50));
      });
      break;
    }
    default: error(frame.id, -32601, "methodNotFound", "method_not_found");
  }
});

lines.on("close", () => process.exit(0));
