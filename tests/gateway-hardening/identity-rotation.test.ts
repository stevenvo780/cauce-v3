import { createHash, type X509Certificate } from 'node:crypto';
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HashedMtlsIdentityFileProvider, HashedTokenFileAuthProvider } from '../../services/gateway/src/index.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composePath = join(projectRoot, 'deploy', 'compose.yaml');

const principal = {
  tenant_id: 'Steven', alias: 'kant', session_id: 'mtls-kant', channel: 'adapter',
  roles: ['operator'], permissions: ['route', 'read', 'control']
};

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function registryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-identity-'));
  created.push(directory);
  return directory;
}

const live = new Date(Date.now() + 3_600_000).toISOString();
const lapsed = new Date(Date.now() - 3_600_000).toISOString();

function document(records: Record<string, unknown>[]): string {
  return JSON.stringify({
    version: 1,
    identities: records.map((record) => ({ expires_at: live, ...record, principal })),
  });
}

/**
 * Rotates exactly the way `ops/runbooks/authentication.md` prescribes: write a sibling temp file
 * and rename it over the registry. The rename publishes a NEW inode, which is precisely what a
 * single-file bind mount cannot see. The descriptor kept open on the pre-rotation inode models
 * that pinning: the old content stays reachable through the old inode, so a provider that cached
 * a descriptor or an inode instead of re-resolving the path would keep serving the stale registry.
 */
async function rotateByRename(path: string, contents: string): Promise<void> {
  const staging = `${path}.next`;
  await writeFile(staging, contents, { mode: 0o400 });
  await rename(staging, path);
}

function certificate(fingerprint: string): X509Certificate {
  return { fingerprint256: fingerprint.toUpperCase().replace(/(.{2})(?=.)/g, '$1:') } as X509Certificate;
}

const provisioned = 'a'.repeat(64);
const rotatedIn = 'b'.repeat(64);

describe('identity registry rotation reaches the gateway', () => {
  it('serves the post-rename mTLS registry even while the pre-rotation inode stays open', async () => {
    const directory = await registryDirectory();
    const path = join(directory, 'mtls_identities.json');
    await writeFile(path, document([{ certificate_sha256: provisioned }]), { mode: 0o400 });
    const provider = new HashedMtlsIdentityFileProvider(path);
    await expect(provider.resolve(certificate(provisioned))).resolves.toMatchObject({ alias: 'kant' });

    const pinned = await open(path, 'r');
    try {
      await rotateByRename(path, document([{ certificate_sha256: rotatedIn }]));

      // The new registration must reach the gateway.
      await expect(provider.resolve(certificate(rotatedIn))).resolves.toMatchObject({ alias: 'kant' });
      // And the revocation must too: the removed fingerprint has to fail closed.
      await expect(provider.resolve(certificate(provisioned))).rejects.toThrow('not provisioned');
      // The pre-rotation inode is still readable, so only path re-resolution can explain the above.
      expect((await pinned.readFile('utf8')).includes(provisioned)).toBe(true);
    } finally {
      await pinned.close();
    }
  });

  it('keeps both records of a make-before-break overlap live and expires each on its own date', async () => {
    const directory = await registryDirectory();
    const path = join(directory, 'mtls_identities.json');
    await writeFile(path, document([
      { certificate_sha256: provisioned }, { certificate_sha256: rotatedIn },
    ]), { mode: 0o400 });
    const provider = new HashedMtlsIdentityFileProvider(path);
    await expect(provider.resolve(certificate(provisioned))).resolves.toMatchObject({ alias: 'kant' });
    await expect(provider.resolve(certificate(rotatedIn))).resolves.toMatchObject({ alias: 'kant' });

    await rotateByRename(path, document([
      { certificate_sha256: provisioned, expires_at: lapsed }, { certificate_sha256: rotatedIn },
    ]));
    await expect(provider.resolve(certificate(provisioned))).rejects.toThrow('expired');
    await expect(provider.resolve(certificate(rotatedIn))).resolves.toMatchObject({ alias: 'kant' });
  });

  it('refuses only the mTLS record with no expiry and reports the file once', async () => {
    const directory = await registryDirectory();
    const path = join(directory, 'mtls_identities.json');
    await writeFile(path, JSON.stringify({
      version: 1,
      identities: [
        { certificate_sha256: provisioned, principal },
        { certificate_sha256: rotatedIn, expires_at: live, principal },
      ],
    }), { mode: 0o400 });
    const provider = new HashedMtlsIdentityFileProvider(path);
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(provider.resolve(certificate(provisioned)))
        .rejects.toThrow('identity expiry is missing');
      await expect(provider.resolve(certificate(rotatedIn))).resolves.toMatchObject({ alias: 'kant' });
      const lines = reported.mock.calls
        .filter(([line]) => String(line).includes('identity_records_without_valid_expiry'));
      expect(lines).toHaveLength(1);
      expect(String(lines[0]?.[0])).not.toContain(provisioned);
    } finally {
      reported.mockRestore();
    }
  });

  it('revokes a pilot token hash published by atomic rename', async () => {
    const directory = await registryDirectory();
    const path = join(directory, 'token_hashes.json');
    const token = 'test-only-pilot-token-with-sufficient-entropy';
    const digest = createHash('sha256').update(token).digest('hex');
    await writeFile(path, document([{ token_sha256: digest }]), { mode: 0o400 });
    const provider = new HashedTokenFileAuthProvider({ path });
    const request = { headers: { cookie: `__Host-cauce_session=${encodeURIComponent(token)}` }, raw: { socket: {} } };
    type Request = Parameters<HashedTokenFileAuthProvider['authenticateHttp']>[0];
    await expect(provider.authenticateHttp(request as Request)).resolves.toMatchObject({ alias: 'kant' });

    const pinned = await open(path, 'r');
    try {
      await rotateByRename(path, document([{ token_sha256: 'c'.repeat(64) }]));
      await expect(provider.authenticateHttp(request as Request)).rejects.toThrow('not recognized');
      expect((await pinned.readFile('utf8')).includes(digest)).toBe(true);
    } finally {
      await pinned.close();
    }
  });
});

function serviceBlock(compose: string, service: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${service}:`);
  expect(start, `service ${service} is missing from deploy/compose.yaml`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

/** Container-side directories the service mounts read-only as a directory bind. */
function readOnlyDirectoryBinds(block: string): string[] {
  const targets: string[] = [];
  const entries = block.split(/^ {6}- (?=type: bind$)/m).slice(1);
  for (const entry of entries) {
    const target = /^ {8}target: (\S+)$/m.exec(entry);
    if (target?.[1] && /^ {8}read_only: true$/m.test(entry)) targets.push(target[1]);
  }
  return targets;
}

describe('deployed identity registries are mounted as a directory', () => {
  it('never resolves a per-request registry through a single-file secret mount', async () => {
    const compose = await readFile(composePath, 'utf8');
    const gateway = serviceBlock(compose, 'gateway');
    const registries = [...gateway.matchAll(/^ {6}(CAUCE_\w*(?:IDENTITY|HASH)\w*FILE): (\S+)$/gm)]
      .flatMap(([, name, path]) => (name && path ? [{ name, path }] : []));
    expect(registries.map((entry) => entry.name).sort())
      .toEqual(['CAUCE_MTLS_IDENTITY_FILE', 'CAUCE_TOKEN_HASH_FILE']);

    const binds = readOnlyDirectoryBinds(gateway);
    for (const { name, path } of registries) {
      // A compose file secret is a single-file bind: it pins the inode, so the atomic rename
      // that rotates or revokes an identity would never become visible inside the container.
      expect(path.startsWith('/run/secrets/'), `${name} must not be a single-file secret mount`).toBe(false);
      const mount = binds.find((target) => path.startsWith(`${target}/`));
      expect(mount, `${name}=${path} must resolve inside a read-only directory bind`).toBeDefined();
      // The registry must sit directly in the mounted directory, so the mount cannot be widened
      // to an ancestor such as /run/secrets that would expose unrelated material to the gateway.
      expect(posix.dirname(path)).toBe(mount);
    }
  });

  it('keeps the identity mount dedicated instead of exposing the whole secret tree', async () => {
    const compose = await readFile(composePath, 'utf8');
    const gateway = serviceBlock(compose, 'gateway');
    expect(readOnlyDirectoryBinds(gateway)).not.toContain('/run/secrets');
    // The mount source has to be its own variable; reusing a broader secret directory would
    // hand the gateway every present and future secret in it.
    expect(gateway).toContain('${CAUCE_GATEWAY_IDENTITY_DIR:?');
    expect(compose).not.toContain('source: gateway_mtls_identities');
    expect(compose).not.toContain('source: gateway_token_hashes');
  });
});
