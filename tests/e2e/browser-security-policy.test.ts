import { expect, it } from 'vitest';
import { ownedBrowserLifecycle, type BrowserDescriptor } from './browser-owned-lifecycle.js';
import { assertBrowserSecurity, browserSecurityOptions, resolveBrowserSecurity, type BrowserContainerSecurity, type BrowserDocker } from './browser-security-policy.js';

const imageId = `sha256:${'a'.repeat(64)}`;
const daemonVersion = { version: '29.7.2', apiVersion: '1.55', minApiVersion: '1.40', os: 'linux', arch: 'amd64' };
function daemon(overrides: { image?: unknown; capabilities?: unknown; version?: unknown } = {}) {
  const commands: string[][] = [];
  const docker: BrowserDocker = async (args) => {
    commands.push(args);
    if (args[0] === 'image') return { stdout: JSON.stringify(overrides.image ?? { id: imageId, user: 'node' }) };
    if (args[0] === 'info') return { stdout: JSON.stringify(overrides.capabilities ?? ['name=seccomp,profile=builtin', 'name=selinux']) };
    if (args[0] === 'version') return { stdout: JSON.stringify(overrides.version ?? daemonVersion) };
    throw new Error('Unexpected Docker mutation');
  };
  return { docker, commands };
}
const container: BrowserContainerSecurity = { user: 'node', privileged: false, securityOpt: null, capAdd: null, capDrop: null };

it('preserves the image default user without querying or overriding normal-host daemon security', async () => {
  const fake = daemon();
  const policy = await resolveBrowserSecurity(fake.docker, imageId, browserSecurityOptions({}));
  expect(policy).toEqual({ options: [], imageUser: 'node' });
  expect(fake.commands.map((args) => args.slice(0, 2))).toEqual([['image', 'inspect']]);
  expect(() => { assertBrowserSecurity(container, policy); }).not.toThrow();
  expect(() => { assertBrowserSecurity({ ...container, securityOpt: [], capAdd: [], capDrop: [] }, policy); }).not.toThrow();
  expect(Object.isFrozen(policy)).toBe(true);
  expect(Object.isFrozen(policy.options)).toBe(true);
});

it('admits only the explicit per-browser SELinux exception and records the actual public daemon version', async () => {
  const fake = daemon();
  const policy = await resolveBrowserSecurity(fake.docker, imageId, browserSecurityOptions({ CAUCE_E2E_BROWSER_SELINUX_COMPAT: '1' }));
  expect(policy).toEqual({ options: ['label=disable'], imageUser: 'node', daemon: daemonVersion });
  expect(fake.commands.map((args) => args[0])).toEqual(['image', 'info', 'version']);
  expect(Object.isFrozen(policy.daemon)).toBe(true);
  expect(() => { assertBrowserSecurity({ ...container, securityOpt: ['label=disable'] }, policy); }).not.toThrow();
  expect(() => { assertBrowserSecurity(container, policy); }).toThrow('security policy changed');
  expect(() => { assertBrowserSecurity({ ...container, securityOpt: ['label=disable', 'seccomp=unconfined'] }, policy); }).toThrow('security policy changed');
});

it.each(['', '0', 'true', 'false', ' 1', '1 ', 'label=disable', '1,seccomp=unconfined'])('rejects invalid compatibility input before any Docker command: %s', (value) => {
  expect(() => browserSecurityOptions({ CAUCE_E2E_BROWSER_SELINUX_COMPAT: value })).toThrow('absent or exactly 1');
});

it.each([{ options: ['seccomp=unconfined'] }, { options: ['label=disable', 'label=disable'] }, { options: ['label=disable', 'privileged'] }])('rejects an arbitrary security option list before querying Docker: %j', async ({ options }) => {
  const fake = daemon();
  await expect(resolveBrowserSecurity(fake.docker, imageId, options)).rejects.toThrow('not allowed');
  expect(fake.commands).toEqual([]);
});

it.each([{ capabilities: [] }, { capabilities: ['name=seccomp'] }, { capabilities: ['selinux'] }, { capabilities: 'name=selinux' }, { capabilities: {} }])('refuses SELinux compatibility without verified daemon support: %j', async ({ capabilities }) => {
  const fake = daemon({ capabilities });
  await expect(resolveBrowserSecurity(fake.docker, imageId, ['label=disable'])).rejects.toThrow('requires daemon SELinux support');
  expect(fake.commands.map((args) => args[0])).toEqual(['image', 'info']);
});

it.each([{ id: 'foreign', user: 'node' }, { id: imageId }, { id: imageId, user: 1000 }])('rejects unverifiable image identity or default user: %j', async (image) => {
  const fake = daemon({ image });
  await expect(resolveBrowserSecurity(fake.docker, imageId, [])).rejects.toThrow('default user cannot be verified');
});

it('rejects incomplete daemon version metadata instead of fabricating an attestation', async () => {
  const fake = daemon({ version: { ...daemonVersion, apiVersion: '' } });
  await expect(resolveBrowserSecurity(fake.docker, imageId, ['label=disable'])).rejects.toThrow('version cannot be verified');
});

it.each([
  { user: 'root' }, { privileged: true }, { privileged: undefined }, { capAdd: ['SYS_ADMIN'] }, { capDrop: ['NET_RAW'] },
  { capAdd: undefined }, { capDrop: undefined }, { securityOpt: ['seccomp=unconfined'] }, { securityOpt: undefined },
])('rejects actual privilege, user, capability or security drift: %j', async (drift) => {
  const fake = daemon();
  const policy = await resolveBrowserSecurity(fake.docker, imageId, []);
  expect(() => { assertBrowserSecurity({ ...container, ...drift }, policy); }).toThrow('security policy changed');
});

it('rejects inspection before the declared security policy is resolved', () => {
  expect(() => { assertBrowserSecurity(container, undefined); }).toThrow('policy is unresolved');
});

it('preserves a verified empty default image user without inventing a guest UID', async () => {
  const fake = daemon({ image: { id: imageId, user: '' } });
  const policy = await resolveBrowserSecurity(fake.docker, imageId, []);
  expect(policy.imageUser).toBe('');
  expect(() => { assertBrowserSecurity({ ...container, user: '' }, policy); }).not.toThrow();
  expect(() => { assertBrowserSecurity({ ...container, user: '1000' }, policy); }).toThrow('security policy changed');
});

it.each(['', '0', 'true'])('defers invalid environment rejection until start so the caller can clean its existing transport: %j', async (value) => {
  const environment = { CAUCE_E2E_BROWSER_SELINUX_COMPAT: value };
  const descriptor: BrowserDescriptor = { name: 'own-browser', owner: 'own-owner', imageId, networkName: 'own-network',
    networkId: 'own-network-id', networkOwner: 'own-network-owner', directory: '/unused/private-transport', socketIdentity: { uid: 1000, dev: 1, ino: 2 } };
  const fake = daemon();
  const lifecycle = ownedBrowserLifecycle(fake.docker, descriptor, undefined, environment);
  environment.CAUCE_E2E_BROWSER_SELINUX_COMPAT = '1';
  let transportOpen = true;
  try {
    await expect(lifecycle.start()).rejects.toThrow('absent or exactly 1');
  } finally {
    await lifecycle.close();
    if (!lifecycle.retained()) transportOpen = false;
  }
  expect(transportOpen).toBe(false);
  expect(lifecycle.retained()).toBe(false);
  expect(fake.commands).toEqual([]);
});

it('captures an admitted environment before later mutation and publishes only its frozen options', async () => {
  const environment = { CAUCE_E2E_BROWSER_SELINUX_COMPAT: '1' };
  const descriptor: BrowserDescriptor = { name: 'own-browser', owner: 'own-owner', imageId, networkName: 'own-network',
    networkId: 'own-network-id', networkOwner: 'own-network-owner', directory: '/unused/private-transport', socketIdentity: { uid: 1000, dev: 1, ino: 2 } };
  const fake = daemon();
  const lifecycle = ownedBrowserLifecycle(fake.docker, descriptor, undefined, environment);
  environment.CAUCE_E2E_BROWSER_SELINUX_COMPAT = 'invalid';
  await expect(lifecycle.start()).rejects.toThrow('ENOENT');
  expect(fake.commands.map((args) => args[0])).toEqual(['image', 'info', 'version']);
  expect(lifecycle.descriptor.securityOptions).toEqual(['label=disable']);
  expect(Object.isFrozen(lifecycle.descriptor.securityOptions)).toBe(true);
  await lifecycle.close();
});
