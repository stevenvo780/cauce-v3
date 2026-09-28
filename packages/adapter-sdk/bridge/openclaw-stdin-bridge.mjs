#!/usr/bin/env node
import { realpath, readdir, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 1024 * 1024;
// Upper bound for one run: the runtime's timeout does not always surface as a rejection.
const DEFAULT_RUN_DEADLINE_MS = 45 * 60 * 1000;

function runDeadlineMs() {
  const raw = process.env.CAUCE_OPENCLAW_RUN_DEADLINE_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_DEADLINE_MS;
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
  try {
    const { agentCliCommand, defaultRuntime } = await loadOpenClaw();
    // From here the turn MAY have side effects: before would lie, after would hide a half-finished
    // turn and retry work already paid for. Via stderr; stdout is the contract.
    process.stderr.write("<<cauce:harness-started>>\n");
    empezado = true;
    const abandon = (reason) => {
      process.stdout.write = originalWrite;
      originalWrite(failureEnvelope(reason, nativeSessionKey));
      process.stderr.write(`openclaw stdin bridge abandoned the run: ${reason}\n`);
      process.exit(1);
    };
    const deadline = runDeadlineMs();
    const timer = setTimeout(() => { abandon(`OpenClaw run exceeded ${String(deadline)} ms without a final result`); }, deadline);
    timer.unref();
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { abandon(`terminated by ${signal} before a final result`); });
    try {
      returned = await agentCliCommand({
        message,
        sessionKey: nativeSessionKey,
        json: true,
        deliver: false,
      }, defaultRuntime);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (!empezado) throw error;
    process.stdout.write = originalWrite;
    originalWrite(`${JSON.stringify({
      result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      ...(nativeSessionKey === undefined ? {} : { session_id: nativeSessionKey }),
    })}\n`);
    process.stderr.write(`openclaw stdin bridge failed: ${describeFailure(error)}\n`);
    process.exitCode = 1;
    return;
  } finally {
    process.stdout.write = originalWrite;
  }

  const result = decodeFinal(Buffer.concat(chunks).toString("utf8"), returned);
  const envelope = {
    result,
    ...(nativeSessionKey === undefined ? {} : { session_id: nativeSessionKey }),
  };
  originalWrite(`${JSON.stringify(envelope)}\n`);
}

main().catch((error) => {
  // Dumps the full error to stderr for diagnosis; the structured response travels via stdout
  // and stderr does not pollute the contract.
  process.stderr.write(`openclaw stdin bridge failed: ${describeFailure(error)}\n`);
  process.exitCode = 1;
});
