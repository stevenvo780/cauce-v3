#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const runner = path.join(here, 'run-all.mjs');
const matrix = path.join(repositoryRoot, 'scripts/test-all.mjs');
const asRoot = process.getuid?.() === 0;

const manifest = {
  name: 'cauce-run-all-fixture',
  scripts: {
    'test:ops': 'node ops/tests/run-all.mjs',
    'test:container-supervisor': 'node ops/tests/container-supervisor.test.mjs',
    'test:container-cutover': 'node ops/tests/container-cutover.test.mjs',
  },
};

async function plantTree(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cauce-run-all-'));
  const tests = path.join(root, 'ops/tests');
  await mkdir(tests, { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await copyFile(runner, path.join(tests, 'run-all.mjs'));
  await copyFile(matrix, path.join(root, 'scripts/test-all.mjs'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest), 'utf8');
  const probes = path.join(root, 'docker-probes');
  await writeFile(
    path.join(root, 'bin/docker'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${probes}"\nexit "\${CAUCE_FAKE_DOCKER_EXIT:-1}"\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(tests, name), body, 'utf8');
  return { root, tests, probes };
}

function run(tree, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [path.join(tree.tests, 'run-all.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(tree.root, 'bin')}:${process.env.PATH}`,
      CAUCE_RELEASE_VALIDATION: '0',
      CAUCE_OPS_TEST_TIMEOUT_MS: '',
      CAUCE_FAKE_DOCKER_EXIT: '1',
      ...extraEnvironment,
    },
  });
  assert.equal(result.error, undefined, String(result.error));
  const verdicts = new Map();
  for (const line of result.stdout.split('\n')) {
    const parsed = /^(PASS|FAIL|SKIP|TIMEOUT)\s{2}(\S+)\s{2}\S+s(?:\s{2}(.*))?$/u.exec(line);
    if (parsed) verdicts.set(parsed[2], { verdict: parsed[1], detail: parsed[3] ?? '' });
  }
  return { status: result.status, stdout: result.stdout, verdicts };
}

async function probeCount(tree) {
  try {
    return (await readFile(tree.probes, 'utf8')).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

const gates = await plantTree({
  'test_plain.py': "print('plain')\n",
  'test_none.py': "# cauce:requiere none\nprint('none')\n",
  'test_root.py': "# cauce:requiere root\nprint('root')\n",
  'test_late.py': `${'# padding\n'.repeat(24)}# cauce:requiere root\nprint('late')\n`,
  'docker-one.test.mjs': "// cauce:requiere docker\nprocess.stdout.write('one\\n');\n",
  'docker-two.test.mjs': "// cauce:requiere docker\nprocess.stdout.write('two\\n');\n",
  'container-supervisor.test.mjs': 'process.exit(1);\n',
});

const withoutDaemon = run(gates);
assert.equal(withoutDaemon.verdicts.get('test_plain.py').verdict, 'PASS');
assert.equal(withoutDaemon.verdicts.get('test_none.py').verdict, 'PASS');
assert.equal(withoutDaemon.verdicts.get('test_late.py').verdict, 'PASS');
assert.equal(withoutDaemon.verdicts.get('test_root.py').verdict, asRoot ? 'PASS' : 'SKIP');
assert.equal(withoutDaemon.verdicts.get('docker-one.test.mjs').verdict, 'SKIP');
assert.match(withoutDaemon.verdicts.get('docker-two.test.mjs').detail, /requires docker: no daemon answers/u);
const gated = withoutDaemon.verdicts.get('container-supervisor.test.mjs');
assert.equal(gated.verdict, 'SKIP');
assert.match(gated.detail, /run by the matrix suite: pnpm run test:container-supervisor/u);
assert.equal(withoutDaemon.status, 0, 'a skip must never set the exit code');
assert.equal(await probeCount(gates), 1, 'the docker daemon must be probed once for the whole run');

await rm(gates.probes, { force: true });
const strict = run(gates, { CAUCE_RELEASE_VALIDATION: '1' });
assert.equal(strict.verdicts.get('docker-one.test.mjs').verdict, 'FAIL');
assert.equal(strict.verdicts.get('container-supervisor.test.mjs').verdict, 'SKIP');
assert.equal(strict.status, 1, 'release validation must not let an unmet requirement pass as a skip');

await rm(gates.probes, { force: true });
const withDaemon = run(gates, { CAUCE_FAKE_DOCKER_EXIT: '0' });
assert.equal(withDaemon.verdicts.get('docker-one.test.mjs').verdict, 'PASS');
assert.equal(withDaemon.verdicts.get('docker-two.test.mjs').verdict, 'PASS');
assert.equal(withDaemon.status, 0);

const rejections = await plantTree({
  'test_unknown.py': "# cauce:requiere marciano\nprint('unknown')\n",
  'test_conflict.py': "# cauce:requiere root\n# cauce:requiere docker\nprint('conflict')\n",
});
const rejected = run(rejections);
assert.equal(rejected.verdicts.get('test_unknown.py').verdict, 'FAIL');
assert.match(rejected.verdicts.get('test_unknown.py').detail, /cauce:requiere marciano/u);
assert.equal(rejected.verdicts.get('test_conflict.py').verdict, 'FAIL');
assert.match(rejected.verdicts.get('test_conflict.py').detail, /conflicting declarations: docker, root/u);
assert.equal(rejected.status, 1, 'an unusable declaration must never be read as a skip');

const wedged = await plantTree({
  'test_wedged.py': [
    'import os, pathlib, time',
    "pathlib.Path(os.environ['CAUCE_WEDGE_PID']).write_text(str(os.getpid()))",
    'time.sleep(120)',
    "pathlib.Path(os.environ['CAUCE_WEDGE_DONE']).write_text('done')",
    '',
  ].join('\n'),
});
const pidFile = path.join(wedged.root, 'wedged.pid');
const doneFile = path.join(wedged.root, 'wedged.done');
const startedAt = Date.now();
const killed = run(wedged, {
  CAUCE_OPS_TEST_TIMEOUT_MS: '1000',
  CAUCE_WEDGE_PID: pidFile,
  CAUCE_WEDGE_DONE: doneFile,
});
const elapsedMs = Date.now() - startedAt;
assert.equal(killed.verdicts.get('test_wedged.py').verdict, 'TIMEOUT');
assert.match(killed.verdicts.get('test_wedged.py').detail, /killed after 1\.0s/u);
assert.equal(killed.status, 1, 'a timeout must fail the run');
assert.ok(elapsedMs < 30_000, `the runner waited ${elapsedMs}ms instead of enforcing its deadline`);
await assert.rejects(readFile(doneFile, 'utf8'), 'the wedged test outlived its deadline');
const wedgedPid = Number(await readFile(pidFile, 'utf8'));
assert.throws(() => process.kill(wedgedPid, 0), /ESRCH/u, 'the wedged test was left orphaned');

for (const tree of [gates, rejections, wedged]) await rm(tree.root, { recursive: true, force: true });
console.log('run-all gates ok: requirement declarations, matrix ownership and the per-test deadline');
