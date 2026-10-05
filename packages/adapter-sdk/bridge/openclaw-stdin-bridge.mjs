#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { realpath, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PHASE_PREFIX = "@cauce/openclaw-phase/v1 ";
const phaseStart = performance.now();
function phase(name) {
  if (!process.argv.includes("--cauce-phase-observer-v1")) return;
  try {
    process.stderr.write(`${PHASE_PREFIX}${JSON.stringify({ phase: name, elapsedMs: performance.now() - phaseStart, utc: new Date().toISOString() })}\n`);
  } catch { /* Diagnostics cannot change execution. */ }
}

const MAX_INPUT_BYTES = 1024 * 1024;
const PROGRESS_MARKER = "<<cauce:progress>>";
const PROGRESS_POLL_MS = Number.parseInt(process.env.CAUCE_OPENCLAW_PROGRESS_POLL_MS ?? "", 10) || 15_000;

function runDeadlineMs() {
  const raw = process.env.CAUCE_OPENCLAW_RUN_DEADLINE_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function listNames(directory) {
  return readdir(directory).catch(() => []);
}

async function codexRollout(codexHome, threadId, cache) {
  if (cache.has(threadId)) return cache.get(threadId);
  const root = join(codexHome, "sessions");
  for (const year of (await listNames(root)).sort().reverse()) {
    for (const month of (await listNames(join(root, year))).sort().reverse()) {
      for (const day of (await listNames(join(root, year, month))).sort().reverse()) {
        const hit = (await listNames(join(root, year, month, day))).find((name) => name.includes(threadId));
        if (hit !== undefined) { cache.set(threadId, join(root, year, month, day, hit)); return cache.get(threadId); }
      }
    }
  }
  return undefined;
}

async function claudeTranscripts(home, claudeSessionId) {
  const projects = join(home, ".claude", "projects");
  const files = [];
  for (const project of await listNames(projects)) {
    const names = await listNames(join(projects, project));
    if (names.includes(`${claudeSessionId}.jsonl`)) files.push(join(projects, project, `${claudeSessionId}.jsonl`));
    if (names.includes(claudeSessionId)) {
      for (const name of await listNames(join(projects, project, claudeSessionId, "subagents"))) {
        files.push(join(projects, project, claudeSessionId, "subagents", name));
      }
    }
  }
  return files;
}

async function runFiles(home, sessionKey, cache) {
  if (sessionKey === undefined) return [];
  const files = [];
  const agents = join(home, ".openclaw", "agents");
  for (const agent of await listNames(agents)) {
    let store;
    try { store = JSON.parse(readFileSync(join(agents, agent, "sessions", "sessions.json"), "utf8")); } catch { continue; }
    const entry = store[sessionKey] ?? store[`agent:${agent}:${sessionKey}`];
    if (entry === undefined) continue;
    const transcript = entry.sessionFile ?? join(agents, agent, "sessions", `${String(entry.sessionId)}.jsonl`);
    files.push(transcript, transcript.replace(/\.jsonl$/u, ".trajectory.jsonl"));
    try {
      const { threadId } = JSON.parse(readFileSync(`${transcript}.codex-app-server.json`, "utf8"));
      const rollout = typeof threadId === "string"
        ? await codexRollout(join(agents, agent, "agent", "codex-home"), threadId, cache) : undefined;
      if (rollout !== undefined) files.push(rollout);
    } catch { /* not a codex-runtime session */ }
    const claude = entry.claudeCliSessionId ?? entry.cliSessionIds?.["claude-cli"];
    if (typeof claude === "string") files.push(...await claudeTranscripts(home, claude));
  }
  return files;
}

// Progress is growth of THIS run's own files: other sessions and crons must not keep a hung run alive.
function watchProgress(home, sessionKey, emit) {
  const sizes = new Map();
  const cache = new Map();
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      let grew = false;
      for (const file of await runFiles(home, sessionKey, cache)) {
        const size = (await stat(file).catch(() => undefined))?.size;
        if (size === undefined) continue;
        if (sizes.has(file) && sizes.get(file) !== size) grew = true;
        sizes.set(file, size);
      }
      if (grew) emit();
    } finally { busy = false; }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, PROGRESS_POLL_MS);
  timer.unref();
  return () => { clearInterval(timer); };
}

function gatewayPort() {
  const path = process.env.OPENCLAW_CONFIG_PATH ?? join(process.env.HOME ?? "", ".openclaw", "openclaw.json");
  try {
    const port = JSON.parse(readFileSync(path, "utf8"))?.gateway?.port;
    return Number.isSafeInteger(port) && port > 0 ? port : 18789;
  } catch { return 18789; }
}

function gatewayListening(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (alive) => { socket.destroy(); done(alive); };
    socket.setTimeout(2_000, () => { finish(true); });
    socket.once("connect", () => { finish(true); });
    socket.once("error", (error) => { finish(error?.code === "ECONNREFUSED" ? false : true); });
  });
}

class EmbeddedFallbackIntercepted extends Error {
  constructor(line) {
    super(line.split("\n")[0]);
    this.byTimeout = /timed out/u.test(line);
  }
}

// OpenClaw re-runs the turn embedded without checking whether the gateway run is still alive.
function interceptingRuntime(runtime) {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== "error") return Reflect.get(target, property, receiver);
      return (...args) => {
        const line = args.map(String).join(" ");
        if (line.startsWith("EMBEDDED FALLBACK:")) throw new EmbeddedFallbackIntercepted(line);
        return target.error?.(...args);
      };
    },
  });
}

async function embeddedFallbackRefusal(intercepted) {
  if ((process.env.CAUCE_OPENCLAW_EMBEDDED_FALLBACK ?? "gateway-down") === "never") {
    return "embedded fallback disabled (CAUCE_OPENCLAW_EMBEDDED_FALLBACK=never)";
  }
  if (intercepted.byTimeout) return "the gateway client gave up; not re-running the turn embedded";
  if (await gatewayListening(gatewayPort())) return "the gateway is still alive; not re-running the turn embedded in parallel";
  return undefined;
}

function failureEnvelope(message, nativeSessionKey) {
  return `${JSON.stringify({
    result: { ok: false, error: message },
    ...(nativeSessionKey === undefined ? {} : { session_id: nativeSessionKey }),
  })}\n`;
}

async function existsDirectory(path) {
  return stat(path).then((entry) => entry.isDirectory(), () => false);
}

async function readPrompt() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_INPUT_BYTES) throw new Error("input limit exceeded");
    chunks.push(bytes);
  }
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (!prompt) throw new Error("empty input");
  return prompt;
}

function sessionKey(args) {
  let value;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--session-key" && typeof args[index + 1] === "string") {
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--session-key=")) {
      value = argument.slice("--session-key=".length);
    }
  }
  return value && value.length > 0 ? value : undefined;
}

function possibleDistDirectories(resolvedEntry) {
  const directories = [];
  let current = dirname(resolvedEntry);
  for (let depth = 0; depth < 5; depth += 1) {
    directories.push(current, join(current, "dist"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

async function discoverDistDirectories() {
  const explicit = process.env.CAUCE_OPENCLAW_DIST_DIR;
  if (explicit) return [explicit];

  const candidates = [];
  try {
    candidates.push(...possibleDistDirectories(fileURLToPath(import.meta.resolve("openclaw"))));
  } catch {
    // A global CLI commonly is not import-resolvable from this package.
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      const executable = await realpath(join(directory, process.platform === "win32" ? "openclaw.cmd" : "openclaw"));
      candidates.push(...possibleDistDirectories(executable));
    } catch {
      // Continue searching PATH without interpreting wrapper contents.
    }
  }

  const unique = [...new Set(candidates)];
  const existing = [];
  for (const candidate of unique) if (await existsDirectory(candidate)) existing.push(candidate);
  return existing;
}

async function compatibleModules(directory, pattern, exportName) {
  const names = await readdir(directory).catch(() => []);
  const compatible = [];
  for (const name of names.filter((candidate) => pattern.test(candidate))) {
    try {
      const module = await import(pathToFileURL(join(directory, name)).href);
      if (exportName in module) compatible.push(module);
    } catch {
      // An incompatible build is not a discovery candidate.
    }
  }
  return compatible;
}

async function loadOpenClaw() {
  const installations = [];
  for (const directory of await discoverDistDirectories()) {
    const agents = await compatibleModules(directory, /^agent-via-gateway-[^.]+\.js$/u, "agentCliCommand");
    const runtimes = await compatibleModules(directory, /^runtime-[^.]+\.js$/u, "defaultRuntime");
    if (agents.length === 1 && typeof agents[0].agentCliCommand === "function"
      && runtimes.length === 1 && runtimes[0].defaultRuntime !== undefined) {
      installations.push({ agentCliCommand: agents[0].agentCliCommand, defaultRuntime: runtimes[0].defaultRuntime });
    } else if (agents.length > 1 || runtimes.length > 1) {
      throw new Error("ambiguous OpenClaw modules");
    }
  }
  if (installations.length !== 1) throw new Error("OpenClaw modules were absent or ambiguous");
  return installations[0];
}

function decodeFinal(captured, returned) {
  const stripped = captured.trim();
  if (stripped) {
    try {
      return JSON.parse(stripped);
    } catch {
      // Native imports or the command may have logged before the final JSON line.
    }
    const lines = stripped.split(/\r?\n/u).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Keep searching backwards for the final machine-readable value.
      }
    }
    if (returned === undefined) return lines.at(-1);
  }
  if (returned !== undefined) return returned;
  throw new Error("OpenClaw produced no final output");
}

function describeFailure(error) {
  return error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
}

async function main() {
  phase("bridge_enter");
  const message = await readPrompt();
  const nativeSessionKey = sessionKey(process.argv.slice(2));
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  });

  let returned;
  let empezado = false;
  // The embedded app-server keeps handles open: every path exits explicitly, and `emitido` stops a
  // signal from appending a second envelope after the real one (that corrupted answers).
  let emitido = false;
  const salir = (codigo) => {
    // Backstop in case the flush callback never fires.
    setTimeout(() => { process.exit(codigo); }, 2000);
  };
  try {
    const { agentCliCommand, defaultRuntime } = await loadOpenClaw();
    phase("modules_loaded");
    // From here the turn MAY have side effects: before would lie, after would hide a half-finished
    // turn and retry work already paid for. Via stderr; stdout is the contract.
    process.stderr.write("<<cauce:harness-started>>\n");
    empezado = true;
    const abandon = (reason) => {
      process.stdout.write = originalWrite;
      phase(reason.startsWith("terminated") ? "bridge_cancelled" : "bridge_timeout");
      process.stderr.write(`openclaw stdin bridge abandoned the run: ${reason}\n`);
      if (emitido) { process.exit(0); return; }
      emitido = true;
      originalWrite(failureEnvelope(reason, nativeSessionKey));
      process.exit(1);
    };
    const deadline = runDeadlineMs();
    const timer = deadline === undefined ? undefined
      : setTimeout(() => { abandon(`OpenClaw run exceeded ${String(deadline)} ms without a final result`); }, deadline);
    timer?.unref();
    const stopWatching = watchProgress(process.env.HOME ?? "", nativeSessionKey, () => { process.stderr.write(`${PROGRESS_MARKER}\n`); });
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { abandon(`terminated by ${signal} before a final result`); });
    try {
      const hardMs = process.env.CAUCE_HARNESS_TIMEOUT_KIND === "hard" ? Number(process.env.CAUCE_HARNESS_TIMEOUT_MS) : Number.NaN;
      const timeout = Number.isSafeInteger(hardMs) && hardMs > 0 ? String(Math.ceil(hardMs / 1000)) : "0";
      const request = { message, sessionKey: nativeSessionKey, json: true, deliver: false, timeout };
      try {
        phase("agent_cli_started");
        returned = await agentCliCommand(request, interceptingRuntime(defaultRuntime));
        phase("agent_cli_resolved");
      } catch (error) {
        if (!(error instanceof EmbeddedFallbackIntercepted)) throw error;
        const refusal = await embeddedFallbackRefusal(error);
        if (refusal !== undefined) throw new Error(`${refusal}: ${error.message}`);
        process.stderr.write(`openclaw stdin bridge: gateway is down, running the turn embedded: ${error.message}\n`);
        phase("agent_cli_started");
        returned = await agentCliCommand({ ...request, local: true }, defaultRuntime);
        phase("agent_cli_resolved");
      }
    } finally {
      clearTimeout(timer);
      stopWatching();
    }
  } catch (error) {
    phase("bridge_failed");
    if (!empezado) throw error;
    process.stdout.write = originalWrite;
    originalWrite(`${JSON.stringify({
      result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      ...(nativeSessionKey === undefined ? {} : { session_id: nativeSessionKey }),
    })}\n`);
    process.stderr.write(`openclaw stdin bridge failed: ${describeFailure(error)}\n`);
    emitido = true;
    process.exitCode = 1;
    salir(1);
    return;
  } finally {
    process.stdout.write = originalWrite;
  }

  const result = decodeFinal(Buffer.concat(chunks).toString("utf8"), returned);
  phase("decode_completed");
  const envelope = {
    result,
    ...(nativeSessionKey === undefined ? {} : { session_id: nativeSessionKey }),
  };
  emitido = true;
  phase("envelope_flush_requested");
  originalWrite(`${JSON.stringify(envelope)}\n`, () => { process.exit(0); });
  salir(0);
}

main().catch((error) => {
  process.stderr.write(`openclaw stdin bridge failed: ${describeFailure(error)}\n`);
  process.exitCode = 1;
});
