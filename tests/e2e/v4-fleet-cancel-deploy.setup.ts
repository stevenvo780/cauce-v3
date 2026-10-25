import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CauceRepository, type HostSetupArtifactRequest, type HostSetupScope } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { HostSetupConfigSchema, HostSetupPackager, type HostSetupConfig } from '../../services/gateway/src/fleet/host-setup.js';
import type { ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function records(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(record);
}

function publicConfiguration(packager: HostSetupPackager, scope: HostSetupScope, placeholder: string): HostSetupConfig {
  const value = packager.build(scope).package;
  if (!records(value.artifacts) || !record(value.policy) || !record(value.policy.authority)) {
    throw new Error('the public setup package lacks its artifacts or policy');
  }
  const artifact = (item: Record<string, unknown>) => {
    const { name, sha256 } = item;
    if (typeof name !== 'string' || typeof sha256 !== 'string') throw new Error('the public setup artifact lacks its identity');
    const declared = packager.artifact({ action: 'artifact', name, sha256, offset: 0 });
    return { path: declared.path, sha256: declared.sha256, size: declared.size };
  };
  const release = value.artifacts.find(item => item.kind === 'release');
  const image = value.artifacts.find(item => item.kind === 'image' && item.name === 'agent-image');
  if (!release || !image || value.artifacts.some(item => item.kind === 'image' && item.name !== 'agent-image')) {
    throw new Error('deployment fixture requires one release and one agent image');
  }
  return HostSetupConfigSchema.parse({ version: 1, signing_key_file: placeholder,
    release: { name: 'release', revision: value.release_revision, ...artifact(release) },
    image: { name: 'agent-image', id: image.image_id, ...artifact(image) },
    files: value.artifacts.filter(item => item.kind === 'file').map(item => ({ name: item.name, ...artifact(item) })),
    policy: { ...value.policy, authority: { ...value.policy.authority, host_id: '@host@' } },
  });
}

export class CancelDeploySetup extends HostSetupPackager {
  private active: HostSetupPackager;
  readonly initialConfiguration: HostSetupConfig;
  private configuration: HostSetupConfig;

  constructor(configuration: HostSetupConfig, private readonly signingKey: KeyObject) {
    super(configuration, signingKey);
    this.initialConfiguration = structuredClone(configuration);
    this.configuration = structuredClone(configuration);
    this.active = new HostSetupPackager(configuration, signingKey);
  }

  override build(scope: HostSetupScope, issuedAt = Date.now()) {
    return this.active.build(scope, issuedAt);
  }

  override artifact(wanted: HostSetupArtifactRequest) {
    return this.active.artifact(wanted);
  }

  publish(configuration: HostSetupConfig): void {
    this.configuration = HostSetupConfigSchema.parse(configuration);
    this.active = new HostSetupPackager(this.configuration, this.signingKey);
  }

  approvedConfiguration(): HostSetupConfig { return structuredClone(this.configuration); }
}

export async function installCancelDeploySetup(computer: ComputerHarness, origin: string, company: string, host: string): Promise<{
  computer: ComputerHarness; setup: CancelDeploySetup;
}> {
  const configuration = publicConfiguration(computer.packager, { company_id: company, host_id: host, harnesses: ['codex'] },
    join(dirname(computer.installRoot), 'unused-canary-signer.pem'));
  const setup = new CancelDeploySetup(configuration, generateKeyPairSync('ed25519').privateKey);
  await computer.app.close();
  const uid = process.geteuid?.() ?? 0;
  const gateway = await buildGateway({ pool: computer.pool, repository: new CauceRepository(computer.pool), logger: false,
    consoleOrigins: [origin], hostSetup: setup,
    signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(dirname(computer.installRoot), 'authority/signed.sock'), { ownerUid: uid, peerUid: uid }),
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(computer.pool), signingKey: Buffer.alloc(32, 61) }),
  });
  try {
    await gateway.listen({ host: '127.0.0.1', port: Number(new URL(computer.gatewayUrl).port) });
    return { setup, computer: { ...computer, app: gateway, packager: setup,
      close: async () => { await gateway.close(); return computer.close(); } } };
  } catch (error) { await gateway.close(); throw error; }
}
