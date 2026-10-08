import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLegacyAdoptionProbe } from './legacy-adoption-probe.js';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
const target = { tenant_id: 'acme', alias: 'iza' };
const facts = { source: 'measured', target, runtime_key: 'iza', harness_id: 'codex',
  placement: { host_id: 'local', mode: 'native', runtime_user: 'stev', home_directory: '/home/stev', state_directory: '/home/stev/state' },
  primary_account_id: null, account_provider: null, account_binding_approved: false,
  physical_identity_sha256: 'a'.repeat(64), supervisor_fenced: true };
async function fixture(response: unknown = facts) {
  const directory = await mkdtemp(`${tmpdir()}/cauce-adoption-probe-`); temporary.push(directory);
  const script = `${directory}/probe.py`; const log = `${directory}/log`;
  await writeFile(script, `import sys,json\nlog=${JSON.stringify(log)}\nfacts=json.loads(${JSON.stringify(JSON.stringify(response))})\nfor line in sys.stdin:\n r=json.loads(line)\n with open(log,'a') as f: f.write(r['action']+'\\n')\n print(json.dumps({'id':r['id'],'ok':True,**({'facts':facts} if r['action']=='measure' else {})}),flush=True)\n if r['action']=='release': break\n`);
  return { log, probe: createLegacyAdoptionProbe([{ hostId: 'local', targets: [target], python: '/usr/bin/python3', executable: script, policyFile: `${directory}/policy`, timeoutMs: 2000 }]) };
}

describe('legacy physical adoption bridge', () => {
  it('holds the process session through callback completion and releases on success', async () => {
    const { log, probe } = await fixture();
    let completed = false;
    const value = await probe.withSupervisorFence([target], async fence => {
      expect(await fence.measure(target)).toEqual(facts);
      await fence.assertHeld();
      expect(await readFile(log, 'utf8')).not.toContain('release');
      await new Promise(resolve_ => setTimeout(resolve_, 20));
      completed = true;
      return 17;
    });
    expect(completed).toBe(true); expect(value).toBe(17);
    expect(await readFile(log, 'utf8')).toBe('acquire\nmeasure\nassert\nrelease\n');
  });
  it('releases on callback failure and rejects use after its lifetime', async () => {
    const { log, probe } = await fixture();
    let after: (() => Promise<void>) | undefined;
    await expect(probe.withSupervisorFence([target], async fence => {
      after = () => fence.assertHeld();
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await readFile(log, 'utf8')).toBe('acquire\nrelease\n');
    await expect(after?.()).rejects.toThrow('unavailable');
  });
  it('rejects unsupported targets, duplicate mappings and mismatched physical facts', async () => {
    const { probe } = await fixture({ ...facts, target: { ...target, alias: 'other' } });
    await expect(probe.withSupervisorFence([target], fence => fence.measure(target))).rejects.toThrow('unavailable');
    await expect(probe.withSupervisorFence([{ ...target, alias: 'missing' }], async () => true)).rejects.toThrow('unavailable');
    expect(() => createLegacyAdoptionProbe([{ hostId: 'local', targets: [target, target], python: '/usr/bin/python3', executable: '/tmp/probe', policyFile: '/tmp/policy' }])).toThrow();
    const unavailablePython = createLegacyAdoptionProbe([{ hostId: 'local', targets: [target], python: '/unavailable-cauce-python', executable: '/tmp/probe', policyFile: '/tmp/policy', timeoutMs: 100 }]);
    await expect(unavailablePython.withSupervisorFence([target], async () => true)).rejects.toThrow('unavailable');
  });
  it('keeps a failed measurement session alive until callback rollback completes', async () => {
    const directory = await mkdtemp(`${tmpdir()}/cauce-adoption-failed-`); temporary.push(directory);
    const script = `${directory}/probe.py`; const log = `${directory}/log`;
    await writeFile(script, `import sys,json\nlog=${JSON.stringify(log)}\nfor line in sys.stdin:\n r=json.loads(line)\n with open(log,'a') as f: f.write(r['action']+'\\n')\n print(json.dumps({'id':r['id'],'ok':r['action']!='measure'}),flush=True)\n`);
    const probe = createLegacyAdoptionProbe([{ hostId: 'local', targets: [target], python: '/usr/bin/python3', executable: script, policyFile: '/tmp/policy', timeoutMs: 2000 }]);
    await expect(probe.withSupervisorFence([target], async fence => {
      await expect(fence.measure(target)).rejects.toThrow('unavailable');
      await new Promise(resolve_ => setTimeout(resolve_, 20));
      expect(await readFile(log, 'utf8')).not.toContain('release');
      throw new Error('transaction rolled back');
    })).rejects.toThrow('transaction rolled back');
    expect(await readFile(log, 'utf8')).toBe('acquire\nmeasure\nrelease\n');
  });
  it('opens the real Python socket/OFD fence and keeps it until the callback returns', async () => {
    const cwd = resolve(import.meta.dirname, '../../../..');
    const source = `import sys,json\nfrom ops.tests.test_fleet_legacy_supervisor_fence import LegacySupervisorFenceTests\nt=LegacySupervisorFenceTests()\nt.setUp()\ntry:\n print(json.dumps({'policy':str(t.policy),'locks':str(t.lock_root),'control':str(t.control)}),flush=True)\n sys.stdin.readline()\nfinally: t.tearDown()\n`;
    const child: ChildProcessWithoutNullStreams = spawn('/usr/bin/python3', ['-B', '-c', source], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    try {
      const [chunk] = await once(child.stdout, 'data') as [Buffer];
      const details = JSON.parse(chunk.toString('utf8')) as { policy: string; locks: string; control: string };
      const probe = createLegacyAdoptionProbe([{ hostId: 'local', targets: [target], python: '/usr/bin/python3',
        executable: `${cwd}/ops/cli/fleet-adoption-probe.py`, policyFile: details.policy, timeoutMs: 5000 }]);
      await probe.withSupervisorFence([target], async fence => {
        const measured = await fence.measure(target);
        expect(measured).toMatchObject({ source: 'measured', supervisor_fenced: true, primary_account_id: null });
        const check = spawn('/usr/bin/python3', ['-c', "import os,sys,fcntl;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)", `${details.control}/cauce-v3-adoption.guard`]);
        check.stderr.resume();
        const [status] = await once(check, 'exit') as [number | null]; expect(status).not.toBe(0);
        await fence.assertHeld();
      });
    } finally {
      child.stdin.end('\n');
      await once(child, 'exit');
    }
  }, 15_000);
  it('retains physical custody after helper SIGKILL until callback completion and nonce recovery', async () => {
    const cwd = resolve(import.meta.dirname, '../../../..');
    const source = `import sys,json\nfrom ops.tests.test_fleet_legacy_supervisor_fence import LegacySupervisorFenceTests\nt=LegacySupervisorFenceTests()\nt.setUp()\ntry:\n print(json.dumps({'policy':str(t.policy),'control':str(t.control),'command':str(t.command),'home':str(t.home)}),flush=True)\n sys.stdin.readline()\nfinally: t.tearDown()\n`;
    const child = spawn('/usr/bin/python3', ['-B', '-c', source], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    let stop: ChildProcessWithoutNullStreams | undefined;
    const run = async (script: string, arguments_: string[]) => {
      const process_ = spawn('/usr/bin/python3', ['-B', '-c', script, ...arguments_]);
      process_.stderr.resume();
      const [status] = await once(process_, 'exit') as [number | null];
      return status;
    };
    try {
      const [chunk] = await once(child.stdout, 'data') as [Buffer];
      const details = JSON.parse(chunk.toString('utf8')) as { policy: string; control: string; command: string; home: string };
      const executable = `${cwd}/ops/cli/fleet-adoption-probe.py`;
      const probe = createLegacyAdoptionProbe([{ hostId: 'local', targets: [target], python: '/usr/bin/python3',
        executable, policyFile: details.policy, timeoutMs: 5000 }]);
      const value = await probe.withSupervisorFence([target], async fence => {
        await fence.measure(target); await fence.assertHeld();
        const kill = "import pathlib,os,signal,sys\np=[]\nfor x in pathlib.Path('/proc').iterdir():\n try:\n  arguments=(x/'cmdline').read_bytes().split(b'\\0')\n  raw=(x/'stat').read_text();parent=raw[raw.rfind(')')+2:].split()[1]\n  if parent==sys.argv[2] and sys.argv[1].encode() in arguments and b'--step' in arguments: p.append(int(x.name))\n except (OSError,ValueError): pass\nassert len(p)==1,p\nos.kill(p[0],signal.SIGKILL)";
        expect(await run(kill, [details.policy, String(process.pid)])).toBe(0);
        stop = spawn('/usr/bin/python3', ['-B', executable, 'control', '--policy', details.policy, '--runtime-key', 'iza',
          '--', details.command, 'stop', 'iza'], { env: { ...process.env, HOME: details.home, CAUCE_ADOPTION_PROBE_POLICY_FILE: details.policy }, stdio: ['pipe', 'pipe', 'pipe'] });
        stop.stderr.resume();
        await new Promise(resolve_ => setTimeout(resolve_, 150));
        expect(await run('import os,sys,fcntl;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)', [`${details.control}/cauce-v3-adoption.guard`])).not.toBe(0);
        expect(stop.exitCode).toBeNull();
        expect(JSON.parse(await readFile(`${details.control}/cauce-v3-adapter.json`, 'utf8'))).toMatchObject({ phase: 'running' });
        return 42;
      });
      expect(value).toBe(42);
      if (stop?.exitCode === null) await once(stop, 'exit');
      expect(stop?.exitCode).toBe(0);
    } finally {
      stop?.kill('SIGTERM');
      child.stdin.end('\n'); await once(child, 'exit');
    }
  }, 15_000);
});
