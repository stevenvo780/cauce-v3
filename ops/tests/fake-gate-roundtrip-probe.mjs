#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';

const [alias, output] = process.argv.slice(2);
if (process.argv.length !== 4 || !alias || !output) process.exit(125);
if (process.env.FAKE_GATE_PROBE_LOG) {
  await appendFile(process.env.FAKE_GATE_PROBE_LOG, `${JSON.stringify({ alias })}\n`);
}
if (process.env.FAKE_GATE_SEQUENCE_LOG) {
  await appendFile(process.env.FAKE_GATE_SEQUENCE_LOG, `${JSON.stringify({ action: 'probe' })}\n`);
}
if (process.env.FAKE_GATE_PATH_LOG) {
  await appendFile(process.env.FAKE_GATE_PATH_LOG, `${JSON.stringify({ evidence: output })}\n`);
}
const requestedExit = Number(process.env.FAKE_GATE_PROBE_EXIT ?? 0);
if (requestedExit) process.exit(requestedExit);
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1,
  tenant: 'Steven',
  alias,
  deliveryId: '00000000-0000-4000-8000-000000000001',
  nonce: '00000000000000000000000000000001',
  startedAt: new Date().toISOString(),
})}\n`, { mode: 0o600 });
