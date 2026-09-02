#!/usr/bin/env node
//
// Runs the fake pty-agent in a process of its own, configured from the environment, so the
// suite can drop it to an unprivileged uid the way it drops the relay: the gate runs vitest as
// root and the agent refuses euid 0, so it cannot live inside the test worker.
//
// Each agent event leaves as one JSON line on stdout, `{sessions, event}`, which is what the parent
// rebuilds its handle from. Keys and tickets never reach it: only names, lengths and short hashes.

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { startFakeAgent } from './fake-pty-agent.mjs';

const environment = process.env;
const readIfSet = (name) => (environment[name] ? readFileSync(environment[name]) : undefined);
const number = (value, fallback) => (value === undefined ? fallback : Number(value));

let agent = null;

function report(event) {
  process.stdout.write(`${JSON.stringify({ sessions: agent === null ? 0 : agent.sessions, event })}\n`);
}

agent = startFakeAgent({
  host: environment.RELAY_HOST ?? '127.0.0.1',
  port: number(environment.RELAY_PORT, 0),
  cert: readIfSet('AGENT_CERT'),
  key: readIfSet('AGENT_KEY'),
  ca: readIfSet('AGENT_CA'),
  servername: environment.RELAY_SERVERNAME ?? 'localhost',
  tenant: environment.TENANT,
  alias: environment.ALIAS,
  alias_key: environment.ALIAS_KEY_HEX ?? '',
  container_id: environment.CONTAINER_ID,
  generation: environment.GENERATION,
  image_id: environment.IMAGE_ID,
  runtime_user: environment.RUNTIME_USER,
  runtime_uid: number(environment.RUNTIME_UID, 1000),
  modes: (environment.AGENT_MODES ?? 'shell').split(',').filter(Boolean),
  flood_bytes: number(environment.AGENT_FLOOD_BYTES, 4 * 1024 * 1024),
  on_event: report,
});

if (agent.failed) {
  process.exit(agent.exit_code);
}

const stop = () => { agent.destroy(); };
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

process.exit(await agent.closed);
