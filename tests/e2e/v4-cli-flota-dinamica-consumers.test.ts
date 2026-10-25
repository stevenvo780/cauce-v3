import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const owner = 'l2b-ciclo-sdk-1025';
const prefix = `zz-canary-${owner}-consumers-${randomUUID()}`;
const directory = join(process.cwd(), '.delegados/v4/recibos/l2b-ciclo-sdk-1025/consumers', prefix);
const image = `${prefix}:local`;
let socketGroup = '';
let labVerified = false;
const dockerWrapper = `#!/usr/bin/python3 -I
import os,re,sys
args=sys.argv[1:]
index=0
value_options={"--config","--context","--host","--log-level","--tlscacert","--tlscert","--tlskey","-c","-H","-l"}
while index<len(args) and args[index].startswith("-"):
    option=args[index]
    index+=2 if option in value_options else 1
insert=None
if index<len(args) and args[index] in {"run","create","build"}:
    insert=index+1
elif tuple(args[index:index+2]) in {
    ("container","run"),("container","create"),("image","build"),
    ("buildx","build"),("volume","create"),("network","create")
}:
    insert=index+2
if insert is not None:
    consumer=os.environ.get("CAUCE_E2E_CONSUMER","")
    if not re.fullmatch(${JSON.stringify(`${prefix}-[0-9a-f-]{36}`)},consumer):
        raise SystemExit("consumer resource scope is missing")
    args[insert:insert]=["--label",${JSON.stringify(`cauce.e2e.owner=${owner}`)},"--label","cauce.e2e.consumer="+consumer]
os.execv("/usr/local/libexec/cauce-consumer-docker",["docker",*args])
`;
const consumers = [
  'test_cli_python_isolation.py', 'test_fleet_executor.py', 'test_fleet_executor_agent_quota.py',
  'test_fleet_executor_authority.py', 'test_fleet_executor_container.py', 'test_fleet_executor_image_refresh.py',
  'test_fleet_executor_import_layout.py', 'test_fleet_executor_legacy.py', 'test_fleet_executor_rebind.py',
  'test_fleet_executor_recovery.py', 'test_fleet_executor_replacement.py', 'test_fleet_executor_sdk.py',
  'test_fleet_executor_templates.py', 'test_fleet_model_fallback.py', 'test_fleet_orphan_sweep.py',
  'test_fleet_provider_openclaw.py', 'test_model_fallback_docker.py', 'test_provider_login_container.py',
  'test_fleet_executor_tui.py', 'test_fleet_executor_tui_steps.py',
];
const isolatedSourceConsumers = new Set([
  'test_fleet_executor_agent_quota.py', 'test_fleet_executor_legacy.py', 'test_fleet_executor_templates.py',
  'test_model_fallback_docker.py', 'test_provider_login_container.py',
]);

async function makePublicSourceReadable(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isDirectory()) {
    await chmod(path, 0o755);
    await Promise.all((await readdir(path)).map(name => makePublicSourceReadable(join(path, name))));
  } else if (entry.isFile()) {
    await chmod(path, entry.mode & 0o111 ? 0o755 : 0o644);
  } else {
    throw new Error('the isolated public source must contain only regular files and directories');
  }
}

const saveManifest = (imageCleanup: Awaited<ReturnType<typeof cleanup>> | null) => writeFile(join(directory, 'manifest.json'),
  JSON.stringify({ prefix, declared_consumers: consumers, image_cleanup: imageCleanup }, null, 2) + '\n', { mode: 0o600 });

function failed(error: unknown, timedOut: boolean): { code: number; stderr: string } {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return { code: timedOut ? 124 : typeof code === 'number' ? code : 125, stderr };
}

async function cleanup(consumer: string): Promise<{ clean: boolean; remaining: Record<string, string[]> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, 75_000);
  const remaining: Record<string, string[]> = {};
  const filters = ['--filter', `label=cauce.e2e.owner=${owner}`, '--filter', `label=cauce.e2e.consumer=${consumer}`];
  const resources = [
    { kind: 'containers', list: ['ps', '-a', '--quiet', '--no-trunc'], remove: ['rm', '--force'], valid: /^[a-f0-9]{64}$/u },
    { kind: 'volumes', list: ['volume', 'ls', '--quiet'], remove: ['volume', 'rm'], valid: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u },
    { kind: 'networks', list: ['network', 'ls', '--quiet', '--no-trunc'], remove: ['network', 'rm'], valid: /^[a-f0-9]{64}$/u },
    { kind: 'images', list: ['image', 'ls', '--quiet', '--no-trunc'], remove: ['image', 'rm'], valid: /^sha256:[a-f0-9]{64}$/u },
  ];
  const run = (args: string[]) => execute('docker', args, { timeout: 10_000, signal: controller.signal, killSignal: 'SIGKILL' });
  try {
    for (let pass = 0; pass < 2; pass++) {
      for (const resource of resources) {
        const ids = [...new Set((await run([...resource.list, ...filters])).stdout.split(/\s+/u).filter(Boolean))];
        if (ids.some(id => !resource.valid.test(id))) throw new Error('invalid owned resource identity');
        if (ids.length) await run([...resource.remove, ...ids]).catch(() => undefined);
      }
    }
    for (const resource of resources) {
      remaining[resource.kind] = [...new Set((await run([...resource.list, ...filters])).stdout.split(/\s+/u).filter(Boolean))];
    }
    return { clean: Object.values(remaining).every(ids => ids.length === 0), remaining };
  } catch {
    return { clean: false, remaining };
  } finally { clearTimeout(timer); }
}

beforeAll(async () => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await saveManifest(null);
  console.info('CONSUMER_RUN ' + JSON.stringify({ prefix, directory }));
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('run the executor consumers through scripts/e2e-lab.sh');
  }
  labVerified = true;
  const context = await mkdtemp(join(tmpdir(), `${prefix}-`));
  try {
    const recipe = await readFile('tests/e2e/lab-runner/Dockerfile');
    const base = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
    await writeFile(join(context, 'Dockerfile'), `FROM ${base}\n`
      + 'RUN apt-get update && apt-get install -y --no-install-recommends python3-yaml && rm -rf /var/lib/apt/lists/*'
      + ' && mv /usr/local/bin/docker /usr/local/libexec/cauce-consumer-docker\n'
      + 'COPY --chmod=0755 docker-wrapper /usr/local/bin/docker\n'
      + 'RUN python3 -I -B -m py_compile /usr/local/bin/docker\n');
    await writeFile(join(context, 'docker-wrapper'), dockerWrapper);
    await execute('docker', ['build', '--quiet', '--label', `cauce.e2e.owner=${owner}`,
      '--label', `cauce.e2e.consumer=${prefix}`, '--tag', image, context], { timeout: 240_000 })
      .catch(() => { throw new Error('the isolated consumer runner image could not be built'); });
    socketGroup = (await execute('stat', ['-c', '%g', '/var/run/docker.sock'])).stdout.trim();
  } finally { await rm(context, { recursive: true, force: true }); }
}, 270_000);
afterAll(async () => {
  const imageCleanup = labVerified ? await cleanup(prefix) : null;
  await saveManifest(imageCleanup);
  if (imageCleanup) expect(imageCleanup.clean, 'the owned consumer image must be removed').toBe(true);
}, 90_000);

describe.sequential('consumidores del ciclo de vida del executor en docker-lab', () => {
  it.each(consumers)('%s', async filename => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const consumer = `${prefix}-${randomUUID()}`;
    const receipt = join(directory, `${filename}.json`);
    const args = ['-B', join('ops/tests', filename)];
    const save = (data: object) => writeFile(receipt, JSON.stringify({ consumer, command: ['python3', ...args], ...data }, null, 2)
      + '\n', { mode: 0o600 });
    await save({ exit_code: 124, completed: false, summary: [] });
    const name = `${prefix}-${filename.replaceAll('_', '-').replace('.py', '')}`;
    let workdir = process.cwd();
    let disposableSource: string | undefined;
    let result = { code: 125, stderr: '' };
    let summary: string[] = [];
    let timedOut = false;
    let cleaned: Awaited<ReturnType<typeof cleanup>>;
    try {
      if (isolatedSourceConsumers.has(filename)) {
        disposableSource = await mkdtemp(join(tmpdir(), `${prefix}-source-`));
        workdir = disposableSource;
        await chmod(workdir, 0o755);
        for (const relative of ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/tests', 'ops/schemas',
          'packages/adapter-sdk/descriptors']) {
          await cp(join(process.cwd(), relative), join(workdir, relative), { recursive: true });
        }
        await makePublicSourceReadable(workdir);
      }
      const command = ['run', '--rm', '--init', '--name', name, '--label', `cauce.e2e.owner=${owner}`,
        '--label', `cauce.e2e.consumer=${consumer}`,
        '--user', `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`, '--group-add', socketGroup,
        '--network', 'host', '--mount', 'type=bind,src=/datos,dst=/datos,readonly',
        '--mount', 'type=bind,src=/tmp,dst=/tmp', '--mount', 'type=bind,src=/var/tmp,dst=/var/tmp',
        '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
        '--env', 'CAUCE_RELEASE_VALIDATION=1', '--env', 'CAUCE_REQUIRE_TESTCONTAINERS=1',
        '--env', `CAUCE_E2E_CONSUMER=${consumer}`,
        '--workdir', workdir, image, 'python3', ...args];
      const controller = new AbortController();
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 300_000);
      result = await execute('docker', command, { signal: controller.signal, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 })
        .then(value => ({ ...value, code: 0 }), (error: unknown) => failed(error, timedOut))
        .finally(() => { clearTimeout(timer); });
      summary = result.stderr.split('\n').filter(line => /^(Ran \d+ tests? in [0-9.]+s|OK(?: \(.*\))?|FAILED \(.*\))$/u.test(line)
        || /^(ERROR|FAIL): [A-Za-z0-9_. ()-]+$/u.test(line)
        || /^ {2}File "[^"\r\n]+", line \d+, in [A-Za-z0-9_<>]+$/u.test(line));
      await save({ exit_code: result.code, timed_out: timedOut, completed: true, summary, stderr: result.stderr });
    } finally {
      cleaned = await cleanup(consumer);
      if (disposableSource) await rm(disposableSource, { recursive: true, force: true });
    }
    await save({ exit_code: result.code, timed_out: timedOut, completed: true, summary, stderr: result.stderr, cleanup: cleaned });
    expect(cleaned.clean, `${filename}: owned resources must be removed`).toBe(true);
    expect(result.code, `${filename}: ${summary.join(' | ')}`).toBe(0);
    expect(summary.some(line => /^Ran [1-9]\d* tests? /u.test(line)), 'the consumer must execute its tests').toBe(true);
    expect(summary.some(line => line.startsWith('OK (skipped=')), 'the required consumers must not be skipped').toBe(false);
  }, 420_000);
});
