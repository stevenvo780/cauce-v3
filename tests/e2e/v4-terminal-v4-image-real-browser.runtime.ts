import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { browserDocker, browserExec, browserErrorStderr } from './browser-owned-lifecycle.js';
import { evidence, owner, digest, type V4Image } from './v4-terminal-v4-image-real-browser.image.js';
import { startV4Infrastructure, stopProcess } from './v4-terminal-v4-image-real-browser.infra.js';
import { TMUX_SOCKET } from '../../packages/adapter-sdk/src/shared-session/types.js';

export type V4Harness = 'openclaw' | 'muse' | 'grok';
interface Binding {
  container_id: string; image_id: string; started_at: string; generation: string; command: string; native_command: string;
  files: Record<string, string>; state: string; profile: string; adapter_pid: number;
  openclaw_help?: { legacy: Record<string, unknown>; measured: { exit?: number; session_flag?: boolean; local_flag?: boolean; history_limit_flag?: boolean } };
}

export async function packageSdk(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'zz-canary-h8b-sdk-'));
  const target = join(directory, 'packages/adapter-sdk');
  try {
  await browserExec('pnpm', ['--filter', '@cauce/adapter-sdk', 'deploy', '--legacy', '--prod', target], { timeout: 120_000, maxBuffer: 256 * 1024 });
  const guard = 'import os,pathlib,sys;root=pathlib.Path(sys.argv[1]);link=root/"node_modules/.pnpm/node_modules/@cauce/adapter-sdk";\nif link.is_symlink():link.unlink();link.symlink_to(os.path.relpath(root,link.parent))\nfor path in root.rglob("*"):\n if path.is_symlink() and not path.resolve().is_relative_to(root):raise SystemExit("SDK package link escapes private release")';
  await browserExec('python3', ['-c', guard, target]);
  await rm(join(target, 'dist'), { recursive: true, force: true });
  await browserExec('pnpm', ['exec', 'tsc', '-p', 'packages/adapter-sdk/tsconfig.json', '--outDir', join(target, 'dist'), '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'], { timeout: 120_000, maxBuffer: 256 * 1024 });
  await cp('packages/adapter-sdk/bridge', join(target, 'dist/bridge'), { recursive: true });
  await cp('packages/adapter-sdk/descriptors', join(target, 'dist/descriptors'), { recursive: true });
  const publicScripts = (await browserExec('git', ['ls-files', 'ops/scripts'])).stdout.trim().split('\n').filter(path => /\.(?:py|json)$/u.test(path));
  for (const path of publicScripts) {
    const destination = join(target, 'test-runtime', path);
    await (await import('node:fs/promises')).mkdir(join(destination, '..'), { recursive: true });
    await cp(path, destination);
  }
  const files: Record<string, string> = {};
  const visit = async (root: string, relative = ''): Promise<void> => {
    for (const row of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, row.name);
      if (row.isDirectory()) await visit(root, path);
      else if (row.isFile()) files[path] = digest(await readFile(join(root, path)));
    }
  };
  await visit(join(target, 'dist'));
  await visit(join(target, 'test-runtime'), 'ops');
  await writeFile(join(evidence, 'sdk-package.json'), JSON.stringify({ directory: target, files }, null, 2));
  await chmod(directory, 0o755);
  return target;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function startV4Runtime(image: V4Image, sdk: string, harness: V4Harness) {
  const key = `h8b-${harness}-${randomBytes(5).toString('hex')}`;
  const alias = `tui${randomBytes(6).toString('hex')}`;
  const name = `zz-canary-${owner}-${key}`;
  const directory = await mkdtemp(join(tmpdir(), `zz-canary-h8b-${harness}-`));
  await chmod(directory, 0o755);
  let infra: Awaited<ReturnType<typeof startV4Infrastructure>>;
  try { infra = await startV4Infrastructure(alias, key, harness); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const requestFile = join(directory, 'request.json');
  const request = { directory, harness, alias, runtime_key: key, name, image_id: image.id, sdk, sdk_root: join(sdk, '../..'),
    room: infra.room, relay_url: `${infra.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, cert: infra.pki.agentCert, key: infra.pki.agentKey, ca: infra.pki.caCert };
  const driver = async (action: string) => browserExec('python3', ['tests/e2e/v4-terminal-v4-image-real-browser.driver.py', action, requestFile], { timeout: 120_000, maxBuffer: 128 * 1024 });
  let launcher: ReturnType<typeof spawn> | undefined;
  let launcherLog = '';
  let lastNative = '';
  let binding: Binding | undefined;
  let canaryMayExist = false;
  const close = async () => {
    const failures: unknown[] = [];
    try { if (launcher) await stopProcess(launcher, 'PTY launcher'); } catch (error) { failures.push(error); }
    try {
      if (canaryMayExist) {
        const cleanup = await driver('cleanup');
        await writeFile(join(evidence, `${harness}-runtime-cleanup.json`), cleanup.stdout);
      }
    } catch (error) { failures.push(error); }
    try { await infra.close(); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'V4 runtime cleanup failed');
  };
  try {
    await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
    canaryMayExist = true;
    binding = JSON.parse((await driver('prepare')).stdout) as Binding;
    const bound = binding;
    await writeFile(join(evidence, `${harness}-binding.json`), JSON.stringify(bound, null, 2));
    await infra.database.pool.query('UPDATE agents SET container_name=$3,state_directory=$4 WHERE tenant_id=$1 AND alias=$2', ['Steven', alias, bound.container_id, bound.state]);
    const adapterLog = async () => (await browserDocker(['exec', '--user', 'node', name, 'cat', `${bound.state}/adapter.log`])).stdout;
    const deadline = Date.now() + 45_000;
    let lease = false;
    while (Date.now() < deadline) {
      if (harness !== 'openclaw') {
        const capture = await browserDocker(['exec', '--user', 'node', '--env', `TMUX_TMPDIR=${bound.state}`, name,
          '/usr/bin/tmux', '-L', TMUX_SOCKET, 'capture-pane', '-e', '-p', '-J', '-S', '-100', '-t', `cauce-${key}:agente`]).then(value => value.stdout, () => '');
        if (capture.trim()) lastNative = /sign in|log in|device.code|user.code|https:\/\/.*auth/iu.test(capture) ? '[authorization prompt omitted]' : capture;
      }
      const rows = await infra.database.pool.query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2', ['Steven', alias]);
      if (rows.rows.length > 0) { lease = true; break; }
      const output = await adapterLog();
      if (/fatal|Error:|failed to start/iu.test(output)) throw new Error(`canary adapter startup failed: ${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!lease) throw new Error(`real adapter omitted its connection lease: ${(await adapterLog()).slice(-4000)}`);
    if (harness !== 'openclaw') {
      const ready = Date.now() + 20_000;
      while (Date.now() < ready) {
        try {
          await browserDocker(['exec', '--user', 'node', '--env', `TMUX_TMPDIR=${bound.state}`, name, 'tmux', '-L', TMUX_SOCKET, 'has-session', '-t', `cauce-${key}`]); break;
        } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
      }
    }
    launcher = spawn('bash', ['ops/pty-agent/cauce-pty-launcher.sh', alias], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CAUCE_PTY_OPS_ROOT: join(process.cwd(), 'ops'), CAUCE_PTY_CONFIG_ROOT: infra.launcherConfig,
        CAUCE_PTY_PKI_ROOT: infra.launcherPkiRoot, CAUCE_PTY_LOCK_ROOT: join(directory, 'locks'), CAUCE_FLEET_RUNTIME_STATE: join(directory, 'inventory') } });
    launcher.stdout?.on('data', (chunk: Buffer) => { launcherLog = (launcherLog + chunk.toString()).slice(-24 * 1024); });
    launcher.stderr?.on('data', (chunk: Buffer) => { launcherLog = (launcherLog + chunk.toString()).slice(-24 * 1024); });
    return { ...infra, alias, key, name, binding: bound, close, adapterLog, launcherLog: () => launcherLog,
      tmuxMarkers: async () => {
        const format = '#{@cauce_alias}|#{@cauce_harness}|#{window_name}|#{pane_dead}';
        const output = (await browserDocker(['exec', '--user', 'node', '--env', `TMUX_TMPDIR=${bound.state}`, name,
          '/usr/bin/tmux', '-L', TMUX_SOCKET, 'display-message', '-p', '-t', `cauce-${key}:agente`, format])).stdout.trim().split('|');
        return { alias: output[0], harness: output[1], window: output[2], dead: output[3] };
      },
      observe: async () => JSON.parse((await browserDocker(['inspect', '--format', '{"id":{{json .Id}},"image":{{json .Image}},"started_at":{{json .State.StartedAt}},"read_only":{{json .HostConfig.ReadonlyRootfs}}}', name])).stdout) as {
        id: string; image: string; started_at: string; read_only: boolean;
      },
      nativeProcesses: async (): Promise<{ pid: number; executable: string; comm: string; uid: number; runtime_key_matches: boolean; profile_matches: boolean; session_matches: boolean }[]> => {
        const script = `import json,os,pathlib,sys
rows=[]
for path in pathlib.Path('/proc').iterdir():
 if not path.name.isdigit():continue
 try:
  if path.stat().st_uid!=1000:continue
  argv=(path/'cmdline').read_bytes().split(bytes([0]));exe=os.readlink(path/'exe')
  match=(exe=='/usr/local/bin/node' and int(path.name)!=int(sys.argv[5])) if sys.argv[1]=='openclaw' else exe==sys.argv[4]
  if not match:continue
  fields=dict(item.split(b'=',1) for item in (path/'environ').read_bytes().split(bytes([0])) if b'=' in item)
  profile=fields.get({'openclaw':b'OPENCLAW_STATE_DIR','grok':b'GROK_HOME','muse':b'XDG_CONFIG_HOME'}[sys.argv[1]])
  wanted=sys.argv[3]+('/config' if sys.argv[1]=='muse' else '')
  if profile!=wanted.encode():continue
  rows.append({'pid':int(path.name),'executable':exe,'comm':(path/'comm').read_text().strip(),'uid':1000,'runtime_key_matches':fields.get(b'CAUCE_RUNTIME_KEY')==sys.argv[2].encode(),'profile_matches':profile==wanted.encode(),'session_matches':('agent:'+sys.argv[2]+':canary').encode() in argv})
 except (OSError,ValueError):continue
print(json.dumps(rows))`;
        return JSON.parse((await browserDocker(['exec', '--user', '0', name, 'python3', '-I', '-B', '-c', script, harness, key, bound.profile, bound.native_command, String(bound.adapter_pid)])).stdout) as { pid: number; executable: string; comm: string; uid: number; runtime_key_matches: boolean; profile_matches: boolean; session_matches: boolean }[];
      },
      capture: async (): Promise<string> => {
        return (await browserDocker(['exec', '--user', 'node', '--env', `TMUX_TMPDIR=${bound.state}`, name, '/usr/bin/tmux', '-L', TMUX_SOCKET, 'capture-pane', '-p', '-J', '-S', '-2000', '-t', `cauce-${key}:agente`])).stdout;
      } };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
    await writeFile(join(evidence, `${harness}-startup-error.txt`), browserErrorStderr(error));
    await writeFile(join(evidence, `${harness}-launcher.log`), launcherLog);
    if (binding && harness !== 'openclaw') {
      const native = lastNative || await browserDocker(['exec', '--user', 'node', '--env', `TMUX_TMPDIR=${binding.state}`, name,
        '/usr/bin/tmux', '-L', TMUX_SOCKET, 'capture-pane', '-p', '-J', '-S', '-100', '-t', `cauce-${key}:agente`]).then(value => value.stdout, () => 'native pane unavailable');
      await writeFile(join(evidence, `${harness}-startup-native.txt`), /sign in|log in|device.code|user.code|https:\/\/.*auth/iu.test(native) ? '[authorization prompt omitted]' : native);
    }
    } catch (diagnostic) { failures.push(diagnostic); }
    try { await close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'V4 runtime startup failed');
    throw error;
  }
}
