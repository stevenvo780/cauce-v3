import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { modelFallbackCommand, superviseModelFallback } from '../src/sdk/model-fallback-server.js';
import type { AdapterLog } from '../src/sdk/types.js';

const supervision = { initialMs: 20, maximumMs: 40, stableMs: 60_000, killMs: 500 };

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('condition was not observed');
}

test('only the executor argv starts the Muse bridge server', () => {
  assert.equal(modelFallbackCommand({}), undefined);
  assert.deepEqual(modelFallbackCommand({ CAUCE_MODEL_FALLBACK_SERVE: '["/usr/bin/python3","serve"]' }), ['/usr/bin/python3', 'serve']);
  for (const raw of ['["python3","serve"]', '["/usr/bin/python3"]', '{"command":"/bin/sh"}', '["/bin/sh",1]', 'not json']) {
    assert.throws(() => modelFallbackCommand({ CAUCE_MODEL_FALLBACK_SERVE: raw }));
  }
});

test('the bridge server sees only the Muse profile, is restarted when it exits and stops with the adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-fallback-supervision-'));
  try {
    const script = join(directory, 'server.mjs');
    const starts = join(directory, 'starts');
    await writeFile(starts, '');
    await writeFile(script, `import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(starts)}, 'x');
writeFileSync(${JSON.stringify(join(directory, 'env.json'))}, JSON.stringify(process.env));
if (process.argv[2] === 'exit') process.exit(3);
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(join(directory, 'stopped'))}, 'yes'); process.exit(0); });
setInterval(() => {}, 1000);
`);
    const logs: AdapterLog[] = [];
    const environment = { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: '/profile/config', CAUCE_MUSE_CLI_COMMAND: '/usr/local/bin/muse',
      CAUCE_BOOTSTRAP: '1', CAUCE_TLS_KEY_FILE: '/run/cauce-credentials/key', META_TOKEN: 'secret' };
    const crashing = new AbortController();
    const restarted = superviseModelFallback([process.execPath, script, 'exit'], entry => logs.push(entry), crashing.signal, supervision, environment);
    await until(async () => (await readFile(starts, 'utf8')).length >= 3);
    crashing.abort();
    await restarted;
    assert.ok(logs.length >= 2);
    assert.ok(logs.every(entry => entry.event === 'model_fallback_server_exited' && entry.reason === 'exit 3'));
    const seen = JSON.parse(await readFile(join(directory, 'env.json'), 'utf8')) as Record<string, string>;
    assert.equal(seen.XDG_CONFIG_HOME, '/profile/config');
    assert.equal(seen.CAUCE_MUSE_CLI_COMMAND, '/usr/local/bin/muse');
    for (const name of ['CAUCE_BOOTSTRAP', 'CAUCE_TLS_KEY_FILE', 'META_TOKEN']) assert.equal(seen[name], undefined);
    const running = new AbortController();
    const served = superviseModelFallback([process.execPath, script], () => undefined, running.signal, supervision, environment);
    const before = (await readFile(starts, 'utf8')).length;
    await until(async () => (await readFile(starts, 'utf8')).length > before);
    running.abort();
    await served;
    assert.equal(await readFile(join(directory, 'stopped'), 'utf8'), 'yes');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
