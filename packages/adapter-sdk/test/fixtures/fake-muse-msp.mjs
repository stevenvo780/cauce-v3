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
const read = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
};
const scenario = read(join(process.cwd(), "fake-muse-scenario.json"), {});
const state = read(statePath, { sessions: {}, turns: [], hostEnv: [], events: [], reads: 0, pages: 0 });
state.openings ??= [];
state.capabilityRequests ??= [];
state.hostEnv.push({ home, configHome, dataHome, codexHome: process.env.CODEX_HOME ?? null, args: launchArgs });
let submitted = false;
function persist() { writeFileSync(statePath, JSON.stringify(state)); }
persist();
function response(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function error(id, code, kind, reason) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id,
    error: { code, message: reason, data: { kind, reason } },
  })}\n`);
}
function notify(method, params) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
function head(id) {
  if (scenario.missingCursor) return undefined;
  return state.events.filter((event) => event.params.sessionId === id).at(-1)?.params.viewCursor
    ?? (scenario.beforeGenesis ? "" : "v1-0");
}
function opened(id) {
  const held = state.sessions[id];
  return {
    sessionId: id, workspaceRoot: held.workspaceRoot,
    modelId: scenario.staleModelMetadata ? "muse-spark-1.3-contributor" : held.modelId,
    providerId: "meta", approvalMode: { mode: held.approvalMode, source: "startup", lastCommandId: null },
    status: "idle", activeTurnId: null, path: join(dataHome, "muse", id), turnCount: held.turnCount,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", forkedFrom: null,
  };
}
function event(method, params, deliver = true) {
  const sequence = state.events.length + 1;
  const position = { id: `record-${sequence}`, sequence };
  const sourceRange = { first: position, last: position, stream: { kind: "session", id: params.sessionId } };
  const frame = { method, params: { ...params,
    ...(method === "item/delta" ? {} : { sourceRange }), viewCursor: `v1-${sequence}`,
  } };
  if (scenario.invalidTerminalRange && method === "turn/completed") frame.params.sourceRange = {};
  state.events.push(frame);
  persist();
  if (deliver) notify(frame.method, frame.params);
  return frame;
}
function history() {
  if (scenario.preflightUnavailable || (submitted && scenario.recoveryUnavailable)) {
    return { mode: "none", noneReason: "projectionUnavailable", items: null, snapshot: null };
  }
  if (scenario.historyReason !== undefined) {
    return { mode: "none", noneReason: scenario.historyReason, items: null, snapshot: null };
  }
  return { mode: "inline", items: [], snapshot: null };
}
function models() {
  const rows = ["muse-spark-1.3", "muse-spark-1.3-contributor"].map((modelId) => {
    const variants = scenario.unknownVariants ? "unknown" : scenario.variants
      ?? ["minimal", "low", "medium", "high", "xhigh",
        ...(!modelId.endsWith("contributor") || scenario.subscriptionContributorMax ? ["max"] : [])];
    return {
    modelId, providerId: "meta", profileId: null, isActive: false, isDefault: modelId.endsWith("contributor"),
    contextLimit: 1_048_576, outputLimit: 65_536, cost: null, description: null,
    displayLabel: modelId, releaseDate: null,
    ...(scenario.missingVariants ? {} : {
      variants,
      ...(variants === "unknown" || scenario.legacyCatalog ? {} : {
        reasoningEffortVariants: variants.map((tier) => ({ tier, description: tier })),
        defaultReasoningEffort: "high",
      }),
    }),
  }; });
  if (scenario.invalidVariants) rows[0].reasoningEffortVariants = [{ tier: "ultra" }];
  return { models: rows, source: scenario.catalogSource ?? "providerCatalog", providerId: "meta", profileId: null };
}
function finish(p) {
  const sessionId = p.sessionId;
  const turnId = scenario.ackTurnId ?? p.commandId;
  event("turn/started", { sessionId, turnId, commandId: p.commandId });
  if (scenario.hang) return;
  const finishTurn = () => {
  const answer = scenario.answer ?? JSON.stringify({
    reply: "Muse responde", messages: [], notify: [], status: "done", retryable: false, artifacts: [],
  });
  const message = (id, status, revision, text) => ({
    itemId: `${p.commandId}:${id}`, turnId, kind: "agentMessage", status, revision, text,
  });
  if (scenario.lateCommentary) {
    event("item/started", { sessionId, item: message("commentary", "inProgress", 1, "Working") });
  }
  event("item/completed", { sessionId, item: {
    ...message("answer", "completed", 1, answer), ...(scenario.truncated ? { truncated: true } : {}),
  } }, !scenario.lostMessage);
  if (scenario.lateCommentary) {
    event("item/completed", { sessionId, item: message("commentary", "completed", 2, "Earlier commentary") });
  }
  if (!scenario.noTerminal) {
    event("turn/completed", {
      sessionId, turnId: scenario.wrongTerminal ? "another-turn" : turnId,
      terminal: scenario.terminal ?? "completed",
      ...(scenario.terminal === "failed"
        ? { error: { kind: "modelError", message: "synthetic model failure", retryable: false } } : {}),
    }, !scenario.lostTerminal);
  }
  if (scenario.fault === "health") {
    notify("session/viewHealthChanged", { sessionId, health: "unavailable", noneReason: "projectionUnavailable" });
  } else if (scenario.fault === "protocol") {
    process.stdout.write("invalid-json\n");
  } else if (scenario.fault === "gap") {
    notify("view/gap", { sessionId, after: "v1-0", next: head(sessionId) });
  } else if (scenario.fault === "exit") {
    process.exit(0);
  }
  if (scenario.fault === "idle" || scenario.wrongTerminal || scenario.noTerminal) {
    notify("session/statusChanged", { sessionId, status: "idle", viewCursor: head(sessionId) });
  }
  };
  const steps = scenario.slowSteps ?? 0;
  const progressId = `${p.commandId}:streaming-progress`;
  if (scenario.deltaProgress) event("item/started", { sessionId, item: {
    itemId: progressId, turnId, kind: "agentMessage", status: "inProgress", revision: 1, text: "",
  } });
  let firstDelta;
  for (let step = 0; step < steps; step += 1) {
    setTimeout(() => {
      if (scenario.deltaProgress) {
        if (scenario.duplicateDelta && firstDelta) notify("item/delta", firstDelta.params);
        else {
          const frame = event("item/delta", {
            sessionId, itemId: progressId, delta: scenario.emptyDelta && step > 0 ? "" : "x",
          });
          firstDelta ??= frame;
        }
      }
      else event("item/completed", { sessionId, item: {
        itemId: `${p.commandId}:progress:${scenario.staleProgress ? 0 : step}`,
        turnId: scenario.foreignProgress ? "another-turn" : turnId,
        kind: "agentMessage", status: "completed", revision: 1, text: `paso ${step}`,
      } });
    }, (step + 1) * (scenario.stepMs ?? 50));
  }
  if (steps === 0) finishTurn(); else setTimeout(finishTurn, (steps + 1) * (scenario.stepMs ?? 50));
}

const lines = createInterface({ input: process.stdin });
async function registerMcp(method, params) {
  const server = params.config?.mcpServers?.cauce;
  if (!server) { state.openings.push({ method, sessionId: params.sessionId, endpoint: null, toolNames: [] }); persist(); return; }
  if (server.transport !== "stdio" || server.mode !== "required" || server.framing !== "lineDelimitedJson"
    || server.command !== process.execPath || server.args?.length !== 2) throw new Error("invalid MCP registration");
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client({ name: "fake-muse-native-client", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: server.command,
    args: scenario.mcpMissingBinary ? [join(process.cwd(), "absent-cauce-mcp.js")] : server.args,
    stderr: "pipe", env: { PATH: process.env.PATH, HOME: home, CAUCE_EMISSION_SOCKET_PATH: server.args[1] } });
  try {
    if (scenario.mcpRegistryFailure) throw new Error("synthetic registry failure");
    await client.connect(transport);
    const { tools } = await client.listTools();
    state.openings.push({ method, sessionId: params.sessionId, endpoint: server.args[1],
      command: server.command, binary: server.args[0], toolNames: tools.map(tool => tool.name) });
    persist();
  } finally { await client.close(); }
}

lines.on("line", async (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  const p = frame.params ?? {};
  switch (frame.method) {
    case "initialize": {
      if (scenario.brokenHandshake) { process.stdout.write("invalid-json\n"); break; }
      const requested = p.capabilities?.requestedCapabilities ?? [];
      state.capabilityRequests.push(requested); persist();
      response(frame.id, {
        experimentalApi: false, grantedCapabilities: !scenario.missingSessionMcp && requested.includes("sessionMcp") ? ["sessionMcp"] : [], museHome: join(dataHome, "muse"),
        platformFamily: "unix", platformOs: "linux",
        schema: { fingerprint: "sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81", version: "1" },
        serverInfo: { name: "fake-muse", version: "1.4.1" }, sessionDurability: "durable", userAgent: "fake-muse",
      });
      break;
    }
    case "session/start":
      try { await registerMcp(frame.method, p); }
      catch { error(frame.id, -32030, "commandRejected", "mcp_startup_failed"); break; }
      if (state.sessions[p.sessionId]) { error(frame.id, -32030, "commandRejected", "session_id_conflict"); break; }
      state.sessions[p.sessionId] = {
        workspaceRoot: p.workspaceRoot, modelId: p.modelId ?? null, approvalMode: p.approvalMode, turnCount: 0,
      };
      persist();
      response(frame.id, { session: opened(p.sessionId), viewCursor: head(p.sessionId) });
      break;
    case "session/resume":
      try { await registerMcp(frame.method, p); }
      catch { error(frame.id, -32030, "commandRejected", "mcp_startup_failed"); break; }
      if (!state.sessions[p.sessionId]) { error(frame.id, -32020, "sessionNotFound", "missing"); break; }
      response(frame.id, { session: opened(p.sessionId), viewCursor: head(p.sessionId),
        history: { mode: "none", noneReason: "excluded", items: null, snapshot: null }, pendingRequests: [],
      });
      break;
    case "session/read":
      state.reads += 1;
      persist();
      if (!scenario.hangRead) {
        const finishRead = () => response(frame.id, {
          session: { ...opened(p.sessionId),
            ...(scenario.readWorkspaceRoot === undefined ? {} : { workspaceRoot: scenario.readWorkspaceRoot }),
          }, viewCursor: head(p.sessionId), history: history(), pendingRequests: [],
        });
        if (scenario.readDelayMs) setTimeout(finishRead, scenario.readDelayMs); else finishRead();
      }
      break;
    case "model/list": response(frame.id, models()); break;
    case "session/setApprovalMode":
      state.sessions[p.sessionId].approvalMode = p.mode;
      persist();
      response(frame.id, { commandId: p.commandId, status: "accepted", applyOutcome: "completed",
        effectiveMode: { mode: p.mode, source: "approvalReconfigure", lastCommandId: p.commandId },
      });
      break;
    case "session/setModel":
      state.sessions[p.sessionId].modelId = p.model.modelId;
      persist();
      response(frame.id, { commandId: p.commandId, status: "accepted" });
      break;
    case "turn/start":
      submitted = true;
      state.sessions[p.sessionId].turnCount += 1;
      state.turns.push({ sessionId: p.sessionId, commandId: p.commandId, input: p.input,
        reasoningEffort: p.reasoningEffort ?? null, model: state.sessions[p.sessionId].modelId,
      });
      persist();
      if (scenario.terminalBeforeAck) finish(p);
      response(frame.id, { commandId: p.commandId, status: "accepted",
        turnId: scenario.ackTurnId ?? p.commandId, disposition: "started", startedNewTurn: true,
      });
      if (!scenario.terminalBeforeAck) setImmediate(() => finish(p));
      break;
    case "view/page": {
      state.pages += 1;
      persist();
      if (scenario.pageError) { error(frame.id, -32025, "viewTruncated", "synthetic view failure"); break; }
      const events = state.events.filter((event) => event.params.sessionId === p.sessionId && event.method !== "item/delta");
      const index = events.findIndex((event) => event.params.viewCursor === p.cursor);
      const served = events.slice(index + 1, index + 1 + p.limit);
      if (scenario.foreignPage && served[0]) served[0] = { ...served[0], params: { ...served[0].params, sessionId: "foreign-session" } };
      response(frame.id, { events: scenario.stalledPage ? [] : served,
        nextCursor: scenario.stalledPage ? p.cursor : (index + 1 + served.length < events.length ? served.at(-1).params.viewCursor : null),
      });
      break;
    }
    default: error(frame.id, -32601, "methodNotFound", "method_not_found");
  }
});
lines.on("close", () => process.exit(0));
