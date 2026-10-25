import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const OWNER = 's3-tmpdir-proveedores-1025';
const RUN = randomUUID().slice(0, 8);
const IMAGE = 'node:22-slim';
const ROOT = process.cwd();
const RECEIPTS = join(ROOT, '.delegados/v4/recibos', OWNER);
const PROBE = `import hashlib, json, os, pathlib, pwd, sys
sys.path.insert(0, sys.argv[1])
provider, root = sys.argv[2], pathlib.Path(sys.argv[3])
state, profile, home = root / 'state', root / 'profile', root / 'home'
for directory in (state, profile, home):
    os.mkdir(directory, 0o700)
user = pwd.getpwuid(os.getuid()).pw_name
cli = root / 'provider-cli'
cli.write_text('#!/usr/bin/python3\\n')
cli.chmod(0o700)
agent = {'runtime_user': user, 'home_directory': str(home), 'state_directory': str(state),
         'runtime_mode': 'container', 'harness_id': provider, 'runtime_key': 'turno', 'model_id': None,
         'primary_account_id': 'account'}
binding = {'provider': provider, 'runtime_user': user, 'identity': 'subject', 'path': str(profile),
           'command': str(cli), 'command_sha256': hashlib.sha256(cli.read_bytes()).hexdigest()}
if provider == 'muse':
    bridge = pathlib.Path(sys.argv[4])
    binding['muse'] = {'bridge': str(bridge), 'bridge_sha256': hashlib.sha256(bridge.read_bytes()).hexdigest()}
    import fleet_provider_muse as driver
elif provider == 'grok':
    import fleet_provider_grok as driver
else:
    import fleet_provider_openclaw as driver
    source, bridge = root / 'auth-list.mjs', root / 'bridge.mjs'
    source.write_text('export {}\\n')
    bridge.write_text('export {}\\n')
    source.chmod(0o600)
    bridge.chmod(0o600)
    binding['provider'] = 'codex'
    agent['model_id'] = 'openai/gpt-5.5'
    binding['openclaw'] = {'provider_id': 'openai', 'method_id': 'device-code', 'version': driver.VERSION,
        'auth_list_source': str(source), 'auth_list_sha256': driver.AUTH_LIST_SHA256,
        'node_command': sys.argv[4], 'node_command_sha256': '00' * 32, 'bridge': str(bridge),
        'bridge_sha256': hashlib.sha256(bridge.read_bytes()).hexdigest()}
print(json.dumps(driver.environment(binding, agent)))
`;

const TURN = `import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = process.env.CAUCE_TURN_SCRIPT;
if (script === undefined) process.exit(2);
const staged = mkdtempSync(join(tmpdir(), 'cauce-stdin-'));
writeFileSync(join(staged, 'prompt'), 'turno\\n', { mode: 0o600, flag: 'wx' });
const child = spawnSync(process.execPath, [script], { encoding: 'utf8' });
if (child.status !== 0) process.exit(child.status ?? 1);
writeFileSync(join(tmpdir(), 'adapter-staged'), 'staged\\n', { mode: 0o600, flag: 'wx' });
setInterval(() => undefined, 1000);
`;

const PROVIDER_TURN = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.TMPDIR;
if (dir === undefined) process.exit(2);
writeFileSync(join(dir, 'provider-turn'), 'turno\\n', { mode: 0o600, flag: 'wx' });
process.stdout.write('reply\\n');
`;

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await exec('docker', args, { timeout: 30_000, maxBuffer: 1_000_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

async function removeOwned(): Promise<void> {
  const listed = await docker(['ps', '-aq', '--filter', `label=cauce.e2e.owner=${OWNER}`, '--filter', `name=zz-canary-${OWNER}-`]);
  const ids = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (ids.length > 0) await docker(['rm', '-f', ...ids]);
}

describe('el temporal del turno queda en space/tmp', () => {
  afterAll(async () => {
    await removeOwned();
  });

  it.each(['openclaw', 'muse', 'grok'] as const)('%s hace un turno y deja TMPDIR en space/tmp', async provider => {
    const work = await mkdtemp(join(tmpdir(), `zz-canary-${OWNER}-`));
    const state = join(work, 'state');
    const node = (await exec('which', ['node'])).stdout.trim();
    const extra = provider === 'muse' ? join(ROOT, 'ops/container-runtime/muse-cauce') : node;
    const probed = await exec('python3', ['-c', PROBE, join(ROOT, 'ops/cli'), provider, work, extra], { timeout: 20_000 });
    const environment = JSON.parse(probed.stdout) as Record<string, string>;
    const spaceTmp = join(state, 'space', 'tmp');
    expect(environment.TMPDIR).toBe(spaceTmp);
    const created = await lstat(spaceTmp);
    expect(created.isSymbolicLink()).toBe(false);
    expect(created.isDirectory()).toBe(true);
    expect(created.mode & 0o777).toBe(0o700);
    await mkdir(join(state, 'space', 'projects'), { mode: 0o700 });
    expect(await lstat(join(state, 'workspace')).then(() => true, () => false)).toBe(false);
    if (provider === 'openclaw') {
      expect(environment.CAUCE_OPENCLAW_WORKSPACE).toBe(join(state, 'space', 'projects'));
      expect(environment.NODE_COMPILE_CACHE).toBe(join(work, 'profile', 'tmp', 'node-compile-cache'));
    }
    if (provider === 'muse') expect(environment.CAUCE_MUSE_WORKSPACE).toBe(join(state, 'space', 'projects'));
    if (provider === 'grok') {
      expect(environment.CAUCE_GROK_WORKSPACE).toBe(join(state, 'space', 'projects'));
      expect(environment.GROK_HOME).toBe(join(work, 'profile'));
    }
    await writeFile(join(state, 'turn.mjs'), TURN, { mode: 0o600 });
    await writeFile(join(state, 'provider.mjs'), PROVIDER_TURN, { mode: 0o600 });
    const name = `zz-canary-${OWNER}-${provider}-${RUN}`;
    const account = userInfo();
    const args = ['run', '-d', '--name', name, '--label', `cauce.e2e.owner=${OWNER}`, '--network', 'none',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--user', `${String(account.uid)}:${String(account.gid)}`,
      '--mount', `type=bind,src=${state},dst=${state}`, '-w', join(state, 'space', 'projects'),
      '--entrypoint', 'node', ...Object.entries({ ...environment, HOME: join(state, 'space', 'projects'),
        CAUCE_TURN_SCRIPT: join(state, 'provider.mjs') }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      IMAGE, join(state, 'turn.mjs')];
    const started = await docker(args);
    expect(started.code, started.stderr).toBe(0);
    await expect.poll(async () => lstat(join(spaceTmp, 'provider-turn')).then(() => true, () => false),
      { timeout: 20_000, interval: 200 }).toBe(true);
    const marker = await lstat(join(spaceTmp, 'provider-turn'));
    const staged = await lstat(join(spaceTmp, 'adapter-staged'));
    expect(marker.isFile() && !marker.isSymbolicLink()).toBe(true);
    expect(staged.isFile() && !staged.isSymbolicLink()).toBe(true);
    expect(marker.mode & 0o777).toBe(0o600);
    const observed = await docker(['exec', name, 'node', '-e',
      'const fs=require("node:fs");const rows=fs.readFileSync("/proc/1/environ").toString().split("\\0").filter(row=>row.startsWith("TMPDIR="));if(rows.length!==1)process.exit(2);process.stdout.write(rows[0]);']);
    expect(observed.code, observed.stderr).toBe(0);
    expect(observed.stdout).toBe(`TMPDIR=${spaceTmp}`);
    const inside = await docker(['exec', name, 'node', '-e',
      'const fs=require("node:fs");const path=process.argv[1];const info=fs.lstatSync(path);if(!info.isFile()||info.isSymbolicLink())process.exit(2);process.stdout.write(String(info.mode&511));',
      join(spaceTmp, 'provider-turn')]);
    expect(inside.code, inside.stderr).toBe(0);
    expect(inside.stdout).toBe(String(0o600));
    const leaked = await docker(['exec', name, 'node', '-e',
      'const fs=require("node:fs");process.stdout.write(String(fs.readdirSync("/tmp").some(name=>name==="provider-turn"||name==="adapter-staged")));']);
    expect(leaked.stdout).toBe('false');
    await docker(['rm', '-f', name]);
    await mkdir(RECEIPTS, { recursive: true, mode: 0o700 });
    await writeFile(join(RECEIPTS, `${provider}-${RUN}.json`), JSON.stringify({
      provider, tmpdir: spaceTmp, environ: observed.stdout, stat: 'provider-turn 0600', workspace_sibling: false,
    }) + '\n', { mode: 0o600 });
    await rm(work, { recursive: true, force: true });
  }, 60_000);
});
