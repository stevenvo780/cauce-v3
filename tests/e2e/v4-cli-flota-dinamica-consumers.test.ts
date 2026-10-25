import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const directory = join(process.cwd(), '.delegados/v4/recibos/l2b-ciclo-sdk-1025/consumers');
const owner = 'l2b-ciclo-sdk-1025';
const prefix = `zz-canary-${owner}-consumers-${randomUUID()}`;
const image = `${prefix}:local`;
let imageBuilt = false;
let socketGroup = '';
const consumers = [
  'test_cli_python_isolation.py', 'test_fleet_executor.py', 'test_fleet_executor_agent_quota.py',
  'test_fleet_executor_authority.py', 'test_fleet_executor_container.py', 'test_fleet_executor_image_refresh.py',
  'test_fleet_executor_import_layout.py', 'test_fleet_executor_legacy.py', 'test_fleet_executor_rebind.py',
  'test_fleet_executor_recovery.py', 'test_fleet_executor_replacement.py', 'test_fleet_executor_sdk.py',
  'test_fleet_executor_templates.py', 'test_fleet_model_fallback.py', 'test_fleet_orphan_sweep.py',
  'test_fleet_provider_openclaw.py', 'test_model_fallback_docker.py', 'test_provider_login_container.py',
  'test_fleet_executor_tui.py', 'test_fleet_executor_tui_steps.py',
];

function failed(error: unknown): { code: number; stdout: string; stderr: string } {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'number'
    || !('stdout' in error) || typeof error.stdout !== 'string' || !('stderr' in error) || typeof error.stderr !== 'string') {
    throw new Error('the Python consumer could not complete');
  }
  return { code: error.code, stdout: error.stdout, stderr: error.stderr };
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('run the executor consumers through scripts/e2e-lab.sh');
  }
  const context = await mkdtemp(join(tmpdir(), `${prefix}-`));
  try {
    const recipe = await readFile('tests/e2e/lab-runner/Dockerfile');
    const base = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
    await writeFile(join(context, 'Dockerfile'), `FROM ${base}\n`
      + 'RUN apt-get update && apt-get install -y --no-install-recommends python3-yaml && rm -rf /var/lib/apt/lists/*\n');
    await execute('docker', ['build', '--quiet', '--label', `cauce.e2e.owner=${owner}`, '--tag', image, context], { timeout: 240_000 });
    imageBuilt = true;
    socketGroup = (await execute('stat', ['-c', '%g', '/var/run/docker.sock'])).stdout.trim();
  } finally { await rm(context, { recursive: true, force: true }); }
}, 270_000);
afterAll(async () => {
  if (imageBuilt) await execute('docker', ['image', 'rm', image]);
});

describe.sequential('consumidores del ciclo de vida del executor en docker-lab', () => {
  it.each(consumers)('%s', async filename => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${prefix}-${filename.replaceAll('_', '-').replace('.py', '')}`;
    const args = ['-B', join('ops/tests', filename)];
    let workdir = process.cwd();
    let disposableSource: string | undefined;
    if (filename === 'test_fleet_executor_agent_quota.py') {
      disposableSource = await mkdtemp(join(tmpdir(), `${prefix}-source-`));
      workdir = disposableSource;
      await chmod(workdir, 0o755);
      for (const relative of ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/tests', 'ops/schemas',
        'packages/adapter-sdk/descriptors']) {
        await cp(join(process.cwd(), relative), join(workdir, relative), { recursive: true });
      }
    }
    const command = ['run', '--rm', '--init', '--name', name, '--label', `cauce.e2e.owner=${owner}`,
      '--user', `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`, '--group-add', socketGroup,
      '--network', 'host', '--mount', 'type=bind,src=/datos,dst=/datos,readonly',
      '--mount', 'type=bind,src=/tmp,dst=/tmp', '--mount', 'type=bind,src=/var/tmp,dst=/var/tmp',
      '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
      '--env', 'CAUCE_RELEASE_VALIDATION=1', '--env', 'CAUCE_REQUIRE_TESTCONTAINERS=1',
      '--workdir', workdir, image, 'python3', ...args];
    const result = await execute('docker', command, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 })
      .then(value => ({ ...value, code: 0 }), failed)
      .finally(async () => {
        await execute('docker', ['rm', '--force', name]).catch(() => undefined);
        if (disposableSource) await rm(disposableSource, { recursive: true, force: true });
      });
    const summary = result.stderr.split('\n').filter(line => /^(Ran \d+ tests? in [0-9.]+s|OK(?: \(.*\))?|FAILED \(.*\))$/u.test(line)
      || /^(ERROR|FAIL): [A-Za-z0-9_. ()-]+$/u.test(line)
      || /^ {2}File "[^"\r\n]+", line \d+, in [A-Za-z0-9_<>]+$/u.test(line));
    await writeFile(join(directory, `${filename}.json`), JSON.stringify({
      command: ['python3', ...args], exit_code: result.code, summary,
    }, null, 2) + '\n', { mode: 0o600 });
    expect(result.code, `${filename}: ${summary.join(' | ')}`).toBe(0);
    expect(summary.some(line => /^Ran [1-9]\d* tests? /u.test(line)), 'the consumer must execute its tests').toBe(true);
    expect(summary.some(line => line.startsWith('OK (skipped=')), 'the required consumers must not be skipped').toBe(false);
  }, 330_000);
});
