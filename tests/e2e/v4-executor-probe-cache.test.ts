import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const OWNER = 'p1-sondas-1025';

it('reuses real executor probes across processes and invalidates changed image digests', async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('Run with CAUCE_E2E_CONTEXT=lab scripts/e2e-lab.sh p1-sondas-1025');
  }
  const directory = await mkdtemp(`/tmp/zz-canary-${OWNER}-`);
  const name = `zz-canary-${OWNER}-${randomUUID().slice(0, 8)}`;
  const images = [`${name}:a`, `${name}:b`];
  const receipts = join(process.cwd(), '.delegados/v4/recibos', OWNER);
  await mkdir(receipts, { recursive: true });
  await chmod(directory, 0o755);
  try {
    for (const [filename, version] of [['grok', 'grok 1.0.41'], ['muse', '1.4.10-R6427.1'], ['node-probe', 'OpenClaw 2026.7.1-2']]) {
      if (!filename || !version) throw new Error('Missing probe fixture command');
      await writeFile(join(directory, filename), '#!/usr/bin/python3\nimport json,pathlib,sys,time\n'
        + `log=pathlib.Path(${JSON.stringify(join(directory, 'native-invocations.jsonl'))})\n`
        + 'if log.exists():\n with log.open("a") as stream: stream.write(json.dumps({"command":pathlib.Path(sys.argv[0]).name,"time":time.time()})+"\\n")\n'
        + `print(${JSON.stringify(version)})\n`, { mode: 0o755 });
    }
    await writeFile(join(directory, 'muse-cauce'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(directory, 'openclaw-cli'), 'public version-only fixture\n');
    await writeFile(join(directory, 'bridge.mjs'), 'export const fixture = true;\n');
    await writeFile(join(directory, 'native-invocations.jsonl'), '');
    await copyFile('ops/tests/fixtures/openclaw-auth-list-2026.7.1-2.txt', join(directory, 'auth-list.js'));
    const recipe = await readFile('tests/e2e/lab-runner/Dockerfile');
    const base = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
    const dockerfile = `FROM ${base}\nARG variant\nLABEL cauce.e2e.owner=${OWNER} cauce.e2e.case=${name} variant=$variant\n`
      + 'COPY --chmod=755 grok muse node-probe muse-cauce /usr/local/bin/\n'
      + 'COPY --chmod=644 openclaw-cli bridge.mjs auth-list.js /usr/local/bin/\n';
    await writeFile(join(directory, 'Dockerfile'), dockerfile);
    for (const [index, image] of images.entries()) {
      await execute('docker', ['build', '--pull=false', '--build-arg', `variant=${String(index)}`, '-t', image, directory], { timeout: 180_000 });
    }
    const firstImage = images[0];
    const secondImage = images[1];
    if (!firstImage || !secondImage) throw new Error('Missing image variants');
    const group = (await execute('stat', ['-c', '%g', '/var/run/docker.sock'])).stdout.trim();
    const result = await execute('docker', ['run', '--rm', '--name', name, '--label', `cauce.e2e.owner=${OWNER}`,
      '--user', `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`, '--group-add', group,
      '--network', 'none', '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
      '--mount', 'type=bind,src=/tmp,dst=/tmp', '--mount', 'type=bind,src=/datos,dst=/datos,readonly',
      firstImage, 'python3', '-I', '-B', join(process.cwd(), 'tests/e2e/v4-executor-probe-cache.lab.py'),
      process.cwd(), directory, firstImage, secondImage, name], { timeout: 480_000, maxBuffer: 2 * 1024 * 1024 });
    await writeFile(join(receipts, 'executor-probe-cache.log'), result.stdout + result.stderr);
    const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as { passed: boolean };
    await copyFile(join(directory, 'receipt.json'), join(receipts, 'executor-probe-cache.json'));
    expect(receipt.passed, result.stdout + result.stderr).toBe(true);
  } catch (error) {
    await copyFile(join(directory, 'receipt.json'), join(receipts, 'executor-probe-cache.json')).catch(() => undefined);
    await writeFile(join(receipts, 'executor-probe-cache-error.log'), String(error));
    throw error;
  } finally {
    await execute('docker', ['rm', '-f', name]).catch(() => undefined);
    for (const image of images) await execute('docker', ['image', 'rm', '-f', image]).catch(() => undefined);
    const remaining = (await execute('docker', ['ps', '-a', '--filter', `label=cauce.e2e.case=${name}`, '--format', '{{.Names}}'])).stdout.trim();
    await writeFile(join(receipts, 'executor-probe-cache-cleanup.json'), JSON.stringify({ case: name, remaining_containers: remaining }, null, 2));
    await rm(directory, { recursive: true, force: true });
    expect(remaining, 'Probe containers remain after cleanup').toBe('');
  }
}, 600_000);
