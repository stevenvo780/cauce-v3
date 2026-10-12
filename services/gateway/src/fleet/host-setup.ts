import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { stableHostJson, type HostSetupScope } from '@cauce/store';
import { LoginPathSchema, readPrivateJson } from './provider-login.js';
import { privateBytes } from './signed-source.js';

const Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** The computer downloads without credentials or proxies; HTTP is accepted only for loopback test gateways, as on the host side. */
const ArtifactUrl = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && url.hostname !== ''
      && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)));
  } catch { return false; }
});
const Artifact = z.object({ name: Name, url: ArtifactUrl, sha256: Hex, size: z.number().int().positive().max(512 * 1024 * 1024) }).strict();
const Bundle = z.object({ directory: z.string().regex(/^@release@\/[A-Za-z0-9_./-]+$/u).refine(value => !value.split('/').includes('..')),
  digest: Hex }).strict();
const Template = z.record(z.string(), z.unknown());
const Policy = z.object({
  container_templates: z.array(Template.and(z.object({ harness_id: Name }))).max(100).default([]),
  profile_templates: z.array(Template).max(100).default([]),
  bundles: z.record(Name, Bundle),
  hooks: z.record(z.string(), Template).default({}),
  transport: Template.optional(),
  authority: z.object({ identity_directory: z.literal('@identity@'), host_id: z.literal('@host@'), ca_certificate: z.string().min(1).max(4096) })
    .strict().optional(),
}).strict();
export const HostSetupConfigSchema = z.object({
  version: z.literal(1),
  signing_key_file: LoginPathSchema,
  release: Artifact.extend({ name: z.literal('release'), revision: z.string().regex(/^[a-f0-9]{40}$/u) }).strict(),
  files: z.array(Artifact).max(16).default([]),
  policy: Policy,
}).strict().refine(value => new Set(['release', ...value.files.map(file => file.name)]).size === value.files.length + 1,
  { message: 'setup artifacts need distinct names' });
export type HostSetupConfig = z.infer<typeof HostSetupConfigSchema>;
export interface SignedHostSetupPackage { package: Record<string, unknown>; signature: string; signer_public_key: string }

function substitute(value: unknown, scope: HostSetupScope): unknown {
  if (typeof value === 'string') return value.replaceAll('@host@', scope.host_id).replaceAll('@company@', scope.company_id);
  if (Array.isArray(value)) return value.map(item => substitute(item, scope));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, scope)]));
  }
  return value;
}

/**
 * Signs the company default executor policy for one verified computer. The policy is the platform approved
 * template narrowed to the harnesses the platform keeps enabled; the computer adds identity, user and roots.
 */
export class HostSetupPackager {
  readonly signerPublicKey: string;
  readonly signerFingerprint: string;

  constructor(private readonly config: HostSetupConfig, private readonly key: KeyObject) {
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('Host setup signing key must be Ed25519');
    const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
    this.signerPublicKey = der.toString('base64');
    this.signerFingerprint = createHash('sha256').update(der).digest('hex');
  }

  static async load(filename: string): Promise<HostSetupPackager> {
    const config = HostSetupConfigSchema.parse(await readPrivateJson(filename));
    return new HostSetupPackager(config, createPrivateKey(await privateBytes(config.signing_key_file)));
  }

  build(scope: HostSetupScope, issuedAt = Date.now()): SignedHostSetupPackage {
    const enabled = new Set(scope.harnesses);
    const { policy, release, files } = this.config;
    const bundles = Object.fromEntries(Object.entries(policy.bundles).filter(([harness]) => enabled.has(harness)));
    const narrowed = { ...policy, bundles,
      container_templates: policy.container_templates.filter(template => template.harness_id in bundles) };
    const signed = { version: 1, company_id: scope.company_id, host_id: scope.host_id, issued_at: issuedAt,
      release_revision: release.revision,
      artifacts: [{ name: release.name, kind: 'release', url: release.url, sha256: release.sha256, size: release.size },
        ...files.map(file => ({ ...file, kind: 'file' }))],
      policy: substitute(narrowed, scope) };
    return { package: signed, signature: sign(null, Buffer.from(stableHostJson(signed)), this.key).toString('base64'),
      signer_public_key: this.signerPublicKey };
  }
}

export async function configuredHostSetup(environment: NodeJS.ProcessEnv = process.env): Promise<HostSetupPackager | undefined> {
  const filename = environment.CAUCE_FLEET_HOST_SETUP_CONFIG_FILE;
  return filename === undefined ? undefined : HostSetupPackager.load(filename);
}
