import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareSpaceLayout } from '../src/context/space-layout.js';
import type { CommandRunRequest, CommandRunResult } from '../src/sdk/types.js';
import { ControlledRunner, delivery, setup } from './engine-fixtures.js';

const IDENTITY = { 'company-id': 'zz_canary', 'tenant-id': 'ZzCanary', alias: 'zz-canary-agent', 'runtime-key': 'zz-canary-agent' };

function repositoryFile(relative: string): string {
  for (let directory = dirname(fileURLToPath(import.meta.url)); directory !== dirname(directory); directory = dirname(directory)) {
    if (existsSync(join(directory, relative))) return join(directory, relative);
  }
  throw new Error(`${relative} is not reachable from this test`);
}

/** The provider stand-in is a real child process: it answers with what it reads through a relative path of its cwd. */
class NonceRunner extends ControlledRunner {
  readonly answers: { nonce: string; cwd: string }[] = [];
  override async run(request: CommandRunRequest): Promise<CommandRunResult> {
    const read = spawnSync('/bin/sh', ['-c', 'cat nonce.txt; echo; pwd -P'], { cwd: request.cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    const [nonce = '', cwd = ''] = read.stdout.trim().split('\n');
    this.answers.push({ nonce, cwd });
    this.stdout = JSON.stringify({ reply: `nonce:${nonce}`, messages: [], status: 'done', retryable: false, artifacts: [] });
    return super.run(request);
  }
}

test('after the verified migration a turn runs in space/projects and answers the nonce read from the new path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zz-canary-space-migration-'));
  const previous = { workspace: process.env.CAUCE_AGENT_WORKSPACE, space: process.env.CAUCE_SPACE_ROOT };
  t.after(async () => {
    for (const [name, value] of [['CAUCE_AGENT_WORKSPACE', previous.workspace], ['CAUCE_SPACE_ROOT', previous.space]] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, 'workspace'); const space = join(root, 'state', 'space');
  const nonce = `zz-canary-nonce-${randomUUID()}`;
  await mkdir(workspace, { mode: 0o755 });
  await writeFile(join(workspace, 'nonce.txt'), nonce, { mode: 0o600 });
  await writeFile(join(workspace, 'CLAUDE.md'), 'Legacy project instructions.\n', { mode: 0o600 });
  const layout = await prepareSpaceLayout(space);

  const migration = spawnSync(process.env.CAUCE_PYTHON ?? 'python3', [repositoryFile('ops/cli/space_archive.py'), 'migrate',
    '--workspace', workspace, '--directory', space, ...Object.entries(IDENTITY).flatMap(([name, value]) => [`--${name}`, value])],
  { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(migration.status, 0, migration.stderr);
  const receipt = JSON.parse(migration.stdout) as { state: string; lost: string[]; cwd: string; before: { sha256: string } };
  assert.deepEqual([receipt.state, receipt.lost, receipt.cwd], ['migrated', [], layout.projects]);
  const stored = JSON.parse(await readFile(join(space, 'config', 'space-migration.json'), 'utf8')) as { before_sha256: string };
  assert.equal(stored.before_sha256, receipt.before.sha256);
  await writeFile(join(workspace, 'nonce.txt'), 'zz-canary-stale-legacy-copy');

  process.env.CAUCE_SPACE_ROOT = space;
  process.env.CAUCE_AGENT_WORKSPACE = layout.projects;
  const runner = new NonceRunner();
  const context = await setup('space-migration-nonce-turn', runner);
  await context.engine.handleDelivery(delivery('nonce-migrado'));

  assert.equal(runner.requests[0]?.cwd, layout.projects);
  assert.deepEqual(runner.answers, [{ nonce, cwd: await realpath(layout.projects) }]);
  const done = context.events.at(-1);
  assert.equal(done?.phase, 'done');
  assert.ok(JSON.stringify(done).includes(`nonce:${nonce}`));
  assert.equal(JSON.stringify(context.events).includes('zz-canary-stale-legacy-copy'), false);
});
