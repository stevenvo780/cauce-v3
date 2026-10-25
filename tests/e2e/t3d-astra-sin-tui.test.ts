import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';

const execute = promisify(execFile);
const owner = 't3d-astra-sin-tui-1025';
const root = process.cwd();
const receipts = join(root, '.delegados/v4/recibos', owner, 'lab');

test('prepara sin TUI y conserva el panel tras dos actualizaciones, dos veces seguidas', async () => {
  const daemon = await execute('docker', ['info', '--format', '{{.Name}}']);
  assert.equal(daemon.stdout.trim(), 'docker-lab');
  const build = JSON.parse(await readFile(join(receipts, 'build-proof.json'), 'utf8')) as {
    bundle: string; clean_source: string;
  };
  const image = 'cauce-e2e-lab-runner:' + createHash('sha256')
    .update(await readFile(join(root, 'tests/e2e/lab-runner/Dockerfile'))).digest('hex').slice(0, 12);
  const node = join(receipts, 'node-runtime');
  await copyFile(process.execPath, node);
  await chmod(node, 0o700);
  const campaign = randomUUID().slice(0, 8);
  await writeFile(join(receipts, 'two-consecutive-runs.json'), JSON.stringify({ owner, campaign, result: 'RUNNING' }) + '\n', { mode: 0o600 });
  const results: { run: string; result: string; output: string }[] = [];
  for (const number of [1, 2]) {
    const run = `official-${campaign}-run-${String(number)}`;
    const name = `zz-canary-${owner}-native-${String(process.pid)}-${String(number)}`;
    try {
      // The adapter must run under the VM user manager rather than inside the runner container.
      const result = await execute('docker', ['run', '--rm', '--name', name,
        '--label', `cauce.e2e.owner=${owner}`, '--privileged', '--pid=host', '--network=host',
        '--mount', 'type=bind,src=/usr/bin/nsenter,dst=/host-nsenter,readonly',
        '--mount', 'type=bind,src=/datos,dst=/datos', '--mount', 'type=bind,src=/tmp,dst=/tmp',
        '--entrypoint', '/host-nsenter', image, '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--cgroup',
        '--root=/proc/1/root', `--wdns=${root}`, '/usr/sbin/runuser', '-u', 'deploy', '--',
        '/usr/bin/env', 'HOME=/home/deploy', 'PATH=/usr/bin:/bin',
        'XDG_RUNTIME_DIR=/run/user/1000', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
        'T3D_ON_VM=1', `T3D_RUN=${run}`, `T3D_SOURCE=${build.clean_source}`, `T3D_BUNDLE=${build.bundle}`,
        node, '--import', 'tsx',
        'tests/e2e/t3d-astra-sin-tui.lab.mjs'], { timeout: 600_000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /ASTRA_ABSENT_TUI_LAB_PASS/u);
      results.push({ run, result: 'PASS', output: result.stdout.trim() });
    } finally {
      await execute('docker', ['rm', '-f', name]).catch(() => undefined);
    }
  }
  await writeFile(join(receipts, 'two-consecutive-runs.json'), JSON.stringify({
    owner, campaign, result: 'PASS', runner: 'scripts/e2e-lab.sh', daemon: 'docker-lab',
    method: 'owned-container-enters-vm-namespaces-and-drops-to-deploy',
    credentials_copied: false, production_writes: false, results,
  }, null, 2) + '\n', { mode: 0o600 });
}, 1_250_000);
