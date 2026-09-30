import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../../scripts/muse-catalog-check.mjs", import.meta.url));

interface CatalogProbeOutput {
  readonly maximum?: unknown;
  readonly supportVerified: unknown;
  readonly sessionStarts?: unknown;
  readonly turnStarts?: unknown;
}

async function probe(variants: unknown, source = "providerCatalog") {
  const root = await mkdtemp(join(tmpdir(), "muse-catalog-check-"));
  const executable = join(root, "muse-public-double.mjs");
  const calls = join(root, "calls.json");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const methods=[];
const lines=createInterface({input:process.stdin});
lines.on("line",raw=>{
 const frame=JSON.parse(raw); methods.push(frame.method);
 writeFileSync(${JSON.stringify(calls)},JSON.stringify({methods,args:process.argv.slice(2)}));
 let result;
 if(frame.method==="initialize") result={serverInfo:{version:"1.4.1"}};
 if(frame.method==="model/list") result={source:${JSON.stringify(source)},privateCredential:"synthetic_do_not_publish",models:[{
  modelId:"muse-spark-1.3", providerId:"meta", profileId:"synthetic_private_profile",
  variants:${JSON.stringify(variants)}
 }]};
 if(result) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:frame.id,result})+"\\n");
});
`, { mode: 0o700 });
  try {
    const result = spawnSync(process.execPath, [checker, executable, "muse-spark-1.3", "max"], {
      cwd: root, encoding: "utf8", timeout: 25_000,
    });
    return { result, calls: JSON.parse(await readFile(calls, "utf8")) as {
      methods: string[]; args: string[];
    } };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("Muse catalog check uses only discovery methods and publishes no private metadata", async () => {
  const { result, calls } = await probe(["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.methods, ["initialize", "initialized", "model/list"]);
  assert.deepEqual(calls.args, ["serve", "--no-session-log"]);
  const output = JSON.parse(result.stdout) as CatalogProbeOutput;
  assert.equal(output.maximum, "max");
  assert.equal(output.supportVerified, true);
  assert.equal(output.sessionStarts, 0);
  assert.equal(output.turnStarts, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic_private|synthetic_do_not_publish/u);
});

test("Muse catalog check rejects unsupported effort without sending a turn", async () => {
  const { result, calls } = await probe(["minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout) as CatalogProbeOutput;
  assert.equal(output.supportVerified, false);
  assert.ok(!calls.methods.includes("turn/start"));
});

test("Muse catalog check does not infer entitlement from a bundled catalog", async () => {
  const { result } = await probe(["high", "xhigh", "max"], "bundledCatalog");
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout) as CatalogProbeOutput;
  assert.equal(output.supportVerified, false);
});
