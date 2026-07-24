#!/usr/bin/env node
import { appendFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
// CAUCE_HARNESS_COMMAND replaces the executable but deliberately preserves each
// harness definition's base arguments. Hermes now uses its packaged stdin bridge
// as that base argument rather than the older `chat` CLI token.
const harness = args.some((argument) => path.basename(argument) === 'hermes-stdin-bridge.py') ? 'hermes'
  : args.includes('--print') ? 'claude'
    : args.includes('exec') ? 'codex'
      : args.includes('run') ? 'opencode'
        : undefined;
if (!harness) throw new Error('fleet harness double could not identify the adapter dialect');
const logDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '.matrix-state', 'harness-logs');

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString('utf8');
const alias = /FLEET_ALIAS:([a-z][a-z0-9_-]{0,63})/u.exec(input)?.[1];
if (!alias) throw new Error('fleet harness double prompt lacks its non-secret test alias');

await mkdir(logDirectory, { recursive: true, mode: 0o700 });
const marker = path.join(logDirectory, `${alias}.first-attempt`);
let firstAttempt = false;
try {
  const handle = await open(marker, 'wx', 0o600);
  await handle.close();
  firstAttempt = true;
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}

await appendFile(path.join(logDirectory, `${alias}.jsonl`), `${JSON.stringify({
  alias,
  harness,
  invocation: firstAttempt ? 1 : 2,
  args,
})}\n`, { mode: 0o600 });

// The non-empty reply exercises the origin relay. A synthetic delegation would
// need a trusted online target and would create extra fleet deliveries.
const output = {
  reply: firstAttempt ? `${harness} planned retry` : `${harness} completed`,
  messages: [],
  status: firstAttempt ? 'failed' : 'done',
  retryable: firstAttempt,
  artifacts: [],
};

switch (harness) {
  case 'hermes':
    process.stdout.write(`${JSON.stringify({ output, session_id: `hermes-stateless-${alias}` })}\n`);
    break;
  case 'opencode':
    process.stdout.write(`${JSON.stringify({ type: 'session', id: `ses_opencode_observed_${alias}` })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'result', output })}\n`);
    break;
  case 'claude':
    process.stdout.write(`${JSON.stringify({
      type: 'result', result: JSON.stringify(output), session_id: `claude-observed-${alias}`,
    })}\n`);
    break;
  case 'codex':
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: `codex-native-${alias}` })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) },
    })}\n`);
    break;
  default:
    throw new Error(`unsupported executable harness double '${harness}'`);
}
