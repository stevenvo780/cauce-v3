import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserDocker, browserErrorStderr, browserErrorStdout, browserExec } from './browser-owned-lifecycle.js';

export const owner = 'h8b-tui-v4-produccion-1025';
export const runId = randomUUID();
export const evidence = join(process.cwd(), '.delegados/v4/recibos', owner, runId);
export const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
export interface V4TestContext { owner: string; evidence: string; runId: string }
export const defaultContext: V4TestContext = { owner, evidence, runId };
export function currentV4TestContext(): V4TestContext {
  const taskOwner = /^\/tmp\/cauce-e2e-home-(h8d-regresion-tui-1025|h8f-tiempos-muse-grok-1025)-\d+$/u.exec(process.env.HOME ?? '')?.[1];
  return taskOwner === undefined ? defaultContext : { owner: taskOwner, runId,
    evidence: join(process.cwd(), '.delegados/v4/recibos', taskOwner, runId) };
}
export interface V4Image { tag: string; id: string; recipe: Record<string, string>; sourceDateEpoch: string; versions: string }

export async function realV4Image(context = defaultContext): Promise<V4Image> {
  const { owner, evidence, runId } = context;
  if (!process.env.HOME?.startsWith('/tmp/cauce-e2e-home-')) throw new Error('use the versioned lab runner');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const sources = ['ops/agent-runtime/Dockerfile', 'ops/container-runtime/muse-cauce',
    'ops/cuotas/codex-http-probe.py', 'ops/cuotas/leer-cuota-grok.mjs', 'ops/cuotas/leer-cuota.mjs',
    'ops/patches/openclaw-turn-compaction-guard.mjs'];
  const bodies = await Promise.all(sources.map(path => readFile(path)));
  const recipe = Object.fromEntries(sources.map((path, index) => [path, digest(bodies[index] ?? '')]));
  const recipeHash = digest(Buffer.concat(bodies));
  const tag = `zz-canary-${owner}:${recipeHash.slice(0, 16)}`;
  const daemonId = (await browserDocker(['info', '--format', '{{.ID}}'])).stdout.trim();
  if (!/^[A-Za-z0-9:._-]{1,256}$/u.test(daemonId)) throw new Error('Docker daemon identity is unavailable');
  const daemonHash = digest(daemonId);
  const cacheRoot = join(process.cwd(), '.delegados/v4/recibos', owner, 'image-cache');
  const ledger = join(cacheRoot, daemonHash, recipeHash);
  await mkdir(ledger, { recursive: true, mode: 0o700 });
  const inspect = async (): Promise<string | undefined> => {
    try {
      const value = (await browserDocker(['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', tag])).stdout.trim().split(' ');
      if (value[1] !== owner || !value[0]?.match(/^sha256:[a-f0-9]{64}$/u)) throw new Error('V4 image tag ownership differs');
      return value[0];
    } catch (error) { if (/No such image/iu.test(browserErrorStderr(error))) return undefined; throw error; }
  };
  let previous = await readFile(join(ledger, 'manifest.json'), 'utf8').then(text => JSON.parse(text) as V4Image, () => undefined);
  let id = await inspect();
  const sourceDateEpoch = (await browserExec('git', ['log', '-1', '--format=%ct', '--', ...sources])).stdout.trim();
  if (!/^\d+$/u.test(sourceDateEpoch)) throw new Error('canonical image timestamp is unavailable');
  let migrated = false;
  if (id && !previous) {
    const legacy = await readFile(join(cacheRoot, recipeHash, 'manifest.json'), 'utf8').then(text => JSON.parse(text) as V4Image, () => undefined);
    if (legacy?.id === id && legacy.tag === tag && legacy.sourceDateEpoch === sourceDateEpoch
      && JSON.stringify(legacy.recipe) === JSON.stringify(recipe)) {
      previous = legacy;
      migrated = true;
      await writeFile(join(ledger, 'manifest.json'), JSON.stringify(legacy, null, 2));
    }
  }
  await writeFile(join(evidence, 'image-cache-binding.json'), JSON.stringify({ daemon_sha256: daemonHash, ledger, legacy_migrated: migrated,
    local_image_id: id, receipt_image_id: previous?.id }, null, 2));
  if (id && (previous?.id !== id || JSON.stringify(previous.recipe) !== JSON.stringify(recipe))) throw new Error('cached V4 image has no matching recipe receipt');
  if (id && previous?.sourceDateEpoch !== sourceDateEpoch) throw new Error('cached V4 image timestamp differs from its verified receipt');
  if (!id) {
    const work = await mkdtemp(join(tmpdir(), `zz-canary-${owner}-image-`));
    try {
      for (const name of ['musebridge', 'quotareaders', 'patches']) await mkdir(join(work, name));
      await copyFile(sources[1] ?? '', join(work, 'musebridge/muse-cauce'));
      await chmod(join(work, 'musebridge/muse-cauce'), 0o755);
      for (const path of sources.slice(2, 5)) await copyFile(path, join(work, 'quotareaders', path.split('/').at(-1) ?? ''));
      await copyFile(sources[5] ?? '', join(work, 'patches/openclaw-turn-compaction-guard.mjs'));
      const archive = join(work, 'agent-image.tar');
      const command = ['build', '-q', '--provenance=false', '--label', `cauce.e2e.owner=${owner}`,
        '--build-context', `musebridge=${work}/musebridge`, '--build-context', `quotareaders=${work}/quotareaders`,
        '--build-context', `patches=${work}/patches`,
        '--build-arg', `SOURCE_DATE_EPOCH=${sourceDateEpoch}`, '--output',
        `type=docker,rewrite-timestamp=true,name=${tag},dest=${archive}`, 'ops/agent-runtime'];
      process.stdout.write(`v4-image-build ${JSON.stringify({ tag, recipe, source_date_epoch: sourceDateEpoch })}\n`);
      const built = await browserDocker(command, { timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 }).catch(async (error: unknown) => {
        await writeFile(join(evidence, 'image-build.log'), browserErrorStdout(error) + browserErrorStderr(error)); throw error;
      });
      await writeFile(join(evidence, 'image-build.log'), built.stdout + built.stderr);
      await browserDocker(['load', '-q', '-i', archive], { timeout: 240_000 });
      id = await inspect();
      if (!id) throw new Error('canonical V4 image was not loaded');
      await writeFile(join(ledger, 'manifest.json'), JSON.stringify({ tag, id, recipe, sourceDateEpoch, versions: '' }, null, 2));
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  const probeName = `zz-canary-${owner}-versions-${runId}`;
  const cleanProbe = async () => {
    const ids = (await browserDocker(['container', 'ls', '-aq', '--filter', `name=^/${probeName}$`, '--filter', `label=cauce.e2e.owner=${owner}`])).stdout.trim();
    if (ids) await browserDocker(['rm', '-f', ids]);
    const remaining = (await browserDocker(['container', 'ls', '-aq', '--filter', `name=^/${probeName}$`])).stdout.trim();
    await writeFile(join(evidence, 'image-probe-cleanup.json'), JSON.stringify({ name: probeName, absent: remaining === '' }));
    if (remaining) throw new Error('owned V4 image probe remains');
  };
  let versions: string;
  try {
  versions = (await browserDocker(['run', '--rm', '--name', probeName, '--label', `cauce.e2e.owner=${owner}`, '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,noexec,size=128m,mode=1777', '--env', 'MUSE_NO_AUTO_UPDATE=1', '--env',
    'NODE_COMPILE_CACHE=/tmp/compile-cache', '--entrypoint', '/bin/sh', tag, '-c',
    'set -e; for name in node tmux grok muse openclaw; do command -v "$name"; done; node --version; grok --version; muse --version; openclaw --version; test -f /usr/local/lib/node_modules/openclaw/dist/index.js'],
  { timeout: 60_000, maxBuffer: 64 * 1024 })).stdout.trim();
  } finally { await cleanProbe(); }
  const result: V4Image = { tag, id, recipe, sourceDateEpoch, versions };
  if (!previous) await writeFile(join(ledger, 'manifest.json'), JSON.stringify(result, null, 2));
  await writeFile(join(evidence, 'image.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`v4-image-artifacts ${JSON.stringify({ run_id: runId, directory: evidence, tag, id })}\n`);
  return result;
}
