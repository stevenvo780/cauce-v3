import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const owner = 'h7-trasladados-1025';

async function ready(args: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await execute('docker', args); return; }
    catch (error) {
      if (attempt === 99) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

async function readable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await readable(filename);
    else if (entry.isFile()) await chmod(filename, 0o644);
  }
}

it('purges native and container terminals with real systemd and relay authority receipts', async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('Run this suite with scripts/e2e-lab.sh in docker-lab');
  }
  const name = `zz-canary-${owner}-purge-${randomUUID().slice(0, 8)}`;
  const image = `${name}:local`;
  const sourceRoot = await mkdtemp('/datos/h7purge-');
  const receipts = join(process.cwd(), '.delegados/v4/recibos', owner);
  await mkdir(receipts, { recursive: true });
  const dockerfile = 'FROM docker:29-cli AS docker\nFROM python:3.12-slim\nCOPY --from=docker /usr/local/bin/docker /usr/bin/docker\n'
    + 'RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session openssl '
    + '&& rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir pyyaml==6.0.3 && useradd -m -u 1500 -s /bin/bash cauce '
    + '&& ln -s /usr/local/bin/python3 /usr/bin/python3\n'
    + 'STOPSIGNAL SIGRTMIN+3\nCMD ["/sbin/init"]\n';
  const source = join(receipts, `${name}.Dockerfile`);
  await writeFile(source, dockerfile);
  try {
    for (const relative of ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/pty-agent', 'ops/schemas', 'ops/tests', 'packages/adapter-sdk/descriptors']) {
      await cp(join(process.cwd(), relative), join(sourceRoot, relative), { recursive: true });
    }
    await mkdir(join(sourceRoot, 'tests/e2e'), { recursive: true });
    await cp(join(process.cwd(), 'tests/e2e/v4-purga-terminal.fixture.py'), join(sourceRoot, 'tests/e2e/v4-purga-terminal.fixture.py'));
    await readable(sourceRoot);
    await execute('docker', ['build', '--label', `cauce.e2e.owner=${owner}`, '-t', image, '-f', source, receipts], { timeout: 240_000 });
    await execute('docker', ['run', '-d', '--name', name, '--label', `cauce.e2e.owner=${owner}`, '--privileged', '--cgroupns=private',
      '--network', 'none', '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', `${sourceRoot}:${sourceRoot}:ro`,
      '-v', '/var/tmp:/var/tmp', '-v', '/var/run/docker.sock:/var/run/docker.sock', image]);
    await ready(['exec', name, 'test', '-S', '/run/dbus/system_bus_socket']);
    await execute('docker', ['exec', name, 'loginctl', 'enable-linger', 'cauce']);
    const group = (await execute('docker', ['exec', name, 'stat', '-c', '%g', '/var/run/docker.sock'])).stdout.trim();
    await execute('docker', ['exec', name, 'groupadd', '-g', group, 'fixture-docker']);
    await execute('docker', ['exec', name, 'usermod', '-aG', 'fixture-docker', 'cauce']);
    const args = ['exec', '--user', 'cauce', '--env', 'XDG_RUNTIME_DIR=/run/user/1500', '--env',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1500/bus', name];
    await ready([...args, 'systemctl', '--user', 'is-system-running']);
    const result = await execute('docker', [...args, 'python3', '-B', join(sourceRoot, 'tests/e2e/v4-purga-terminal.fixture.py'), sourceRoot, image],
      { timeout: 300_000, maxBuffer: 1024 * 1024 });
    const evidence = JSON.parse(result.stdout) as Record<string, { after: string[]; replay_identical: boolean; relay_foreign_identity_preserved: boolean }>;
    expect(Object.keys(evidence)).toEqual(['container', 'native']);
    for (const row of Object.values(evidence)) {
      expect(row.after).toEqual(['inactive', 'inactive']); expect(row.replay_identical).toBe(true);
      expect(row.relay_foreign_identity_preserved).toBe(true);
    }
    await writeFile(join(receipts, 'purge-terminal-evidence.json'), JSON.stringify(evidence, null, 2));
    console.info('TERMINAL_PURGE_EVIDENCE', JSON.stringify(evidence));
  } finally {
    await execute('docker', ['rm', '-f', name]).catch(() => undefined);
    await execute('docker', ['image', 'rm', image]).catch(() => undefined);
    const remaining = await execute('docker', ['ps', '-aq', '--filter', `name=^/${name}$`]);
    expect(remaining.stdout.trim()).toBe('');
    await rm(sourceRoot, { recursive: true, force: true });
  }
}, 600_000);
