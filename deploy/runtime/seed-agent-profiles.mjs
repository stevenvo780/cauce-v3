#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createPool } from '../packages/store/dist/db.js';
import { AgentProfileRepository } from '../packages/store/dist/agent-profile.js';
import { assertProductionPostgresTls } from './postgres-tls.mjs';
import { applyRoster, inspectRoster, parseGroupsRoster, verifyRoster } from './seed-agent-profiles-core.mjs';

const phase = process.argv[2] ?? 'inspect';
if (!['inspect', 'apply', 'post'].includes(phase) || process.argv.length > 4) {
  throw new Error('usage: seed-agent-profiles.mjs inspect|apply|post [groupsPath]');
}
const groupsPath = process.argv[3] ?? '/tmp/grupos.json';
if (phase === 'apply' && process.env.CAUCE_PROFILE_SEED_CONFIRM !== 'grupos-json-v1') {
  throw new Error('exact CAUCE_PROFILE_SEED_CONFIRM is required');
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const document = JSON.parse(await readFile(groupsPath, 'utf8'));
const roster = parseGroupsRoster(document);

await assertProductionPostgresTls();
const pool = createPool(connectionString, { max: 2, applicationName: 'cauce-profile-seed' });
try {
  const repository = new AgentProfileRepository(pool);
  const generatedAt = new Date().toISOString();
  const rows = phase === 'inspect'
    ? await inspectRoster(repository, roster)
    : phase === 'apply'
      ? await applyRoster(repository, roster)
      : await verifyRoster(repository, roster);
  const ok = phase === 'apply'
    ? rows.every((row) => row.status !== 'error')
    : phase === 'post'
      ? rows.every((row) => !row.exists || (row.purpose_matches && row.human_brief_matches))
      : true;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    suite: 'cauce-v3-agent-profile-seed',
    phase,
    generatedAt,
    groupsPath,
    rosterSize: roster.length,
    ok,
    rows,
  })}\n`);
  if (!ok) process.exitCode = 1;
} finally {
  await pool.end();
}
