#!/usr/bin/env node
import { appendFile, copyFile, lstat } from "node:fs/promises";
import path from "node:path";

const [, output, phase] = process.argv.slice(2);
const sourceRoot = process.env.FAKE_GATE_SNAPSHOT_DIR;
if (!sourceRoot || !output || !phase) process.exit(125);
if (phase === 'post-cutover' || phase === 'canary') {
  for (const file of [process.env.CAUCE_GATE_BASELINE_FILE, process.env.CAUCE_GATE_PROBE_EVIDENCE_FILE]) {
    if (!file || !(await lstat(file).catch(() => undefined))?.isFile()) process.exit(124);
  }
}
if (process.env.FAKE_GATE_SEQUENCE_LOG) {
  await appendFile(process.env.FAKE_GATE_SEQUENCE_LOG, `${JSON.stringify({ action: 'collector', phase })}\n`);
}
if (process.env.FAKE_GATE_PATH_LOG) {
  await appendFile(process.env.FAKE_GATE_PATH_LOG, `${JSON.stringify({ snapshot: output })}\n`);
}
const requestedExit = Number(process.env.FAKE_GATE_COLLECTOR_EXIT ?? 0);
if (requestedExit) process.exit(requestedExit);
await copyFile(path.join(sourceRoot, `${phase}.json`), output);
