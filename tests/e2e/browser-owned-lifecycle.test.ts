import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ownedBrowserLifecycle, browserResourcesRetained, type BrowserDescriptor } from './browser-owned-lifecycle.js';

const cid = 'a'.repeat(64);
let descriptor: BrowserDescriptor;
let server: Server;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'blc-'));
  await chmod(directory, 0o700);
  server = createServer((socket) => { socket.destroy(); });
  const socket = join(directory, 'proxy.sock');
  await new Promise<void>((resolve) => { server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  descriptor = { name: `cauce-ui-browser-${randomUUID()}`, owner: randomUUID(), imageId: `sha256:${'b'.repeat(64)}`,
    networkName: 'own-network', networkId: 'own-network-id', networkOwner: randomUUID(), directory, socketIdentity: await lstat(socket) };
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  await rmdir(directory);
});

function daemon() {
  let visible = false;
  let state = 'created';
  let owner = descriptor.owner;
  let securityOpt: string[] | null = null;
  let createError = false;
  let startError = false;
  let removing = false;
  let exitedBeforeRemoval = false;
  let foreignNetwork = false;
  let changeNetworkAfterCreate = false;
  let linger = false;
  let stopBehavior = 'normal';
  let stopFailure: Error | undefined;
  let inspectFailureAfterStop = false;
  let ticks = 0;
  const commands: string[][] = [];
  const view = () => ({ id: cid, name: `/${descriptor.name}`, image: descriptor.imageId, owner, cohort: 'ui-functional',
    user: '', privileged: false, securityOpt, capAdd: null, capDrop: null, networkMode: descriptor.networkName, mounts: [{ Type: 'bind', Source: directory, Destination: '/qa-browser-transport', RW: false }],
    state: { Status: state, Pid: state === 'running' ? 1234 : 0 }, networks: state === 'created' ? {} : { [descriptor.networkName]: { NetworkID: descriptor.networkId } } });
  const docker = async (args: string[], options?: { timeout: number }) => {
    commands.push(args);
    expect(options?.timeout).toBeGreaterThan(0);
    expect(options?.timeout).toBeLessThanOrEqual(15_000);
    if (args[0] === 'image') return { stdout: JSON.stringify({ id: descriptor.imageId, user: '' }) };
    if (args[0] === 'info') return { stdout: JSON.stringify(['name=selinux']) };
    if (args[0] === 'version') return { stdout: JSON.stringify({ version: '29.7.2', apiVersion: '1.55', minApiVersion: '1.40', os: 'linux', arch: 'amd64' }) };
    if (args[0] === 'network' && args[1] === 'inspect') return { stdout: JSON.stringify({ id: foreignNetwork ? 'foreign-network-id' : descriptor.networkId, name: descriptor.networkName, internal: true, owner: descriptor.networkOwner }) };
    if (args[0] === 'inspect') {
      if (inspectFailureAfterStop) {
        inspectFailureAfterStop = false;
        throw new Error('original CID inspection failure');
      }
      if (!visible) throw Object.assign(new Error('own absence'), { code: 1, stderr: `Error: No such object: ${args.at(-1) ?? ''}` });
      return { stdout: JSON.stringify(view()) };
    }
    if (args[0] === 'create') {
      if (createError) throw new Error('original CLI create timeout');
      visible = true;
      securityOpt = args.includes('--security-opt') ? ['label=disable'] : null;
      if (changeNetworkAfterCreate) foreignNetwork = true;
      return { stdout: cid };
    }
    if (args[0] === 'start') {
      if (startError) throw new Error('original CLI start timeout');
      state = 'running';
      return { stdout: descriptor.name };
    }
    if (args[0] === 'stop') {
      if (stopBehavior !== 'normal') {
        if (stopBehavior === 'not-found-removed') visible = false;
        if (stopBehavior === 'not-found-foreign-owner') owner = 'foreign';
        if (stopBehavior === 'inspect-fails') inspectFailureAfterStop = true;
        const reference = stopBehavior === 'not-found-wrong-reference' ? 'f'.repeat(64) : cid;
        stopFailure = Object.assign(new Error('original synthetic stop failure'), {
          code: stopBehavior === 'unknown' ? 125 : 1,
          stderr: stopBehavior === 'unknown' ? 'Error response from daemon: operation denied'
            : `Error response from daemon: No such container: ${reference}`,
        });
        if (stopBehavior === 'not-found-present') state = 'running';
        throw stopFailure;
      }
      state = exitedBeforeRemoval ? 'exited' : 'removing'; removing = true; return { stdout: cid };
    }
    if (args[0] === 'rm') { visible = false; return { stdout: cid }; }
    throw new Error('unexpected Docker operation');
  };
  return { docker, commands, timing: { now: () => ticks, wait: async (ms: number) => { ticks += ms; if (removing && !linger) visible = false; } },
    failCreate: () => { createError = true; }, failStart: () => { startError = true; },
    lateCreate: () => { visible = true; }, foreign: () => { owner = 'foreign'; }, visible: () => visible,
    stayRemoving: () => { linger = true; }, elapsed: () => ticks,
    foreignSecurity: () => { securityOpt = ['seccomp=unconfined']; },
    foreignNetworkAfterCreate: () => { changeNetworkAfterCreate = true; }, foreignNetworkNow: () => { foreignNetwork = true; },
    exitBeforeAutoRemove: () => { exitedBeforeRemoval = true; },
    stopWith: (behavior: string) => { stopBehavior = behavior; }, stopFailure: () => stopFailure };
}
it('retains an absent namespace when the daemon creates after CLI cancellation and first cleanup inspection', async () => {
  const fake = daemon(); fake.failCreate();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await expect(owned.start()).rejects.toThrow('original CLI create timeout');
  const cleanupError = await owned.close().catch((error: unknown) => error);
  expect(browserResourcesRetained(cleanupError)).toBe(true);
  fake.lateCreate();
  expect(fake.visible()).toBe(true);
  expect(fake.commands.filter((args) => ['start', 'rm', 'stop'].includes(args[0] ?? ''))).toEqual([]);
  expect(owned.retained()).toBe(true);
});
it('does not retry admission and cleans the known created CID after a start timeout', async () => {
  const fake = daemon(); fake.failStart();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await expect(owned.start()).rejects.toThrow('original CLI start timeout');
  await owned.close();
  expect(fake.commands.filter((args) => args[0] === 'create')).toHaveLength(1);
  expect(fake.commands.filter((args) => args[0] === 'start')).toEqual([['start', cid]]);
  expect(fake.commands.filter((args) => args[0] === 'rm')).toEqual([['rm', cid]]);
  expect(owned.retained()).toBe(false);
});

it.each(['owner', 'security'])('refuses deletion after the container changes %s despite the same name and CID', async (change) => {
  const fake = daemon();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await owned.start(); if (change === 'owner') fake.foreign(); else fake.foreignSecurity();
  await expect(owned.close()).rejects.toThrow('namespace and image retained');
  expect(fake.commands.filter((args) => ['rm', 'stop'].includes(args[0] ?? ''))).toEqual([]);
  expect(owned.retained()).toBe(true);
});

it.each([undefined, '1'])('waits for auto-removal with the declared security policy: %s', async (compatibility) => {
  const fake = daemon();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, compatibility === undefined ? {} : { CAUCE_E2E_BROWSER_SELINUX_COMPAT: compatibility });
  expect(await owned.start()).toBe(cid);
  await owned.close(); await owned.close();
  expect(fake.commands.filter((args) => args[0] === 'stop')).toEqual([['stop', '--time', '5', cid]]);
  expect(fake.commands.filter((args) => args[0] === 'rm')).toEqual([]);
  expect(fake.visible()).toBe(false);
  expect(owned.retained()).toBe(false);
  const create = fake.commands.find((args) => args[0] === 'create');
  expect(create).toContain('--pull=never');
  expect(create).toContain(descriptor.imageId);
  expect(create?.filter((arg) => arg === '--security-opt')).toHaveLength(compatibility === '1' ? 1 : 0);
  if (compatibility === '1') expect(create?.[create.indexOf('--security-opt') + 1]).toBe('label=disable');
  expect(create).not.toContain('--user');
  expect(owned.descriptor.securityOptions).toEqual(compatibility === '1' ? ['label=disable'] : []);
});
it('reports unresolved remote creation and never equates repeated absence with cancellation', async () => {
  const fake = daemon(); fake.failCreate();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await expect(owned.start()).rejects.toThrow('original CLI create timeout');
  await expect(owned.close()).rejects.toMatchObject({ cause: { message: 'CLI exit does not confirm remote create cancellation' } });
  expect(owned.retained()).toBe(true);
  expect(fake.commands.filter((args) => args[0] === 'create')).toHaveLength(1);
  expect(fake.commands.filter((args) => args[0] === 'start')).toEqual([]);
});
it('recovers the exact late-created resource without converting the initial error to a successful start', async () => {
  const fake = daemon(); fake.failCreate();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await expect(owned.start()).rejects.toThrow('original CLI create timeout');
  fake.lateCreate(); await owned.close();
  expect(fake.commands.filter((args) => args[0] === 'start')).toEqual([]);
  expect(fake.commands.filter((args) => args[0] === 'rm')).toEqual([['rm', cid]]);
  expect(owned.retained()).toBe(false);
});
it('bounds automatic removal verification and retains a namespace whose removal remains pending', async () => {
  const fake = daemon(); fake.stayRemoving();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await owned.start();
  await expect(owned.close()).rejects.toMatchObject({ cause: { message: 'Owned browser removal remains unresolved' } });
  expect(fake.elapsed()).toBe(15_000);
  expect(fake.commands.filter((args) => args[0] === 'rm')).toEqual([]);
  expect(owned.retained()).toBe(true);
});
it('refuses cleanup when the private transport no longer has the verified mode', async () => {
  const fake = daemon();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await owned.start(); await chmod(join(directory, 'proxy.sock'), 0o644);
  await expect(owned.close()).rejects.toMatchObject({ cause: { message: 'Owned browser socket identity changed' } });
  expect(fake.commands.filter((args) => ['rm', 'stop'].includes(args[0] ?? ''))).toEqual([]);
});
it('rejects a replaced network before start even when created has no allocated network map', async () => {
  const fake = daemon(); fake.foreignNetworkAfterCreate();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await expect(owned.start()).rejects.toThrow('Owned browser network identity changed');
  await expect(owned.close()).rejects.toThrow('namespace and image retained');
  expect(fake.commands.filter((args) => ['start', 'rm', 'stop'].includes(args[0] ?? ''))).toEqual([]);
  expect(owned.retained()).toBe(true);
});
it('retains the created resource if its network changes before destructive cleanup', async () => {
  const fake = daemon(); fake.failStart();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await expect(owned.start()).rejects.toThrow('original CLI start timeout');
  fake.foreignNetworkNow();
  await expect(owned.close()).rejects.toThrow('namespace and image retained');
  expect(fake.commands.filter((args) => ['rm', 'stop'].includes(args[0] ?? ''))).toEqual([]);
});
it('waits for auto-removal in exited state without racing another rm', async () => {
  const fake = daemon(); fake.exitBeforeAutoRemove();
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await owned.start(); await owned.close();
  expect(fake.commands.filter((args) => args[0] === 'stop')).toEqual([['stop', '--time', '5', cid]]);
  expect(fake.commands.filter((args) => args[0] === 'rm')).toEqual([]);
  expect(fake.visible()).toBe(false);
  expect(owned.retained()).toBe(false);
});
it('reconciles stop 404 only after the known CID is confirmed absent', async () => {
  const fake = daemon(); fake.stopWith('not-found-removed');
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await owned.start(); await owned.close();
  const inspectionsAfterStop = fake.commands.filter((args) => args[0] === 'inspect' && args.at(-1) === cid);
  expect(inspectionsAfterStop.length).toBeGreaterThanOrEqual(2);
  expect(fake.commands.filter((args) => args[0] === 'stop')).toEqual([['stop', '--time', '5', cid]]);
  expect(fake.visible()).toBe(false);
  expect(owned.retained()).toBe(false);
});

it.each([
  ['unknown stop error', 'unknown'],
  ['No such container for another reference', 'not-found-wrong-reference'],
  ['the known CID still present', 'not-found-present'],
  ['the known CID identity changed', 'not-found-foreign-owner'],
  ['inspection after stop fails', 'inspect-fails'],
])('retains resources when stop reconciliation is unsafe: %s', async (_label, behavior) => {
  const fake = daemon(); fake.stopWith(behavior);
  const owned = ownedBrowserLifecycle(fake.docker, descriptor, fake.timing, {});
  await owned.start();
  const error = await owned.close().catch((failure: unknown) => failure);
  expect(browserResourcesRetained(error)).toBe(true);
  expect((error as Error).cause).toBe(fake.stopFailure());
  expect(owned.retained()).toBe(true);
  expect(fake.commands.filter((args) => args[0] === 'stop')).toEqual([['stop', '--time', '5', cid]]);
});
