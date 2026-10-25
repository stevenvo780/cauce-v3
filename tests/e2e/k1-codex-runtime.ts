import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserDocker, browserExec } from './browser-owned-lifecycle.js';
import { TMUX_SOCKET } from '../../packages/adapter-sdk/src/shared-session/types.js';

export const K1_OWNER = 'k1-dialogo-daemon-codex-1025';
export const K1_RUN = randomUUID();
export const K1_PREFIX = `zz-canary-${K1_OWNER}-${K1_RUN}`;
export const K1_EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', K1_OWNER, K1_RUN);
const labels = ['--label', `cauce.e2e.owner=${K1_OWNER}`, '--label', `cauce.e2e.run=${K1_RUN}`];

export async function k1Receipt(name: string, data: unknown): Promise<void> {
  await mkdir(K1_EVIDENCE, { recursive: true, mode: 0o700 });
  await writeFile(join(K1_EVIDENCE, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function cleanupK1Resources(): Promise<void> {
  const filters = ['--filter', `label=cauce.e2e.owner=${K1_OWNER}`, '--filter', `label=cauce.e2e.run=${K1_RUN}`];
  const resources = [
    { name: 'containers', list: ['container', 'ls', '-aq', '--no-trunc'], remove: ['rm', '-f'] },
    { name: 'volumes', list: ['volume', 'ls', '-q'], remove: ['volume', 'rm'] },
    { name: 'networks', list: ['network', 'ls', '-q', '--no-trunc'], remove: ['network', 'rm'] },
    { name: 'images', list: ['image', 'ls', '-q', '--no-trunc'], remove: ['image', 'rm', '-f'] },
  ];
  for (const resource of resources) {
    const ids = [...new Set((await browserDocker([...resource.list, ...filters])).stdout.split(/\s+/u).filter(Boolean))];
    if (ids.length) await browserDocker([...resource.remove, ...ids]);
  }
  const remaining: Record<string, string[]> = {};
  for (const resource of resources) remaining[resource.name] =
    (await browserDocker([...resource.list, ...filters])).stdout.split(/\s+/u).filter(Boolean);
  await k1Receipt('cleanup.json', { run: K1_RUN, remaining, clean: Object.values(remaining).every(rows => !rows.length) });
  if (Object.values(remaining).some(rows => rows.length)) throw new Error('owned K1 resources remain');
}

export async function startK1CodexRuntime() {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('K1 requires scripts/e2e-lab.sh');
  }
  await mkdir(K1_EVIDENCE, { recursive: true, mode: 0o700 });
  console.info('K1_RUN ' + JSON.stringify({ run: K1_RUN, directory: K1_EVIDENCE }));
  const directory = await mkdtemp(join(tmpdir(), `${K1_PREFIX}-`));
  const sdk = join(directory, 'sdk');
  const name = `${K1_PREFIX}-runtime`;
  const image = `${K1_PREFIX}:local`;
  const close = async () => {
    try { await cleanupK1Resources(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  try {
    await chmod(directory, 0o755);
    await mkdir(join(sdk, 'src/bin'), { recursive: true });
    await cp('packages/adapter-sdk/descriptors', join(sdk, 'descriptors'), { recursive: true });
    await cp(await realpath('node_modules/ws'), join(sdk, 'vendor/ws'), { recursive: true });
    for (const bin of ['codex', 'shared-session']) {
      await browserExec(join(process.cwd(), 'node_modules/.bin/esbuild'), [
        `packages/adapter-sdk/src/bin/${bin}.ts`, '--bundle', '--platform=node', '--format=esm', '--target=node22',
        '--log-level=error', `--outfile=${join(sdk, 'src/bin', `${bin}.js`)}`,
        `--alias:@cauce/protocol=${join(process.cwd(), 'packages/protocol/src/index.ts')}`,
        '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);',
      ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    }
    const sdkDigests = Object.fromEntries(await Promise.all(['codex', 'shared-session'].map(async bin =>
      [bin, createHash('sha256').update(await readFile(join(sdk, 'src/bin', `${bin}.js`))).digest('hex')] as const)));
    const sourceHead = (await browserExec('git', ['rev-parse', 'HEAD'])).stdout.trim();
    const recipe = await readFile('tests/e2e/lab-runner/Dockerfile');
    const base = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
    await writeFile(join(directory, 'Dockerfile'), `FROM ${base}\n`
      + 'RUN npm install --global --no-audit --no-fund @openai/codex@0.164.0'
      + ' && npm install --prefix /usr/local/share/k1-compat --no-audit --no-fund @openai/codex@0.160.1'
      + ' && npm cache clean --force\n');
    await browserDocker(['build', '-q', ...labels, '-t', image, directory], { timeout: 300_000, maxBuffer: 1024 * 1024 });
    const imageId = (await browserDocker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
    await browserDocker(['run', '-d', '--init', '--name', name, ...labels, '--network', 'host', '--user', 'node',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '--tmpfs', '/tmp:rw,nosuid,size=128m,mode=1777', '--tmpfs', '/home/node:rw,exec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
      '--mount', `type=bind,src=${sdk},dst=/cauce-sdk,readonly`, '--workdir', '/home/node',
      '--env', 'HOME=/home/node', '--env', 'CODEX_HOME=/home/node/.codex', '--env', 'TERM=xterm-256color',
      '--entrypoint', '/bin/sleep', imageId, 'infinity']);
    const id = (await browserDocker(['inspect', '--format', '{{.Id}}', name])).stdout.trim();
    const exec = (args: string[], timeout = 30_000) => browserDocker(['exec', '--user', 'node', name, ...args], { timeout, maxBuffer: 1024 * 1024 });
    const tmux = (args: string[]) => exec(['/usr/bin/tmux', '-L', TMUX_SOCKET, ...args]);
    const mounts = JSON.parse((await exec(['python3', '-I', '-B', '-c', `import json,pathlib
rows=[]
for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
 fields=line.split()
 if fields[4] in {'/home/node','/tmp'}:rows.append({'path':fields[4],'options':fields[5].split(',')})
print(json.dumps(rows))`])).stdout) as unknown;
    await k1Receipt('runtime-mounts.json', mounts);
    await k1Receipt('runtime.json', { run: K1_RUN, name, id, image: imageId, codex_version: '0.164.0',
      repository_codex_pin: '0.160.1', provider: 'local Responses fixture', authentication: 'DevOnlyAuthProvider.forTests',
      source_head_observed: sourceHead, compiled_sdk_sha256: sdkDigests });
    return { name, id, imageId, directory, exec, tmux, close };
  } catch (error) { await close(); throw error; }
}
