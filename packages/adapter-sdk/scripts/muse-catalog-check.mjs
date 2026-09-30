#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const [binary, model, requested] = process.argv.slice(2);
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
if (!binary || !isAbsolute(binary) || !model || !efforts.includes(requested)) {
  process.stderr.write("Usage: muse-catalog-check.mjs /absolute/muse-bin model expected-effort\n");
  process.exit(2);
}
const child = spawn(binary, ["serve", "--no-session-log"], {
  cwd: process.cwd(), env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
});
child.stderr.resume();
const lines = createInterface({ input: child.stdout });
let completed = false;
let serverVersion;
const timer = setTimeout(() => {
  process.stderr.write("Muse catalog query exceeded its bounded read budget\n");
  process.exitCode = 1;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
}, 20_000);
const send = (frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const fail = () => { process.exitCode = 1; child.stdin.end(); };
child.stdin.on("error", fail);
child.on("error", () => {
  process.stderr.write("Muse catalog host could not be started\n");
  clearTimeout(timer);
  fail();
});
lines.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { fail(); return; }
  if (frame.error) {
    process.stderr.write("Muse rejected the catalog query\n");
    fail(); return;
  }
  if (frame.id === "initialize") {
    serverVersion = frame.result?.serverInfo?.version;
    send({ method: "initialized" });
    send({ id: "catalog", method: "model/list", params: {} });
  }
  if (frame.id !== "catalog") return;
  const catalog = frame.result;
  const rows = Array.isArray(catalog?.models) ? catalog.models.filter((row) => row.modelId === model) : [];
  const variants = rows.length === 1 ? rows[0].variants : undefined;
  const verified = catalog?.source === "providerCatalog" && Array.isArray(variants) && variants.includes(requested)
    && variants.every((entry) => efforts.includes(entry)) && new Set(variants).size === variants.length;
  const maximum = verified ? efforts.findLast((entry) => variants.includes(entry)) : undefined;
  const summarize = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value)
    ? value : undefined;
  process.stdout.write(`${JSON.stringify({
    serverVersion: summarize(serverVersion), source: summarize(catalog?.source),
    provider: summarize(rows[0]?.providerId), model: summarize(model),
    requested, supportedEfforts: verified ? variants : undefined,
    maximum, supportVerified: verified && maximum === requested, sessionStarts: 0, turnStarts: 0,
  })}\n`);
  completed = true;
  if (!verified || maximum !== requested) process.exitCode = 1;
  child.stdin.end();
});
child.on("exit", () => {
  clearTimeout(timer);
  if (!completed) process.exitCode = 1;
});
send({ id: "initialize", method: "initialize", params: {
  clientInfo: { name: "cauce_catalog_only", version: "1.0.0" }, capabilities: { userInputDialogs: false },
} });
