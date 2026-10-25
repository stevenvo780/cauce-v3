import { describe, expect, test } from 'vitest';
import { cdpUpstream, deviceNumbersAreComparable, mountedSocketMatches, type PrivateSocketView } from '../e2e/browser-socket-identity.js';
import { labTcpTarget } from '../e2e/lab-private-socket.js';
import { BROWSER_DOCKER_TIMEOUT_MS, BROWSER_IMAGE_CLEANUP_TIMEOUT_MS, removeOwnedBrowserImage } from '../e2e/browser-owned-lifecycle.js';

const identity = { uid: 1000, ino: 3757023, dev: 69 };
const forwarded = 'unix:///run/user/1000/docker-lab.sock';

function view(overrides: Partial<PrivateSocketView> = {}): PrivateSocketView {
  return { socket: true, mode: 0o600, uid: identity.uid, ino: identity.ino, dev: 36, ...overrides };
}

describe('mounted private browser socket', () => {
  test('skips the device number only when the daemon is the forwarded docker-lab socket', () => {
    expect(deviceNumbersAreComparable(forwarded)).toBe(false);
    expect(deviceNumbersAreComparable('unix:///var/run/docker.sock')).toBe(true);
    expect(deviceNumbersAreComparable(undefined)).toBe(true);
    expect(mountedSocketMatches(view(), identity, forwarded)).toBe(true);
    expect(mountedSocketMatches(view(), identity, 'unix:///var/run/docker.sock')).toBe(false);
    expect(mountedSocketMatches(view(), identity, undefined)).toBe(false);
  });

  test('still requires a private socket, mode 0600, uid and inode when devices are not comparable', () => {
    expect(mountedSocketMatches(view({ socket: false }), identity, forwarded)).toBe(false);
    expect(mountedSocketMatches(view({ mode: 0o666 }), identity, forwarded)).toBe(false);
    expect(mountedSocketMatches(view({ uid: 0 }), identity, forwarded)).toBe(false);
    expect(mountedSocketMatches(view({ ino: identity.ino + 1 }), identity, forwarded)).toBe(false);
  });

  test('rejects an inode collision across devices when the daemon is local', () => {
    expect(mountedSocketMatches(view({ dev: identity.dev }), identity, undefined)).toBe(true);
    expect(mountedSocketMatches(view({ dev: identity.dev + 1 }), identity, 'unix:///var/run/docker.sock')).toBe(false);
  });

  test('publishes CDP on the container address unless a VM tunnel reserved a loopback port', () => {
    expect(cdpUpstream('10.201.4.2', undefined)).toEqual({ host: '10.201.4.2', port: 9223 });
    expect(cdpUpstream('10.201.4.2', 38111)).toEqual({ host: '127.0.0.1', port: 38111 });
    expect(() => cdpUpstream('10.201.4.2', 0)).toThrow(/tunnel port/);
    expect(labTcpTarget('10.201.4.2', 9223)).toBe('10.201.4.2:9223');
    expect(() => labTcpTarget('10.201.4.2:9223', 9223)).toThrow(/IPv4/);
    expect(() => labTcpTarget('docker-lab', 9223)).toThrow(/IPv4/);
    expect(() => labTcpTarget('10.201.4.2', 65536)).toThrow(/tcp port/);
  });
});

const browserImage = { image: 'cauce-ui-functional:00000000-0000-4000-8000-000000000001', imageId: `sha256:${'a'.repeat(64)}`, owned: true,
  container: { id: 'c'.repeat(64), owner: '00000000-0000-4000-8000-000000000002' } };

function imageRemovalHarness() {
  const state = { tag: `${browserImage.imageId} ui-functional` as string | undefined, containerPresent: false, now: 0,
    remove: () => { state.tag = undefined; } };
  const calls: { args: string[]; timeout: number | undefined }[] = [];
  const docker = (args: string[], options?: { timeout: number }) => {
    calls.push({ args, timeout: options?.timeout });
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (state.tag === undefined) return Promise.reject(Object.assign(new Error('absent'), {
        code: 1, stderr: `Error response from daemon: No such image: ${browserImage.image}`,
      }));
      return Promise.resolve({ stdout: state.tag });
    }
    if (args[0] === 'inspect') {
      if (!state.containerPresent) return Promise.reject(Object.assign(new Error('absent'), {
        code: 1, stderr: `Error response from daemon: No such container: ${browserImage.container.id}`,
      }));
      return Promise.resolve({ stdout: `${browserImage.container.id} ${browserImage.imageId} ${browserImage.container.owner} ui-functional` });
    }
    if (args[0] === 'image' && args[1] === 'rm') {
      try { state.remove(); return Promise.resolve({ stdout: '' }); }
      catch (error) { return Promise.reject(error instanceof Error ? error : new Error('image removal failed', { cause: error })); }
    }
    return Promise.reject(new Error(`unexpected Docker command: ${args.join(' ')}`));
  };
  return { state, calls, docker, timing: { now: () => state.now, wait: (ms: number) => { state.now += ms; return Promise.resolve(); } } };
}

describe('owned Chromium image cleanup', () => {
  test('reconciles a cancelled CLI when the exact tag has already disappeared', async () => {
    const harness = imageRemovalHarness();
    harness.state.remove = () => { harness.state.tag = undefined; throw new Error('context canceled'); };
    await removeOwnedBrowserImage(harness.docker, browserImage, harness.timing);
    const removals = harness.calls.filter(call => call.args[1] === 'rm');
    expect(removals).toHaveLength(1);
    expect(removals[0]?.timeout).toBeGreaterThan(BROWSER_DOCKER_TIMEOUT_MS);
    expect(harness.calls.findIndex(call => call.args[0] === 'inspect')).toBeLessThan(harness.calls.findIndex(call => call.args[1] === 'rm'));
  });

  test('retries a cancelled removal only after confirming the same tag identity again', async () => {
    const harness = imageRemovalHarness();
    let attempts = 0;
    harness.state.remove = () => {
      attempts += 1;
      if (attempts === 1) throw new Error('context canceled');
      harness.state.tag = undefined;
    };
    await removeOwnedBrowserImage(harness.docker, browserImage, harness.timing);
    expect(attempts).toBe(2);
    expect(harness.state.now).toBeGreaterThan(0);
    expect(harness.calls.filter(call => call.args[0] === 'inspect')).toHaveLength(2);
  });

  test('refuses a reassigned tag after cancellation and refuses a different owner', async () => {
    const harness = imageRemovalHarness();
    harness.state.remove = () => { harness.state.tag = `sha256:${'b'.repeat(64)} ui-functional`; throw new Error('context canceled'); };
    await expect(removeOwnedBrowserImage(harness.docker, browserImage, harness.timing)).rejects.toThrow(/changed identity\/ownership/u);
    expect(harness.calls.filter(call => call.args[1] === 'rm')).toHaveLength(1);
    const foreign = imageRemovalHarness();
    foreign.state.tag = `${browserImage.imageId} somebody-else`;
    await expect(removeOwnedBrowserImage(foreign.docker, browserImage, foreign.timing)).rejects.toThrow(/changed identity\/ownership/u);
    expect(foreign.calls.some(call => call.args[1] === 'rm')).toBe(false);
  });

  test('waits within a fixed budget and never removes the tag while its exact owned container still exists', async () => {
    const harness = imageRemovalHarness();
    harness.state.containerPresent = true;
    await expect(removeOwnedBrowserImage(harness.docker, browserImage, harness.timing)).rejects.toThrow(/cleanup remains unresolved/u);
    expect(harness.state.now).toBe(BROWSER_IMAGE_CLEANUP_TIMEOUT_MS);
    expect(harness.calls.some(call => call.args[1] === 'rm')).toBe(false);
    expect(harness.calls.find(call => call.args[0] === 'inspect')?.args.at(-1)).toBe(browserImage.container.id);
    expect(harness.calls.some(call => call.args[0] === 'ps')).toBe(false);
  });

  test('stops after two failed attempts and never touches a borrowed image', async () => {
    const harness = imageRemovalHarness();
    harness.state.remove = () => { throw new Error('context canceled'); };
    await expect(removeOwnedBrowserImage(harness.docker, browserImage, harness.timing)).rejects.toThrow(/remains after cleanup/u);
    expect(harness.calls.filter(call => call.args[1] === 'rm')).toHaveLength(2);
    const borrowed = imageRemovalHarness();
    await removeOwnedBrowserImage(borrowed.docker, { ...browserImage, owned: false }, borrowed.timing);
    expect(borrowed.calls).toHaveLength(0);
  });
});
