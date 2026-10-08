import { createHash } from 'node:crypto';
import * as files from 'node:fs/promises';
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLoginPins, createProviderLogin, cleanupProviderLogin, readPrivateJson, type ProviderLoginConfig } from './provider-login.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof files>(); return { ...actual, open: vi.fn(actual.open) };
});
const operationId = '74000000-0000-4000-8000-000000000001';
const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of temporary) await rm(path, { recursive: true, force: true }); temporary.length = 0; });
function zeroHash(size: number): string {
  const hash = createHash('sha256'); const block = Buffer.alloc(65_536);
  for (let remaining = size; remaining > 0; remaining -= block.length) hash.update(block.subarray(0, Math.min(remaining, block.length)));
  return hash.digest('hex');
}
async function fixture(mode = 'verified'): Promise<ProviderLoginConfig> {
  const root = await mkdtemp(join(tmpdir(), 'provider-login-test-')); temporary.push(root);
  const executable = join(root, 'helper.py');
  await writeFile(executable, `import sys,json,base64,os\nmode=${JSON.stringify(mode)}\nif '--cleanup' in sys.argv:\n op=sys.argv[2]\n print(json.dumps({'stopped_verified':mode!='unverified'}),flush=True)\n sys.exit(0)\npacket=json.loads(sys.stdin.readline())\nop=packet['operation_id']\nif mode=='private-error':\n print('PRIVATE_HELPER_ERROR',file=sys.stderr)\n sys.exit(1)\nif mode=='oversized':\n print('x'*200000,flush=True)\n sys.exit(0)\nstarted={'type':'started','operation_id':op,'pid':os.getpid(),'start_ticks':'100','runtime_uid':1000,'backend':'native'}\nif mode=='container': started.update(backend='container',container_id=packet['container_binding']['container_id'])\nprint(json.dumps(started),flush=True)\nfor line in sys.stdin:\n control=json.loads(line)\n if control['type']=='input':\n  print(json.dumps({'type':'output','data':control['data']}),flush=True)\n if control['type']=='close':\n  print(json.dumps({'type':'exited','operation_id':op,'exit_code':0,'stopped_verified':mode!='unverified'}),flush=True)\n  break\n`, { mode: 0o700 });
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  return { python: '/usr/bin/python3', helper: { executable, sha256 }, stateRoot: root, method: 'device',
    startTimeoutMs: 1000, stopTimeoutMs: 1000,
    packet: { operation_id: operationId, command: ['/usr/bin/true'], runtime_user: 'dev', home: '/home/dev', cwd: '/home/dev',
      env: { HOME: '/home/dev' }, backend: 'native', state_root: root, account_scope: 'test-account' } };
}
describe('private provider login transport', () => {
  it.each(['normal', 'crash'])('runs actual native PTY and %s cleanup with exact runtime user', async mode => {
    const user = userInfo(); const root = await mkdtemp(join(user.homedir, 'provider-login-native-')); temporary.push(root);
    const helper = fileURLToPath(new URL('../../../../ops/cli/provider-login.py', import.meta.url)); const python = await realpath('/usr/bin/python3');
    const worker = join(root, 'worker.py');
    await writeFile(worker, `import os,sys,termios,time\na=termios.tcgetattr(0);a[3]&=~termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,a)\nprint('NATIVE_READY',os.getuid(),sys.stdin.isatty(),flush=True)\nprint('DIRECTORIES',os.environ['HOME'],os.getcwd(),flush=True)\nline=sys.stdin.readline();print('INPUT_BYTES',len(line.strip()),flush=True)\ntime.sleep(60)\n`, { mode: 0o700 });
    const hash = async (filename: string) => createHash('sha256').update(await readFile(filename)).digest('hex');
    const config: ProviderLoginConfig = { python, helper: { executable: helper, sha256: await hash(helper) }, stateRoot: root, method: 'terminal',
      stopTimeoutMs: 10_000, packet: { operation_id: operationId, command: [python, worker], command_sha256: await hash(python),
        command_files: { [worker]: await hash(worker) }, runtime_user: user.username, home: root, cwd: root,
        env: { PATH: '/usr/bin:/bin' }, backend: 'native', state_root: root, account_scope: 'fixture-account' } };
    const login = await createProviderLogin(config, new AbortController().signal); let output = '';
    login.subscribeOutput(bytes => { output += Buffer.from(bytes).toString(); });
    const until = async (marker: string) => {
      if (output.includes(marker)) return;
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('actual PTY output absent')); }, 5000);
        const unsubscribe = login.subscribeOutput(() => { if (output.includes(marker)) { clearTimeout(timer); unsubscribe(); accept(); } });
      });
    };
    try {
      await login.start(); await until('NATIVE_READY'); expect(output).toContain(`NATIVE_READY ${user.uid.toString()} True`);
      await until('DIRECTORIES'); expect(output).toContain(`DIRECTORIES ${root} ${root}`);
      await login.write(Buffer.from('TRANSIENT_PRIVATE_FIXTURE\n')); await until('INPUT_BYTES'); await login.resize(99, 33);
      const filename = join(root, operationId + '.json'); const saved = await readFile(filename, 'utf8');
      expect(saved).not.toContain('TRANSIENT_PRIVATE_FIXTURE'); expect(saved).not.toContain(worker);
      const metadata = z.object({ controller: z.object({ pid: z.number().int().positive() }),
        processes: z.array(z.object({ pid: z.number().int().positive() })) }).loose().parse(JSON.parse(saved));
      if (mode === 'crash') process.kill(metadata.controller.pid, 'SIGKILL');
      expect(await login.close()).toEqual({ stopped: true });
      await expect(stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const child of metadata.processes) await expect(stat(`/proc/${child.pid.toString()}`)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await cleanupProviderLogin(config, operationId, new AbortController().signal)).toEqual({ stopped: true });
    } finally { await login.close(); }
  }, 20_000);
  it('starts only from a matching proof and carries transient bounded bytes until an observed close', async () => {
    const config = await fixture(); const login = await createProviderLogin(config, new AbortController().signal);
    let output = ''; const received = new Promise<void>(resolve => login.subscribeOutput(bytes => { output += Buffer.from(bytes).toString(); resolve(); }));
    await login.start(); await login.write(Buffer.from('synthetic-transient-input')); await received;
    expect(output).toBe('synthetic-transient-input'); expect(login.method).toBe('device');
    await login.resize(80, 24); expect(await login.close()).toEqual({ stopped: true });
    expect(await login.close()).toEqual({ stopped: true });
  });
  it('requires a stop proof even when helper exits with code zero', async () => {
    const config = await fixture('unverified'); const login = await createProviderLogin(config, new AbortController().signal);
    await login.start(); expect(await login.close()).toEqual({ stopped: false });
    expect(await cleanupProviderLogin(config, operationId, new AbortController().signal)).toEqual({ stopped: false });
  });
  it('rejects a changed helper pin before starting a process', async () => {
    const config = await fixture(); await writeFile(config.helper.executable, '# changed synthetic helper\n');
    await expect(createProviderLogin(config, new AbortController().signal)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
  it.each([286_750_056, 289_101_384, 536_870_912])('accepts a correctly pinned binary of %i bytes using bounded reads', async size => {
    const config = await fixture(); const filename = join(config.stateRoot, 'public-cli');
    const file = await files.open(filename, 'wx', 0o700);
    try { await file.truncate(size); } finally { await file.close(); }
    await expect(assertLoginPins({ [filename]: zeroHash(size) })).resolves.toBeUndefined();
    await expect(assertLoginPins({ [filename]: '0'.repeat(64) })).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  }, 15_000);
  it('rejects binaries above 512 MiB even with a matching hash', async () => {
    const config = await fixture(); const filename = join(config.stateRoot, 'public-cli'); const size = 536_870_913;
    const file = await files.open(filename, 'wx', 0o700);
    try { await file.truncate(size); } finally { await file.close(); }
    await expect(assertLoginPins({ [filename]: zeroHash(size) })).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  }, 15_000);
  it('rejects growth past the bound after the initial file-size observation and closes the handle', async () => {
    const config = await fixture(); const filename = join(config.stateRoot, 'growing-public-cli');
    const file = await files.open(filename, 'wx+', 0o700); const initial = await file.stat(); const size = 536_870_913;
    await file.truncate(size); vi.spyOn(file, 'stat').mockResolvedValue(initial);
    const close = vi.spyOn(file, 'close'); vi.mocked(files.open).mockResolvedValueOnce(file);
    await expect(assertLoginPins({ [filename]: zeroHash(size) })).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(close).toHaveBeenCalledOnce();
  }, 15_000);
  it('rechecks the pinned native login command immediately before starting', async () => {
    const config = await fixture(); const command = join(config.stateRoot, 'command');
    await writeFile(command, 'synthetic original', { mode: 0o700 });
    config.packet.command = [command]; config.packet.command_sha256 = createHash('sha256').update(await readFile(command)).digest('hex');
    const login = await createProviderLogin(config, new AbortController().signal);
    await writeFile(command, 'synthetic substitute');
    await expect(login.start()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(await login.close()).toEqual({ stopped: true });
  });
  it('rejects a helper start receipt for the wrong backend or container identity', async () => {
    const config = await fixture(); config.packet.backend = 'container'; config.packet.container_binding = { container_id: 'a'.repeat(64),
      generation: 'b'.repeat(64), image_digest: 'sha256:' + 'c'.repeat(64), python: '/usr/bin/python3', helper: '/cauce/executor/provider-login.py' };
    const login = await createProviderLogin(config, new AbortController().signal);
    await expect(login.start()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' }); await login.close();
  });
  it('accepts the Python container started frame only with the exact immutable container ID', async () => {
    const config = await fixture('container'); config.packet.backend = 'container'; config.packet.container_binding = { container_id: 'a'.repeat(64),
      generation: 'b'.repeat(64), image_digest: 'sha256:' + 'c'.repeat(64), python: '/usr/bin/python3', helper: '/cauce/executor/provider-login.py' };
    const login = await createProviderLogin(config, new AbortController().signal);
    await login.start(); expect(await login.close()).toEqual({ stopped: true });
    expect(await cleanupProviderLogin(config, operationId, new AbortController().signal)).toEqual({ stopped: true });
  });
  it.each(['private-error', 'oversized'])('rejects %s output without reflecting stdout or stderr', async mode => {
    const config = await fixture(mode); const login = await createProviderLogin(config, new AbortController().signal);
    await expect(login.start()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    await login.close();
  });
  it('cleans up a prior operation with a matching verified receipt after restart', async () => {
    const config = await fixture();
    expect(await cleanupProviderLogin(config, operationId, new AbortController().signal)).toEqual({ stopped: true });
  });
  it('does not launch a process after cancellation or accept oversized channel input', async () => {
    const config = await fixture(); const abort = new AbortController(); abort.abort();
    await expect(createProviderLogin(config, abort.signal)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    const login = await createProviderLogin(config, new AbortController().signal); await login.start();
    await expect(login.write(Buffer.alloc(4097))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(login.resize(0, 0)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await login.close();
  });
  it('loads policy only from a private regular file without reflecting malformed private contents', async () => {
    const config = await fixture(); const path = join(config.stateRoot, 'policy.json');
    await writeFile(path, '{"allowed":true}', { mode: 0o600 }); expect(await readPrivateJson(path)).toEqual({ allowed: true });
    await chmod(path, 0o644); await expect(readPrivateJson(path)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    await chmod(path, 0o600); await writeFile(path, 'PRIVATE_POLICY_MALFORMED');
    await expect(readPrivateJson(path)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
  it('rejects symlink and multiply linked private policies', async () => {
    const config = await fixture(); const filename = join(config.stateRoot, 'policy.json');
    await writeFile(filename, '{}', { mode: 0o600 }); const redirect = join(config.stateRoot, 'redirect');
    await symlink(filename, redirect); await expect(readPrivateJson(redirect)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    await link(filename, join(config.stateRoot, 'hardlink')); await expect(readPrivateJson(filename)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
});
