import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { connectXOuterDocker } from './v4-agentes-x-docker-isolation.js';

const execute = promisify(execFile);

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
  const outer = await connectXOuterDocker();
  const runner = outer.runner.runner;
  const owner = typeof runner === 'object' && runner !== null && 'owner' in runner ? runner.owner : undefined;
  if (typeof owner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/u.test(owner)
      || process.env.HOME?.startsWith(`/tmp/cauce-e2e-home-${owner}-`) !== true) {
    throw new Error('terminal purge requires the verified runner owner and its private HOME');
  }
  const run = randomUUID().slice(0, 8);
  const name = `zz-canary-${owner}-purge-${run}`;
  const helper = `${name}-cleanup`;
  const image = `${name}:local`;
  const snapshot = `/var/tmp/${name}-source`;
  const sourceRoot = await mkdtemp('/datos/zz-canary-purge-source-');
  const receipts = join(process.cwd(), '.delegados/v4/recibos', owner, 'purge-analysis', run);
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const labels = ['--label', `cauce.e2e.owner=${owner}`, '--label', `cauce.e2e.run=${run}`];
  const save = async (file: string, value: unknown) => writeFile(join(receipts, `${file}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await save('resources', { owner, run, name, helper, image, sourceRoot, snapshot, runner: outer.runner,
    legacy_inner_prefix: 'zz-canary-h7-trasladados-1025-' });
  let imageId: string | undefined, snapshotAttempted = false, computerAbsent = false;
  let snapshotRemoved = false, helperAbsent = false, imageAbsent = false, stderr = '';
  const innerResources: { scope: string; containerAbsent: boolean; volumesAbsent: boolean }[] = [];
  const packets = (prefix: string): unknown[] => [...stderr.matchAll(new RegExp(prefix + ' (\\{[^\\n]+\\})', 'gu'))].map(match => {
    try { return JSON.parse(match[1] ?? '{}') as unknown; } catch { return { malformed: true }; }
  });
  const failures: unknown[] = [];
  const owned = async (kind: 'container' | 'image', reference: string) => {
    const found = await outer.command([kind, 'inspect', '--format',
      '{{.Id}}\t{{index .Config.Labels "cauce.e2e.owner"}}\t{{index .Config.Labels "cauce.e2e.run"}}'
        + (kind === 'container' ? '\t{{.Image}}' : ''), reference]);
    if (found.code === 1 && /no such (?:object|image|container)/iu.test(found.stderr) && found.stderr.includes(reference)) return undefined;
    if (found.code !== 0) throw new Error(`terminal purge ${kind} identity could not be inspected`);
    const [id, actualOwner, actualRun, actualImage] = found.stdout.trim().split('\t');
    if (!id || actualOwner !== owner || actualRun !== run || imageId !== undefined
        && (kind === 'image' ? id !== imageId : actualImage !== imageId)) {
      throw new Error(`terminal purge ${kind} identity differs`);
    }
    return id;
  };
  const dockerfile = 'FROM docker:29-cli AS docker\nFROM python:3.12-slim\nCOPY --from=docker /usr/local/bin/docker /usr/bin/docker\n'
    + 'RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session openssl mount '
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
    await execute('docker', ['build', ...labels, '-t', image, '-f', source, receipts], { timeout: 240_000 });
    imageId = await owned('image', image);
    if (!imageId) throw new Error('terminal purge image was not observed after build');
    await execute('docker', ['run', '-d', '--name', name, ...labels, '--privileged', '--cgroupns=private',
      '--network', 'none', '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', `${sourceRoot}:${sourceRoot}:ro`,
      '-v', '/var/tmp:/var/tmp:rprivate', '-v', '/var/run/docker.sock:/var/run/docker.sock', imageId]);
    const containerId = await owned('container', name);
    await save('computer', { containerId, imageId });
    await ready(['exec', name, 'test', '-S', '/run/dbus/system_bus_socket']);
    snapshotAttempted = true;
    const copied = await execute('docker', ['exec', name, 'python3', '-I', '-B', '-c', `import json,os,pathlib,shutil,stat,sys
source,target=map(pathlib.Path,sys.argv[1:3]);owner,run=sys.argv[3:5]
if target.parent!=pathlib.Path('/var/tmp') or target.name!='zz-canary-'+owner+'-purge-'+run+'-source': raise SystemExit('snapshot path differs')
target.mkdir(mode=0o755)
identity=target.stat();marker={'owner':owner,'run':run,'device':identity.st_dev,'inode':identity.st_ino}
(target/'.purge-snapshot.json').write_text(json.dumps(marker))
for item in source.iterdir():
 destination=target/item.name
 if item.is_dir() and not item.is_symlink(): shutil.copytree(item,destination,copy_function=shutil.copyfile,symlinks=True)
 elif item.is_file() and not item.is_symlink(): shutil.copyfile(item,destination)
 else: raise SystemExit('snapshot source is not regular')
files=0;directories=0
for item in [target,*target.rglob('*')]:
 details=item.lstat()
 if stat.S_ISDIR(details.st_mode): item.chmod(0o755);directories+=1
 elif stat.S_ISREG(details.st_mode) and details.st_nlink==1: item.chmod(0o644);files+=1
 else: raise SystemExit('snapshot entry is not regular')
 if details.st_uid!=0: raise SystemExit('snapshot owner differs')
print(json.dumps({**marker,'path':str(target),'files':files,'directories':directories}))`, sourceRoot, snapshot, owner, run]);
    await save('source-snapshot', JSON.parse(copied.stdout) as unknown);
    await execute('docker', ['exec', name, 'mount', '--bind', snapshot, snapshot]);
    await execute('docker', ['exec', name, 'mount', '-o', 'remount,bind,ro', snapshot]);
    await execute('docker', ['exec', name, 'python3', '-I', '-B', '-c',
      'import os,sys;sys.exit(0 if os.statvfs(sys.argv[1]).f_flag&os.ST_RDONLY else 1)', snapshot]);
    await save('source-mount', { path: snapshot, read_only_verified: true });
    await execute('docker', ['exec', name, 'loginctl', 'enable-linger', 'cauce']);
    const group = (await execute('docker', ['exec', name, 'stat', '-c', '%g', '/var/run/docker.sock'])).stdout.trim();
    await execute('docker', ['exec', name, 'groupadd', '-g', group, 'fixture-docker']);
    await execute('docker', ['exec', name, 'usermod', '-aG', 'fixture-docker', 'cauce']);
    const args = ['exec', '--user', 'cauce', '--env', 'XDG_RUNTIME_DIR=/run/user/1500', '--env',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1500/bus', name];
    await ready([...args, 'systemctl', '--user', 'is-system-running']);
    let result: { stdout: string; stderr: string };
    try {
      result = await execute('docker', [...args, 'python3', '-I', '-B', join(snapshot, 'tests/e2e/v4-purga-terminal.fixture.py'), snapshot, image],
        { timeout: 300_000, maxBuffer: 1024 * 1024 });
      stderr = result.stderr;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string') stderr = error.stderr;
      throw error;
    }
    const evidence = JSON.parse(result.stdout) as Record<string, { after: string[]; replay_identical: boolean; relay_foreign_identity_preserved: boolean }>;
    expect(Object.keys(evidence)).toEqual(['container', 'native']);
    for (const row of Object.values(evidence)) {
      expect(row.after).toEqual(['inactive', 'inactive']); expect(row.replay_identical).toBe(true);
      expect(row.relay_foreign_identity_preserved).toBe(true);
    }
    await save('purge-terminal-evidence', evidence);
    console.info('TERMINAL_PURGE_EVIDENCE', JSON.stringify(evidence));
  } catch (error) {
    failures.push(error);
  } finally {
    for (const action of [async () => {
      const id = await owned('container', name);
      if (id) await execute('docker', ['rm', '-f', id]);
      computerAbsent = await owned('container', name) === undefined;
      expect(computerAbsent).toBe(true);
    }, async () => {
      if (!snapshotAttempted) return;
      if (!computerAbsent || !imageId) throw new Error('snapshot cleanup requires the stopped computer and its image');
      for (const packet of packets('PURGE_INNER_SCOPE')) {
        if (typeof packet !== 'object' || packet === null || !('scope' in packet) || typeof packet.scope !== 'string'
            || !/^zz-canary-h7-trasladados-1025-[a-f0-9]{12}$/u.test(packet.scope)) throw new Error('purge inner scope differs');
        const present = await outer.command(['ps', '-aq', '--filter', `name=^/${packet.scope}$`]);
        const volumes = await outer.command(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${packet.scope}-(state|provider-profiles)$`]);
        if (present.code !== 0 || volumes.code !== 0) throw new Error('purge inner resource absence could not be inspected');
        innerResources.push({ scope: packet.scope, containerAbsent: !present.stdout.trim(), volumesAbsent: !volumes.stdout.trim() });
      }
      if (innerResources.some(row => !row.containerAbsent || !row.volumesAbsent)) throw new Error('snapshot retained because child resources remain');
      await owned('image', image);
      await execute('docker', ['run', '-d', '--name', helper, ...labels, '--network', 'none', '-v', '/var/tmp:/var/tmp', imageId, 'sleep', 'infinity']);
      if (!await owned('container', helper)) throw new Error('snapshot cleanup helper is absent');
      await execute('docker', ['exec', helper, 'python3', '-I', '-B', '-c', `import json,pathlib,shutil,stat,sys
target=pathlib.Path(sys.argv[1]);owner,run=sys.argv[2:4]
if target.parent!=pathlib.Path('/var/tmp') or target.name!='zz-canary-'+owner+'-purge-'+run+'-source': raise SystemExit('snapshot path differs')
if target.exists() or target.is_symlink():
 details=target.lstat();marker=target/'.purge-snapshot.json'
 if not stat.S_ISDIR(details.st_mode) or details.st_uid!=0 or details.st_mode&0o022 or marker.is_symlink(): raise SystemExit('snapshot directory identity differs')
 expected={'owner':owner,'run':run,'device':details.st_dev,'inode':details.st_ino}
 if marker.stat().st_uid!=0 or json.loads(marker.read_text())!=expected: raise SystemExit('snapshot receipt differs')
 shutil.rmtree(target)
if target.exists() or target.is_symlink(): raise SystemExit('snapshot removal is not proven')`, snapshot, owner, run]);
      snapshotRemoved = true;
    }, async () => {
      const id = await owned('container', helper);
      if (id) await execute('docker', ['rm', '-f', id]);
      helperAbsent = await owned('container', helper) === undefined;
      expect(helperAbsent).toBe(true);
    }, async () => {
      const id = await owned('image', image);
      if (id) await execute('docker', ['image', 'rm', id]);
      imageAbsent = await owned('image', image) === undefined;
      expect(imageAbsent).toBe(true);
    }, async () => {
      if (!computerAbsent) throw new Error('source cleanup requires the stopped computer');
      await rm(sourceRoot, { recursive: true, force: true });
    }]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    try {
      await save('cleanup', { computerAbsent, helperAbsent, imageAbsent, snapshotRemoved, imageId, sourceRoot, snapshot,
        inner_scopes: packets('FLEET_ORPHAN_SWEEP'), inner_resources: innerResources,
        runtime_diagnostics: packets('PURGE_RUNTIME_DIAGNOSTIC'), failures: failures.map(error => error instanceof Error ? error.name : 'unknown') });
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'terminal purge or owned cleanup failed');
}, 600_000);
