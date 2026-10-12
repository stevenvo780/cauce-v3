import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hostEnrollmentMessage, hostRequestMessage, type HostInvitation } from '@cauce/store';

export function setupBundle(directory = '@release@/adapter') {
  return { directory, digest: `sha256:${'d'.repeat(64)}`, executable: '/usr/local/bin/python3.12', executable_sha256: null, argv: [] };
}
export function hostSetupConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, signing_key_file: '/etc/cauce/host-setup.pem',
    release: { name: 'release', revision: 'a'.repeat(40), url: 'https://releases.example.test/executor.tar', sha256: 'b'.repeat(64), size: 4096 },
    files: [{ name: 'fleet-ca', url: 'https://releases.example.test/ca.pem', sha256: 'c'.repeat(64), size: 1200 }],
    policy: {
      bundles: { codex: setupBundle(), claude: setupBundle() },
      container_templates: [{ harness_id: 'codex', prefix: 'zz-canary-' }, { harness_id: 'claude', prefix: 'zz-claude-' }],
      profile_templates: [{ provider: 'codex', runtime_user: 'node' }],
      hooks: { verify: { executable: '@release@/ops/cli/fleet-provider-hook.py', user: '@user@', argv: ['--company', '@company@'] } },
      transport: { gateway_url: 'https://gateway.example.test', network: 'cauce-@host@', ca_certificate: '@install@/files/fleet-ca' },
      authority: { identity_directory: '@identity@', host_id: '@host@', ca_certificate: '@install@/files/fleet-ca' },
    },
    ...overrides,
  };
}

export interface SetupOwnerSession { cookie: string; origin: string; 'x-csrf-token': string }
/** A person registers a company through the public route and signs in; no platform administrator takes part. */
export async function registerSetupOwner(app: FastifyInstance, slug: string): Promise<SetupOwnerSession> {
  const origin = 'http://localhost'; const email = `${slug}@example.test`; const password = `${slug}-password-0`;
  const registered = await app.inject({ method: 'POST', url: '/v3/auth/register', headers: { origin },
    payload: { email, name: slug, password, company: { name: slug, slug } } });
  if (registered.statusCode !== 201) throw new Error(`registration failed (${String(registered.statusCode)}): ${registered.body}`);
  const login = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin }, payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login failed (${String(login.statusCode)})`);
  const header = login.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
  return { cookie, origin, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
}
export async function inviteSetupHost(app: FastifyInstance, session: SetupOwnerSession, hostId: string) {
  const response = await app.inject({ method: 'POST', url: '/v3/console/fleet/hosts/enrollments', headers: { ...session },
    payload: { host_id: hostId, display_name: hostId } });
  if (response.statusCode !== 201) throw new Error(`invitation failed (${String(response.statusCode)}): ${response.body}`);
  return response.json<HostInvitation & { setup_signer_fingerprint?: string }>();
}
export async function claimSetupHost(app: FastifyInstance, invitation: HostInvitation) {
  const keys = generateKeyPairSync('ed25519');
  const response = await app.inject({ method: 'POST', url: `/v3/fleet/hosts/enrollments/${invitation.enrollment_id}/claim`, payload: {
    invitation_token: invitation.invitation_token, public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64') } });
  if (response.statusCode !== 200) throw new Error(`claim failed (${String(response.statusCode)}): ${response.body}`);
  return { host_id: invitation.host_id, company_id: invitation.company_id, keys };
}
export function setupPacket(host: { host_id: string; company_id: string; keys: { privateKey: KeyObject } },
  overrides: { host_id?: string; company_id?: string; path_host?: string } = {}) {
  const value = { company_id: overrides.company_id ?? host.company_id, host_id: overrides.host_id ?? host.host_id, issued_at: Date.now(),
    nonce: randomBytes(32).toString('hex'), payload: { action: 'package' }, proof: '' };
  const path = `/v3/fleet/hosts/${overrides.path_host ?? value.host_id}/setup`;
  value.proof = sign(null, Buffer.from(hostRequestMessage('POST', path, value)), host.keys.privateKey).toString('base64');
  return value;
}
