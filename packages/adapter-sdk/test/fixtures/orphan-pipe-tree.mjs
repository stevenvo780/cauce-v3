#!/usr/bin/env node
/**
 * Reproduces the real case: the harness leaves a GRANDCHILD with inherited stdout/stderr and EXITS.
 *
 * This is what any CLI does that starts an MCP server, watcher or bridge and does not
 * disconnect it from its descriptors. The direct child dies, but the pipe the runner reads stays
 * open on the other end, so `close` never arrives.
 *
 * argv: <marker> <final-output> <ms-grandchild-lives> <ms-before-writing-marker>
 * The grandchild writes the marker only if NOBODY killed it: this is the proof that the harvest
 * reached the descendants and not only the child's pid.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const marker = process.argv[2];
const finalOutput = process.argv[3] ?? "";
const holdMs = Number(process.argv[4] ?? 60_000);
const markerMs = Number(process.argv[5] ?? 1_500);

if (!marker) throw new Error("marker path required");

const grandchild = spawn(
  process.execPath,
  [
    "--eval",
    `process.on('SIGTERM', () => {});`
    + `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), ${markerMs});`
    + `setTimeout(() => process.exit(0), ${holdMs});`,
  ],
  // Inherits OUR pipes: this is exactly what keeps the runner's end open.
  { stdio: ["ignore", "inherit", "inherit"] },
);
grandchild.unref();

if (finalOutput.length > 0) process.stdout.write(finalOutput);
