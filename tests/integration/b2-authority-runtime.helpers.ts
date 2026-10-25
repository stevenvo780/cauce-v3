import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';

const execute = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function fileDigests(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileDigests(directory, relative));
    else if (entry.isFile()) result[relative] = hash(await readFile(join(directory, relative)));
  }
  return result;
}
export async function startRuntimeAuthority(databaseUrl: string) {
  const directory = await mkdtemp('/var/tmp/zz-canary-b2-authority-');
  try { return await launchRuntimeAuthority(directory, databaseUrl); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
async function launchRuntimeAuthority(directory: string, databaseUrl: string) {
  const projectRoot = resolve(import.meta.dirname, '../..');
  const executable = join(projectRoot, 'ops/cli/fleet-authority-issuer.py');
  const certificate = join(directory, 'ca.crt'); const key = join(directory, 'ca.key');
  await execute('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=zz-canary-b2-authority', '-keyout', key, '-out', certificate, '-addext', 'basicConstraints=critical,CA:TRUE'], { timeout: 30_000 });
  await chmod(key, 0o600);
  const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 });
  const registries: Record<string, string> = {};
  for (const name of ['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token']) {
    const parent = join(directory, name); await mkdir(parent, { mode: 0o700 });
    registries[name] = join(parent, name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json');
    await writeFile(registries[name], JSON.stringify({ version: 1, identities: [] }), { mode: 0o600 });
  }
  const policy = join(directory, 'authority-policy.json');
  await writeFile(policy, JSON.stringify({ version: 1, state_root: state, registries,
    signer: { certificate, key, certificate_sha256: hash(await readFile(certificate)), key_sha256: hash(await readFile(key)) } }), { mode: 0o600 });
  const policyDigest = hash(await readFile(policy));
  const csr = join(directory, 'runtime.csr');
  await execute('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=agent-b2-runtime',
    '-keyout', join(directory, 'runtime.key'), '-out', csr], { timeout: 30_000 });
  const csrPem = await readFile(csr, 'utf8');
  const issuer = spawn('/usr/bin/python3', ['-I', '-B', executable, '--policy', policy, '--policy-sha256', policyDigest], {
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; issuer.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString(); if (output.length > 262_144) issuer.kill('SIGKILL');
  });
  issuer.stderr.resume();
  issuer.stdin.end(JSON.stringify({ action: 'issue', phase: 'normal', csr_pem: csrPem, csr_sha256: hash(csrPem),
    idempotency_key: 'zz-canary-b2-runtime', agent: { tenant_id: 'B2Tenant', alias: 'b2-agent' },
    scope: { operation_id: randomUUID(), host_id: 'zz-canary-b2-host', runtime_key: 'b2-runtime', scope_sha256: 'a'.repeat(64) } }));
  const deadline = setTimeout(() => { issuer.kill('SIGKILL'); }, 30_000);
  try { await once(issuer, 'close'); } finally { clearTimeout(deadline); }
  if (issuer.exitCode !== 0) { await rm(directory, { recursive: true, force: true }); throw new Error('isolated authority material was not issued'); }
  const issued = JSON.parse(output) as { certificate_sha256: string; expires_at: string };
  const command = join(directory, 'authority-command.json');
  await writeFile(command, JSON.stringify({ python: '/usr/bin/python3', executable, sha256: hash(await readFile(executable)),
    policy_file: policy, policy_sha256: policyDigest }), { mode: 0o600 });
  const database = join(directory, 'database-url'); await writeFile(database, databaseUrl, { mode: 0o600 });
  const run = join(directory, 'run'); await mkdir(run, { mode: 0o700 }); const socket = join(run, 'authority.sock');
  const uid = process.geteuid?.() ?? 0;
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'services/gateway/src/fleet/authority/signed-main.ts')], {
    cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userInfo().homedir,
      CAUCE_FLEET_AUTHORITY_SOCKET: socket, CAUCE_FLEET_AUTHORITY_OWNER_UID: String(uid), CAUCE_FLEET_AUTHORITY_PEER_UID: String(uid),
      CAUCE_FLEET_AUTHORITY_COMMAND_FILE: command, CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE: database },
  });
  const closed = once(child, 'close'); let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    try { await closed; } finally { clearTimeout(timeout); await rm(directory, { recursive: true, force: true }); }
  };
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (child.exitCode !== null) throw new Error('isolated authority exited before opening its socket');
      if (await lstat(socket).then(value => value.isSocket(), () => false)) {
        return { directory, policy, socket, child, close, diagnostic: () => diagnostic,
          fingerprint: issued.certificate_sha256, expiresAt: issued.expires_at,
          client: () => new SignedFleetAuthorityClient(socket, { ownerUid: uid, peerUid: uid }) };
      }
      await delay(50);
    }
    throw new Error('isolated authority socket did not appear');
  } catch (error) { await close(); throw error; }
}
