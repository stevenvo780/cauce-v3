import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { z } from 'zod';
import { ExtensionsAllowedSchema } from '@cauce/protocol';
import { StoreError, stableHostJson, type HostSetupArtifactRequest, type HostSetupScope } from '@cauce/store';
import { LoginPathSchema, readPrivateJson } from './provider-login.js';
import { privateBytes } from './signed-source.js';

const Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const Revision = z.string().regex(/^[a-f0-9]{40}$/u);
/** Releases pin the config digest from docker save; setup resolves it to the client's immutable Docker Id. */
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** The computer refuses larger releases and files (`MAX_ARTIFACT` in `ops/cli/host_setup.py`); the agent image is a `docker save`. */
const MAX_ARTIFACT = 512 * 1024 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024 * 1024;
const MAX_SMALL_FILE = 1024 * 1024;
const Size = (limit: number) => z.number().int().positive().max(limit);
/** A file the gateway streams from its own disk; the computer checks the signed size and digest. */
const Served = z.object({ name: Name, path: LoginPathSchema, sha256: Hex, size: Size(MAX_ARTIFACT) }).strict();
/** Same fields the executor demands of an approved runtime bundle; the directory always lives inside the signed release. */
const Bundle = z.object({ directory: z.string().regex(/^@release@\/[A-Za-z0-9_./-]+$/u).refine(value => !value.split('/').includes('..')),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), executable: z.string().min(1).max(4096), executable_sha256: Hex.nullable(),
  argv: z.array(z.string().max(4096)).max(32), descriptor_sha256: Hex.optional() }).strict();
const Template = z.record(z.string(), z.unknown());
const Providers = z.array(Name).min(1).max(100).refine(values => new Set(values).size === values.length);
const QuotaEnvironment = z.object({ image: ImageId,
  network: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), providers: Providers }).strict();
const Policy = z.object({
  container_templates: z.array(Template.and(z.object({ harness_id: Name }))).max(100).default([]),
  profile_templates: z.array(Template).max(100).default([]),
  bundles: z.record(Name, Bundle),
  hooks: z.record(z.string(), Template).default({}),
  transport: Template.optional(),
  quota_environments: QuotaEnvironment.optional(),
  extensions_allowed: ExtensionsAllowedSchema.optional(),
  authority: z.object({ identity_directory: z.literal('@identity@'), host_id: z.literal('@host@'), ca_certificate: z.string().min(1).max(4096) })
    .strict().optional(),
}).strict();
/** What the packager signs and serves, once the release manifest of the deployed candidate filled in its pins. */
export const HostSetupConfigSchema = z.object({
  version: z.literal(1),
  signing_key_file: LoginPathSchema,
  release: Served.extend({ name: z.literal('release'), revision: Revision }).strict(),
  image: Served.extend({ name: z.literal('agent-image'), size: Size(MAX_IMAGE), id: ImageId }).strict().optional(),
  quota_image: Served.extend({ name: z.literal('quota-image'), size: Size(MAX_IMAGE), id: ImageId, providers: Providers }).strict().optional(),
  files: z.array(Served).max(16).default([]),
  policy: Policy,
}).strict().refine(value => new Set(['release', 'agent-image', 'quota-image', ...value.files.map(file => file.name)]).size === value.files.length + 3,
  { message: 'setup artifacts need distinct names' })
  .refine(value => value.image === undefined || value.policy.container_templates.every(template => template.image === value.image?.id),
    { message: 'every container template must run the agent image the gateway serves' })
  .refine(value => value.policy.quota_environments === undefined ||
    value.policy.quota_environments.image === (value.quota_image ?? value.image)?.id,
  { message: 'quota environments must run the quota image the gateway serves' })
  .refine(value => value.quota_image === undefined || value.policy.quota_environments === undefined ||
    value.policy.quota_environments.providers.every(provider => value.quota_image?.providers.includes(provider)),
  { message: 'quota environments may only advertise providers available in the quota image' });
export type HostSetupConfig = z.infer<typeof HostSetupConfigSchema>;
/** `CAUCE_FLEET_HOST_SETUP_CONFIG_FILE`: the platform template; the build-dependent pins come from the release directory. */
export const HostSetupFileSchema = z.object({
  version: z.literal(1),
  signing_key_file: LoginPathSchema,
  release_directory: LoginPathSchema,
  files: z.array(z.object({ name: Name, path: LoginPathSchema }).strict()).max(16).default([]),
  policy: z.record(z.string(), z.unknown()),
}).strict();
const PlainName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const ReleaseImage = z.object({ file: PlainName, sha256: Hex, size: Size(MAX_IMAGE), id: ImageId, reference: z.string().min(1).max(256) });
/** `host-release.json`, written by `ops/scripts/host-release.py pack` next to the files it describes. */
export const HostReleaseManifestSchema = z.object({
  version: z.literal(1),
  revision: Revision,
  release: z.object({ file: PlainName, sha256: Hex, size: Size(MAX_ARTIFACT) }).strict(),
  image: ReleaseImage.strict().optional(),
  quota_image: ReleaseImage.extend({ providers: Providers }).strict().optional(),
  pins: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), z.string().min(1).max(4096)).default({}),
}).strict();
export const HOST_RELEASE_MANIFEST = 'host-release.json';
export interface SignedHostSetupPackage { package: Record<string, unknown>; signature: string; signer_public_key: string }
export interface HostSetupArtifact { path: string; sha256: string; size: number; offset: number }

function substitute(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map(item => substitute(item, replace));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, replace)]));
  }
  return value;
}

/** Opens one regular file that nobody but its owner can rewrite; `size` pins what the manifest or the config declared. */
async function openRegular(path: string, size?: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (size !== undefined && info.size !== size)) {
      throw new Error(`host setup artifact ${path} is not the declared regular file`);
    }
    return { file, size: info.size };
  } catch (error) { await file.close(); throw error; }
}

/** Fills the platform template with the deployed release: its pins, its files and the small files the config names. */
export async function resolveHostSetup(value: unknown): Promise<HostSetupConfig> {
  const template = HostSetupFileSchema.parse(value);
  const manifestFile = await openRegular(join(template.release_directory, HOST_RELEASE_MANIFEST));
  let manifest;
  try {
    if (manifestFile.size > MAX_SMALL_FILE) throw new Error('host release manifest exceeds its limit');
    manifest = HostReleaseManifestSchema.parse(JSON.parse((await manifestFile.file.readFile()).toString('utf8')));
  } finally { await manifestFile.file.close(); }
  const declared = async (file: string, size: number) => {
    const path = join(template.release_directory, file); const opened = await openRegular(path, size);
    await opened.file.close(); return path;
  };
  const files = [];
  for (const item of template.files) {
    const opened = await openRegular(item.path);
    try {
      if (opened.size === 0 || opened.size > MAX_SMALL_FILE) throw new Error(`host setup file ${item.name} must hold 1 to ${String(MAX_SMALL_FILE)} bytes`);
      files.push({ ...item, sha256: createHash('sha256').update(await opened.file.readFile()).digest('hex'), size: opened.size });
    } finally { await opened.file.close(); }
  }
  const policy = Policy.parse(substitute(template.policy, text => text.replace(/@pin:([a-z][a-z0-9_]{0,63})@/gu, (_match, name: string) => {
    const pin = manifest.pins[name];
    if (pin === undefined) throw new Error(`host setup policy names the release pin ${name}, absent from ${HOST_RELEASE_MANIFEST}`);
    return pin;
  })));
  const { image, quota_image: quotaImage } = manifest;
  if (policy.quota_environments !== undefined && quotaImage !== undefined) {
    policy.quota_environments.providers = policy.quota_environments.providers.filter(provider => quotaImage.providers.includes(provider));
  }
  return HostSetupConfigSchema.parse({ version: 1, signing_key_file: template.signing_key_file,
    release: { name: 'release', revision: manifest.revision, path: await declared(manifest.release.file, manifest.release.size),
      sha256: manifest.release.sha256, size: manifest.release.size },
    ...(image === undefined ? {} : { image: { name: 'agent-image', id: image.id, path: await declared(image.file, image.size),
      sha256: image.sha256, size: image.size } }),
    ...(quotaImage === undefined ? {} : { quota_image: { name: 'quota-image', id: quotaImage.id,
      path: await declared(quotaImage.file, quotaImage.size), sha256: quotaImage.sha256, size: quotaImage.size, providers: quotaImage.providers } }),
    files, policy });
}

/**
 * Signs the company default executor policy for one verified computer and serves the artifacts it names. The policy is
 * the platform approved template narrowed to the harnesses the platform keeps enabled; the computer adds identity, user and roots.
 */
export class HostSetupPackager {
  readonly signerPublicKey: string;
  readonly signerFingerprint: string;
  private readonly served: ReadonlyMap<string, { path: string; sha256: string; size: number }>;

  constructor(private readonly config: HostSetupConfig, private readonly key: KeyObject) {
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('Host setup signing key must be Ed25519');
    const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
    this.signerPublicKey = der.toString('base64');
    this.signerFingerprint = createHash('sha256').update(der).digest('hex');
    this.served = new Map([config.release, ...[config.image, config.quota_image].filter(item => item !== undefined), ...config.files]
      .map(item => [item.name, { path: item.path, sha256: item.sha256, size: item.size }]));
  }

  static async load(filename: string): Promise<HostSetupPackager> {
    const config = await resolveHostSetup(await readPrivateJson(filename));
    return new HostSetupPackager(config, createPrivateKey(await privateBytes(config.signing_key_file)));
  }

  build(scope: HostSetupScope, issuedAt = Date.now()): SignedHostSetupPackage {
    const enabled = new Set(scope.harnesses);
    const { policy, release, image, quota_image: quotaImage, files } = this.config;
    const bundles = Object.fromEntries(Object.entries(policy.bundles).filter(([harness]) => enabled.has(harness)));
    const narrowed = { ...policy, bundles,
      extensions_allowed: ExtensionsAllowedSchema.parse(scope.extensions_allowed ?? { types: [], mount_roots: [], networks: [] }),
      container_templates: policy.container_templates.filter(template => Object.hasOwn(bundles, template.harness_id)) };
    if (narrowed.quota_environments !== undefined) {
      const providers = narrowed.quota_environments.providers.filter(provider => provider === 'agy' || Object.hasOwn(bundles, provider));
      if (providers.length === 0) delete narrowed.quota_environments;
      else narrowed.quota_environments = { ...narrowed.quota_environments, providers };
    }
    const signed = { version: 1, company_id: scope.company_id, host_id: scope.host_id, issued_at: issuedAt,
      release_revision: release.revision,
      artifacts: [{ name: release.name, kind: 'release', sha256: release.sha256, size: release.size },
        ...(image === undefined ? [] : [{ name: image.name, kind: 'image', sha256: image.sha256, size: image.size, image_id: image.id }]),
        ...(quotaImage === undefined ? [] : [{ name: quotaImage.name, kind: 'image', sha256: quotaImage.sha256, size: quotaImage.size, image_id: quotaImage.id }]),
        ...files.map(file => ({ name: file.name, kind: 'file', sha256: file.sha256, size: file.size }))],
      policy: { ...substitute(narrowed, text => text.replaceAll('@host@', scope.host_id).replaceAll('@company@', scope.company_id)) as typeof narrowed,
        extensions_allowed: narrowed.extensions_allowed } };
    return { package: signed, signature: sign(null, Buffer.from(stableHostJson(signed)), this.key).toString('base64'),
      signer_public_key: this.signerPublicKey };
  }

  /** Runs inside the verified host request: a name, digest or offset the package does not sign rolls the request back. */
  artifact(wanted: HostSetupArtifactRequest): HostSetupArtifact {
    const item = this.served.get(wanted.name);
    if (item === undefined) throw new StoreError('not_found', 'the setup package has no such artifact');
    if (item.sha256 !== wanted.sha256) throw new StoreError('conflict', 'the setup package changed; request a new package');
    if (wanted.offset >= item.size) throw new StoreError('invalid_input', 'artifact offset is beyond its size');
    return { ...item, offset: wanted.offset };
  }
}

/** The bytes from `offset` to the end; the descriptor is opened after the request committed and closes with the stream. */
export async function openHostSetupArtifact(artifact: HostSetupArtifact): Promise<{ stream: Readable; length: number }> {
  const opened = await openRegular(artifact.path, artifact.size);
  return { stream: opened.file.createReadStream({ start: artifact.offset, autoClose: true }), length: artifact.size - artifact.offset };
}

/** Compose passes the variable through with an empty default, so an empty value means setup is off. */
export async function configuredHostSetup(environment: NodeJS.ProcessEnv = process.env): Promise<HostSetupPackager | undefined> {
  const filename = environment.CAUCE_FLEET_HOST_SETUP_CONFIG_FILE;
  return filename === undefined || filename === '' ? undefined : HostSetupPackager.load(filename);
}
